import "./patches"

import {decode} from "@webassemblyjs/wasm-parser"
import * as fs from "fs"
import { isArray } from "util";

import {ArrayMap} from "./arraymap"
import { VirtualRegisterManager, VirtualRegister, PhantomRegister } from "./virtualregistermanager";
import { StringCompiler } from "./stringcompiler";
import { WebIDLBinder, BinderMode } from "./webidlbinder";

/* TODO CORRECTNESS:
    - Be extra careful with conversions from floats -> ints. The bit library's rounding behavior is undefined.
    - Imported globals use global IDs that precede other global IDs
    - The same applies to memories. ^
    - Test i64 bitshifts/rotations.
*/

/* TODO OPTIMIZATION:

    - Track bools and only convert them if need be.
    - ^ Some compilers might generate some really dumb code, requiring some further specialization for bitwise ops on bools...
    - Floating point memory should probably write back floats upon read, especially since pre-initialized memory can contain FP data.
    - Implement better long divide/modulo ops.
*/

// this may or may not be the best way to handle memory init but is pretty fast+easy to do for now
function makeBinaryStringLiteral(array: number[]) {
    let literal = ["'"];
    for (let i=0;i<array.length;i++) {
        let c = array[i];
        if (c < 0x20 || c > 0x7E) {
            // high and low values
            let tmp = "00"+c.toString(16);
            literal.push("\\x"+tmp.substr(tmp.length-2));

        } else if (c==0x27) {
            // quote
            literal.push("\\'");
        } else if (c==0x5C) {
            // backslash
            literal.push("\\\\");
        } else {
            literal.push(String.fromCharCode(c));
        }
    }
    literal.push("'");
    return literal.join("");
}

// Probably won't work on lua implementations with sane identifier parsing rules.
function sanitizeIdentifier(ident: string|number) {
    // ident = ident.toString();
    // return ident
    //     .replace(/\$/g,"__IDENT_CHAR_DOLLAR__")
    //     .replace(/\./g,"__IDENT_CHAR_DOT__")
    //     .replace(/\:/g,"__IDENT_CHAR_COLON__")
    //     .replace(/\~/g,"__IDENT_CHAR_TILDE__")
    //     .replace(/\//g,"__IDENT_CHAR_FSLASH__")
    //     .replace(/\#/g,"__IDENT_CHAR_HASH__")
    //     .replace(/\</g,"__IDENT_CHAR_LT__")
    //     .replace(/\>/g,"__IDENT_CHAR_GT__")
    //     .replace(/\-/g,"__IDENT_CHAR_MINUS__");

    return ident.toString().replace(/[^A-Za-z0-9_]/g,(str) => {
        return `__x${str.charCodeAt(0).toString(16)}`;
    });
}

interface WASMModuleState {
    funcStates: WASMFuncState[];
    funcByName: Map<string,WASMFuncState>;
    memoryAllocations: ArrayMap<string>;
    func_tables: Array< Array< Array<Index> > >;

    nextGlobalIndex: number;
}

interface WASMFuncState {
    id: string;
    origID: string;
    regManager: VirtualRegisterManager;
    insLastRefs: number[];
    insLastAssigned: [number,WASMBlockState | false][];
    insCountPass1: number;
    insCountPass2: number;
    insCountPass1LoopLifespanAdjs: Map<number,WASMBlockState>;
    forceVarInit: Map<number, number[]>,
    registersToBeFreed: VirtualRegister[];
    locals: VirtualRegister[];
    localTypes: Valtype[];
    blocks: WASMBlockState[];
    funcType?: Signature;
    modState?: WASMModuleState;

    hasSetjmp: boolean;
    setJmps: CallInstruction[];

    labels: Map<string,{ins: number,id: number,rid: number}>;
    labelsByIns: [number,string][];
    gotos: {ins: number,label: string}[];
    jumpStreamEnabled: boolean;
    curJmpID: number;

    usedLabels: {[labelID: string]: boolean};

    stackLevel: number;
    stackData: (string | VirtualRegister | PhantomRegister | false)[];
}

interface WASMBlockState {
    id: string;
    blockType: "block" | "loop" | "if";
    resultRegister?: VirtualRegister;
    resultType?: Valtype | null;
    insCountStart: number;
    enterStackLevel: number; // used to check if we left a block with an extra item in the stack
    hasClosed?: true;
}

export interface WASM2LuaOptions {
    whitelist?: string[];
    compileFlags?: string[];
    heapBase?: string;
    pureLua?: boolean;
    libMode?: boolean;
    jmpStreamThreshold?: number;
    webidl?: {
        idlFilePath: string,
        mallocName?: string,
        freeName?: string,
    }
}

const FUNC_VAR_HEADER = "";

export class wasm2lua extends StringCompiler {
    outBuf: string[] = [];
    moduleStates: WASMModuleState[] = [];
    globalRemaps: Map<string,string>;
    globalTypes: Signature[] = [];

    registerDebugOutput = false;
    stackDebugOutput = false;
    insDebugOutput = false;

    get fileHeader() {
       let footer = fs.readFileSync(__dirname + "/../resources/fileheader_common_footer.lua").toString();
       let header = fs.readFileSync(__dirname + "/../resources/fileheader_common_header.lua").toString();
       let memLib = fs.readFileSync(this.options.pureLua ? (__dirname + "/../resources/fileheader_lua.lua") : (__dirname + "/../resources/fileheader_ffi.lua")).toString();

       return `${header}${memLib}${footer}`;
    }

    static get fileFooter() {
       return fs.readFileSync(__dirname + "/../resources/filefooter.lua").toString();
    }

    static get binderHeader() {
       return fs.readFileSync(__dirname + "/../resources/binderheader.lua").toString();
    }

    static get wasiModule() {
       return fs.readFileSync(__dirname + "/../resources/wasilib.lua").toString();
    }

    private program_ast: Program;

    constructor(private program_binary: Buffer, private options: WASM2LuaOptions = {}) {
        super();

        if (options.compileFlags == null) {
            options.compileFlags = [];
        }

        if (typeof options.heapBase !== "string") {
            options.heapBase = "__GLOBALS__[0]";
        }

        if (typeof options.jmpStreamThreshold !== "number") {
            options.jmpStreamThreshold = 8000;
        }

        this.program_ast = decode(program_binary,{
            // dump: true,
        });

        this.process()
    }

    assert(cond: any,err: string = "assertion failed") {
        if(!cond) {
            throw new Error(err);
        }
    }

    writeHeader(buf: string[]) {
        this.write(buf,this.fileHeader);
        this.newLine(buf);
    }

    writeFooter(buf: string[]) {
        this.write(buf,wasm2lua.fileFooter);
    }

    fn_freeRegisterEx(buf: string[],func: WASMFuncState,reg: VirtualRegister) {
        func.regManager.freeRegister(reg);
        if(this.registerDebugOutput) {
            this.write(buf,`--[[register ${func.regManager.getPhysicalRegisterName(reg)} (${reg.name}) freed]]`);
        }
    }

    fn_freeRegisterAddQueue(buf: string[],func: WASMFuncState,reg: VirtualRegister) {
        func.registersToBeFreed.push(reg);
        if(this.registerDebugOutput) {
            this.write(buf,`--[[register ${func.regManager.getPhysicalRegisterName(reg)} (${reg.name}) added to free-queue]]`);
        }
    }

    fn_freeRegister(buf: string[],func: WASMFuncState,reg: VirtualRegister) {
        // return this.fn_freeRegisterAddQueue(buf,func,reg);
        return this.fn_freeRegisterEx(buf,func,reg);
    }

    fn_createTempRegister(buf: string[],func: WASMFuncState) {
        let reg = func.regManager.createTempRegister();
        if(this.registerDebugOutput) {
            this.write(buf,`--[[register ${func.regManager.getPhysicalRegisterName(reg)} (temp) allocated]]`);
        }
        return reg;
    }

    fn_createPhantomRegister(buf: string[],func: WASMFuncState) {
        let reg = func.regManager.createPhantomRegister();
        if(this.registerDebugOutput) {
            this.write(buf,`--[[phantom register allocated]]`);
        }
        return reg;
    }

    fn_createNamedRegister(buf: string[],func: WASMFuncState,name: string) {
        let reg = func.regManager.createRegister(name);
        if(this.registerDebugOutput) {
            this.write(buf,`--[[register ${func.regManager.getPhysicalRegisterName(reg)} (${reg.name}) allocated]]`);
        }
        return reg;
    }

    getPushStack(func: WASMFuncState,stackExpr: string | VirtualRegister | PhantomRegister,resolveRegister?: boolean) {
        func.stackLevel++;
        if(typeof stackExpr === "string") {
            func.stackData.push(stackExpr);
        }
        else if(typeof stackExpr === "object") {
            if(resolveRegister) {
                if(stackExpr.isPhantom == true) {
                    throw new Error("Cannot resolve a phantom register unless it is virtualized");
                }
                else {
                    func.stackData.push(func.regManager.getPhysicalRegisterName(stackExpr));
                }
            }
            else {
                stackExpr.stackEntryCount++;
                func.stackData.push(stackExpr);
            }
        }
        else {
            throw new Error("`stackExpr` must be a string or VirtualRegister")
        }

        if(this.stackDebugOutput) {
            return `--[[PUSH TO ${func.stackLevel - 1}]]`;
        }
        else {
            return "";
        }
    }

    decrementStackEntry(buf: string[],func: WASMFuncState,reg: VirtualRegister | PhantomRegister,popDepsRecursively: boolean) {
        if(popDepsRecursively) {
            if(reg.isPhantom) {
                for(let subDep of reg.dependencies) {
                    this.decrementStackEntry(buf,func,subDep,true);
                }
            }
        }

        reg.stackEntryCount--;
        if(reg.stackEntryCount == 0) {
            if(reg.isPhantom == false) {
                if(typeof reg.lastRef === "number") {
                    if(func.insCountPass2 >= reg.lastRef) {
                        this.fn_freeRegister(buf,func,reg);
                    }
                }
                else {
                    this.fn_freeRegister(buf,func,reg);
                }
            }
        }
        else if(reg.stackEntryCount < 0) {
            throw new Error("just wHat")
        }
    }

    invalidateCachedExpressionsWithDependency(buf: string[],state: WASMFuncState,dependency: VirtualRegister) {
        for(let stackID=state.stackData.length - 1;stackID >= 0;stackID--) {
            let stackEntry = state.stackData[stackID];

            // invalidate all cached expressions that depend on this local
            if(typeof stackEntry === "object") {
                if(stackEntry.isPhantom) {
                    if(stackEntry.dependencies.indexOf(dependency) !== -1) {
                        let realized = state.regManager.realizePhantomRegister(stackEntry);
                        state.stackData[stackID] = realized;

                        this.writeLn(buf,`${state.regManager.getPhysicalRegisterName(realized)} = ${stackEntry.value};`);

                        for(let subDep of stackEntry.dependencies) {
                            this.decrementStackEntry(buf,state,subDep,true);
                        }
                    }
                }
            }
        }
    }

    getPop(func: WASMFuncState,popToTemp?: PhantomRegister) {
        if(func.stackLevel == 1) {
            // throw new Error("attempt to pop below zero");
            console.log("attempt to pop below zero");
            return "--[[WARNING: NEGATIVE POP]] (nil)";
        }
        
        let lastData = func.stackData.pop();
        func.stackLevel--;
        if(typeof lastData === "string") {
            if(this.stackDebugOutput) {
                return `--[[POP FROM ${func.stackLevel}]]${lastData}`;
            }
            else {
                return lastData;
            }
        }
        else if(typeof lastData === "object") {
            let buf = [];

            if(popToTemp) {
                if(lastData.isPhantom == false) {
                    popToTemp.dependencies.push(lastData);
                }
                else {
                    popToTemp.dependencies.push(...lastData.dependencies);
                }
            }
            else {
                this.decrementStackEntry(buf,func,lastData,true);
            }

            if(lastData.isPhantom == true) {
                this.write(buf,"(" + lastData.value + ")");
            }
            else {
                this.write(buf,func.regManager.getPhysicalRegisterName(lastData));
            }

            if(this.stackDebugOutput) {
                return `--[[POP FROM ${func.stackLevel}]]${buf.join("")}`;
            }
            else {
                return buf.join("");
            }
        }
        else {
            throw new Error("Could not resolve pop value");
        }
    }

    getPeek(func: WASMFuncState,n=0) {
        if(func.stackLevel-n <= 1) {
            console.log("attempt to peek below zero");
            return "--[[WARNING: NEGATIVE PEEK]] nil";
        }

        let lastData = func.stackData[func.stackData.length-n-1];

        if(typeof lastData === "string") {
            return lastData;
        }
        else if(typeof lastData === "object") {
            // only peeking, so no chance we want to free the register?
            if(lastData.isPhantom == true) {
                return "(" + lastData.value + ")";
            }
            else {
                return func.regManager.getPhysicalRegisterName(lastData);
            }
        }
        else {
            return `__STACK__[${func.stackLevel-n-1}]`;
        }
    }

    stackDrop(func: WASMFuncState) {
        this.getPop(func);
    }

    process() {
        this.writeHeader(this.outBuf);

        // Note: I'm fairly sure there can only be one `module` per wasm file.
        this.assert(this.program_ast.body.length > 0,"WASM file has no body");
        this.assert(this.program_ast.body.length == 1,"WASM file has multiple bodies");
        this.assert(this.program_ast.body[0].type == "Module","WASM file has no Module");

        let mod = this.program_ast.body[0] as Module;
        this.write(this.outBuf,"do");
        this.indent();
        this.newLine(this.outBuf);
        this.write(this.outBuf,this.processModule(mod));
        this.outdent(this.outBuf);
        this.write(this.outBuf,"end");
        this.newLine(this.outBuf);

        if(this.importedWASI) {
            this.newLine(this.outBuf);
            this.writeLn(this.outBuf,"__IMPORTS__.wasi_unstable = (function()");
            this.write(this.outBuf,wasm2lua.wasiModule);
            this.writeLn(this.outBuf,"end)()(module.memory)");
        }

        if(this.options.webidl) {
            let idl = fs.readFileSync(this.options.webidl.idlFilePath);

            let binder = new WebIDLBinder(idl.toString(),BinderMode.WEBIDL_LUA,this.options.libMode);

            binder.luaC.indent();
            binder.buildOut();
            binder.luaC.outdent();

            this.newLine(this.outBuf);
            this.writeLn(this.outBuf,`local __MALLOC__ = __FUNCS__.${this.options.webidl.mallocName || "malloc"}`);
            this.writeLn(this.outBuf,`local __FREE__ = __FUNCS__.${this.options.webidl.freeName || "free"}`);

            this.newLine(this.outBuf);
            this.write(this.outBuf,wasm2lua.binderHeader);
            
            this.newLine(this.outBuf);
            this.write(this.outBuf,"do");
            this.indent();
            this.newLine(this.outBuf);
            this.write(this.outBuf,binder.outBufLua.join(""));
            this.outdent(this.outBuf);
            this.write(this.outBuf,"end");
            this.newLine(this.outBuf);
        }

        this.newLine(this.outBuf);
        this.writeFooter(this.outBuf);
    }

    // !!!!!!IMPORTANT!!!!!!
    // The rule is, an emitting function MUST leave trailing whitespace (i.e. newlines)
    // and an emitting function does NOT have to start with .newLine()

    processModule(node: Module) {
        let buf = [];

        let state: WASMModuleState = {
            funcStates: [],
            funcByName: new Map(),
            memoryAllocations: new ArrayMap(),
            func_tables: [],

            nextGlobalIndex: 0
        };

        for(let section of node.metadata.sections) {
            this.processModuleMetadataSection(section);
        }
        
        for(let field of node.fields) {
            if(field.type == "ModuleImport") {
                this.write(buf,this.processModuleImport(field,state));
            }
        }
        
        for(let field of node.fields) {
            if(field.type == "Func") {
                this.initFunc(field,state);
            }
        }
        
        for(let field of node.fields) {
            if(field.type == "TypeInstruction") {
                this.write(buf,this.processTypeInstruction(field));
            }
            else if(field.type == "Func") {
                this.write(buf,this.processFunc(field,state));
            }
            else if(field.type == "ModuleExport") {
                // Done in 3rd pass
            }
            else if(field.type == "ModuleImport") {
                // Already done in 1st pass
            }
            else if(field.type == "Start") {
                // Done in 4th pass
            }
            else if (field.type == "Table") {
                // TODO
            }
            else if (field.type == "Memory") {
                let memID;
                if(field.id) {
                    if(field.id.type == "NumberLiteral") {
                        memID = "mem_" + field.id.value;
                    }
                    else {
                        memID = field.id.value;
                    }
                    state.memoryAllocations.set(field.id.value,memID);
                }
                else {
                    memID = "mem_u" + state.memoryAllocations.numSize;
                    state.memoryAllocations.push(memID);
                }

                if (field.limits.max != null) {
                    this.write(buf,"local " + memID + " = __MEMORY_ALLOC__(" + field.limits.min + ", " + field.limits.max + ");");
                } else {
                    this.write(buf,"local " + memID + " = __MEMORY_ALLOC__(" + field.limits.min + ");");
                }

                this.newLine(buf);

                if((field.id.value == 0) || (memID == "mem_0")) {
                    this.writeLn(buf,`module.memory = ${memID}`);
                }
            }
            else if (field.type == "Global") {
                this.write(buf,"do");

                this.indent();
                this.newLine(buf);

                this.writeLn(buf,FUNC_VAR_HEADER);
                
                // :thonk:
                let global_init_state: WASMFuncState = {
                    id: "__GLOBAL_INIT__", 
                    origID: "__GLOBAL_INIT__", 
                    locals: [],
                    localTypes: [],
                    blocks: [],
                    regManager: new VirtualRegisterManager(),
                    insLastRefs: [],
                    insLastAssigned: [],
                    registersToBeFreed: [],
                    insCountPass1: 0,
                    insCountPass2: 0,
                    insCountPass1LoopLifespanAdjs: new Map(),
                    forceVarInit: new Map(),
                    stackData: [],
                    stackLevel: 1,
                    hasSetjmp: false,
                    setJmps: [],
                    labels: new Map(),
                    labelsByIns: [],
                    gotos: [],
                    jumpStreamEnabled: false,
                    curJmpID: 0,
                    usedLabels: {},
                };

                this.processInstructionsPass1(field.init,global_init_state)
                this.write(buf,this.processInstructionsPass2(field.init,global_init_state));
                this.writeEx(buf,this.processInstructionsPass3(field.init,global_init_state),-1);

                this.write(buf,"__GLOBALS__["+state.nextGlobalIndex+"] = "+this.getPop(global_init_state)+";");

                this.outdent(buf);

                this.newLine(buf);

                this.write(buf,"end");
                this.newLine(buf);

                state.nextGlobalIndex++;
            }
            else if (field.type == "Elem") {
                let table_index = field.table.value;

                if (state.func_tables[table_index] == null) {
                    state.func_tables[table_index] = [];
                    this.write(buf,`local __TABLE_FUNCS_${table_index}__ = {};`);
                    this.newLine(buf);
                }
                let sub_index = state.func_tables[table_index].length;

                this.write(buf,`local __TABLE_OFFSET_${table_index}_${sub_index}__ = {};`);
                this.newLine(buf);

                this.write(buf,"do");

                this.indent();
                this.newLine(buf);

                this.writeLn(buf,FUNC_VAR_HEADER);
                
                // :thonk:
                let global_init_state: WASMFuncState = {
                    id: "__TABLE_INIT__", 
                    origID: "__TABLE_INIT__", 
                    locals: [],
                    localTypes: [],
                    regManager: new VirtualRegisterManager(),
                    registersToBeFreed: [],
                    insCountPass1: 0,
                    insCountPass2: 0,
                    insCountPass1LoopLifespanAdjs: new Map(),
                    forceVarInit: new Map(),
                    insLastAssigned: [],
                    insLastRefs: [],
                    blocks: [],
                    stackData: [],
                    stackLevel: 1,
                    hasSetjmp: false,
                    setJmps: [],
                    labels: new Map(),
                    labelsByIns: [],
                    gotos: [],
                    jumpStreamEnabled: false,
                    curJmpID: 0,
                    usedLabels: {},
                };

                this.processInstructionsPass1(field.offset,global_init_state)
                this.write(buf,this.processInstructionsPass2(field.offset,global_init_state));
                this.writeEx(buf,this.processInstructionsPass3(field.offset,global_init_state),-1);

                // bias the table offset so we can just use lua table indexing like lazy bastards
                this.write(buf,`__TABLE_OFFSET_${table_index}_${sub_index}__ = 1 + `+this.getPop(global_init_state)+";");
                this.newLine(buf);

                this.outdent(buf);
                this.newLine(buf);

                this.write(buf,"end");
                this.newLine(buf);

                state.func_tables[table_index].push( field.funcs );
            }
            else if (field.type == "Data") {
                if(field.memoryIndex && field.memoryIndex.type == "NumberLiteral") {
                    this.write(buf,"__MEMORY_INIT__(mem_"+field.memoryIndex.value+",");
                } else {
                    throw new Error("Bad index on memory.");
                }

                // this might not be correct in all cases but it probably isn't important
                if(field.offset && field.offset.type == "Instr" && field.offset.id == "const") {
                    let value = field.offset.args[0];
                    if (value.type == "NumberLiteral") {
                        this.write(buf,value.value+",");
                    }
                } else if(field.offset && field.offset.type == "Instr" && field.offset.id == "get_global") {
                    this.write(buf,"__GLOBALS__["+(field.offset.args[0] as NumberLiteral).value+"],");
                } else {
                    throw new Error("Bad offset on memory: "+JSON.stringify(field.offset));
                }

                this.write(buf,makeBinaryStringLiteral(field.init.values)+");");
                this.newLine(buf);
            }
            else {
                throw new Error("TODO - Module Section - " + field.type);
            }
        }

        if (this.options.whitelist!=null) {
            this.options.whitelist.forEach((whitelist_name)=>{
                this.write(buf,`__EXPORTS__.${whitelist_name} = ${whitelist_name}`);
                this.newLine(buf);
            });
        }

        // Process function tables
        state.func_tables.forEach((table,table_index) => {
            table.forEach((sub_table,sub_index)=>{
                let offset_var = `__TABLE_OFFSET_${table_index}_${sub_index}__`;

                sub_table.forEach((func_index,n)=>{
                    let fstate = this.getFuncByIndex(state,func_index);
                    if (!fstate) {
                        throw new Error("Unresolved table entry #"+func_index);
                    }

                    this.write(buf,`__TABLE_FUNCS_${table_index}__[${offset_var}+${n}] = ${fstate.id};`);
                    this.newLine(buf);
                });
            });

            /*this.write(buf,`__TABLE_FUNCS_${table_index}__ = {`);
            let func_ids = table.map((func_index) => {
                let fstate = this.getFuncByIndex(state,func_index);
                if (!fstate) {
                    throw new Error("Unresolved table entry #"+func_index);
                }
                return fstate.id;
            });
            this.write(buf,func_ids.join(","));
            this.write(buf,"};");
            this.newLine(buf);*/
        });
        
        for(let field of node.fields) {
            if(field.type == "ModuleExport") {
                this.write(buf,this.processModuleExport(field,state));
            }
        }
        
        this.newLine(buf);
        this.write(buf,"function module.init()");
        this.indent();
        this.newLine(buf);
        for(let field of node.fields) {
            if(field.type == "Start") {
                let fstate = this.getFuncByIndex(state,field.index);
                if(fstate) {
                    this.write(buf,`${fstate.id}()`);
                    if(fstate.funcType && (fstate.funcType.params.length > 0)) {
                        this.write(buf," -- WARNING: COULDN'T FIGURE OUT WHAT ARGUMENT TO PASS IN");
                    }
                }
                else {
                    this.write(buf,"error('could not find start function')")
                }
                this.newLine(buf);
            }
        }
        if(this.importedWASI) {
            this.writeLn(buf,"module.exports._start()");
        }
        this.outdent(buf);
        this.write(buf,"end");
        this.newLine(buf);

        return buf.join("");
    }

    processModuleMetadataSection(node: SectionMetadata) {
        // In case we need to yoink out custom sections in the future.
        // I thought this was needed now but it isn't.
        /*if (node.section=="custom") {
            let start = node.startOffset;
            let length = node.size.value;

            let custom_binary = this.program_binary.slice(start,start+length);
            console.log("CUSTOM SECTION",custom_binary.toString());
        }*/
        return "";
    }

    processTypeInstruction(node: TypeInstruction) {
        this.globalTypes.push(node.functype);
        return "";
    }

    getFuncByIndex(modState: WASMModuleState, index: Index) {
        if(index.type == "NumberLiteral") {
            if(modState.funcByName.get(`func_${index.value}`)) {
                return modState.funcByName.get(`func_${index.value}`);
            }
            else if(modState.funcByName.get(`func_u${index.value}`)) {
                return modState.funcByName.get(`func_u${index.value}`);
            } else {
                return modState.funcStates[index.value] || false;
            }
        }
        else {
            return modState.funcByName.get(index.value) || false;
        }

        return false;
    }

    initFunc(node: Func | {signature: Signature,name: {value: string}}, state: WASMModuleState,renameTo?: string,betterName?: string) {
        let funcType: Signature;
        if(node.signature.type == "Signature") {
            funcType = node.signature;
        }

        let funcID;
        if(typeof node.name.value === "string") {
            funcID = node.name.value;
        }
        else if(typeof node.name.value === "number") {
            funcID = "func_" + node.name.value;
        }
        else {
            funcID = "func_" + state.funcStates.length;
        }

        let fstate: WASMFuncState = {
            id: renameTo ? renameTo : "__FUNCS__."+sanitizeIdentifier(funcID),
            origID: betterName || funcID,
            regManager: new VirtualRegisterManager(),
            registersToBeFreed: [],
            insLastAssigned: [],
            insLastRefs: [],
            insCountPass1: 0,
            insCountPass2: 0,
            insCountPass1LoopLifespanAdjs: new Map(),
            forceVarInit: new Map(),
            locals: [],
            localTypes: funcType.params.map((x)=>x.valtype),
            blocks: [],
            funcType,
            modState: state,
            stackData: [],
            stackLevel: 1,
            hasSetjmp: false,
            setJmps: [],
            labels: new Map(),
            labelsByIns: [],
            gotos: [],
            jumpStreamEnabled: false,
            curJmpID: 0,
            usedLabels: {},
        };

        state.funcStates.push(fstate);
        state.funcByName.set(funcID,fstate);

        return fstate;
    }

    forEachVar(state: WASMFuncState,cb: (vname: string,isVirtual: boolean) => void) {
        let hasVars = false;
        if(state.regManager.virtualDisabled) {
            let seen = {};
            for(let i=(state.funcType ? state.funcType.params.length : 0);i < state.regManager.registerCache.length;i++) {
                let reg = state.regManager.registerCache[i];
                let name = state.regManager.getPhysicalRegisterName(reg);
                if(seen[name]) {continue;}
                seen[name] = true;
                hasVars = true;
                cb(name,false);
            }
        }
        else if((state.regManager.totalRegisters - (state.funcType ? state.funcType.params.length : 0)) > 0) {
            for(let i=(state.funcType ? state.funcType.params.length : 0);i < state.regManager.totalRegisters;i++) {
                hasVars = true;
                if(i >= VirtualRegisterManager.MAX_REG) {
                    cb(`vreg[${i}]`,true);
                }
                else {
                    cb(`reg${i}`,false);
                }
            }
        }
        return hasVars;
    }

    forEachVarIncludeParams(state: WASMFuncState,cb: (vname: string,isVirtual: boolean) => void) {
        let hasVars = false;

        for (let i = 0; i < state.funcType.params.length; i++) {
            cb(`reg${i}`,false);
        }

        hasVars = hasVars || this.forEachVar(state,cb);

        return hasVars;
    }

    doneFunctions: {[funcID: string]: boolean} = {};
    processFunc(node: Func,modState: WASMModuleState) {
        let buf = [];
        if(node.signature.type == "NumberLiteral") {
            if(!this.globalTypes[node.signature.value]) {
                this.write(buf,"-- WARNING: Function type signature read failed (1)");
                this.newLine(buf);
            }
        }
        else if(node.signature.type !== "Signature") {
            this.write(buf,"-- WARNING: Function type signature read failed (2)");
            this.newLine(buf);
        }

        let state = modState.funcByName.get(typeof node.name.value === "string" ? node.name.value : "func_u" + modState.funcStates.length);
        if(!state) {state = this.initFunc(node,modState);}

        if(this.doneFunctions[state.id]) {
            console.log(`Warning: duplicate WASM function ${state.id} ignored`)
            return "";
        }
        this.doneFunctions[state.id] = true;

        state.stackLevel = 1;
        this.getAllFuncCallsTo(node.body,state,"setjmp",state.setJmps);
        state.hasSetjmp = state.setJmps.length > 0;

        this.write(buf,"function ");
        this.write(buf,state.id);
        if(state.hasSetjmp) {this.write(buf,"__setjmp_internal");}
        this.write(buf,"(");

        // don't generate code for non-whitelisted functions
        if (this.options.whitelist != null && this.options.whitelist.indexOf(node.name.value+"") == -1) {
            if (state.id == "__W2L__WRITE_NUM") {
                this.write(buf,`a) print(a) end`);
            } else if (state.id == "__W2L__WRITE_STR") {
                this.write(buf,`a) local str="" while mem_0[a]~=0 do str=str..string.char(mem_0[a]) a=a+1 end print(str) end`);
            } else {
                this.write(buf,`) print("!!! PRUNED: ${state.id}") end`);
            }
            this.newLine(buf);
            return buf.join("");
        }

        if(state.hasSetjmp) {
            this.write(buf,"__setjmp_data__");

            if(node.signature.type == "Signature") {
                if(node.signature.params.length > 0) {
                    this.write(buf,",");
                }
            }
        }

        if(node.signature.type == "Signature") {
            let i = 0;
            for(let param of node.signature.params) {
                let reg = this.fn_createNamedRegister(buf,state,`arg${i}`);
                state.locals[i] = reg;
                this.write(buf,state.regManager.getPhysicalRegisterName(reg));

                if((i+1) !== node.signature.params.length) {
                    this.write(buf,", ");
                }
                i++;
            }
        }
        else {
            throw new Error("TODO " + node.signature.type);
        }

        this.write(buf,")");

        this.indent();
        this.newLine(buf);
        
        this.writeLn(buf,FUNC_VAR_HEADER);

        this.processInstructionsPass1(node.body,state)
        for(let jmpData of state.gotos) {
            let labelSrc = state.labels.get(jmpData.label);
            if(typeof labelSrc !== "undefined") {
                if(Math.abs(labelSrc.ins - jmpData.ins) > this.options.jmpStreamThreshold) {
                    state.jumpStreamEnabled = true;
                    state.curJmpID = 0;
                    this.writeLn(buf,"local __nextjmp");
                    state.labelsByIns.sort((a,b) => {
                        return b[0] - a[0];
                    });
                    break;
                }
            }
        }
        this.write(buf,this.processInstructionsPass2(node.body,state));
        this.writeEx(buf,this.processInstructionsPass3(node.body,state),-1);

        if(state.hasSetjmp) {
            // setjmp xpcall barrier
            let buf2 = [];

            this.write(buf2,"if __setjmp_data__ then");
            this.indent();
            this.newLine(buf2);

            this.writeLn(buf2,`${this.options.heapBase} = __setjmp_data__.heapBase;`);

            let hasVars = this.forEachVarIncludeParams(state,(varName) => {
                this.write(buf2,`${varName}`);
                this.write(buf2,",");
            })
            if(hasVars) {
                buf2.pop(); // get rid of trailing comma
                this.write(buf2," = ");
                this.forEachVarIncludeParams(state,(varName,virtual) => {
                    if(virtual) {
                        this.write(buf2,`__setjmp_data__.data.${varName.replace(/[\[\]]/g,"")}`);
                    }
                    else {
                        this.write(buf2,`__setjmp_data__.data.${varName}`);
                    }
                    this.write(buf2,",");
                });
                buf2.pop(); // get rid of trailing comma again
                this.write(buf2,";");
            }

            this.newLine(buf2);
            this.write(buf2,"if ")
            let i = 0;
            for(let jmpCall of state.setJmps) {
                this.write(buf2,`__setjmp_data__.target == "jmp_${sanitizeIdentifier(jmpCall.loc.start.line)}_${sanitizeIdentifier(jmpCall.loc.start.column)}" then `);
                this.write(buf2,`goto jmp_${sanitizeIdentifier(jmpCall.loc.start.line)}_${sanitizeIdentifier(jmpCall.loc.start.column)}`);
                if((i + 1) !== state.setJmps.length) {
                    this.newLine(buf2);
                    this.write(buf2,"elseif");
                }
                i++;
            }
            this.newLine(buf2);
            this.write(buf2,"else __setjmp_data__.unresolved = true error(__setjmp_data__) end");
            this.outdent();
            this.newLine(buf2);
            this.write(buf2,"end");
            this.newLine(buf2);

            this.writeEx(buf,buf2.join(""),-1); // write before all opcodes but not register header
        }

        this.endAllBlocks(buf,state);
        
        if(state.stackLevel > 1) {
            this.write(buf,"do return ");

            let nRets = state.funcType ? state.funcType.results.length : 0;
            for(let i=0;i < nRets;i++) {
                this.write(buf,this.getPop(state));
                if(nRets !== (i + 1)) {
                    this.write(buf,",");
                }
            }

            this.write(buf,"; end;");
            this.newLine(buf);
        }

        this.outdent(buf);

        this.write(buf,"end");
        this.newLine(buf);

        if(state.hasSetjmp) {
            this.newLine(buf);
            this.write(buf,"function ");
            this.write(buf,state.id);
            this.write(buf,"(");

            let argBuf = [];
            if(node.signature.type == "Signature") {
                let i = 0;
                for(let param of node.signature.params) {
                    let reg = this.fn_createNamedRegister(argBuf,state,`arg${i}`);
                    state.locals[i] = reg;
                    this.write(argBuf,state.regManager.getPhysicalRegisterName(reg));
    
                    if((i+1) !== node.signature.params.length) {
                        this.write(argBuf,", ");
                    }
                    i++;
                }
            }
            this.write(buf,argBuf.join(""));
            this.write(buf,")");

            this.indent();
            this.newLine(buf);
            
            this.write(buf,"local setjmpState;");
            this.newLine(buf);
            this.write(buf,"::start::");
            this.newLine(buf);

            this.write(buf,"local suc,");
            let nRets = Math.max(1,state.funcType ? state.funcType.results.length : 0);
            for(let i=0;i < nRets;i++) {
                this.write(buf,`ret${i}`);
                if (i<nRets-1) {
                    this.write(buf,",");
                }
            }
            this.write(buf," = ");

            this.write(buf,"pcall(")
            this.write(buf,state.id);
            this.write(buf,"__setjmp_internal,setjmpState")
            if(argBuf.length > 0) {
                this.write(buf,",");
                this.write(buf,argBuf.join(""));
            }
            this.writeLn(buf,");");

            this.write(buf,`if not suc and (type(ret0) == "table") then`);
            this.indent()
            this.newLine(buf);
            this.write(buf,`if ret0.unresolved then`);
            this.indent()
            this.newLine(buf);
            this.write(buf,"ret0.unresolved = false; error(ret0)")
            this.outdent();
            this.newLine(buf)
            this.writeLn(buf,"end")
            this.writeLn(buf,"setjmpState = ret0;");
            this.write(buf,"goto start;");
            this.outdent();
            this.newLine(buf)
            this.writeLn(buf,"elseif not suc then return error(ret0) end");
            
            this.write(buf,"return ")
            for(let i=0;i < nRets;i++) {
                this.write(buf,`ret${i}`);
            }

            this.outdent();
            this.newLine(buf);
            this.writeLn(buf,"end");
        }

        return buf.join("");
    }

    static instructionBinOpRemap: {[key: string] : {op: string, bool_result?: boolean, unsigned?: boolean}} = {
        add: {op:"+"},
        sub: {op:"-"},
        mul: {op:"*"},
        div: {op:"/"},

        eq: {op:"==",bool_result:true},
        ne: {op:"~=",bool_result:true},

        lt: {op:"<",bool_result:true},
        le: {op:"<=",bool_result:true},
        ge: {op:">=",bool_result:true},
        gt: {op:">",bool_result:true},

        lt_s: {op:"<",bool_result:true},
        le_s: {op:"<=",bool_result:true},
        ge_s: {op:">=",bool_result:true},
        gt_s: {op:">",bool_result:true},

        lt_u: {op:"<",bool_result:true,unsigned:true},
        le_u: {op:"<=",bool_result:true,unsigned:true},
        ge_u: {op:">=",bool_result:true,unsigned:true},
        gt_u: {op:">",bool_result:true,unsigned:true},
    };

    static instructionBinOpFuncRemap = {
        // binary
        and: "bit_band",
        or: "bit_bor",
        xor: "bit_bxor",
        shl: "bit_lshift",
        shr_u: "bit_rshift", // logical shift
        shr_s: "bit_arshift", // arithmetic shift
        rotl: "bit_rol",
        rotr: "bit_ror",

        // division
        div_s: "__DIVIDE_S__",
        div_u: "__DIVIDE_U__",
        rem_s: "__MODULO_S__",
        rem_u: "__MODULO_U__",

        // unary
        clz: "__CLZ__",
        ctz: "__CTZ__",
        popcnt: "__POPCNT__",

        // floating point
        sqrt: "math_sqrt",
        nearest: "__FLOAT__.nearest",
        trunc: "__FLOAT__.truncate",
        floor: "math_floor",
        ceil: "math_ceil",
        abs: "math_abs",
        copysign: "__FLOAT__.copysign",

        min: "__FLOAT__.min",
        max: "__FLOAT__.max"

    };

    writeLabel(buf: string[],label: string,state: WASMFuncState) {
        if(state.jumpStreamEnabled) {
            let jmpID = state.curJmpID++;
            if(jmpID == 0) {
                this.write(buf,`goto ${label} ::jmpstream_${jmpID}:: if __nextjmp ~= ${jmpID} then goto jmpstream_${jmpID + 1} end ::${label}::`);
            }
            else if((jmpID+1) == state.labels.size) {
                this.write(buf,`goto ${label} ::jmpstream_${jmpID}:: if __nextjmp ~= ${jmpID} then goto jmpstream_${jmpID - 1} end ::${label}::`);
            }
            else {
                this.write(buf,`goto ${label} ::jmpstream_${jmpID}:: if __nextjmp > ${jmpID} then goto jmpstream_${jmpID + 1} elseif __nextjmp < ${jmpID} then goto jmpstream_${jmpID - 1} end ::${label}::`);
            }
        }
        else if(state.usedLabels[label]) {
            this.write(buf,`::${label}::`);
        }
    }

    writeGoto(buf: string[],label: string,state: WASMFuncState) {
        if(state.jumpStreamEnabled) {
            let target = state.labels.get(label);

            if(Math.abs(target.ins - state.insCountPass2) > this.options.jmpStreamThreshold) {
                let closestTargetID: number;
                let closestTargetIns = Infinity;

                if(target.ins > state.insCountPass2) {
                    for(let i=target.rid;i >= 0;i--) {
                        let nextT = state.labelsByIns[i];

                        if((nextT[0] - state.insCountPass2) < JMPSTREAM_INS_GAP) {
                            closestTargetID = i;
                            closestTargetIns = nextT[0];
                            break;
                        }
                    }
                }
                else {
                    for(let i=target.rid;i < state.labelsByIns.length;i++) {
                        let nextT = state.labelsByIns[i];

                        if((state.insCountPass2 - nextT[0]) < JMPSTREAM_INS_GAP) {
                            closestTargetID = i;
                            closestTargetIns = nextT[0];
                            break;
                        }
                    }
                }

                if(closestTargetIns == Infinity) {
                    console.error("Couldn't resolve jump dest in " + state.id);
                }
    
                this.write(buf,`__nextjmp = ${target.id} goto jmpstream_${closestTargetID}`);
            }
            else {
                this.write(buf,`goto ${label}`);
            }
        }
        else {
            this.write(buf,`goto ${label}`);
        }
    }

    beginBlock(buf: string[],state: WASMFuncState,block: WASMBlockState,customStart?: string,pass1LabelStore?: boolean) {
        // BLOCK BEGINS MUST BE CLOSED BY BLOCK ENDS!!!!
        state.blocks.push(block);
        if(typeof customStart === "string") {
            this.newLine(buf);
            this.write(buf,customStart);
            this.write(buf," ");
        } else if ((block.blockType == "loop") && !state.jumpStreamEnabled && !state.hasSetjmp) {
            this.newLine(buf);
            this.write(buf,"while true do");
            this.write(buf," ");
        }
        this.writeLabel(buf,`${sanitizeIdentifier(block.id)}_start`,state);
        if(pass1LabelStore) {
            state.labels.set(`${sanitizeIdentifier(block.id)}_start`,{ins: state.insCountPass1,id: state.labels.size,rid: state.labelsByIns.length});
            state.labelsByIns.push([state.insCountPass1,`${sanitizeIdentifier(block.id)}_start`]);
        }
        this.indent();
        this.newLine(buf);
        return block;
    }

    endAllBlocks(buf: string[],state: WASMFuncState) {
        while(state.blocks.length > 0) {
            this.endBlock(buf,state);
        }
    }

    endBlocksUntil(buf: string[],state: WASMFuncState,tgtBlock: WASMBlockState) {
        if(tgtBlock.hasClosed) {return;}

        while(state.blocks.length > 0) {
            if(state.blocks[state.blocks.length - 1] == tgtBlock) {break;}

            this.endBlock(buf,state);
        }
    }

    endBlocksUntilEx(buf: string[],state: WASMFuncState,tgtBlock: WASMBlockState) {
        if(tgtBlock.hasClosed) {return;}
        
        while(state.blocks.length > 0) {
            this.endBlock(buf,state);

            if(state.blocks[state.blocks.length - 1] == tgtBlock) {break;}
        }
    }

    endBlock(buf: string[],state: WASMFuncState,pass1LabelStore?: boolean,unreachable?: boolean) {

        let block = state.blocks.pop();
        if(block) {
            this.endBlockInternal(buf,block,state,pass1LabelStore == true,unreachable == true);

            if(state.stackLevel > (block.resultType === null ? block.enterStackLevel : block.enterStackLevel + 1)) {
                this.writeLn(buf,"-- WARNING: a block as popped extra information into the stack.")
            }

            return true;
        }

        return false;
    }

    endBlockInternal(buf: string[],block: WASMBlockState,state: WASMFuncState,pass1LabelStore: boolean,unreachable: boolean) {
        block.hasClosed = true;
        
        if(block.resultType !== null) {
            if(unreachable) {
                this.write(buf,state.regManager.getPhysicalRegisterName(block.resultRegister) + " = error('unreachable')");
            }
            else {
                this.write(buf,state.regManager.getPhysicalRegisterName(block.resultRegister) + " = " + this.getPop(state));
            }
            this.newLine(buf);
        }
        
        // reset stack to normal layout
        let popCnt = state.stackLevel - block.enterStackLevel;
        for(let i=0;i < popCnt;i++) {
            this.getPop(state);
        }

        // push the return value
        if(block.resultType !== null) {
            this.writeLn(buf,"-- BLOCK RET ("+block.blockType+"):");
            this.writeLn(buf,this.getPushStack(state,block.resultRegister));
        }
        
        if ((block.blockType == "loop") && !state.jumpStreamEnabled && !state.hasSetjmp) {
            this.write(buf,"break");
            this.newLine(buf);
            this.outdent(buf);
            this.write(buf,"end");
            this.newLine(buf);
        } else {
            this.outdent(buf);
        }
        if(pass1LabelStore) {
            if(state.labels.get(`${sanitizeIdentifier(block.id)}_fin`)) {
                throw "what";
            }
            state.labels.set(`${sanitizeIdentifier(block.id)}_fin`,{ins: state.insCountPass1,id: state.labels.size,rid: state.labelsByIns.length});
            state.labelsByIns.push([state.insCountPass1,`${sanitizeIdentifier(block.id)}_fin`]);
        }
        this.writeLabel(buf,`${sanitizeIdentifier(block.id)}_fin`,state);
        this.newLine(buf);
    }

    startElseSubBlock(buf: string[], block: WASMBlockState, state: WASMFuncState, pass1LabelStore?: boolean) {
        // TODO: is this right?
        // originally this was uncommented, but that doesn't make sense.
        // dont we assign the return to here AFTER the else block ends?

        // cogg: Yes, this is correct. Both the if and else sub-blocks need to assign to the output register.
        // Part of this function's job is to end the "if" sub-block. This is kind-of a crummy way to do this, but it seems to work.
        // I wanted to use actual blocks for if/else, but it seemed like it would only make things more complicated.
        if(block.resultType !== null) {
            this.write(buf,state.regManager.getPhysicalRegisterName(block.resultRegister) + " = " + this.getPop(state));
            this.newLine(buf);
        }
        
        // reset stack to normal layout
        let popCnt = state.stackLevel - block.enterStackLevel;
        for(let i=0;i < popCnt;i++) {
            this.getPop(state);
        }
        
        this.outdent(buf);
        this.writeGoto(buf,`${sanitizeIdentifier(block.id)}_fin`,state);
        this.newLine(buf);
        this.writeLabel(buf,`${sanitizeIdentifier(block.id)}_else`,state);
        this.indent();
        this.newLine(buf);
        
        if(pass1LabelStore) {
            if(state.labels.get(`${sanitizeIdentifier(block.id)}_else`)) {
                throw "what";
            }
            state.labels.set(`${sanitizeIdentifier(block.id)}_else`,{ins: state.insCountPass1,id: state.labels.size,rid: state.labelsByIns.length});
            state.labelsByIns.push([state.insCountPass1,`${sanitizeIdentifier(block.id)}_else`]);

            state.gotos.push({ins: state.insCountPass1,label: `${sanitizeIdentifier(block.id)}_fin`});
        }
    }

    writeBranch(buf: string[], state: WASMFuncState, blocksToExit: number) {
        let targetBlock = state.blocks[state.blocks.length - blocksToExit - 1];
        let currentBlock = state.blocks[state.blocks.length - 1];

        if(targetBlock) {
            // loops jump to the start, others jump to the end
            if(targetBlock.blockType == "loop") {
                this.writeGoto(buf,sanitizeIdentifier(`${targetBlock.id}_start`),state);
            }
            else {
                if(targetBlock.resultType !== null) {
                    this.write(buf,state.regManager.getPhysicalRegisterName(targetBlock.resultRegister) + " = " + this.getPeek(state)+ "; ");
                }

                this.writeGoto(buf,sanitizeIdentifier(`${targetBlock.id}_fin`),state);
            }
        }
        else if (blocksToExit == state.blocks.length) {
            this.writeReturn(buf,state); // wtf is the trash
        } else {
            this.write(buf,"goto ____UNRESOLVED_DEST____");
        }

        this.write(buf,";");
    }

    simulateBranch(state: WASMFuncState, blocksToExit: number) {
        let targetBlock = state.blocks[state.blocks.length - blocksToExit - 1];

        if(targetBlock) {
            if(targetBlock.blockType == "loop") {
                state.usedLabels[`${sanitizeIdentifier(targetBlock.id)}_start`] = true;
                state.gotos.push({ins: state.insCountPass1,label: `${sanitizeIdentifier(targetBlock.id)}_start`});
            }
            else {
                state.usedLabels[`${sanitizeIdentifier(targetBlock.id)}_fin`] = true;
                state.gotos.push({ins: state.insCountPass1,label: `${sanitizeIdentifier(targetBlock.id)}_fin`});
            }
        }
        else if (blocksToExit == state.blocks.length) {
            // no-op in this context
        }
        else {
            console.log("Warning: unresolved branch jump destination")
        }
    }

    writeReturn(buf: string[], state: WASMFuncState) {
        this.write(buf,"do return ");

        let nRets = state.funcType ? state.funcType.results.length : 0;
        for(let i=0;i < nRets;i++) {
            this.write(buf,this.getPeek(state,i));
            if(nRets !== (i + 1)) {
                this.write(buf,",");
            }
        }

        this.write(buf," end");
    }

    getLastLoop(state: WASMFuncState) {
        for(let i=state.blocks.length - 1;i >= 0;i--) {
            if(state.blocks[i].blockType == "loop") {
                return state.blocks[i];
            }
        }

        return false;
    }

    getAllFuncCallsTo(insArr: Instruction[],state: WASMFuncState,funcName: string,out: CallInstruction[]) {
        for(let ins of insArr) {
            switch(ins.type) {
                case "CallInstruction": {
                    let fstate = this.getFuncByIndex(state.modState,ins.index);
                    if((fstate && fstate.origID == funcName) || (ins.index.value == funcName)) {
                        out.push(ins)
                    }
                    break;
                }
                case "BlockInstruction":
                case "LoopInstruction": {
                    this.getAllFuncCallsTo(ins.instr,state,funcName,out)

                    break;
                }
                case "IfInstruction": {
                    this.getAllFuncCallsTo(ins.consequent,state,funcName,out)
                    
                    if(ins.alternate.length > 0) {
                        this.getAllFuncCallsTo(ins.alternate,state,funcName,out)
                    }

                    break;
                }
            }
        }
    }

    processInstructionsPass1(insArr: Instruction[],state: WASMFuncState) {
        // PASS 1: compute local variable bounds to convert them into efficient virtual registers
        //////////////////////////////////////////////////////////////

        for(let ins of insArr) {
            state.insCountPass1++;

            switch(ins.type) {
                case "Instr": {
                    switch(ins.id) {
                        case "local": {
                            // record local types here
                            ins.args.forEach((arg)=> {
                                if (arg.type=="ValtypeLiteral") {
                                    state.localTypes.push(arg.name);
                                } else {
                                    throw new Error("Bad type???");
                                }
                            });
                            break;
                        }
                        case "get_local": {
                            let locID = (ins.args[0] as NumberLiteral).value;
                            state.insLastRefs[locID] = state.insCountPass1;

                            let data = state.insLastAssigned[locID];
                            if(data == null && (locID >= (state.funcType ? state.funcType.params.length : 0)) ) {
                                // force initialization

                                let forceInitIns = state.insCountPass1;

                                // need to hoist init out of ALL loops.
                                // find the _first_ (least nested) loop.
                                for (let i=0;i<state.blocks.length;i++) {
                                    if(state.blocks[i].blockType == "loop") {
                                        forceInitIns = state.blocks[i].insCountStart;
                                        break;
                                    }
                                }

                                if (state.forceVarInit.get(forceInitIns) == null) {
                                    state.forceVarInit.set(forceInitIns,[]);
                                }

                                state.forceVarInit.get(forceInitIns).push(locID);
                            }

                            // Extend lifetime of variables that are accessed before assignment in loops.

                            // cogg: In many cases we can't know if a local has been assigned to.
                            // Lifetime will now only end in a loop if the previous assignment occurred
                            // directly within the loop. Sub-blocks are bad news because they can be exited
                            // before they reach the assignment. You could add some analysis for this, but
                            // it would be complicated and easy to make mistakes that would break lifetimes again.
                            // This is obviously sub-par but I don't think there are any better options without
                            // much better dataflow analysis. I myself am a advocate of FULL LUXURY GAY SPACE SSA IR,
                            // but there are probably better things to spend our time on.
                            let lastLoop = this.getLastLoop(state);
                            if(lastLoop && (data == null || lastLoop !== data[1])) {
                                if(!state.insCountPass1LoopLifespanAdjs.get(locID)) {
                                    state.insCountPass1LoopLifespanAdjs.set(locID,lastLoop);
                                }
                            }
                            
                            break;
                        }
                        case "set_local": {
                            let locID = (ins.args[0] as NumberLiteral).value;
                            state.insLastRefs[locID] = state.insCountPass1;
                            state.insLastAssigned[locID] = [state.insCountPass1, state.blocks[state.blocks.length-1]]
                            
                            break;
                        }
                        case "tee_local": {
                            let locID = (ins.args[0] as NumberLiteral).value;
                            state.insLastRefs[locID] = state.insCountPass1;
                            state.insLastAssigned[locID] = [state.insCountPass1, state.blocks[state.blocks.length-1]]
                            
                            break;
                        }
                        case "br_if":
                        case "br": {
                            this.simulateBranch(state, (ins.args[0] as NumberLiteral).value);

                            break;
                        }
                        case "br_table": {
                            ins.args.forEach((target,i)=>{
                                this.simulateBranch(state, (target as NumberLiteral).value);
                            });
                            break;
                        }
                        case "end": {
                            this.endBlock([],state,true);
                            break;
                        }
                    }
                    break;
                }
                case "BlockInstruction":
                case "LoopInstruction": {
                    let blockType: "loop"|"block" = (ins.type == "LoopInstruction") ? "loop" : "block";

                    let block = this.beginBlock([],state,{
                        id: `${blockType}_${state.insCountPass1}`,
                        resultType: null, 
                        blockType,
                        enterStackLevel: state.stackLevel,
                        insCountStart: state.insCountPass1,
                    },null,true);

                    this.processInstructionsPass1(ins.instr,state)

                    if(block.blockType === "loop") {
                        for(let deferredVals of state.insCountPass1LoopLifespanAdjs) {
                            if(deferredVals[1] == block) {
                                state.insLastRefs[deferredVals[0]] = state.insCountPass1;
                                state.insCountPass1LoopLifespanAdjs.delete(deferredVals[0]);
                            }
                        }
                    }

                    break;
                }
                case "IfInstruction": {
                    let block = this.beginBlock([],state,{
                        id: `if_${state.insCountPass1}`,
                        blockType: "if",
                        resultType: null,
                        enterStackLevel: state.stackLevel,
                        insCountStart: state.insCountPass1
                    });

                    state.usedLabels[`${sanitizeIdentifier(block.id)}_else`] = true;
                    state.gotos.push({ins: state.insCountPass1,label: `${sanitizeIdentifier(block.id)}_else`});
    
                    state.usedLabels[`${sanitizeIdentifier(block.id)}_fin`] = true;
                    state.gotos.push({ins: state.insCountPass1,label: `${sanitizeIdentifier(block.id)}_fin`});

                    this.processInstructionsPass1(ins.consequent,state)
                    
                    if(ins.alternate.length > 0) {
                        this.startElseSubBlock([],block,state,true);

                        this.processInstructionsPass1(ins.alternate,state);
                    }

                    break;
                }
            }
        }
    }

    processInstructionsPass2(insArr: Instruction[],state: WASMFuncState) {
        let buf = [];

        // PASS 2: emit instructions
        //////////////////////////////////////////////////////////////
        
        let insIdx = -1;
        for(let ins of insArr) {
            state.insCountPass2++;
            insIdx++;

            // check if any locals need force-initialized
            let forceInitVars = state.forceVarInit.get(state.insCountPass2);

            if (forceInitVars != null) {
                forceInitVars.forEach((locID) => {
                    if(this.insDebugOutput || true) {
                        this.write(buf,"-- FORCE INIT VAR | "+state.localTypes[locID]);
                        this.newLine(buf);
                    }
    
                    if(!state.locals[locID]) {
                        state.locals[locID] = this.fn_createNamedRegister(buf,state,`loc${locID}`);
                    }
                    if(typeof state.locals[locID].firstRef === "undefined") {
                        state.locals[locID].firstRef = state.insCountPass2;
                        state.locals[locID].lastRef = state.insLastRefs[locID];
                    }
    
                    this.write(buf,state.regManager.getPhysicalRegisterName(state.locals[locID]));
                    if (state.localTypes[locID] == "i64") {
                        this.write(buf," = __LONG_INT__(0,0);");
                    } else {
                        this.write(buf," = 0;");
                    }
                    this.newLine(buf);
                });
            }

            if(this.insDebugOutput) {
                if(ins.type == "Instr") {
                    this.write(buf,"-- LOOK "+ins.id+" "+JSON.stringify(ins));
                }
                else {
                    this.write(buf,"-- LOOK (!) "+ins.type+" "+JSON.stringify(ins));
                }
                this.newLine(buf);
            }

            switch(ins.type) {
                case "Instr": {
                    switch(ins.id) {
                        // Local + Global Vars
                        //////////////////////////////////////////////////////////////
                        case "local": {
                            // done in pass 3
                            break;
                        }
                        case "const": {
                            if(ins.args[0].type == "LongNumberLiteral") {
                                let _value = (ins.args[0] as LongNumberLiteral).value;
                                this.writeLn(buf,this.getPushStack(state,`__LONG_INT__(${_value.low},${_value.high})`));
                            }
                            else {
                                let _const = (ins.args[0] as NumberLiteral);
                                if (_const.inf) {
                                    if (_const.value > 0) {
                                        this.writeLn(buf,this.getPushStack(state,"(1/0)"));
                                    } else {
                                        this.writeLn(buf,this.getPushStack(state,"(-1/0)"));
                                    }
                                } else if (_const.nan) {
                                    this.writeLn(buf,this.getPushStack(state,"(0/0)"));
                                } else if (_const.value == 0 && 1/_const.value == -Number.POSITIVE_INFINITY) {
                                    this.writeLn(buf,this.getPushStack(state,"(-0)"));
                                } else {
                                    this.writeLn(buf,this.getPushStack(state,_const.value.toString()));
                                }
                            }
                            break;
                        }
                        case "get_global": {
                            let globID = (ins.args[0] as NumberLiteral).value;

                            let globTemp = this.fn_createTempRegister(buf,state);

                            this.write(buf,state.regManager.getPhysicalRegisterName(globTemp));
                            this.write(buf," = __GLOBALS__["+globID+"]");
                            this.write(buf,";");
                            this.newLine(buf);

                            this.writeLn(buf,this.getPushStack(state,globTemp));
                            break;
                        }
                        case "set_global": {
                            let globID = (ins.args[0] as NumberLiteral).value;

                            this.writeLn(buf,"__GLOBALS__["+globID+"] = "+this.getPop(state)+";");

                            break;
                        }
                        case "get_local": {
                            let locID = (ins.args[0] as NumberLiteral).value;
                            if(!state.locals[locID]) {
                                state.locals[locID] = this.fn_createNamedRegister(buf,state,`loc${locID}`);
                            }
                            if(typeof state.locals[locID].firstRef === "undefined") {
                                state.locals[locID].firstRef = state.insCountPass2;
                                state.locals[locID].lastRef = state.insLastRefs[locID];
                            }

                            this.writeLn(buf,this.getPushStack(state,state.locals[locID]));
                            break;
                        }
                        case "set_local": {
                            let locID = (ins.args[0] as NumberLiteral).value;
                            if(!state.locals[locID]) {
                                state.locals[locID] = this.fn_createNamedRegister(buf,state,`loc${locID}`);
                            }
                            if(typeof state.locals[locID].firstRef === "undefined") {
                                state.locals[locID].firstRef = state.insCountPass2;
                                state.locals[locID].lastRef = state.insLastRefs[locID];
                            }

                            this.invalidateCachedExpressionsWithDependency(buf,state,state.locals[locID]);

                            if(state.locals[locID].stackEntryCount > 0) {
                                // copy to temp var
                                
                                let locTemp = this.fn_createTempRegister(buf,state);

                                this.write(buf,state.regManager.getPhysicalRegisterName(locTemp));
                                this.write(buf," = ");
                                this.write(buf,state.regManager.getPhysicalRegisterName(state.locals[locID]));
                                this.write(buf,";");
                                this.newLine(buf);

                                for(let stackID=0;stackID < state.stackData.length;stackID++) {
                                    let stackEntry = state.stackData[stackID];
                                    if(stackEntry == state.locals[locID]) {
                                        // replace all old pushes with a temp copy
                                        state.stackData[stackID] = locTemp;
                                        state.locals[locID].stackEntryCount--;
                                        locTemp.stackEntryCount++;
                                    }
                                }
                            }

                            this.write(buf,state.regManager.getPhysicalRegisterName(state.locals[locID]));
                            this.write(buf," = "+this.getPop(state)+";");
                            this.newLine(buf);

                            break;
                        }
                        case "tee_local": {
                            let locID = (ins.args[0] as NumberLiteral).value;
                            if(!state.locals[locID]) {
                                state.locals[locID] = this.fn_createNamedRegister(buf,state,`loc${locID}`);
                            }
                            if(typeof state.locals[locID].firstRef === "undefined") {
                                state.locals[locID].firstRef = state.insCountPass2;
                                state.locals[locID].lastRef = state.insLastRefs[locID];
                            }

                            this.invalidateCachedExpressionsWithDependency(buf,state,state.locals[locID]);

                            if(state.locals[locID].stackEntryCount > 0) {
                                // copy to temp var
                                
                                let locTemp = this.fn_createTempRegister(buf,state);

                                this.write(buf,state.regManager.getPhysicalRegisterName(locTemp));
                                this.write(buf," = ");
                                this.write(buf,state.regManager.getPhysicalRegisterName(state.locals[locID]));
                                this.write(buf,";");
                                this.newLine(buf);

                                for(let stackID=0;stackID < state.stackData.length;stackID++) {
                                    let stackEntry = state.stackData[stackID];
                                    if(stackEntry == state.locals[locID]) {
                                        // replace all old pushes with a temp copy
                                        state.stackData[stackID] = locTemp;
                                        state.locals[locID].stackEntryCount--;
                                        locTemp.stackEntryCount++;
                                    }
                                }
                            }

                            // write local
                            this.write(buf,state.regManager.getPhysicalRegisterName(state.locals[locID]));
                            this.write(buf," = "+this.getPop(state)+";");
                            this.newLine(buf);
                            // read back
                            this.writeLn(buf,this.getPushStack(state,state.locals[locID]));

                            break;
                        }
                        // Arithmetic
                        //////////////////////////////////////////////////////////////
                        case "neg": {
                            let resultVar = this.fn_createPhantomRegister(buf,state);
                            let arg = this.getPop(state,resultVar);
                            resultVar.value = `-(${arg})`;
                            this.writeLn(buf,this.getPushStack(state,resultVar));

                            break;
                        }
                        case "add":
                        case "sub":
                        case "mul":
                        case "div":

                        case "eq":
                        case "ne":

                        case "lt":
                        case "le":
                        case "ge":
                        case "gt":

                        case "lt_s":
                        case "le_s":
                        case "ge_s":
                        case "gt_s":

                        case "lt_u":
                        case "le_u":
                        case "ge_u":
                        case "gt_u":
                        {
                            let op = wasm2lua.instructionBinOpRemap[ins.id].op;
                            let convert_bool = wasm2lua.instructionBinOpRemap[ins.id].bool_result;
                            let unsigned = wasm2lua.instructionBinOpRemap[ins.id].unsigned;

                            let resultVar = this.fn_createPhantomRegister(buf,state);

                            let tmp = this.getPop(state,resultVar);
                            let tmp2 = this.getPop(state,resultVar);

                            if (convert_bool) {
                                if (unsigned) {
                                    if (ins.object == "i64") {
                                        resultVar.value = `(${tmp2}):_${ins.id}(${tmp}) and 1 or 0`
                                    } else {
                                        resultVar.value = `(__UNSIGNED__(${tmp2}) ${op} __UNSIGNED__(${tmp})) and 1 or 0`
                                    }
                                } else {
                                    resultVar.value = `(${tmp2} ${op} ${tmp}) and 1 or 0`
                                }
                            } else if (ins.object=="i32") {
                                if (ins.id == "mul") {
                                    // used to hide this behind a flag, but correctness is probably the best policy here
                                    resultVar.value = `__MULTIPLY_CORRECT__(${tmp2},${tmp})`
                                } else {
                                    resultVar.value = `bit_tobit(${tmp2} ${op} ${tmp})`
                                }
                            } else {
                                resultVar.value = `${tmp2} ${op} ${tmp}`
                            }
                            this.writeLn(buf,this.getPushStack(state,resultVar));

                            break;
                        }
                        case "and":
                        case "or":
                        case "xor":
                        case "shl":
                        case "shr_u":
                        case "shr_s":
                        case "rotl":
                        case "rotr":

                        case "div_s":
                        case "div_u":
                        case "rem_s":
                        case "rem_u":

                        case "copysign":
                        case "min":
                        case "max":
                        {
                            let resultVar = this.fn_createPhantomRegister(buf,state);

                            let tmp = this.getPop(state,resultVar);
                            let tmp2 = this.getPop(state,resultVar);

                            if (ins.object=="i32" || ins.object == "f32" || ins.object == "f64") {
                                let op_func = wasm2lua.instructionBinOpFuncRemap[ins.id];
    
                                resultVar.value = `${op_func}(${tmp2},${tmp})`;
                            } else if (ins.object=="i64") {
                                resultVar.value = `(${tmp2}):_${ins.id}(${tmp})`;
                            } else {
                                resultVar.value = "error('BIT OP ON UNSUPPORTED TYPE: "+ins.object+","+ins.id+"')";
                            }
                            this.writeLn(buf,this.getPushStack(state,resultVar));

                            break;
                        }
                        // unary
                        case "clz":
                        case "ctz":
                        case "popcnt":

                        case "sqrt":
                        case "nearest":
                        case "trunc":
                        case "floor":
                        case "ceil":
                        case "abs":
                        {
                            let resultVar = this.fn_createPhantomRegister(buf,state);
                            let arg = this.getPop(state,resultVar);
                            if (ins.object=="i64") {
                                resultVar.value = arg + ":_" + ins.id +"()";
                            } else {
                                let op_func = wasm2lua.instructionBinOpFuncRemap[ins.id];
                                resultVar.value = op_func+"("+arg+")";
                            }
                            this.writeLn(buf,this.getPushStack(state,resultVar));

                            break;
                        }
                        case "eqz": {
                            let resultVar = this.fn_createPhantomRegister(buf,state);
                            let value = this.getPop(state,resultVar);
                            if (ins.object == "i64") {
                                resultVar.value = `((${value})[1] == 0) and ((${value})[2] == 0) and 1 or 0`;
                            } else {
                                resultVar.value = `(${value} == 0) and 1 or 0`;
                            }

                            this.writeLn(buf,this.getPushStack(state,resultVar));
                            break;
                        }
                        case "select": {
                            // Freaking ternary op. This is a dumb way to compile this
                            // but it allows us to handle it without adding another temp var.

                            let resultVar = this.fn_createTempRegister(buf,state);
                            
                            let popCond = this.getPop(state);
                            let ret1 = this.getPop(state);
                            let ret2 = this.getPop(state);
                            
                            this.write(buf,`if ${popCond} == 0 then `);
                            this.write(buf,` ${state.regManager.getPhysicalRegisterName(resultVar)} = ${ret1} `);
                            this.write(buf,`else ${state.regManager.getPhysicalRegisterName(resultVar)} = ${ret2} `);
                            this.write(buf,"end;");

                            this.write(buf,this.getPushStack(state,resultVar));

                            this.newLine(buf);
                            break;
                        }
                        case "drop": {
                            this.stackDrop(state);
                            if(this.stackDebugOutput) {
                                this.write(buf,"-- stack drop");
                                this.newLine(buf);
                            }
                            break;
                        }
                        // Type Conversions
                        //////////////////////////////////////////////////////////////
                        case "convert_s/i32":
                        case "promote/f32":
                        case "demote/f64":
                            // These are no-ops.
                            break;
                        case "convert_u/i32": {
                            // Convert uint32 to float/double.
                            let resultVar = this.fn_createPhantomRegister(buf,state);
                            let arg = this.getPop(state,resultVar);
                            resultVar.value = `__UNSIGNED__(${arg})`;
                            this.writeLn(buf,this.getPushStack(state,resultVar));
                            break;
                        }
                        case "convert_s/i64": {
                            // Convert int64 to float/double.
                            let resultVar = this.fn_createPhantomRegister(buf,state);
                            let arg = this.getPop(state,resultVar);
                            resultVar.value = `__UNSIGNED__((${arg})[1]) + (${arg})[2]*4294967296`;
                            this.writeLn(buf,this.getPushStack(state,resultVar));
                            break;
                        }
                        case "convert_u/i64": {
                            // Convert uint64 to float/double.
                            let resultVar = this.fn_createPhantomRegister(buf,state);
                            let arg = this.getPop(state,resultVar);
                            resultVar.value = `__UNSIGNED__((${arg})[1]) + __UNSIGNED__((${arg})[2])*4294967296`;
                            this.writeLn(buf,this.getPushStack(state,resultVar));
                            break;
                        }
                        case "trunc_s/f32":
                        case "trunc_s/f64":
                        case "trunc_u/f32":
                        case "trunc_u/f64": {
                            // These all basically operate the same AFAIK, the only difference is the cases where they trap.
                            let resultVar = this.fn_createPhantomRegister(buf,state);
                            let arg = this.getPop(state,resultVar);
                            if(ins.object == "i64") {
                                resultVar.value = `__LONG_INT_N__(__TRUNC__(${arg}))`;
                            }
                            else {
                                resultVar.value = `bit_tobit(__TRUNC__(${arg}))`;
                            }
                            this.writeLn(buf,this.getPushStack(state,resultVar));
                            break;
                        }
                        case "extend_u/i32": {
                            // Easy (signed extension will be slightly more of a pain)
                            let resultVar = this.fn_createPhantomRegister(buf,state);
                            let arg = this.getPop(state,resultVar);
                            resultVar.value = `__LONG_INT__(${arg},0)`;
                            this.writeLn(buf,this.getPushStack(state,resultVar));
                            break;
                        }
                        case "extend_s/i32": {
                            let resultVar = this.fn_createPhantomRegister(buf,state);
                            let arg = this.getPop(state,resultVar);
                            // Extract the sign bit and arithmetic shift it to obtain the high half.
                            resultVar.value = `__LONG_INT__(${arg},bit_arshift(${arg},31))`;
                            this.writeLn(buf,this.getPushStack(state,resultVar));
                            break;
                        }
                        case "wrap/i64": {
                            let resultVar = this.fn_createPhantomRegister(buf,state);
                            let arg = this.getPop(state,resultVar);
                            // return low uint32
                            resultVar.value = `(${arg})[1]`;
                            this.writeLn(buf,this.getPushStack(state,resultVar));
                            break;
                        }
                        case "reinterpret/i32": {
                            let resultVar = this.fn_createPhantomRegister(buf,state);
                            let arg = this.getPop(state,resultVar);
                            resultVar.value = `UInt32ToFloat(${arg})`;
                            this.writeLn(buf,this.getPushStack(state,resultVar));
                            break;
                        }
                        case "reinterpret/i64": {
                            let resultVar = this.fn_createPhantomRegister(buf,state);
                            let arg = this.getPop(state,resultVar);
                            resultVar.value = `UInt32sToDouble((${arg})[1],(${arg})[2])`;
                            this.writeLn(buf,this.getPushStack(state,resultVar));
                            break;
                        }
                        case "reinterpret/f32": {
                            let resultVar = this.fn_createPhantomRegister(buf,state);
                            let arg = this.getPop(state,resultVar);
                            resultVar.value = `FloatToUInt32(${arg})`;
                            this.writeLn(buf,this.getPushStack(state,resultVar));
                            break;
                        }
                        case "reinterpret/f64": {
                            let resultVar = this.fn_createPhantomRegister(buf,state);
                            let arg = this.getPop(state,resultVar);
                            resultVar.value = `__LONG_INT__(DoubleToUInt32s(${arg}))`;
                            this.writeLn(buf,this.getPushStack(state,resultVar));
                            break;
                        }
                        // Branching
                        //////////////////////////////////////////////////////////////
                        case "br_if": {
                            this.write(buf,"if ");
                            this.write(buf,this.getPop(state));
                            this.write(buf,"~=0 then ");

                            this.writeBranch(buf,state, (ins.args[0] as NumberLiteral).value);

                            this.write(buf," end;");
                            this.newLine(buf);

                            break;
                        }
                        case "br": {
                            this.writeBranch(buf,state, (ins.args[0] as NumberLiteral).value);
                            this.newLine(buf);
                            break;
                        }
                        case "br_table": {
                            let tmp = this.getPop(state);
                            this.newLine(buf);
                            let arg_count = ins.args.length;
            
                            if (arg_count > 1000) {
                                this.write(buf,"error('jump table too big')");
                                this.newLine(buf);

                                break;
                            }

                            ins.args.forEach((target,i)=>{

                                if (i!=0) {
                                    this.write(buf,"else");
                                }

                                if (i<arg_count-1) {
                                    this.write(buf,`if ${tmp} == ${i} then `);
                                } else {
                                    this.write(buf," ");
                                }

                                this.writeBranch(buf,state, (target as NumberLiteral).value);
                                this.newLine(buf);
                            });
                            if (ins.args.length>1) {
                                // single-target branch tables have no surrounding control structure
                                this.write(buf,"end");
                                this.newLine(buf);
                            }
                            break;
                        }
                        // Memory
                        //////////////////////////////////////////////////////////////
                        case "store":
                        case "store8":
                        case "store16": 
                        case "store32": {
                            // target is always mem_0 according to wasm spec
                            let targ = state.modState.memoryAllocations.get(0);

                            let loadOffset = (ins.args[0] as NumberLiteral).value;
                            let loadOffsetStr = loadOffset != 0 ? `+${loadOffset}` : "";

                            if(targ) {
                                let tmp = this.getPop(state);
                                let tmp2 = this.getPop(state);

                                if (ins.object == "u32") {
                                    if(ins.id == "store16") {
                                        this.write(buf,"__MEMORY_WRITE_16__");
                                    }
                                    else if(ins.id == "store8") {
                                        this.write(buf,"__MEMORY_WRITE_8__");
                                    }
                                    else {
                                        this.write(buf,"__MEMORY_WRITE_32__");
                                    }
                                    this.write(buf,`(${targ},${tmp2}${loadOffsetStr},${tmp});`);
                                } else if (ins.object == "u64") {
                                    this.write(buf,`(${tmp}):${ins.id}(${targ},${tmp2}${loadOffsetStr});`);
                                } else if (ins.object == "f32") {
                                    this.write(buf,"__MEMORY_WRITE_32F__");
                                    this.write(buf,`(${targ},${tmp2}${loadOffsetStr},${tmp});`);
                                } else if (ins.object == "f64") {
                                    this.write(buf,"__MEMORY_WRITE_64F__");
                                    this.write(buf,`(${targ},${tmp2}${loadOffsetStr},${tmp});`);
                                } else {
                                    this.write(buf,"-- WARNING: UNSUPPORTED MEMORY OP ON TYPE: "+ins.object);
                                }

                                this.newLine(buf);
                            }
                            else {
                                this.write(buf,"-- WARNING: COULD NOT FIND MEMORY TO WRITE");
                                this.newLine(buf);
                            }

                            break;
                        }
                        case "load":
                        case "load8_s":
                        case "load16_s":
                        case "load32_s":
                        case "load8_u":
                        case "load16_u":
                        case "load32_u": {
                            // target is always mem_0 according to wasm spec
                            let targ = state.modState.memoryAllocations.get(0);

                            if(targ) {
                                let tempVar = this.fn_createTempRegister(buf,state);
                                let vname = state.regManager.getPhysicalRegisterName(tempVar);

                                let loadOffset = (ins.args[0] as NumberLiteral).value;
                                let loadOffsetStr = loadOffset != 0 ? `+${loadOffset}` : "";

                                this.write(buf,`${vname} = `);
                                let is_narrow_u64_load = (ins.object == "u64" && ins.id != "load");
                                if (ins.object == "u32" || is_narrow_u64_load) {
                                    if (ins.id.startsWith("load16")) {
                                        this.write(buf,"__MEMORY_READ_16__");
                                    }
                                    else if (ins.id.startsWith("load8")) {
                                        this.write(buf,"__MEMORY_READ_8__");
                                    }
                                    else {
                                        this.write(buf,"__MEMORY_READ_32__");
                                    }
                                    this.write(buf,`(${targ},${this.getPop(state)}${loadOffsetStr});`);
                                    if (ins.id.endsWith("_s") && ins.id != "load32_s") {
                                        let shift: number;
                                        if (ins.id == "load8_s") {
                                            shift = 24;
                                        } else if (ins.id == "load16_s") {
                                            shift = 16;
                                        } else {
                                            throw new Error("signed load "+ins.id);
                                        }

                                        this.write(buf,`${vname}=bit_arshift(bit_lshift(${vname},${shift}),${shift});`);
                                    }
                                } else if (ins.object == "u64") {
                                    // todo rewrite this trash
                                    if (ins.id == "load") {
                                        this.write(buf,`__LONG_INT__(0,0); ${vname}:${ins.id}(${targ},${this.getPop(state)}${loadOffsetStr});`);
                                    } else {
                                        throw new Error("narrow u64 loads NYI "+ins.id);
                                    }
                                } else if (ins.object == "f32") {
                                    this.write(buf,"__MEMORY_READ_32F__");
                                    this.write(buf,`(${targ},${this.getPop(state)}${loadOffsetStr});`);
                                } else if (ins.object == "f64") {
                                    this.write(buf,"__MEMORY_READ_64F__");
                                    this.write(buf,`(${targ},${this.getPop(state)}${loadOffsetStr});`);
                                } else {
                                    this.write(buf,"0 -- WARNING: UNSUPPORTED MEMORY OP ON TYPE: "+ins.object);
                                    this.newLine(buf);
                                    break;
                                }

                                if (is_narrow_u64_load) {
                                    if (ins.id.endsWith("_s")) {
                                        this.write(buf,`${vname}=__LONG_INT__(${vname},bit_arshift(${vname},31));`);
                                    } else {
                                        this.write(buf,`${vname}=__LONG_INT__(${vname},0);`);
                                    }
                                }

                                this.writeLn(buf,this.getPushStack(state,tempVar));
                            }
                            else {
                                this.write(buf,"-- WARNING: COULD NOT FIND MEMORY TO READ");
                            }
                            this.newLine(buf);

                            break;
                        }
                        case "grow_memory": {
                            // : target is always mem_0 according to wasm spec
                            let targ = state.modState.memoryAllocations.get(0);

                            let tempVar = this.fn_createTempRegister(buf,state);
                            this.write(buf,`${state.regManager.getPhysicalRegisterName(tempVar)} = __MEMORY_GROW__(${targ},__UNSIGNED__(${this.getPop(state)})); `);
                            this.write(buf,this.getPushStack(state,tempVar));
                            this.newLine(buf);
                            break;
                        }
                        case "current_memory": {
                            // : target is always mem_0 according to wasm spec
                            let targ = state.modState.memoryAllocations.get(0);

                            let tempVar = this.fn_createTempRegister(buf,state);
                            this.writeLn(buf,`${state.regManager.getPhysicalRegisterName(tempVar)} = ${targ}._page_count;`);
                            this.writeLn(buf,this.getPushStack(state,tempVar));
                            break;
                        }
                        // Misc
                        //////////////////////////////////////////////////////////////
                        case "return": {
                            this.writeReturn(buf,state);
                            this.newLine(buf);
                            break;
                        }
                        case "end": {
                            let lastIns = insArr[insIdx - 1];
                            let isUnreachable = false;

                            if(lastIns) {
                                if(lastIns.type == "Instr") {
                                    if(lastIns.id == "unreachable") {
                                        // self explanatory
                                        isUnreachable = true;
                                    }
                                    else if(lastIns.id == "br") {
                                        // unconditional branch: this instruction will never be reached
                                        isUnreachable = true;
                                    }
                                }
                            }

                            this.endBlock(buf,state,isUnreachable);
                            break;
                        }
                        case "unreachable": {
                            this.write(buf,"error('unreachable');");
                            this.newLine(buf);
                            break;
                        }
                        case "nop":
                            // nop :)
                            break;
                        default: {
                            //this.write(buf,"-- TODO "+ins.id+" "+JSON.stringify(ins));
                            this.write(buf,"error('TODO "+ins.id+"');");
                            this.newLine(buf);
                            break;
                        }
                    }
                    break;
                }
                case "CallInstruction": {
                    let fstate = this.getFuncByIndex(state.modState,ins.index);

                    if((fstate && fstate.origID == "setjmp") || (ins.index.value == "setjmp")) {
                        let resultVar = this.fn_createTempRegister(buf,state);
                        let jmpBufLoc = this.getPop(state);

                        let resVarName = state.regManager.getPhysicalRegisterName(resultVar);

                        this.write(buf,`${resVarName} = {data = {},target = "jmp_${sanitizeIdentifier(ins.loc.start.line)}_${sanitizeIdentifier(ins.loc.start.column)}",result = 0,heapBase = ${this.options.heapBase},unresolved = false};`);
                        this.newLine(buf);
                        let hasVars = this.forEachVarIncludeParams(state,(varName,virtual) => {
                            if(virtual) {
                                this.write(buf,`${resVarName}.data.${varName.replace(/[\[\]]/g,"")}`);
                            }
                            else {
                                this.write(buf,`${resVarName}.data.${varName}`);
                            }
                            this.write(buf,",");
                        })
                        if(hasVars) {
                            buf.pop(); // get rid of trailing comma
                            this.write(buf," = ");
                            this.forEachVarIncludeParams(state,(varName) => {
                                this.write(buf,`${varName}`);
                                this.write(buf,",");
                            });
                            buf.pop(); // get rid of trailing comma again
                            this.write(buf,";");
                        }
                        this.writeLn(buf,`__SETJMP_STATES__[${state.modState.memoryAllocations.get(0)}][${jmpBufLoc}] = ${resVarName}`);

                        this.write(buf,`::jmp_${sanitizeIdentifier(ins.loc.start.line)}_${sanitizeIdentifier(ins.loc.start.column)}::`);
                        this.newLine(buf);

                        let resultVar2 = this.fn_createTempRegister(buf,state);
                        this.writeLn(buf,`${state.regManager.getPhysicalRegisterName(resultVar2)} = (__setjmp_data__ == ${resVarName}) and __setjmp_data__.result or 0;`);

                        this.fn_freeRegister(buf,state,resultVar);

                        this.writeLn(buf,this.getPushStack(state,resultVar2));
                    }
                    else if((fstate && fstate.origID == "longjmp") || (ins.index.value == "longjmp")) {
                        let resultVal = this.getPop(state);
                        let jmpBufLoc = this.getPop(state);

                        this.write(buf,`if ${resultVal} == 0 then `);
                        this.write(buf,`__SETJMP_STATES__[${state.modState.memoryAllocations.get(0)}][${jmpBufLoc}].result = 1 `);
                        this.write(buf,`else `);
                        this.write(buf,`__SETJMP_STATES__[${state.modState.memoryAllocations.get(0)}][${jmpBufLoc}].result = ${resultVal} `);
                        this.writeLn(buf,`end`);
                        this.write(buf,`error(`);
                        this.write(buf,`__SETJMP_STATES__[${state.modState.memoryAllocations.get(0)}][${jmpBufLoc}]`);
                        this.writeLn(buf,`) -- longjmp`);
                        // TODO: should I do `__SETJMP_STATES__[mem][loc] = nil`
                        // somewhere here???
                    }
                    else {
                        if(fstate && fstate.funcType) {
                            this.writeFunctionCall(state,buf,fstate.id,fstate.funcType);
                            this.newLine(buf);
                        }
                        else {
                            //this.write(buf,"-- WARNING: UNABLE TO RESOLVE CALL " + ins.index.value + " (TODO ARG/RET)");
                            this.write(buf,`error("UNRESOLVED CALL: ${ins.index.value}")`);
                            this.newLine(buf);
                        }
                    }
                    break;
                }
                case "CallIndirectInstruction": {

                    let table_index = 0;

                    let func = `__TABLE_FUNCS_${table_index}__[${this.getPop(state)}+1]`;
                    if (ins.signature.type=="Signature") {
                        this.writeFunctionCall(state,buf,func,ins.signature);
                        this.newLine(buf);
                    } else {
                        this.write(buf,`error("BAD SIGNATURE ON INDIRECT CALL?")`);
                        this.newLine(buf);
                    }

                    break;
                }
                case "BlockInstruction":
                case "LoopInstruction": {
                    let blockType: "loop"|"block" = (ins.type == "LoopInstruction") ? "loop" : "block";

                    let block = this.beginBlock(buf,state,{
                        id: `${blockType}_${state.insCountPass2}`,
                        resultType: (ins.type == "LoopInstruction") ? ins.resulttype : ins.result, 
                        blockType,
                        enterStackLevel: state.stackLevel,
                        insCountStart: state.insCountPass2,
                    });

                    if(block.resultType !== null) {
                        block.resultRegister = this.fn_createTempRegister(buf,state);
                    }

                    this.write(buf,this.processInstructionsPass2(ins.instr,state));
                    break;
                }
                case "IfInstruction": {

                    if (ins.test.length > 0) {
                        this.write(buf,"error('if test nyi')");
                        this.newLine(buf);
                    }

                    let labelBase = `if_${state.insCountPass2}`;
                    let labelBaseSan = sanitizeIdentifier(`if_${state.insCountPass2}`);

                    this.write(buf,"if ");
                    this.write(buf,this.getPop(state));
                    if(ins.alternate.length > 0) {
                        this.write(buf,`==0 then `);
                        this.writeGoto(buf,`${labelBaseSan}_else`,state);
                        this.write(buf,` end`);
                    }
                    else {
                        this.write(buf,`==0 then `);
                        this.writeGoto(buf,`${labelBaseSan}_fin`,state);
                        this.write(buf,` end`);
                    }

                    let block = this.beginBlock(buf,state,{
                        id: labelBase,
                        blockType: "if",
                        resultType: ins.result,
                        enterStackLevel: state.stackLevel,
                        insCountStart: state.insCountPass2
                    });

                    if(block.resultType !== null) {
                        block.resultRegister = this.fn_createTempRegister(buf,state);
                    }

                    this.write(buf,this.processInstructionsPass2(ins.consequent,state));

                    // write else

                    if (ins.alternate.length > 0) {
                        this.startElseSubBlock(buf,block,state);
    
                        this.write(buf,this.processInstructionsPass2(ins.alternate,state));
                    }

                    break;
                }
                default: {
                    //this.write(buf,"-- TODO (!) "+ins.type+" "+JSON.stringify(ins));
                    this.write(buf,"error('TODO "+ins.type+"');");
                    this.newLine(buf);
                    break;
                }
            }

            // PASS 2B: kill unused variables
            if(ins.type === "Instr") {
                switch(ins.id) {
                    case "get_local": 
                    case "set_local": 
                    case "tee_local": {
                        let locID = (ins.args[0] as NumberLiteral).value;

                        if(state.insCountPass2 >= state.insLastRefs[locID]) {
                            if(state.locals[locID].stackEntryCount == 0) {
                                this.fn_freeRegister(buf,state,state.locals[locID]);
                            }
                        }

                        break;
                    }
                }
            }

            let regIdx = 0;
            while(state.registersToBeFreed[regIdx]) {
                let reg = state.registersToBeFreed[regIdx];

                if(typeof reg.lastRef === "number") {
                    if(state.insCountPass2 >= reg.lastRef) {
                        this.fn_freeRegisterEx(buf,state,reg);
                        state.registersToBeFreed.splice(regIdx,1);
                        continue;
                    }
                }
                else {
                    this.fn_freeRegisterEx(buf,state,reg);
                    state.registersToBeFreed.splice(regIdx,1);
                    continue;
                }
                
                regIdx++;
            }
        }

        return buf.join("");
    }

    processInstructionsPass3(insArr: Instruction[],state: WASMFuncState) {
        // PASS 3: emit register header
        //////////////////////////////////////////////////////////////

        let t_buf: string[] = [];

        if(state.regManager.virtualDisabled) {
            this.write(t_buf,"local ");

            let seen = {};
            for(let i=(state.funcType ? state.funcType.params.length : 0);i < state.regManager.registerCache.length;i++) {
                let reg = state.regManager.registerCache[i];
                let name = state.regManager.getPhysicalRegisterName(reg);
                if(seen[name]) {continue;}
                seen[name] = true;
                this.write(t_buf,name);
                this.write(t_buf,",");
            }
            
            if(t_buf.pop() !== ",") {
                // no vars were declared.
                return "";
            }

            this.write(t_buf,";");
            this.newLine(t_buf);

            return t_buf.join("");
        }

        if((state.regManager.totalRegisters - (state.funcType ? state.funcType.params.length : 0)) > 0) {
            if(state.regManager.totalRegisters > VirtualRegisterManager.MAX_REG) {
                this.write(t_buf,"local vreg = {")
                for(let i=VirtualRegisterManager.MAX_REG;i < state.regManager.totalRegisters;i++) {
                    this.write(t_buf,`nil,`);
                }
                this.writeLn(t_buf,"}")
            }

            this.write(t_buf,"local ");
            for(let i=(state.funcType ? state.funcType.params.length : 0);i < state.regManager.totalRegisters;i++) {
                if(i >= VirtualRegisterManager.MAX_REG) {
                    if(t_buf[t_buf.length - 1] == ",") {t_buf.pop();}
                    break;
                }
                else {
                    this.write(t_buf,`reg${i}`);
                    if(i !== (state.regManager.totalRegisters - 1)) {
                        this.write(t_buf,",");
                    }
                }
            }

            if(state.regManager.totalRegisters > (VirtualRegisterManager.MAX_REG * 0.75)) {
                if(state.regManager.totalRegisters > VirtualRegisterManager.MAX_REG) {
                    console.error(`WARNING: [${state.id}] ${state.regManager.totalRegisters} REGISTERS USED (VREGS ENABLED)`);
                }
                else {
                    console.log(`WARNING: [${state.id}] ${state.regManager.totalRegisters} REGISTERS USED`);
                }
            }

            this.write(t_buf,";");
            this.newLine(t_buf);
        }

        return t_buf.join("");
    }

    writeFunctionCall(state: WASMFuncState, buf: string[], func: string, sig: Signature) {
        let argsReg:VirtualRegister[] = [];

        for(let i=0;i < sig.results.length;i++) {
            let reg = this.fn_createTempRegister(buf,state);
            argsReg.push(reg);
            this.write(buf,state.regManager.getPhysicalRegisterName(reg));
            if((i+1) !== sig.results.length) {
                this.write(buf,",");
            }
        }

        if(sig.results.length > 0) {
            this.write(buf," = ");
        }

        this.write(buf,func + "(");
        let args: string[] = [];
        for(let i=0;i < sig.params.length;i++) {
            args.push(this.getPop(state));
        }
        this.write(buf,args.reverse().join(","));
        this.write(buf,");");

        for(let i=0;i < sig.results.length;i++) {
            this.getPushStack(state,argsReg[i]);
        }
    }

    processModuleExport(node: ModuleExport,modState: WASMModuleState) {
        let buf = [];

        this.write(buf,"__EXPORTS__[\"");
        this.write(buf,node.name)
        this.write(buf,"\"] = ");

        switch(node.descr.exportType) {
            case "Func": {
                let fstate = this.getFuncByIndex(modState,node.descr.id);
                if(fstate) {
                    this.write(buf,fstate.id);
                }
                else {
                    this.write(buf,"--[[WARNING: EXPORT_FAIL]] func_u" + node.descr.id.value);
                }
                break;
            }
            case "Mem": {
                let targ = modState.memoryAllocations.get(node.descr.id.value);
                if(targ) {
                    this.write(buf,targ);
                }
                else {
                    this.write(buf,"nil --[[WARNING: COULDN'T FIND MEMORY TO EXPORT]]");
                }
                break;
            }
            case "Global": {
                // TODO - Might need metatable trash?
                this.write(buf,"nil -- TODO global export");
                break;
            }
            case "Table": {
                this.write(buf,`__TABLE_FUNCS_${node.descr.id.value}__`);
                break;
            }
            default: {
                throw new Error("TODO - Export - " + node.descr.exportType);
                break;
            }
        }
        this.write(buf,";");
        this.newLine(buf);

        return buf.join("");
    }

    importedWASI = false;
    processModuleImport(node: ModuleImport,modState: WASMModuleState) {
        let buf = [];
        
        if(node.module == "wasi_unstable") {
            this.importedWASI = true;
        }

        switch(node.descr.type) {
            case "Memory": {
                let memID = `__IMPORTS__.${node.module}.${node.name}`
                if(node.descr.id) {
                    modState.memoryAllocations.set(node.descr.id.value,memID);
                }
                else {
                    modState.memoryAllocations.push(memID);
                }

                break;
            }
            case "FuncImportDescr": {
                this.initFunc({
                    signature: node.descr.signature,
                    name: {value: node.descr.id.value},
                },modState,`__IMPORTS__.${node.module}.${node.name}`,node.name);

                break;
            }
            default: {
                // TODO
                this.write(buf,"-- IMPORT " + JSON.stringify(node));
                this.newLine(buf);

                break;
            }
        }

        return buf.join("");
    }
}

// // Allow custom in/out file while defaulting to swad's meme :)
// // let infile  = process.argv[2] || (__dirname + "/../test/addTwo.wasm");
// // let infile  = process.argv[2] || (__dirname + "/../test/ammo-ex.wasm");
// // let infile  = process.argv[2] || (__dirname + "/../test/dispersion.wasm");
// // let infile  = process.argv[2] || (__dirname + "/../test/call_code.wasm");
// let infile  = process.argv[2] || (__dirname + "/../test/teststub.wasm");
// // let infile  = process.argv[2] || (__dirname + "/../test/test2.wasm");
// // let infile  = process.argv[2] || (__dirname + "/../test/duktape.wasm");
// // let infile  = process.argv[2] || (__dirname + "/../resources/tests/assemblyscript/string-utf8.optimized.wat.wasm");
// // let infile  = process.argv[2] || (__dirname + "/../test/nbody.wasm");
// // let infile  = process.argv[2] || (__dirname + "/../test/matrix.wasm");
// // let infile  = process.argv[2] || (__dirname + "/../test/longjmp.wasm");
// // let infile  = process.argv[2] || (__dirname + "/../test/mandelbrot.wasm");
// // let infile  = process.argv[2] || (__dirname + "/../test/testwasi.wasm");
// // let infile  = process.argv[2] || (__dirname + "/../test/testorder.wasm");
// // let infile  = process.argv[2] || (__dirname + "/../test/testorder2.wasm");
// // let infile  = process.argv[2] || (__dirname + "/../test/testorder3.wasm");
// // let infile  = process.argv[2] || (__dirname + "/../test/testorder5.wasm");
// // let infile  = process.argv[2] || (__dirname + "/../test/testswitch.wasm");
// let outfile = process.argv[3] || (__dirname + "/../test/test.lua");
// let compileFlags = process.argv[4] ? process.argv[4].split(",") : null;
// let whitelist = null;

// let wasm = fs.readFileSync(infile);

// // console.log(JSON.stringify(ast,null,4));

// let inst = new wasm2lua(wasm, {whitelist,compileFlags,webidl: {idlFilePath: __dirname + "/../test/test.idl"}});
// fs.writeFileSync(outfile,inst.outBuf.join(""));

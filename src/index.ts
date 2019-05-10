import {decode} from "@webassemblyjs/wasm-parser"
import * as fs from "fs"
import { isArray, print } from "util";

import {ArrayMap} from "./arraymap"
import { VirtualRegisterManager, VirtualRegister } from "./virtualregistermanager";

// TODO: Imported globals use global IDs that precede other global IDs
// TODO: ^ The same applies to memories. ^

/* TODO TYPES:

- Assume that anything on the stack is already normalized to the correct type.
- ???? Some ops require normalization (add, sub, mul), while others do not (and, or).
    - Apparently we are supposed to trap on overflow??? This seems like a lot of work. Need to investigate more.
- Comparison ops should be normalized (bool -> i32(?)).
- Many ops (comparisons, divisions, and shifts) are sign-dependant. This may be difficult to implement.
- i64 will be a pain, but may be necessary due to runtime usage.
- f32/f64 will be easy to implement, but very hard to read/write to memory in a way friendly to the jit. Soft floats are a potential last resort.
- Signed loads still need sign extended, unsigned loads need to do what signed loads currently do.
*/

/* TODO OPTIMIZATION:

- Memory: Use 32 bits per table cell instead of 8, more is possible but probably a bad idea.
- Might want to use actual loops, might be more jit friendly.
- Statically determine stack depth everywhere. Should improve performance and reduce the need for temporary vars, while not requiring any complex folding logic.
    - Attempted ^this^, not sure I did it correctly.
*/

/* TODO BLOCKS:

 - handle results
 - make sure stack depth is correct on exit?
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
function sanitizeIdentifier(ident: string) {
    return ident
        .replace(/\$/g,"__IDENT_CHAR_DOLLAR__")
        .replace(/\./g,"__IDENT_CHAR_DOT__")
        .replace(/\-/g,"__IDENT_CHAR_MINUS__");
}

interface WASMModuleState {
    funcStates: WASMFuncState[];
    funcByName: Map<string,WASMFuncState>;
    memoryAllocations: ArrayMap<string>;
    func_tables: Array<Array<Index>>;

    nextGlobalIndex: number;
}

interface WASMFuncState {
    id: string;
    regManager: VirtualRegisterManager;
    locals: VirtualRegister[];
    blocks: WASMBlockState[];
    varRemaps: Map<string,string>;
    funcType?: Signature;
    modState?: WASMModuleState;

    // should probably go in funcstate (or more likely blockstate, but I couldn't be bothered to adjust stack methods.)
    stackLevel: number;
    stackData: (string | VirtualRegister | false)[];
}

interface WASMBlockState {
    id: string;
    blockType: "block" | "loop" | "if";
    resultRegister?: VirtualRegister;
    resultType?: Valtype | null;
    enterStackLevel: number; // used to check if we left a block with an extra item in the stack
    hasClosed?: true;
}

interface WASM2LuaOptions {
    whitelist?: string[];
}

const FUNC_VAR_HEADER = "local __TMP__,__TMP2__,__STACK__ = nil,nil,{};";

export class wasm2lua {
    outBuf: string[] = [];
    indentLevel = 0;
    // funcTypes: any[] = [];
    moduleStates: WASMModuleState[] = [];
    globalRemaps: Map<string,string>;
    globalTypes: Signature[] = [];

    static fileHeader = fs.readFileSync(__dirname + "/../resources/fileheader.lua").toString();
    static funcHeader = fs.readFileSync(__dirname + "/../resources/fileheader.lua").toString();

    private program_ast: Program;

    constructor(private program_binary: Buffer, private options: WASM2LuaOptions = {}) {

        this.program_ast = decode(wasm,{
            // dump: true,
        });

        this.process()
    }

    assert(cond: any,err: string = "assertion failed") {
        if(!cond) {
            throw new Error(err);
        }
    }

    indent() {this.indentLevel++;}

    outdent(buf?: string[]) {
        this.indentLevel--;
        if(isArray(buf)) {
            while(buf[buf.length - 1] === "") {
                buf.pop();
            }

            let mat = buf[buf.length - 1].match(/^([\s\S]*?)\n(?:    )*$/);
            if(mat) {
                // fix up indent
                buf[buf.length - 1] = mat[1] + "\n" + (("    ").repeat(this.indentLevel));
            }
        }
    }

    newLine(buf: string[]) {
        buf.push("\n" + (("    ").repeat(this.indentLevel)));
    }

    write(buf: string[],str: string) {buf.push(str);}
    writeLn(buf: string[],str: string) {
        if(str !== "") {
            buf.push(str);
            this.newLine(buf);
        }
    }
    writeEx(buf: string[],str: string,offset: number) {
        if(offset < 0) {offset += buf.length;}
        buf.splice(offset,0,str);
    }

    writeHeader(buf: string[]) {
        this.write(buf,wasm2lua.fileHeader);
        this.newLine(buf);
    }

    getPushStack(func: WASMFuncState,stackExpr?: string | VirtualRegister) {
        // if(true) {
        //     if(typeof stackExpr !== "undefined") {
        //         return `__STACK__[#__STACK__ + 1] = ${stackExpr};`;
        //     }
        //     else {
        //         return `__STACK__[#__STACK__ + 1] = `;
        //     }
        // }

        func.stackLevel++;
        if(typeof stackExpr === "string") {
            func.stackData.push(stackExpr);
            // return `--[[VIRTUAL PUSH TO ${this.stackLevel-1}]]`;
            // return `__STACK__[${func.stackLevel-1}] = ${stackExpr}`;
            return "";
        }
        else if(typeof stackExpr === "object") {
            func.stackData.push(stackExpr);
            // return `--[[VIRTUAL REG PUSH TO ${this.stackLevel-1}]]`;
            // return `__STACK__[${func.stackLevel-1}] = ${func.regManager.getPhysicalRegisterName(stackExpr)}`;
            return "";
        }
        else {
            func.stackData.push(false);
            return `__STACK__[${func.stackLevel-1}] = `;
        }
    }

    getPop(func: WASMFuncState) {
        // if(true) {
        //     return `__STACK_POP__(__STACK__)`;
        // }

        if(func.stackLevel == 1) {
            throw new Error("attempt to pop below zero");
        }
        
        let lastData = func.stackData.pop();
        func.stackLevel--;
        if(typeof lastData === "string") {
            // return `--[[VIRTUAL POP TO ${func.stackLevel}]] ${lastData}`;
            // return `__STACK__[${func.stackLevel}]`;
            return lastData;
        }
        else if(typeof lastData === "object") {
            func.regManager.freeRegister(lastData);
            // return `--[[VIRTUAL REG POP TO ${func.stackLevel}]] ${func.regManager.getPhysicalRegisterName(lastData)}`;
            // return `__STACK__[${func.stackLevel}]`;
            return func.regManager.getPhysicalRegisterName(lastData);
        }
        else {
            return `__STACK__[${func.stackLevel}]`;
        }
    }

    stackDrop(func: WASMFuncState) {
        func.stackLevel--;
    }

    process() {
        this.writeHeader(this.outBuf);

        for(let mod of this.program_ast.body) {
            if(mod.type == "Module") {
                this.write(this.outBuf,"do");
                this.indent();
                this.newLine(this.outBuf);
                this.write(this.outBuf,this.processModule(mod));
                this.outdent(this.outBuf);
                this.write(this.outBuf,"end");
                this.newLine(this.outBuf);
            }
            else {
                throw new Error("TODO");
            }
        }
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

        if(node.id) {
            this.write(buf,"local __EXPORTS__ = {};")
            this.newLine(buf);
            this.write(buf,"__MODULES__." + node.id + " = __EXPORTS__");
            this.newLine(buf);
        }
        else {
            this.write(buf,"__MODULES__.UNKNOWN = __MODULES__.UNKNOWN or {}");
            this.newLine(buf);
            this.write(buf,"local __EXPORTS__ = __MODULES__.UNKNOWN;")
            this.newLine(buf);
        }

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
                this.write(buf,this.processModuleExport(field,state));
            }
            else if(field.type == "ModuleImport") {
                // Already done in 1st pass
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

                this.write(buf,"local " + memID + " = __MEMORY_ALLOC__(" + (field.limits.max || field.limits.min) + ");");
                this.newLine(buf);
            }
            else if (field.type == "Global") {
                this.write(buf,"do");

                this.indent();
                this.newLine(buf);

                this.write(buf,FUNC_VAR_HEADER);
                this.newLine(buf);
                
                // :thonk:
                let global_init_state: WASMFuncState = {
                    id: "__GLOBAL_INIT__", 
                    locals: [],
                    blocks: [],
                    regManager: new VirtualRegisterManager(),
                    varRemaps: new Map(),
                    stackData: [],
                    stackLevel: 1,
                };

                this.write(buf,this.processInstructions(field.init,global_init_state));
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

                this.write(buf,`local __TABLE_FUNCS_${table_index}__, __TABLE_OFFSET_${table_index}__;`);
                this.newLine(buf);

                this.write(buf,"do");

                this.indent();
                this.newLine(buf);

                this.write(buf,FUNC_VAR_HEADER);
                this.newLine(buf);
                
                // :thonk:
                let global_init_state: WASMFuncState = {
                    id: "__TABLE_INIT__", 
                    locals: [],
                    regManager: new VirtualRegisterManager(),
                    blocks: [],
                    varRemaps: new Map(),
                    stackData: [],
                    stackLevel: 1,
                };

                this.write(buf,this.processInstructions(field.offset,global_init_state));
                this.writeEx(buf,this.processInstructionsPass3(field.offset,global_init_state),-1);

                // bias the table offset so we can just use lua table indexing like lazy bastards
                this.write(buf,`__TABLE_OFFSET_${table_index}__ = `+this.getPop(global_init_state)+" - 1;");
                this.newLine(buf);

                this.outdent(buf);
                this.newLine(buf);

                this.write(buf,"end");
                this.newLine(buf);

                state.func_tables[table_index] = field.funcs;
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
                } else {
                    throw new Error("Bad offset on memory.");
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
            this.write(buf,`__TABLE_FUNCS_${table_index}__ = {`);
            let func_ids = table.map((func_index) => {
                let fstate = this.getFuncByIndex(state,func_index);
                if (!fstate) {
                    throw new Error("Unresolved table entry #"+func_index);
                }
                return fstate.id;
            });
            this.write(buf,func_ids.join(","));
            this.write(buf,"};");
            this.newLine(buf);
        });

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

    initFunc(node: Func | {signature: Signature,name: {value: string}}, state: WASMModuleState,renameTo?: string) {
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
            id: renameTo ? renameTo : sanitizeIdentifier(funcID),
            regManager: new VirtualRegisterManager(),
            locals: [],
            blocks: [],
            varRemaps: new Map(),
            funcType,
            modState: state,
            stackData: [],
            stackLevel: 1,
        };

        state.funcStates.push(fstate);
        state.funcByName.set(funcID,fstate);

        return fstate;
    }

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

        state.stackLevel = 1;

        this.write(buf,"function ");
        this.write(buf,state.id);
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

        if(node.signature.type == "Signature") {
            let i = 0;
            for(let param of node.signature.params) {
                let reg = state.regManager.createRegister(`arg${1}`);
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
        
        this.write(buf,FUNC_VAR_HEADER);
        this.newLine(buf);

        // PASS 1 & 2
        this.write(buf,this.processInstructions(node.body,state));
        this.writeEx(buf,this.processInstructionsPass3(node.body,state),-1);

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

        return buf.join("");
    }

    static instructionBinOpRemap: {[key: string] : {op: string, bool_result?: boolean, unsigned?: boolean}} = {
        add: {op:"+"},
        sub: {op:"-"},
        mul: {op:"*"},
        div: {op:"/"},

        eq: {op:"==",bool_result:true},
        ne: {op:"~=",bool_result:true},

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
        and: "bit.band",
        or: "bit.bor",
        xor: "bit.bxor",
        shl: "bit.lshift",
        shr_u: "bit.rshift", // logical shift
        shr_s: "bit.arshift", // arithmetic shift
        rotl: "bit.rol",
        rotr: "bot.ror"
    };

    beginBlock(buf: string[],state: WASMFuncState,block: WASMBlockState,customStart?: string) {
        // BLOCK BEGINS MUST BE CLOSED BY BLOCK ENDS!!!!
        // TODO: blocks can "return" stuff
        state.blocks.push(block);
        this.write(buf,sanitizeIdentifier(`::${block.id}_start::`));
        this.newLine(buf);
        if(typeof customStart === "string") {
            this.write(buf,customStart);
        }
        else {
            this.write(buf,"do");
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

    endBlock(buf: string[],state: WASMFuncState) {

        let block = state.blocks.pop();
        if(block) {
            this.endBlockInternal(buf,block,state);

            if(state.stackLevel > block.enterStackLevel) {
                this.writeLn(buf,"-- WARNING: a block as popped extra information into the stack.")
            }

            return true;
        }

        return false;
    }

    endBlockInternal(buf: string[],block: WASMBlockState,state: WASMFuncState) {
        block.hasClosed = true;
        this.outdent(buf);
        this.write(buf,"end");
        this.newLine(buf);
        this.write(buf,sanitizeIdentifier(`::${block.id}_fin::`));
        this.newLine(buf);

        if(block.blockType == "loop") {
            // reset stack to normal layout
            let popCnt = state.stackLevel - block.enterStackLevel;
            for(let i=0;i < popCnt;i++) {
                this.getPop(state);
            }
        }
        else if((block.blockType == "block") || (block.blockType == "if")) {
            // these blocks can return stuff
            if(block.resultType !== null) {
                this.write(buf,state.regManager.getPhysicalRegisterName(block.resultRegister) + " = " + this.getPop(state));
                this.newLine(buf);
                this.writeLn(buf,this.getPushStack(state,block.resultRegister));
                this.writeLn(buf,"-- BLOCK RET")
            }
            
            // reset stack to normal layout
            let popCnt = state.stackLevel - block.enterStackLevel;
            for(let i=0;i < popCnt;i++) {
                this.getPop(state);
            }
        }
    }

    processInstructions(insArr: Instruction[],state: WASMFuncState) {
        let buf = [];

        // PASS 1: compute local variable bounds to convert them into efficient virtual registers
        //////////////////////////////////////////////////////////////

        let insCount = 0;
        let insLastRefs: number[] = [];
        for(let ins of insArr) {
            insCount++;

            if(ins.type == "Instr") {
                switch(ins.id) {
                    case "local": {
                        // no-op (i think)
                        break;
                    }
                    case "get_local": {
                        let locID = (ins.args[0] as NumberLiteral).value;
                        insLastRefs[locID] = insCount;
                        
                        break;
                    }
                    case "set_local": {
                        let locID = (ins.args[0] as NumberLiteral).value;
                        insLastRefs[locID] = insCount;
                        
                        break;
                    }
                    case "tee_local": {
                        let locID = (ins.args[0] as NumberLiteral).value;
                        insLastRefs[locID] = insCount;
                        
                        break;
                    }
                }
            }
        }

        // PASS 2: emit instructions
        //////////////////////////////////////////////////////////////
        
        insCount = 0;
        for(let ins of insArr) {
            insCount++;

            // if(ins.type == "Instr") {
            //     this.write(buf,"-- LOOK "+ins.id+" "+JSON.stringify(ins));
            // }
            // else {
            //     this.write(buf,"-- LOOK (!) "+ins.type+" "+JSON.stringify(ins));
            // }
            // this.newLine(buf);

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
                                let _const = (ins.args[0] as LongNumberLiteral).value;
                                this.writeLn(buf,this.getPushStack(state,`__LONG_INT__(${_const.low},${_const.high})`));
                            }
                            else {
                                let _const = (ins.args[0] as NumberLiteral).value;
                                this.writeLn(buf,this.getPushStack(state,_const.toString()));
                            }
                            break;
                        }
                        case "get_global": {
                            let globID = (ins.args[0] as NumberLiteral).value;
                            this.writeLn(buf,this.getPushStack(state,"__GLOBALS__["+globID+"]"));
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
                                state.locals[locID] = state.regManager.createRegister(`loc${locID}`);
                                state.locals[locID].firstRef = insCount;
                            }
                            state.locals[locID].lastRef = insCount;

                            this.writeLn(buf,this.getPushStack(state,state.locals[locID]));

                            if(insCount == insLastRefs[locID]) {
                                state.regManager.freeRegister(state.locals[locID]);
                            }

                            break;
                        }
                        case "set_local": {
                            let locID = (ins.args[0] as NumberLiteral).value;
                            if(!state.locals[locID]) {
                                state.locals[locID] = state.regManager.createRegister(`loc${locID}`);
                                state.locals[locID].firstRef = insCount;
                            }
                            state.locals[locID].lastRef = insCount;

                            this.write(buf,state.regManager.getPhysicalRegisterName(state.locals[locID]));
                            this.write(buf," = "+this.getPop(state)+";");
                            this.newLine(buf);

                            if(insCount == insLastRefs[locID]) {
                                state.regManager.freeRegister(state.locals[locID]);
                            }

                            break;
                        }
                        case "tee_local": {
                            let locID = (ins.args[0] as NumberLiteral).value;
                            if(!state.locals[locID]) {
                                state.locals[locID] = state.regManager.createRegister(`loc${locID}`);
                                state.locals[locID].firstRef = insCount;
                            }
                            state.locals[locID].lastRef = insCount;

                            // write local
                            this.write(buf,state.regManager.getPhysicalRegisterName(state.locals[locID]));
                            this.write(buf," = "+this.getPop(state)+" ; ");
                            // read back
                            this.writeLn(buf,this.getPushStack(state,state.locals[locID]));

                            if(insCount == insLastRefs[locID]) {
                                state.regManager.freeRegister(state.locals[locID]);
                            }

                            break;
                        }
                        // Arithmetic
                        //////////////////////////////////////////////////////////////
                        case "sqrt": {
                            this.writeLn(buf,this.getPushStack(state,`math.sqrt(${this.getPop(state)})`));

                            break;
                        }
                        case "neg": {
                            this.writeLn(buf,this.getPushStack(state,`-(${this.getPop(state)})`));

                            break;
                        }
                        case "add":
                        case "sub":
                        case "mul":
                        case "div":
                        case "eq":
                        case "ne":
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

                            this.write(buf,"__TMP__ = ");
                            this.write(buf,this.getPop(state));
                            this.write(buf,"; ");
                            this.write(buf,"__TMP2__ = ");
                            this.write(buf,this.getPop(state));
                            this.write(buf,"; ");
                            this.write(buf,this.getPushStack(state));
                            if (convert_bool) {
                                if (unsigned) {
                                    this.write(buf,"(__UNSIGNED__(__TMP2__) "+op+" __UNSIGNED__(__TMP__)) and 1 or 0");
                                } else {
                                    this.write(buf,"(__TMP2__ "+op+" __TMP__) and 1 or 0");
                                }
                            } else if (ins.object=="i32") {
                                // i32 arithmetic ops need normalized
                                // i32 bit ops already normalize results
                                // other types shouldn't need to be normalized
                                this.write(buf,"bit.tobit(__TMP2__ "+op+" __TMP__)");
                            } else {
                                this.write(buf,"__TMP2__ "+op+" __TMP__");
                            }
                            this.write(buf,";");
                            this.newLine(buf);
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
                        {
                            if (ins.object=="i32") {
                                let op_func = wasm2lua.instructionBinOpFuncRemap[ins.id];
    
                                this.write(buf,"__TMP__ = ");
                                this.write(buf,this.getPop(state));
                                this.write(buf,"; ");
                                this.write(buf,"__TMP2__ = ");
                                this.write(buf,this.getPop(state));
                                this.write(buf,"; ");
                                this.write(buf,this.getPushStack(state));
                                this.write(buf,op_func);
                                this.write(buf,"(__TMP2__,__TMP__);");
                            } else if (ins.object=="i64") {
                                this.write(buf,"__TMP__ = ");
                                this.write(buf,this.getPop(state));
                                this.write(buf,"; ");
                                this.write(buf,"__TMP2__ = ");
                                this.write(buf,this.getPop(state));
                                this.write(buf,"; ");
                                this.write(buf,this.getPushStack(state));
                                this.write(buf,`__TMP2__:_${ins.id}(__TMP__);`);
                            } else {
                                this.write(buf,"error('BIT OP ON UNSUPPORTED TYPE: "+ins.object+","+ins.id+"');");
                            }
                            this.newLine(buf);

                            break;
                        }
                        case "eqz": {
                            this.write(buf,"__TMP__ = ");
                            this.write(buf,this.getPop(state));
                            this.write(buf,"; ");
                            this.write(buf,this.getPushStack(state));
                            this.write(buf,"(__TMP__==0) and 1 or 0;");
                            this.newLine(buf);
                            break;
                        }
                        case "select": {
                            // Freaking ternary op. This is a dumb way to compile this
                            // but it allows us to handle it without adding another temp var.

                            this.write(buf,"__TMP__ = ");
                            this.write(buf,this.getPop(state));
                            this.write(buf,"; ");
                            
                            this.write(buf,"if __TMP__==0 then ");
                            this.write(buf,"__TMP2__="+this.getPop(state)+"; ");
                            this.stackDrop(state);
                            this.write(buf,this.getPushStack(state)+"__TMP2__ ");
                            this.write(buf,"end;");
                            this.newLine(buf);
                            break;
                        }
                        case "drop": {
                            this.stackDrop(state);
                            this.write(buf,"-- stack drop");
                            this.newLine(buf);
                            break;
                        }
                        // Type Conversions
                        //////////////////////////////////////////////////////////////
                        case "promote/f32":
                        case "demote/f64":
                            // These are no-ops.
                            break;
                        case "extend_u/i32": {
                            // Easy (signed extension will be slightly more of a pain)
                            this.write(buf,`__TMP__=${this.getPop(state)}; `);
                            this.write(buf,`${this.getPushStack(state)}__LONG_INT__(__TMP__,0);`);
                            this.newLine(buf);
                            break;
                        }
                        // Branching
                        //////////////////////////////////////////////////////////////
                        case "br_if": {
                            this.write(buf,"if ");
                            this.write(buf,this.getPop(state));
                            this.write(buf,"~=0 then ");

                            let blocksToExit = (ins.args[0] as NumberLiteral).value;
                            let targetBlock = state.blocks[state.blocks.length - blocksToExit - 1];

                            if(targetBlock) {
                                this.write(buf,"goto ")
                                if(targetBlock.blockType == "loop") {
                                    this.write(buf,sanitizeIdentifier(`${targetBlock.id}_start`));
                                }
                                else {
                                    this.write(buf,sanitizeIdentifier(`${targetBlock.id}_fin`));
                                }
                            }
                            else {
                                this.write(buf,"goto ____UNRESOLVED_DEST____");
                            }

                            this.write(buf," end;");
                            this.newLine(buf);
                            break;
                        }
                        case "br": {
                            let blocksToExit = (ins.args[0] as NumberLiteral).value;
                            let targetBlock = state.blocks[state.blocks.length - blocksToExit - 1];

                            if(targetBlock) {
                                this.write(buf,"goto ")
                                if(targetBlock.blockType == "loop") {
                                    this.write(buf,sanitizeIdentifier(`${targetBlock.id}_start`));
                                }
                                else {
                                    this.write(buf,sanitizeIdentifier(`${targetBlock.id}_fin`));
                                }
                            }
                            else {
                                this.write(buf,"goto ____UNRESOLVED_DEST____");
                            }

                            this.write(buf,";");
                            this.newLine(buf);
                            break;
                        }
                        // Memory
                        //////////////////////////////////////////////////////////////
                        case "store":
                        case "store8":
                        case "store16": 
                        case "store32": {
                            let targ = state.modState.memoryAllocations.get(0);
                            // TODO: is target always 0?

                            if(targ) {
                                this.write(buf,"__TMP__ = ");
                                this.write(buf,this.getPop(state));
                                this.write(buf,"; ");
                                this.write(buf,"__TMP2__ = ");
                                this.write(buf,this.getPop(state));
                                this.write(buf,"; ");

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
                                    this.write(buf,`(${targ},__TMP2__+${(ins.args[0] as NumberLiteral).value},__TMP__);`);
                                } else if (ins.object == "u64") {
                                    this.write(buf,`__TMP__:${ins.id}(${targ},__TMP2__+${(ins.args[0] as NumberLiteral).value});`);
                                } else if (ins.object == "f32") {
                                    this.write(buf,"__MEMORY_WRITE_32F__");
                                    this.write(buf,`(${targ},__TMP2__+${(ins.args[0] as NumberLiteral).value},__TMP__);`);
                                } else if (ins.object == "f64") {
                                    this.write(buf,"__MEMORY_WRITE_64F__");
                                    this.write(buf,`(${targ},__TMP2__+${(ins.args[0] as NumberLiteral).value},__TMP__);`);
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
                            let targ = state.modState.memoryAllocations.get(0);
                            // TODO: is target always 0?

                            if(targ) {
                                this.write(buf,"__TMP__ = ");
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
                                    this.write(buf,`(${targ},${this.getPop(state)}+${(ins.args[0] as NumberLiteral).value});`);
                                    if (ins.id.endsWith("_s") && ins.id != "load32_s") {
                                        let shift: number;
                                        if (ins.id == "load8_s") {
                                            shift = 24;
                                        } else if (ins.id == "load16_s") {
                                            shift = 16;
                                        } else {
                                            throw new Error("signed load "+ins.id);
                                        }

                                        this.write(buf,`__TMP__=bit.arshift(bit.lshift(__TMP__,${shift}),${shift});`);
                                    }
                                } else if (ins.object == "u64") {
                                    // todo rewrite this trash
                                    if (ins.id == "load") {
                                        this.write(buf,`__LONG_INT__(0,0); __TMP__:${ins.id}(${targ},${this.getPop(state)}+${(ins.args[0] as NumberLiteral).value});`);
                                    } else {
                                        throw new Error("narrow u64 loads NYI "+ins.id);
                                    }
                                } else if (ins.object == "f32") {
                                    this.write(buf,"__MEMORY_READ_32F__");
                                    this.write(buf,`(${targ},${this.getPop(state)}+${(ins.args[0] as NumberLiteral).value});`);
                                } else if (ins.object == "f64") {
                                    this.write(buf,"__MEMORY_READ_64F__");
                                    this.write(buf,`(${targ},${this.getPop(state)}+${(ins.args[0] as NumberLiteral).value});`);
                                } else {
                                    this.write(buf,"0 -- WARNING: UNSUPPORTED MEMORY OP ON TYPE: "+ins.object);
                                    this.newLine(buf);
                                    break;
                                }

                                if (is_narrow_u64_load) {
                                    if (ins.id.endsWith("_s")) {
                                        this.write(buf,"__TMP__=__LONG_INT__(__TMP__,-1);");
                                    } else {
                                        this.write(buf,"__TMP__=__LONG_INT__(__TMP__,0);");
                                    }
                                }

                                this.write(buf,this.getPushStack(state) + "__TMP__;");
                                this.newLine(buf);
                            }
                            else {
                                this.write(buf,"-- WARNING: COULD NOT FIND MEMORY TO READ");
                                this.newLine(buf);
                            }

                            break;
                        }
                        case "grow_memory": {
                            let targ = state.modState.memoryAllocations.get(0);
                            // TODO: is target always 0?

                            this.write(buf,`__TMP__ = __MEMORY_GROW__(${targ},__UNSIGNED__(${this.getPop(state)})); `);
                            this.write(buf,`${this.getPushStack(state)}__TMP__;`);
                            this.newLine(buf);
                            break;
                        }
                        // Misc
                        //////////////////////////////////////////////////////////////
                        case "return": {
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
                            break;
                        }
                        case "end": {
                            this.endBlock(buf,state);
                            break;
                        }
                        case "unreachable": {
                            this.write(buf,"error('unreachable');");
                            this.newLine(buf);
                            break;
                        }
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
                    if(fstate && fstate.funcType) {
                        this.writeFunctionCall(state,buf,fstate.id,fstate.funcType);
                        this.newLine(buf);
                    }
                    else {
                        //this.write(buf,"-- WARNING: UNABLE TO RESOLVE CALL " + ins.index.value + " (TODO ARG/RET)");
                        this.write(buf,`error("UNRESOLVED CALL: ${ins.index.value}")`);
                        this.newLine(buf);
                    }
                    break;
                }
                case "CallIndirectInstruction": {

                    let table_index = 0;

                    let func = `__TABLE_FUNCS_${table_index}__[__TABLE_OFFSET_${table_index}__+${this.getPop(state)}]`;
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
                        id: ins.label.value,
                        resultType: (ins.type == "LoopInstruction") ? null : ins.result, 
                        blockType,
                        enterStackLevel: state.stackLevel,
                    });

                    if(block.resultType !== null) {
                        block.resultRegister = state.regManager.createTempRegister();
                    }

                    this.write(buf,this.processInstructions(ins.instr,state));
                    break;
                }
                case "IfInstruction": {
                    this.write(buf,"-- <IF>");
                    this.newLine(buf);

                    if(ins.test.length > 0) {
                        this.write(buf,"-- WARNING: 'if test' present, and was not handled");
                        this.newLine(buf);
                    }
                    
                    let ifBlock = this.beginBlock(buf,state,{
                        id: `if_${ins.loc.start.line}_${ins.loc.start.column}`,
                        blockType: "if",
                        resultType: ins.result,
                        enterStackLevel: state.stackLevel,
                    },`if ${this.getPop(state)} then`);

                    if(ifBlock.resultType !== null) {
                        ifBlock.resultRegister = state.regManager.createTempRegister();
                    }

                    this.write(buf,this.processInstructions(ins.consequent,state));
                    
                    // sometimes blocks arent ended so we manually end em
                    this.endBlocksUntil(buf,state,ifBlock);

                    if(ins.alternate.length > 0) {
                        this.outdent();
                        this.write(buf,"else")
                        this.indent();
                        this.newLine(buf);

                        this.write(buf,this.processInstructions(ins.alternate,state));
                    }
                    
                    this.endBlocksUntilEx(buf,state,ifBlock); // ditto above

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
        }

        return buf.join("");
    }

    processInstructionsPass3(insArr: Instruction[],state: WASMFuncState) {
        // PASS 3: emit register header
        //////////////////////////////////////////////////////////////

        let t_buf: string[] = [];

        if((state.regManager.totalRegisters - (state.funcType ? state.funcType.params.length : 0)) > 0) {
            this.write(t_buf,"local ");
            for(let i=(state.funcType ? state.funcType.params.length : 0);i < state.regManager.totalRegisters;i++) {
                this.write(t_buf,`reg${i}`);
                if(i !== (state.regManager.totalRegisters - 1)) {
                    this.write(t_buf,",");
                }
            }

            if(state.regManager.totalRegisters > 150) {
                console.log(`${state.id}: WARNING: ${state.regManager.totalRegisters} REGISTERS USED`);
            }

            this.write(t_buf,";");
            this.newLine(t_buf);
        }

        return t_buf.join("");
    }

    writeFunctionCall(state: WASMFuncState, buf: string[], func: string, sig: Signature) {
        if(sig.results.length > 1) {
            this.write(buf,"__TMP__ = {");
        }
        else {
            this.write(buf,"__TMP__ = ");
        }

        this.write(buf,func + "(");
        let args: string[] = [];
        for(let i=0;i < sig.params.length;i++) {
            args.push(this.getPop(state));
        }
        this.write(buf,args.reverse().join(","));
        this.write(buf,")");

        if(sig.results.length > 1) {
            this.write(buf,"};");
            for(let i=0;i < sig.results.length;i++) {
                this.write(buf,this.getPushStack(state));
                this.write(buf,"__TMP__[" + (i+1) + "];");
            }
        }
        else {
            this.write(buf,"; " + this.getPushStack(state) + " __TMP__;");
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
            default: {
                throw new Error("TODO - Export - " + node.descr.exportType);
                break;
            }
        }
        this.write(buf,";");
        this.newLine(buf);

        return buf.join("");
    }

    processModuleImport(node: ModuleImport,modState: WASMModuleState) {
        let buf = [];

        switch(node.descr.type) {
            case "Memory": {
                let memID = `__MODULES__.${node.module}.${node.name}`
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
                },modState,`__MODULES__.${node.module}.${node.name}`);

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

// Allow custom in/out file while defaulting to swad's meme :)
// let infile  = process.argv[2] || (__dirname + "/../test/addTwo.wasm");
// let infile  = process.argv[2] || (__dirname + "/../test/ammo.wasm");
// let infile  = process.argv[2] || (__dirname + "/../test/dispersion.wasm");
// let infile  = process.argv[2] || (__dirname + "/../test/call_code.wasm");
// let infile  = process.argv[2] || (__dirname + "/../test/test.wasm");
let infile  = process.argv[2] || (__dirname + "/../test/testwasi.wasm");
// let infile  = process.argv[2] || (__dirname + "/../test/testorder.wasm");
// let infile  = process.argv[2] || (__dirname + "/../test/testorder2.wasm");
// let infile  = process.argv[2] || (__dirname + "/../test/testorder3.wasm");
// let infile  = process.argv[2] || (__dirname + "/../test/testorder5.wasm");
// let infile  = process.argv[2] || (__dirname + "/../test/testswitch.wasm");
let outfile = process.argv[3] || (__dirname + "/../test/test.lua");
let whitelist = process.argv[4] ? process.argv[4].split(",") : null;

let wasm = fs.readFileSync(infile);

// console.log(JSON.stringify(ast,null,4));

let inst = new wasm2lua(wasm, {whitelist});
fs.writeFileSync(outfile,inst.outBuf.join(""));

import {decode} from "@webassemblyjs/wasm-parser"
import * as fs from "fs"
import { isArray, print } from "util";

// TODO: Imported globals use global IDs that precede other global IDs
// TODO: ^ The same applies to memories. ^

/* TODO TYPES:

- Assume that anything on the stack is already normalized to the correct type.
- Some ops require normalization (add, sub, mul), while others do not (and, or).
- Comparison ops should be normalized (bool -> i32(?)).
- Many ops (comparisons, divisions, and shifts) are sign-dependant. This may be difficult to implement.
- i64 will be a pain, but may be necessary due to runtime usage.
- f32/f64 will be easy to implement, but very hard to read/write to memory in a way friendly to the jit. Soft floats are a potential last resort.
- Signed loads still need sign extended, unsigned loads need to do what signed loads currently do.

*/

/* TODO OPTIMIZATION:

- Memory: Use 32 bits per table cell instead of 8, more is possible but probably a bad idea.
- Might want to use actual loops, might be more jit friendly.

*/

class ArrayMap<T> extends Map<string | number,T> {
    numSize = 0;

    set(k: string | number,v: T) {
        super.set(k,v);

        if(typeof k === "number") {
            if(k === this.numSize) {
                if((typeof v !== "undefined") && (v !== null)) {
                    this.numSize++;
                }
            }
            else if(k === (this.numSize - 1)) {
                if((typeof v === "undefined") || (v === null)) {
                    this.numSize--;
                }
            }
        }

        return this;
    }

    push(v: T) {
        this.set(this.numSize,v);
    }

    pop() {
        super.set(this.numSize - 1,undefined);
    }
}

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
        .replace(/\./g,"__IDENT_CHAR_DOT__");
}

interface WASMModuleState {
    funcStates: WASMFuncState[];
    funcByName: Map<string,WASMFuncState>;
    memoryAllocations: ArrayMap<string>;

    nextGlobalIndex: number;
}

interface WASMFuncState {
    id: string;
    locals: string[];
    blocks: WASMBlockState[];
    varRemaps: Map<string,string>;
    // stack: StackEntry[] // TODO: use this to fold the stack;
    funcType?: Signature;
    modState?: WASMModuleState;
}

interface WASMBlockState {
    id: string;
    blockType: "block" | "loop" | "if";
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

    constructor(public ast: Program,private options: WASM2LuaOptions = {}) {
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

    writeHeader(buf: string[]) {
        this.write(buf,wasm2lua.fileHeader);
        this.newLine(buf);
    }

    getPushStack() {
        return "__STACK__[#__STACK__ + 1] = ";
    }

    getPop() {
        return "__STACK_POP__(__STACK__)";
    }

    process() {
        this.writeHeader(this.outBuf);

        for(let mod of this.ast.body) {
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
                this.write(buf,this.processModuleImport(field,state));
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
                this.write(buf,"do -- global "+state.nextGlobalIndex);

                this.indent();
                this.newLine(buf);

                this.write(buf,FUNC_VAR_HEADER);
                this.newLine(buf);
                
                // :thonk:
                let global_init_state: WASMFuncState = {
                    id: "__GLOBAL_INIT__", 
                    locals: [],
                    blocks: [],
                    varRemaps: new Map(),
                };

                this.write(buf,this.processInstructions(field.init,global_init_state));

                this.write(buf,"__GLOBALS__["+state.nextGlobalIndex+"] = "+this.getPop()+";");

                this.outdent(buf);

                this.newLine(buf);

                this.write(buf,"end");
                this.newLine(buf);

                state.nextGlobalIndex++;
            }
            else if (field.type == "Elem") {
                console.log(">>>",field);
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

        return buf.join("");
    }

    processModuleMetadataSection(node: SectionMetadata) {
        // TODO: is ignoring this the right thing to do?
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
            funcID = "func_u" + state.funcStates.length;
        }

        let fstate: WASMFuncState = {
            id: renameTo ? renameTo : sanitizeIdentifier(funcID),
            locals: [],
            blocks: [],
            varRemaps: new Map(),
            funcType,
            modState: state,
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
                this.write(buf,`arg${i}`);
                state.locals[i] = `arg${i}`;

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

        this.write(buf,this.processInstructions(node.body,state));

        this.endAllBlocks(buf,state);
        
        this.write(buf,"do return ");

        let nRets = state.funcType ? state.funcType.results.length : 0;
        for(let i=0;i < nRets;i++) {
            this.write(buf,this.getPop());
            if(nRets !== (i + 1)) {
                this.write(buf,",");
            }
        }

        this.write(buf,"; end;");
        this.newLine(buf);

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
    };

    beginBlock(buf: string[],state: WASMFuncState,block: WASMBlockState) {
        // BLOCK BEGINS MUST BE CLOSED BY BLOCK ENDS!!!!
        // TODO: blocks can "return" stuff
        this.write(buf,`::${block.id}_start::`);
        state.blocks.push(block);
        this.newLine(buf);
        this.write(buf,"do");
        this.indent();
        this.newLine(buf);
    }

    endAllBlocks(buf: string[],state: WASMFuncState) {
        while(state.blocks.length > 0) {
            this.endBlock(buf,state);
        }
    }

    endBlock(buf: string[],state: WASMFuncState) {

        let block = state.blocks.pop();
        if(block) {
            this.endBlockInternal(buf,block);
            return true;
        }

        return false;
    }

    endBlockInternal(buf: string[],block: WASMBlockState) {
        this.outdent(buf);
        this.write(buf,"end");
        this.newLine(buf);
        this.write(buf,`::${block.id}_fin::`);
        this.newLine(buf);
    }

    processInstructions(insArr: Instruction[],state: WASMFuncState) {
        let buf = [];
        
        for(let ins of insArr) {
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
                            if(ins.args.length > 0) {
                                this.write(buf,"local ");
                                let i = 0;
                                for(let loc of ins.args) {
                                    i++;
                                    this.write(buf,`loc${state.locals.length}`);
                                    state.locals.push(`loc${state.locals.length}`);
                                    if(i !== ins.args.length) {
                                        this.write(buf,",");
                                    }
                                }
                                this.write(buf,";");
                            }
                            this.newLine(buf);
                            break;
                        }
                        case "const": {
                            if(ins.args[0].type == "LongNumberLiteral") {
                                let _const = (ins.args[0] as LongNumberLiteral).value;
                                this.write(buf,this.getPushStack());
                                this.write(buf,`__LONG_INT__(${_const.low},${_const.high});`);
                                this.newLine(buf);
                            }
                            else {
                                let _const = (ins.args[0] as NumberLiteral).value;
                                this.write(buf,this.getPushStack());
                                this.write(buf,_const.toString());
                                this.write(buf,";");
                                this.newLine(buf);
                            }
                            break;
                        }
                        case "get_global": {
                            let globID = (ins.args[0] as NumberLiteral).value;
                            this.write(buf,this.getPushStack());
                            this.write(buf,"__GLOBALS__["+globID+"]");
                            this.write(buf,";");
                            this.newLine(buf);
                            break;
                        }
                        case "set_global": {
                            let globID = (ins.args[0] as NumberLiteral).value;
                            this.write(buf,"__GLOBALS__["+globID+"] = "+this.getPop()+";");
                            this.newLine(buf);
                            break;
                        }
                        case "get_local": {
                            let locID = (ins.args[0] as NumberLiteral).value;
                            this.write(buf,this.getPushStack());
                            this.write(buf,state.locals[locID] || `loc${locID}`);
                            this.write(buf,";");
                            this.newLine(buf);
                            break;
                        }
                        case "set_local": {
                            let locID = (ins.args[0] as NumberLiteral).value;
                            this.write(buf,state.locals[locID] || `loc${locID}`);
                            this.write(buf," = "+this.getPop()+";");
                            this.newLine(buf);
                            break;
                        }
                        case "tee_local": {
                            let locID = (ins.args[0] as NumberLiteral).value;
                            // write local
                            this.write(buf,state.locals[locID] || `loc${locID}`);
                            this.write(buf," = "+this.getPop()+" ; ");
                            // read back
                            this.write(buf,this.getPushStack());
                            this.write(buf,state.locals[locID] || `loc${locID}`);
                            this.write(buf,";");
                            this.newLine(buf);
                            break;
                        }
                        // Arithmetic
                        //////////////////////////////////////////////////////////////
                        case "add":
                        case "sub":
                        case "mul":
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
                            let unsigned = true;

                            this.write(buf,"__TMP__ = ");
                            this.write(buf,this.getPop());
                            this.write(buf,"; ");
                            this.write(buf,"__TMP2__ = ");
                            this.write(buf,this.getPop());
                            this.write(buf,"; ");
                            this.write(buf,this.getPushStack());
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
                        {
                            if (ins.object=="i32") {
                                let op_func = wasm2lua.instructionBinOpFuncRemap[ins.id];
    
                                this.write(buf,"__TMP__ = ");
                                this.write(buf,this.getPop());
                                this.write(buf,"; ");
                                this.write(buf,"__TMP2__ = ");
                                this.write(buf,this.getPop());
                                this.write(buf,"; ");
                                this.write(buf,this.getPushStack());
                                this.write(buf,op_func);
                                this.write(buf,"(__TMP2__,__TMP__);");
                            } else {
                                this.write(buf,"-- BIT OP ON UNSUPPORTED TYPE: "+ins.object);
                            }
                            this.newLine(buf);

                            break;
                        }
                        case "eqz": {
                            this.write(buf,"__TMP__ = ");
                            this.write(buf,this.getPop());
                            this.write(buf,"; ");
                            this.write(buf,this.getPushStack());
                            this.write(buf,"(__TMP__==0) and 1 or 0;");
                            this.newLine(buf);
                            break;
                        }
                        case "select": {
                            // Freaking ternary op. This is a dumb way to compile this
                            // but it allows us to handle it without adding another temp var.

                            this.write(buf,"__TMP__ = ");
                            this.write(buf,this.getPop());
                            this.write(buf,"; ");
                            
                            this.write(buf,"if __TMP__~=0 then "+this.getPop()+" ");
                            this.write(buf,"else __TMP2__="+this.getPop()+"; "+this.getPop()+"; "+this.getPushStack()+"__TMP2__ ");
                            this.write(buf,"end;");
                        }

                        // Type Conversions
                        //////////////////////////////////////////////////////////////
                        case "promote/f32":
                        case "demote/f64":
                            // These are no-ops.
                            break;

                        // Branching
                        //////////////////////////////////////////////////////////////
                        case "br_if": {
                            this.write(buf,"if ");
                            this.write(buf,this.getPop());
                            this.write(buf,"~=0 then ");

                            let blocksToExit = (ins.args[0] as NumberLiteral).value;
                            let targetBlock = state.blocks[state.blocks.length - blocksToExit - 1];

                            if(targetBlock) {
                                this.write(buf,"goto ")
                                if(targetBlock.blockType == "loop") {
                                    this.write(buf,`${targetBlock.id}_start`);
                                }
                                else {
                                    this.write(buf,`${targetBlock.id}_fin`);
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
                                    this.write(buf,`${targetBlock.id}_start`);
                                }
                                else {
                                    this.write(buf,`${targetBlock.id}_fin`);
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
                                this.write(buf,this.getPop());
                                this.write(buf,"; ");
                                this.write(buf,"__TMP2__ = ");
                                this.write(buf,this.getPop());
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
                                    this.write(buf,`__TMP__.${ins.id}(${targ},__TMP2__+${(ins.args[0] as NumberLiteral).value});`);
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
                        case "load32_s": {
                            let targ = state.modState.memoryAllocations.get(0);
                            // TODO: is target always 0?

                            if(targ) {
                                this.write(buf,"__TMP__ = ");
                                if (ins.object == "u32") {
                                    if(ins.id == "load16_s") {
                                        this.write(buf,"__MEMORY_READ_16__");
                                    }
                                    else if(ins.id == "load8_s") {
                                        this.write(buf,"__MEMORY_READ_8__");
                                    }
                                    else {
                                        this.write(buf,"__MEMORY_READ_32__");
                                    }
                                    this.write(buf,`(${targ},${this.getPop()}+${(ins.args[0] as NumberLiteral).value});`);
                                } else if (ins.object == "u64") {
                                    this.write(buf,`__LONG_INT__(0,0); __TMP__.${ins.id}(${targ},${this.getPop()}+${(ins.args[0] as NumberLiteral).value});`);
                                } else {
                                    this.write(buf,"0 -- WARNING: UNSUPPORTED MEMORY OP ON TYPE: "+ins.object);
                                    this.newLine(buf);
                                    break;
                                }
                                this.write(buf,this.getPushStack() + "__TMP__;");
                                this.newLine(buf);
                            }
                            else {
                                this.write(buf,"-- WARNING: COULD NOT FIND MEMORY TO READ");
                                this.newLine(buf);
                            }

                            break;
                        }
                        case "return": {
                            this.write(buf,"do return ");

                            let nRets = state.funcType ? state.funcType.results.length : 0;
                            for(let i=0;i < nRets;i++) {
                                this.write(buf,this.getPop());
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
                            this.write(buf,"-- TODO "+ins.id+" "+JSON.stringify(ins));
                            this.newLine(buf);
                            break;
                        }
                    }
                    break;
                }
                case "CallInstruction": {
                    let fstate = this.getFuncByIndex(state.modState,ins.index);
                    if(fstate && fstate.funcType) {
                        if(fstate.funcType.results.length > 1) {
                            this.write(buf,"__TMP__ = {");
                        }
                        else {
                            this.write(buf,"__TMP__ = ");
                        }

                        this.write(buf,fstate.id + "(");
                        for(let i=0;i < fstate.funcType.params.length;i++) {
                            this.write(buf,this.getPop());
                            if(i !== (fstate.funcType.params.length - 1)) {
                                this.write(buf,",");
                            }
                        }
                        this.write(buf,")");

                        if(fstate.funcType.results.length > 1) {
                            this.write(buf,"};");
                            for(let i=0;i < fstate.funcType.results.length;i++) {
                                this.write(buf,this.getPushStack());
                                this.write(buf,"__TMP__[" + (i+1) + "];");
                            }
                        }
                        else {
                            this.write(buf,"; " + this.getPushStack() + " __TMP__;");
                        }

                        this.newLine(buf);
                    }
                    else {
                        this.write(buf,"-- WARNING: UNABLE TO RESOLVE CALL " + ins.index.value + " (TODO ARG/RET)");
                        this.newLine(buf);
                    }
                    break;
                }
                case "BlockInstruction":
                case "LoopInstruction": {
                    let blockType: "loop"|"block" = (ins.type == "LoopInstruction") ? "loop" : "block";

                    this.beginBlock(buf,state,{
                        id: ins.label.value,
                        blockType,
                    });

                    this.write(buf,this.processInstructions(ins.instr,state));
                    break;
                }
                case "IfInstruction": {
                    if(ins.test.length > 0) {
                        this.write(buf,"-- WARNING: 'if test' present, and was not handled");
                        this.newLine(buf);
                    }

                    this.write(buf,"if ");
                    this.write(buf,this.getPop());
                    this.write(buf," then");
                    
                    this.beginBlock(buf,state,{
                        id: `if_${ins.loc.start.line}_${ins.loc.start.column}`,
                        blockType: "if",
                    });

                    this.indent();
                    this.newLine(buf);

                    this.processInstructions(ins.consequent,state);
                    
                    this.outdent(buf);

                    if(ins.alternate.length > 0) {
                        this.write(buf,"else")
                        this.indent();
                        this.newLine(buf);
                    
                        this.beginBlock(buf,state,{
                            id: `else_${ins.loc.start.line}_${ins.loc.start.column}`,
                            blockType: "if",
                        });

                        this.processInstructions(ins.alternate,state);
                        
                        this.outdent(buf);
                    }

                    this.write(buf,"end");
                    this.newLine(buf);

                    break;
                }
                default: {
                    this.write(buf,"-- TODO (!) "+ins.type+" "+JSON.stringify(ins));
                    this.newLine(buf);
                    break;
                }
            }
        }

        return buf.join("");
    }

    processModuleExport(node: ModuleExport,modState: WASMModuleState) {
        let buf = [];

        this.write(buf,"__EXPORTS__.");
        this.write(buf,node.name)
        this.write(buf," = ");

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
                    name: {value: node.descr.id},
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
let infile  = process.argv[2] || (__dirname + "/../test/test.wasm");
let outfile = process.argv[3] || (__dirname + "/../test/test.lua");
var whitelist = process.argv[4] ? process.argv[4].split(",") : null;

let wasm = fs.readFileSync(infile)
let ast = decode(wasm,{
    // dump: true,
})

// console.log(JSON.stringify(ast,null,4));

let inst = new wasm2lua(ast,{whitelist});
fs.writeFileSync(outfile,inst.outBuf.join(""));

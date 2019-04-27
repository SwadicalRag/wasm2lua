import {decode} from "@webassemblyjs/wasm-parser"
import * as fs from "fs"

interface WASMModuleState {
    funcStates: WASMFuncState[];
    funcByName: Map<string,WASMFuncState>;
}

interface WASMFuncState {
    id: string;
    locals: string[];
    blocks: WASMBlockState[];
    varRemaps: Map<string,string>;
}

interface WASMBlockState {
    id: string;
    blockType: "block" | "loop" | "if";
}

export class wasm2lua {
    outBuf: string[] = [];
    indentLevel = 0;
    // funcTypes: any[] = [];
    moduleStates: WASMModuleState[] = [];
    globalRemaps: Map<string,string>;

    constructor(public ast: Program) {
        this.process()
    }

    assert(cond: any,err: string = "assertion failed") {
        if(!cond) {
            throw new Error(err);
        }
    }

    indent() {this.indentLevel++;}
    outdent() {this.indentLevel--;}

    newLine() {
        this.outBuf.push("\n" + (("    ").repeat(this.indentLevel)));
    }

    write(str) {this.outBuf.push(str);}

    writeHeader() {
        this.write("__MODULES__ = __MODULES__ or {};");
        this.newLine();
        this.write("__GLOBALS__ = __GLOBALS__ or {};");
        this.newLine();
        this.write("local __TMP__,__STACK__ = nil,{};");
        this.newLine();
        this.write("local function __STACK_POP__()local v=__STACK__[#__STACK__];__STACK__[#__STACK__]=nil;return v;end;");
        this.newLine();
    }

    getPushStack() {
        return "__STACK__[#__STACK__ + 1] = ";
    }

    getPop() {
        return "__STACK_POP__()";
    }

    process() {
        this.writeHeader();

        for(let mod of this.ast.body) {
            if(mod.type == "Module") {
                this.write("do");
                this.indent();
                this.newLine();
                this.processModule(mod);
                this.outdent();
                this.newLine();
                this.write("end");
                this.newLine();
            }
            else {
                throw new Error("TODO");
            }
        }
    }

    processModule(node: Module) {
        let state: WASMModuleState = {
            funcStates: [],
            funcByName: new Map(),
        };

        if(node.id) {
            this.write("local __EXPORTS__ = {};")
            this.newLine();
            this.write("__MODULES__." + node.id + " = __EXPORTS__");
            this.newLine();
        }
        else {
            this.write("__MODULES__.UNKNOWN = __MODULES__.UNKNOWN or {}");
            this.newLine();
            this.write("local __EXPORTS__ = __MODULES__.UNKNOWN;")
            this.newLine();
        }

        for(let section of node.metadata.sections) {
            this.processModuleMetadataSection(section);
        }
        
        for(let field of node.fields) {
            if(field.type == "TypeInstruction") {
                this.processTypeInstruction(field);
            }
            else if(field.type == "Func") {
                this.processFunc(field,state);
            }
            else if(field.type == "ModuleExport") {
                this.processModuleExport(field,state);
            }
            else if(field.type == "ModuleImport") {
                this.processModuleImport(field,state);
            }
            else if (field.type == "Table") {
                console.log(">>>",field);
            }
            else if (field.type == "Memory") {
                console.log(">>>",field);
            }
            else if (field.type == "Global") {
                this.write("-- global");
                this.indent();
                this.newLine();
                
                // :thonk:
                let state: WASMFuncState = {
                    id: "__GLOBALS_INIT__", 
                    locals: [],
                    blocks: [],
                    varRemaps: new Map(),
                };

                this.processInstructions(field.init,state);

                this.outdent();
                this.newLine();
            }
            else if (field.type == "Elem") {
                console.log(">>>",field);
            }
            else if (field.type == "Data") {
                console.log(">>>",field.init.values);
            } else {
                throw new Error("TODO - Module Section - " + field.type);
            }
        }
    }

    processModuleMetadataSection(node: SectionMetadata) {
        // TODO: is ignoring this the right thing to do?
    }

    processTypeInstruction(node: TypeInstruction) {
        // TODO: is ignoring this the right thing to do?
    }

    processFunc(node: Func,modState: WASMModuleState) {
        this.write("function ");
        this.write(node.name.value);
        this.write("(");

        let state: WASMFuncState = {
            id: typeof node.name.value === "string" ? node.name.value : "func_u" + modState.funcStates.length, 
            locals: [],
            blocks: [],
            varRemaps: new Map(),
        };
        modState.funcStates.push(state);
        modState.funcByName.set(state.id,state);

        if(node.signature.type == "Signature") {
            let i = 0;
            for(let param of node.signature.params) {
                this.write(`arg${i}`);
                state.locals[i] = `arg${i}`;

                if((i+1) !== node.signature.params.length) {
                    this.write(", ");
                }
                i++;
            }
        }
        else {
            throw new Error("TODO " + node.signature.type);
        }

        this.write(")");

        this.indent();
        this.newLine();

        this.processInstructions(node.body,state);

        this.outdent();
        this.newLine();

        this.write("end");
        this.newLine();
    }

    static instructionBinOpRemap = {
        add: "+",
        sub: "-",
        mul: "*",
        div: "/",
    };

    static instructionBinOpFuncRemap = {
        
    };

    processInstructions(insArr: Instruction[],state: WASMFuncState) {
        for(let ins of insArr) {
            switch(ins.type) {
                case "Instr": {
                    switch(ins.id) {
                        case "local": {
                            if(ins.args.length > 0) {
                                this.write("local ");
                                let i = 0;
                                for(let loc of ins.args) {
                                    i++;
                                    this.write(`loc${state.locals.length}`);
                                    state.locals.push(`loc${state.locals.length}`);
                                    if(i !== ins.args.length) {
                                        this.write(",");
                                    }
                                }
                                this.write(";");
                            }
                            this.newLine();
                            break;
                        }
                        case "const": {
                            let _const = (ins.args[0] as NumberLiteral).value;
                            this.write(this.getPushStack());
                            this.write(_const);
                            this.write(";");
                            this.newLine();
                            break;
                        }
                        case "get_global": {
                            let globID = (ins.args[0] as NumberLiteral).value;
                            this.write(this.getPushStack());
                            this.write("__GLOBALS__["+globID+"]");
                            this.write(";");
                            this.newLine();
                            break;
                        }
                        case "set_global": {
                            let globID = (ins.args[0] as NumberLiteral).value;
                            this.write("__GLOBALS__["+globID+"] = "+this.getPop()+";");
                            this.newLine();
                            break;
                        }
                        case "get_local": {
                            let locID = (ins.args[0] as NumberLiteral).value;
                            this.write(this.getPushStack());
                            this.write(state.locals[locID] || `loc${locID}`);
                            this.write(";");
                            this.newLine();
                            break;
                        }
                        case "set_local": {
                            let locID = (ins.args[0] as NumberLiteral).value;
                            this.write(state.locals[locID] || `loc${locID}`);
                            this.write(" = "+this.getPop()+";");
                            this.newLine();
                            break;
                        }
                        case "tee_local": {
                            let locID = (ins.args[0] as NumberLiteral).value;
                            // write local
                            this.write(state.locals[locID] || `loc${locID}`);
                            this.write(" = "+this.getPop()+" ; ");
                            // read back
                            this.write(this.getPushStack());
                            this.write(state.locals[locID] || `loc${locID}`);
                            this.write(";");
                            this.newLine();
                            break;
                        }
                        case "add":
                        case "sub":
                        {
                            let op = wasm2lua.instructionBinOpRemap[ins.id];

                            this.write("__TMP__ = ");
                            this.write(this.getPop());
                            this.write(" "+op+" ");
                            this.write(this.getPop());
                            this.write("; ");
                            this.write(this.getPushStack());
                            this.write("__TMP__;");
                            this.newLine();
                            break;
                        }
                        case "br_if": {
                            this.write("if ");
                            this.write(this.getPop());
                            this.write(" then goto ");

                            if(state.blocks[(ins.args[0] as NumberLiteral).value]) {
                                let block = state.blocks[(ins.args[0] as NumberLiteral).value];

                                if(block.blockType == "loop") {
                                    this.write(`${block.id}_start`);
                                }
                                else {
                                    this.write(`${block.id}_fin`);
                                }
                            }
                            else {
                                this.write("____UNRESOLVED_DEST____");
                            }

                            this.write(" end;");
                            this.newLine();
                        }
                        case "return": {
                            this.write("return ");
                            if(ins.args.length > 1) {
                                this.write("--[[WARNING: return arguments more than 1???]]");
                            }
                            let nRets = ins.args.length == 1 ? (ins.args[0] as NumberLiteral).value : 0;
                            for(let i=0;i < nRets;i++) {
                                this.write(this.getPop());
                                if(nRets !== (i + 1)) {
                                    this.write(",");
                                }
                            }
                            this.write(";");
                            this.newLine();
                            break;
                        }
                        case "end": {
                            let block = state.blocks.pop();
                            if(block) {
                                this.outdent();
                                this.newLine();
                                this.write("end");
                                this.newLine();
                                this.write(`::${block.id}_fin:: -- BLOCK END`);
                                this.newLine();
                            }
                            return;
                        }
                        default: {
                            //throw new Error("TODO - Instr - " + ins.id);
                            //break;
                            this.write("-- TODO "+ins.id+" "+JSON.stringify(ins));
                            this.newLine();
                            break;
                        }
                    }
                    break;
                }
                case "CallInstruction": {
                    this.write("-- CALL "+ins.index.value+" (TODO ARG/RET)");
                    this.newLine();
                    break;
                }
                case "BlockInstruction": {
                    this.write(`-- BLOCK BEGIN (${ins.label.value})`);
                    // TODO: blocks can "return" stuff
                    this.newLine();
                    this.write(`::${ins.label.value}_start:: -- BLOCK END`);
                    state.blocks.push({
                        id: ins.label.value,
                        blockType: "block",
                    });
                    this.newLine();
                    this.write("do");
                    this.indent();
                    this.newLine();
                    this.processInstructions(ins.instr,state);
                    break;
                }
                case "IfInstruction": {
                    if(ins.test.length > 0) {
                        this.write("-- WARNING: 'if test' present, and was not handled");
                        this.newLine();
                    }

                    this.write("if ");
                    this.write(this.getPop());
                    this.write(" then");
                    
                    let ifLabel = `if_${ins.loc.start.line}_${ins.loc.start.column}`
                    this.write(`-- BLOCK BEGIN (${ifLabel})`);
                    this.newLine();
                    this.write(`::${ifLabel}_start:: -- BLOCK END`);
                    state.blocks.push({
                        id: ifLabel,
                        blockType: "block",
                    });
                    this.newLine();
                    this.write("do");
                    this.indent();
                    this.newLine();

                    this.indent();
                    this.newLine();

                    this.processInstructions(ins.consequent,state);
                    
                    this.outdent();
                    this.newLine();

                    if(ins.alternate.length > 0) {
                        this.write("else")
                        this.indent();
                        this.newLine();
                    
                        let elseLabel = `else_${ins.loc.start.line}_${ins.loc.start.column}`
                        this.write(`-- BLOCK BEGIN (${elseLabel})`);
                        this.newLine();
                        this.write(`::${elseLabel}_start:: -- BLOCK END`);
                        state.blocks.push({
                            id: elseLabel,
                            blockType: "block",
                        });
                        this.newLine();
                        this.write("do");
                        this.indent();
                        this.newLine();

                        this.processInstructions(ins.alternate,state);
                        
                        this.outdent();
                        this.newLine();
                    }

                    this.write("end");
                    this.newLine();

                    break;
                }
                default: {
                    this.write("-- TODO (!) "+ins.type+" "+JSON.stringify(ins));
                    this.newLine();
                    break;
                }
            }
        }
    }

    processModuleExport(node: ModuleExport,modState: WASMModuleState) {
        this.write("__EXPORTS__.");
        this.write(node.name)
        this.write(" = ");

        switch(node.descr.exportType) {
            case "Func": {
                if(node.descr.id.type == "NumberLiteral") {
                    if(modState.funcByName.get(`func_${node.descr.id.value}`)) {
                        this.write(`${modState.funcByName.get(`func_${node.descr.id.value}`).id}`);
                    }
                    else if(modState.funcByName.get(`func_u${node.descr.id.value}`)) {
                        this.write(`${modState.funcByName.get(`func_u${node.descr.id.value}`).id}`);
                    }
                    else {
                        this.write("--[[EXPORT_FAIL]] func_u" + node.descr.id.value)
                    }
                }
                else {
                    this.write(node.descr.id.value);
                }
                break;
            }
            case "Mem": {
                console.log("memory",node);
                break;
            }
            case "Global": {
                console.log("memory",node);
                break;
            }
            default: {
                throw new Error("TODO - Export - " + node.descr.exportType);
                break;
            }
        }
        this.write(";");
        this.newLine();
    }

    processModuleImport(node: ModuleImport,modState: WASMModuleState) {
        
    }
}

// Allow custom in/out file while defaulting to swad's meme :)
// let infile  = process.argv[2] || (__dirname + "/../addTwo.wasm");
// let infile  = process.argv[2] || (__dirname + "/../ammo.wasm");
let infile  = process.argv[2] || (__dirname + "/../dispersion.wasm");
let outfile = process.argv[3] || (__dirname + "/../test.lua");

let wasm = fs.readFileSync(infile)
let ast = decode(wasm)

let inst = new wasm2lua(ast);
fs.writeFileSync(outfile,inst.outBuf.join(""));

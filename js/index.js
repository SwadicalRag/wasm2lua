"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const wasm_parser_1 = require("@webassemblyjs/wasm-parser");
const fs = require("fs");
class wasm2lua {
    constructor(ast) {
        this.ast = ast;
        this.outBuf = [];
        this.indentLevel = 0;
        this.moduleStates = [];
        this.process();
    }
    assert(cond, err = "assertion failed") {
        if (!cond) {
            throw new Error(err);
        }
    }
    indent() { this.indentLevel++; }
    outdent() { this.indentLevel--; }
    newLine() {
        this.outBuf.push("\n" + (("    ").repeat(this.indentLevel)));
    }
    write(str) { this.outBuf.push(str); }
    writeHeader() {
        this.write("__MODULES__ = __MODULES__ or {};");
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
        for (let mod of this.ast.body) {
            if (mod.type == "Module") {
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
    processModule(node) {
        let state = {
            funcStates: [],
        };
        if (node.id) {
            this.write("local __EXPORTS__ = {};");
            this.newLine();
            this.write("__MODULES__." + node.id + " = __EXPORTS__");
            this.newLine();
        }
        else {
            this.write("__MODULES__.UNKNOWN = __MODULES__.UNKNOWN or {}");
            this.newLine();
            this.write("local __EXPORTS__ = __MODULES__.UNKNOWN;");
            this.newLine();
        }
        for (let section of node.metadata.sections) {
            this.processModuleMetadataSection(section);
        }
        for (let field of node.fields) {
            if (field.type == "TypeInstruction") {
                this.processTypeInstruction(field);
            }
            else if (field.type == "Func") {
                this.processFunc(field, state);
            }
            else if (field.type == "ModuleExport") {
                this.processModuleExport(field, state);
            }
            else if (field.type == "ModuleImport") {
                this.processModuleImport(field, state);
            }
            else if (field.type == "Table") {
                console.log(">>>", field);
            }
            else if (field.type == "Memory") {
                console.log(">>>", field);
            }
            else if (field.type == "Global") {
                this.write("-- global");
                this.indent();
                this.newLine();
                let state = {
                    id: "____global",
                    locals: [],
                    varRemaps: new Map(),
                };
                this.processInstructions(field.init, state);
                this.outdent();
                this.newLine();
            }
            else if (field.type == "Elem") {
                console.log(">>>", field);
            }
            else if (field.type == "Data") {
                console.log(">>>", field.init.values);
            }
            else {
                throw new Error("TODO - Module Section - " + field.type);
            }
        }
    }
    processModuleMetadataSection(node) {
    }
    processTypeInstruction(node) {
    }
    processFunc(node, modState) {
        this.write("function ");
        this.write(node.name.value);
        this.write("(");
        let state = {
            id: typeof node.name.value === "string" ? node.name.value : "func" + modState.funcStates.length,
            locals: [],
            varRemaps: new Map(),
        };
        modState.funcStates.push(state);
        if (node.signature.type == "Signature") {
            let i = 0;
            for (let param of node.signature.params) {
                this.write(`arg${i}`);
                state.locals[i] = `arg${i}`;
                if ((i + 1) !== node.signature.params.length) {
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
        this.processInstructions(node.body, state);
        this.outdent();
        this.newLine();
        this.write("end");
        this.newLine();
    }
    processInstructions(insArr, state) {
        for (let ins of insArr) {
            switch (ins.type) {
                case "Instr": {
                    switch (ins.id) {
                        case "local": {
                            this.write("-- LOCALS: " + JSON.stringify(ins.args));
                            this.newLine();
                            break;
                        }
                        case "const": {
                            let _const = ins.args[0].value;
                            this.write(this.getPushStack());
                            this.write(_const);
                            this.write(";");
                            this.newLine();
                            break;
                        }
                        case "get_global": {
                            let globID = ins.args[0].value;
                            this.write(this.getPushStack());
                            this.write("GLOBALS[" + globID + "]");
                            this.write(";");
                            this.newLine();
                            break;
                        }
                        case "set_global": {
                            let globID = ins.args[0].value;
                            this.write("GLOBALS[" + globID + "] = " + this.getPop() + ";");
                            this.newLine();
                            break;
                        }
                        case "get_local": {
                            let locID = ins.args[0].value;
                            this.write(this.getPushStack());
                            this.write(state.locals[locID] || `loc${locID}`);
                            this.write(";");
                            this.newLine();
                            break;
                        }
                        case "set_local": {
                            let locID = ins.args[0].value;
                            this.write(state.locals[locID] || `loc${locID}`);
                            this.write(" = " + this.getPop() + ";");
                            this.newLine();
                            break;
                        }
                        case "tee_local": {
                            let locID = ins.args[0].value;
                            this.write(state.locals[locID] || `loc${locID}`);
                            this.write(" = " + this.getPop() + " ; ");
                            this.write(this.getPushStack());
                            this.write(state.locals[locID] || `loc${locID}`);
                            this.write(";");
                            this.newLine();
                            break;
                        }
                        case "add":
                        case "sub":
                            {
                                let op = (ins.id == "add" ? "+" : "-");
                                this.write("__TMP__ = ");
                                this.write(this.getPop());
                                this.write(" " + op + " ");
                                this.write(this.getPop());
                                this.write("; ");
                                this.write(this.getPushStack());
                                this.write("__TMP__;");
                                this.newLine();
                                break;
                            }
                        case "return": {
                            this.write("return ");
                            this.write(this.getPop());
                            this.write(";");
                            this.newLine();
                            break;
                        }
                        case "end": {
                            this.assert(ins == insArr[insArr.length - 1]);
                            return;
                        }
                        default: {
                            this.write("-- TODO " + ins.id + " " + JSON.stringify(ins));
                            this.newLine();
                            break;
                        }
                    }
                    break;
                }
                case "CallInstruction": {
                    this.write("-- CALL " + ins.index.value + " (TODO ARG/RET)");
                    this.newLine();
                    break;
                }
                case "BlockInstruction": {
                    this.write(`-- BLOCK BEGIN (${ins.label.value})`);
                    this.indent();
                    this.newLine();
                    this.processInstructions(ins.instr, state);
                    this.outdent();
                    this.newLine();
                    this.write(`::${ins.label.value}:: -- BLOCK END`);
                    this.newLine();
                    break;
                }
                default: {
                    this.write("-- TODO (!) " + ins.type + " " + JSON.stringify(ins));
                    this.newLine();
                    break;
                }
            }
        }
    }
    processModuleExport(node, modState) {
        this.write("__EXPORTS__.");
        this.write(node.name);
        this.write(" = ");
        switch (node.descr.exportType) {
            case "Func": {
                if (node.descr.id.type == "NumberLiteral") {
                    this.assert(modState.funcStates[node.descr.id.value], "attempt to export non existant function");
                    this.write(`${modState.funcStates[node.descr.id.value].id}`);
                }
                else {
                    this.write(node.descr.id.value);
                }
                break;
            }
            case "Mem": {
                console.log("memory", node);
                break;
            }
            case "Global": {
                console.log("memory", node);
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
    processModuleImport(node, modState) {
    }
}
exports.wasm2lua = wasm2lua;
let infile = process.argv[2] || (__dirname + "/../addTwo.wasm");
let outfile = process.argv[3] || (__dirname + "/../test.lua");
let wasm = fs.readFileSync(infile);
let ast = wasm_parser_1.decode(wasm);
let inst = new wasm2lua(ast);
fs.writeFileSync(outfile, inst.outBuf.join(""));
//# sourceMappingURL=index.js.map
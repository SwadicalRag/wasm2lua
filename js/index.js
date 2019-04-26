"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const wasm_parser_1 = require("@webassemblyjs/wasm-parser");
const fs = require("fs");
class wasm2lua {
    constructor(ast) {
        this.ast = ast;
        this.outBuf = [];
        this.indentLevel = 0;
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
                this.processModule(mod);
            }
            else {
                throw new Error("TODO");
            }
        }
    }
    processModule(node) {
        for (let section of node.metadata.sections) {
            this.processModuleSection(section);
        }
        for (let field of node.fields) {
            if (field.type == "TypeInstruction") {
                this.processTypeInstruction(field);
            }
            else if (field.type == "Func") {
                this.processFunc(field);
            }
            else if (field.type == "ModuleExport") {
                this.processModuleExport(field);
            }
            else {
                throw new Error("TODO " + field.type);
            }
        }
    }
    processModuleSection(node) {
    }
    processTypeInstruction(node) {
    }
    processFunc(node) {
        this.write("function ");
        this.write(node.name.value);
        this.write("(");
        let state = {
            locals: [],
            varRemaps: new Map(),
        };
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
    }
    processInstructions(insArr, state) {
        for (let ins of insArr) {
            switch (ins.type) {
                case "Instr": {
                    switch (ins.id) {
                        case "get_local": {
                            let locID = ins.args[0].value;
                            this.write(this.getPushStack());
                            this.write(state.locals[locID] || `loc${locID}`);
                            this.write(";");
                            this.newLine();
                            break;
                        }
                        case "add": {
                            this.write("__TMP__ = ");
                            this.write(this.getPop());
                            this.write(" + ");
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
                            throw new Error("TODO " + ins.id);
                            break;
                        }
                    }
                    break;
                }
                default: {
                    throw new Error("TODO " + ins.type);
                    break;
                }
            }
        }
    }
    processModuleExport(node) {
    }
}
exports.wasm2lua = wasm2lua;
let wasm = fs.readFileSync(__dirname + "/../addTwo.wasm");
let ast = wasm_parser_1.decode(wasm);
let inst = new wasm2lua(ast);
fs.writeFileSync(__dirname + "/../test.lua", inst.outBuf.join(""));
//# sourceMappingURL=index.js.map
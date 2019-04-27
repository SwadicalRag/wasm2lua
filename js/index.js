"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const wasm_parser_1 = require("@webassemblyjs/wasm-parser");
const fs = require("fs");
const util_1 = require("util");
class ArrayMap extends Map {
    constructor() {
        super(...arguments);
        this.numSize = 0;
    }
    set(k, v) {
        super.set(k, v);
        if (typeof k === "number") {
            if (k === this.numSize) {
                if ((typeof v !== "undefined") && (v !== null)) {
                    this.numSize++;
                }
            }
            else if (k === (this.numSize - 1)) {
                if ((typeof v === "undefined") || (v === null)) {
                    this.numSize--;
                }
            }
        }
        return this;
    }
    push(v) {
        this.set(this.numSize, v);
    }
    pop() {
        super.set(this.numSize - 1, undefined);
    }
}
class wasm2lua {
    constructor(ast) {
        this.ast = ast;
        this.outBuf = [];
        this.indentLevel = 0;
        this.moduleStates = [];
        this.globalTypes = [];
        this.process();
    }
    assert(cond, err = "assertion failed") {
        if (!cond) {
            throw new Error(err);
        }
    }
    indent() { this.indentLevel++; }
    outdent(buf) {
        this.indentLevel--;
        if (util_1.isArray(buf)) {
            while (buf[buf.length - 1] === "") {
                buf.pop();
            }
            let mat = buf[buf.length - 1].match(/^([\s\S]*?)\n(?:    )*$/);
            if (mat) {
                buf[buf.length - 1] = mat[1] + "\n" + (("    ").repeat(this.indentLevel));
            }
        }
    }
    newLine(buf) {
        buf.push("\n" + (("    ").repeat(this.indentLevel)));
    }
    write(buf, str) { buf.push(str); }
    writeHeader(buf) {
        this.write(buf, "__MODULES__ = __MODULES__ or {};");
        this.newLine(buf);
        this.write(buf, "__GLOBALS__ = __GLOBALS__ or {};");
        this.newLine(buf);
        this.write(buf, "local function __STACK_POP__(__STACK__)local v=__STACK__[#__STACK__];__STACK__[#__STACK__]=nil;return v;end;");
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
        for (let mod of this.ast.body) {
            if (mod.type == "Module") {
                this.write(this.outBuf, "do");
                this.indent();
                this.newLine(this.outBuf);
                this.write(this.outBuf, this.processModule(mod));
                this.outdent(this.outBuf);
                this.write(this.outBuf, "end");
                this.newLine(this.outBuf);
            }
            else {
                throw new Error("TODO");
            }
        }
    }
    processModule(node) {
        let buf = [];
        let state = {
            funcStates: [],
            funcByName: new Map(),
        };
        if (node.id) {
            this.write(buf, "local __EXPORTS__ = {};");
            this.newLine(buf);
            this.write(buf, "__MODULES__." + node.id + " = __EXPORTS__");
            this.newLine(buf);
        }
        else {
            this.write(buf, "__MODULES__.UNKNOWN = __MODULES__.UNKNOWN or {}");
            this.newLine(buf);
            this.write(buf, "local __EXPORTS__ = __MODULES__.UNKNOWN;");
            this.newLine(buf);
        }
        for (let section of node.metadata.sections) {
            this.processModuleMetadataSection(section);
        }
        for (let field of node.fields) {
            if (field.type == "Func") {
                this.initFunc(field, state);
            }
        }
        for (let field of node.fields) {
            if (field.type == "TypeInstruction") {
                this.write(buf, this.processTypeInstruction(field));
            }
            else if (field.type == "Func") {
                this.write(buf, this.processFunc(field, state));
            }
            else if (field.type == "ModuleExport") {
                this.write(buf, this.processModuleExport(field, state));
            }
            else if (field.type == "ModuleImport") {
                this.write(buf, this.processModuleImport(field, state));
            }
            else if (field.type == "Table") {
                console.log(">>>", field);
            }
            else if (field.type == "Memory") {
                console.log(">>>", field);
            }
            else if (field.type == "Global") {
                this.write(buf, "-- global");
                this.indent();
                this.newLine(buf);
                let state = {
                    id: "__GLOBALS_INIT__",
                    locals: [],
                    blocks: [],
                    varRemaps: new Map(),
                };
                this.write(buf, this.processInstructions(field.init, state));
                this.outdent(buf);
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
        return buf.join("");
    }
    processModuleMetadataSection(node) {
        return "";
    }
    processTypeInstruction(node) {
        this.globalTypes.push(node.functype);
        return "";
    }
    getFuncByIndex(modState, index) {
        if (index.type == "NumberLiteral") {
            if (modState.funcByName.get(`func_${index.value}`)) {
                return modState.funcByName.get(`func_${index.value}`);
            }
            else if (modState.funcByName.get(`func_u${index.value}`)) {
                return modState.funcByName.get(`func_u${index.value}`);
            }
        }
        else {
            return modState.funcByName.get(index.value) || false;
        }
        return false;
    }
    initFunc(node, state) {
        let funcType;
        if (node.signature.type == "Signature") {
            funcType = node.signature;
        }
        let fstate = {
            id: typeof node.name.value === "string" ? node.name.value : "func_u" + state.funcStates.length,
            locals: [],
            blocks: [],
            varRemaps: new Map(),
            funcType,
            modState: state,
        };
        state.funcStates.push(fstate);
        state.funcByName.set(fstate.id, fstate);
        return fstate;
    }
    processFunc(node, modState) {
        let buf = [];
        if (node.signature.type == "NumberLiteral") {
            if (!this.globalTypes[node.signature.value]) {
                this.write(buf, "-- WARNING: Function type signature read failed (1)");
                this.newLine(buf);
            }
        }
        else if (node.signature.type !== "Signature") {
            this.write(buf, "-- WARNING: Function type signature read failed (2)");
            this.newLine(buf);
        }
        let state = modState.funcByName.get(typeof node.name.value === "string" ? node.name.value : "func_u" + modState.funcStates.length);
        if (!state) {
            state = this.initFunc(node, modState);
        }
        this.write(buf, "function ");
        this.write(buf, state.id);
        this.write(buf, "(");
        if (node.signature.type == "Signature") {
            let i = 0;
            for (let param of node.signature.params) {
                this.write(buf, `arg${i}`);
                state.locals[i] = `arg${i}`;
                if ((i + 1) !== node.signature.params.length) {
                    this.write(buf, ", ");
                }
                i++;
            }
        }
        else {
            throw new Error("TODO " + node.signature.type);
        }
        this.write(buf, ")");
        this.indent();
        this.newLine(buf);
        this.write(buf, "local __TMP__,__STACK__ = nil,{};");
        this.newLine(buf);
        this.write(buf, this.processInstructions(node.body, state));
        this.endAllBlocks(buf, state);
        this.outdent(buf);
        this.write(buf, "end");
        this.newLine(buf);
        return buf.join("");
    }
    beginBlock(buf, state, block) {
        this.write(buf, `-- BLOCK BEGIN (${block.id})`);
        this.newLine(buf);
        this.write(buf, `::${block.id}_start:: -- BLOCK START`);
        state.blocks.push(block);
        this.newLine(buf);
        this.write(buf, "do");
        this.indent();
        this.newLine(buf);
    }
    endAllBlocks(buf, state) {
        while (state.blocks.length > 0) {
            this.endBlock(buf, state);
        }
    }
    endBlock(buf, state) {
        let block = state.blocks.pop();
        if (block) {
            this.endBlockInternal(buf, block);
            return true;
        }
        return false;
    }
    endBlockInternal(buf, block) {
        this.outdent(buf);
        this.write(buf, "end");
        this.newLine(buf);
        this.write(buf, `::${block.id}_fin:: -- BLOCK END`);
        this.newLine(buf);
    }
    processInstructions(insArr, state) {
        let buf = [];
        for (let ins of insArr) {
            switch (ins.type) {
                case "Instr": {
                    switch (ins.id) {
                        case "local": {
                            if (ins.args.length > 0) {
                                this.write(buf, "local ");
                                let i = 0;
                                for (let loc of ins.args) {
                                    i++;
                                    this.write(buf, `loc${state.locals.length}`);
                                    state.locals.push(`loc${state.locals.length}`);
                                    if (i !== ins.args.length) {
                                        this.write(buf, ",");
                                    }
                                }
                                this.write(buf, ";");
                            }
                            this.newLine(buf);
                            break;
                        }
                        case "const": {
                            if (ins.args[0].type == "LongNumberLiteral") {
                                let _const = ins.args[0].value.low;
                                this.write(buf, "--[[WARNING: high bits of int64 dropped]]");
                                this.write(buf, this.getPushStack());
                                this.write(buf, _const.toString());
                                this.write(buf, ";");
                                this.newLine(buf);
                            }
                            else {
                                let _const = ins.args[0].value;
                                this.write(buf, this.getPushStack());
                                this.write(buf, _const.toString());
                                this.write(buf, ";");
                                this.newLine(buf);
                            }
                            break;
                        }
                        case "get_global": {
                            let globID = ins.args[0].value;
                            this.write(buf, this.getPushStack());
                            this.write(buf, "__GLOBALS__[" + globID + "]");
                            this.write(buf, ";");
                            this.newLine(buf);
                            break;
                        }
                        case "set_global": {
                            let globID = ins.args[0].value;
                            this.write(buf, "__GLOBALS__[" + globID + "] = " + this.getPop() + ";");
                            this.newLine(buf);
                            break;
                        }
                        case "get_local": {
                            let locID = ins.args[0].value;
                            this.write(buf, this.getPushStack());
                            this.write(buf, state.locals[locID] || `loc${locID}`);
                            this.write(buf, ";");
                            this.newLine(buf);
                            break;
                        }
                        case "set_local": {
                            let locID = ins.args[0].value;
                            this.write(buf, state.locals[locID] || `loc${locID}`);
                            this.write(buf, " = " + this.getPop() + ";");
                            this.newLine(buf);
                            break;
                        }
                        case "tee_local": {
                            let locID = ins.args[0].value;
                            this.write(buf, state.locals[locID] || `loc${locID}`);
                            this.write(buf, " = " + this.getPop() + " ; ");
                            this.write(buf, this.getPushStack());
                            this.write(buf, state.locals[locID] || `loc${locID}`);
                            this.write(buf, ";");
                            this.newLine(buf);
                            break;
                        }
                        case "add":
                        case "sub":
                            {
                                let op = wasm2lua.instructionBinOpRemap[ins.id];
                                this.write(buf, "__TMP__ = ");
                                this.write(buf, this.getPop());
                                this.write(buf, " " + op + " ");
                                this.write(buf, this.getPop());
                                this.write(buf, "; ");
                                this.write(buf, this.getPushStack());
                                this.write(buf, "__TMP__;");
                                this.newLine(buf);
                                break;
                            }
                        case "br_if": {
                            this.write(buf, "if ");
                            this.write(buf, this.getPop());
                            this.write(buf, " then ");
                            let blocksToExit = ins.args[0].value;
                            let targetBlock = state.blocks[state.blocks.length - blocksToExit - 1];
                            if (targetBlock) {
                                this.write(buf, "goto ");
                                if (targetBlock.blockType == "loop") {
                                    this.write(buf, `${targetBlock.id}_start`);
                                }
                                else {
                                    this.write(buf, `${targetBlock.id}_fin`);
                                }
                            }
                            else {
                                this.write(buf, "goto ____UNRESOLVED_DEST____");
                            }
                            this.write(buf, " end;");
                            this.newLine(buf);
                            break;
                        }
                        case "return": {
                            this.write(buf, "do return ");
                            let nRets = state.funcType ? state.funcType.results.length : 0;
                            for (let i = 0; i < nRets; i++) {
                                this.write(buf, this.getPop());
                                if (nRets !== (i + 1)) {
                                    this.write(buf, ",");
                                }
                            }
                            this.write(buf, "; end;");
                            this.newLine(buf);
                            break;
                        }
                        case "end": {
                            this.endBlock(buf, state);
                            break;
                        }
                        default: {
                            this.write(buf, "-- TODO " + ins.id + " " + JSON.stringify(ins));
                            this.newLine(buf);
                            break;
                        }
                    }
                    break;
                }
                case "CallInstruction": {
                    let fstate = this.getFuncByIndex(state.modState, ins.index);
                    if (fstate && fstate.funcType) {
                        if (fstate.funcType.results.length > 1) {
                            this.write(buf, "__TMP__ = {");
                        }
                        else {
                            this.write(buf, this.getPushStack());
                        }
                        this.write(buf, fstate.id + "(");
                        for (let i = 0; i < fstate.funcType.params.length; i++) {
                            this.write(buf, this.getPop());
                            if (i !== (fstate.funcType.params.length - 1)) {
                                this.write(buf, ",");
                            }
                        }
                        this.write(buf, ")");
                        if (fstate.funcType.results.length > 1) {
                            this.write(buf, "};");
                            for (let i = 0; i < fstate.funcType.results.length; i++) {
                                this.write(buf, this.getPushStack());
                                this.write(buf, "__TMP__[" + (i + 1) + "];");
                            }
                        }
                        else {
                            this.write(buf, ";");
                        }
                        this.newLine(buf);
                    }
                    else {
                        this.write(buf, "-- WARNING: UNABLE TO RESOLVE CALL " + ins.index.value + " (TODO ARG/RET)");
                        this.newLine(buf);
                    }
                    break;
                }
                case "BlockInstruction": {
                    this.beginBlock(buf, state, {
                        id: ins.label.value,
                        blockType: "block",
                    });
                    break;
                }
                case "IfInstruction": {
                    if (ins.test.length > 0) {
                        this.write(buf, "-- WARNING: 'if test' present, and was not handled");
                        this.newLine(buf);
                    }
                    this.write(buf, "if ");
                    this.write(buf, this.getPop());
                    this.write(buf, " then");
                    this.beginBlock(buf, state, {
                        id: `if_${ins.loc.start.line}_${ins.loc.start.column}`,
                        blockType: "if",
                    });
                    this.indent();
                    this.newLine(buf);
                    this.processInstructions(ins.consequent, state);
                    this.outdent(buf);
                    if (ins.alternate.length > 0) {
                        this.write(buf, "else");
                        this.indent();
                        this.newLine(buf);
                        this.beginBlock(buf, state, {
                            id: `else_${ins.loc.start.line}_${ins.loc.start.column}`,
                            blockType: "if",
                        });
                        this.processInstructions(ins.alternate, state);
                        this.outdent(buf);
                    }
                    this.write(buf, "end");
                    this.newLine(buf);
                    break;
                }
                default: {
                    this.write(buf, "-- TODO (!) " + ins.type + " " + JSON.stringify(ins));
                    this.newLine(buf);
                    break;
                }
            }
        }
        return buf.join("");
    }
    processModuleExport(node, modState) {
        let buf = [];
        this.write(buf, "__EXPORTS__.");
        this.write(buf, node.name);
        this.write(buf, " = ");
        switch (node.descr.exportType) {
            case "Func": {
                let fstate = this.getFuncByIndex(modState, node.descr.id);
                if (fstate) {
                    this.write(buf, fstate.id);
                }
                else {
                    this.write(buf, "--[[EXPORT_FAIL]] func_u" + node.descr.id.value);
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
        this.write(buf, ";");
        this.newLine(buf);
        return buf.join("");
    }
    processModuleImport(node, modState) {
        let buf = [];
        this.write(buf, "-- IMPORT " + JSON.stringify(node));
        this.newLine(buf);
        return buf.join("");
    }
}
wasm2lua.instructionBinOpRemap = {
    add: "+",
    sub: "-",
    mul: "*",
    div: "/",
};
wasm2lua.instructionBinOpFuncRemap = {};
exports.wasm2lua = wasm2lua;
let infile = process.argv[2] || (__dirname + "/../dispersion.wasm");
let outfile = process.argv[3] || (__dirname + "/../test.lua");
let wasm = fs.readFileSync(infile);
let ast = wasm_parser_1.decode(wasm);
let inst = new wasm2lua(ast);
fs.writeFileSync(outfile, inst.outBuf.join(""));
//# sourceMappingURL=index.js.map
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const wasm_parser_1 = require("@webassemblyjs/wasm-parser");
const fs = require("fs");
const util_1 = require("util");
const arraymap_1 = require("./arraymap");
const virtualregistermanager_1 = require("./virtualregistermanager");
function makeBinaryStringLiteral(array) {
    let literal = ["'"];
    for (let i = 0; i < array.length; i++) {
        let c = array[i];
        if (c < 0x20 || c > 0x7E) {
            let tmp = "00" + c.toString(16);
            literal.push("\\x" + tmp.substr(tmp.length - 2));
        }
        else if (c == 0x27) {
            literal.push("\\'");
        }
        else if (c == 0x5C) {
            literal.push("\\\\");
        }
        else {
            literal.push(String.fromCharCode(c));
        }
    }
    literal.push("'");
    return literal.join("");
}
function sanitizeIdentifier(ident) {
    return ident
        .replace(/\$/g, "__IDENT_CHAR_DOLLAR__")
        .replace(/\./g, "__IDENT_CHAR_DOT__")
        .replace(/\-/g, "__IDENT_CHAR_MINUS__");
}
const FUNC_VAR_HEADER = "local __TMP__,__TMP2__,__STACK__ = nil,nil,{};";
class wasm2lua {
    constructor(program_binary, options = {}) {
        this.program_binary = program_binary;
        this.options = options;
        this.outBuf = [];
        this.indentLevel = 0;
        this.moduleStates = [];
        this.globalTypes = [];
        this.program_ast = wasm_parser_1.decode(wasm, {});
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
            if (buf.length > 0) {
                let mat = buf[buf.length - 1].match(/^([\s\S]*?)\n(?:    )*$/);
                if (mat) {
                    buf[buf.length - 1] = mat[1] + "\n" + (("    ").repeat(this.indentLevel));
                }
            }
        }
    }
    newLine(buf) {
        buf.push("\n" + (("    ").repeat(this.indentLevel)));
    }
    write(buf, str) { buf.push(str); }
    writeLn(buf, str) {
        if (str !== "") {
            buf.push(str);
            this.newLine(buf);
        }
    }
    writeEx(buf, str, offset) {
        if (offset < 0) {
            offset += buf.length;
        }
        buf.splice(offset, 0, str);
    }
    writeHeader(buf) {
        this.write(buf, wasm2lua.fileHeader);
        this.newLine(buf);
    }
    getPushStack(func, stackExpr, resolveRegister) {
        func.stackLevel++;
        if (typeof stackExpr === "string") {
            func.stackData.push(stackExpr);
            return "";
        }
        else if (typeof stackExpr === "object") {
            if (resolveRegister) {
                func.stackData.push(func.regManager.getPhysicalRegisterName(stackExpr));
            }
            else {
                stackExpr.stackEntryCount++;
                func.stackData.push(stackExpr);
            }
            return "";
        }
        else {
            func.stackData.push(false);
            return `__STACK__[${func.stackLevel - 1}] = `;
        }
    }
    getPop(func) {
        if (func.stackLevel == 1) {
            console.log("attempt to pop below zero");
            return "--[[WARNING: NEGATIVE POP]] nil";
        }
        let lastData = func.stackData.pop();
        func.stackLevel--;
        if (typeof lastData === "string") {
            return lastData;
        }
        else if (typeof lastData === "object") {
            lastData.stackEntryCount--;
            if (lastData.stackEntryCount == 0) {
                if (typeof lastData.lastRef === "number") {
                    if (func.insCountPass2 >= lastData.lastRef) {
                        func.regManager.freeRegister(lastData);
                    }
                }
                else {
                    func.regManager.freeRegister(lastData);
                }
            }
            else if (lastData.stackEntryCount < 0) {
                throw new Error("just wHat");
            }
            return func.regManager.getPhysicalRegisterName(lastData);
        }
        else {
            return `__STACK__[${func.stackLevel}]`;
        }
    }
    getPeek(func, n = 0) {
        if (func.stackLevel - n <= 1) {
            console.log("attempt to peek below zero");
            return "--[[WARNING: NEGATIVE PEEK]] nil";
        }
        let lastData = func.stackData[func.stackData.length - n - 1];
        if (typeof lastData === "string") {
            return lastData;
        }
        else if (typeof lastData === "object") {
            return func.regManager.getPhysicalRegisterName(lastData);
        }
        else {
            return `__STACK__[${func.stackLevel - n - 1}]`;
        }
    }
    stackDrop(func) {
        this.getPop(func);
    }
    process() {
        this.writeHeader(this.outBuf);
        for (let mod of this.program_ast.body) {
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
            memoryAllocations: new arraymap_1.ArrayMap(),
            func_tables: [],
            nextGlobalIndex: 0
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
            if (field.type == "ModuleImport") {
                this.write(buf, this.processModuleImport(field, state));
            }
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
            }
            else if (field.type == "Table") {
            }
            else if (field.type == "Memory") {
                let memID;
                if (field.id) {
                    if (field.id.type == "NumberLiteral") {
                        memID = "mem_" + field.id.value;
                    }
                    else {
                        memID = field.id.value;
                    }
                    state.memoryAllocations.set(field.id.value, memID);
                }
                else {
                    memID = "mem_u" + state.memoryAllocations.numSize;
                    state.memoryAllocations.push(memID);
                }
                this.write(buf, "local " + memID + " = __MEMORY_ALLOC__(" + (field.limits.max || field.limits.min) + ");");
                this.newLine(buf);
            }
            else if (field.type == "Global") {
                this.write(buf, "do");
                this.indent();
                this.newLine(buf);
                this.write(buf, FUNC_VAR_HEADER);
                this.newLine(buf);
                let global_init_state = {
                    id: "__GLOBAL_INIT__",
                    locals: [],
                    blocks: [],
                    regManager: new virtualregistermanager_1.VirtualRegisterManager(),
                    insLastRefs: [],
                    registersToBeFreed: [],
                    insCountPass1: 0,
                    insCountPass2: 0,
                    varRemaps: new Map(),
                    stackData: [],
                    stackLevel: 1,
                };
                this.processInstructionsPass1(field.init, global_init_state);
                this.write(buf, this.processInstructionsPass2(field.init, global_init_state));
                this.writeEx(buf, this.processInstructionsPass3(field.init, global_init_state), -1);
                this.write(buf, "__GLOBALS__[" + state.nextGlobalIndex + "] = " + this.getPop(global_init_state) + ";");
                this.outdent(buf);
                this.newLine(buf);
                this.write(buf, "end");
                this.newLine(buf);
                state.nextGlobalIndex++;
            }
            else if (field.type == "Elem") {
                let table_index = field.table.value;
                this.write(buf, `local __TABLE_FUNCS_${table_index}__, __TABLE_OFFSET_${table_index}__;`);
                this.newLine(buf);
                this.write(buf, "do");
                this.indent();
                this.newLine(buf);
                this.write(buf, FUNC_VAR_HEADER);
                this.newLine(buf);
                let global_init_state = {
                    id: "__TABLE_INIT__",
                    locals: [],
                    regManager: new virtualregistermanager_1.VirtualRegisterManager(),
                    registersToBeFreed: [],
                    insCountPass1: 0,
                    insCountPass2: 0,
                    insLastRefs: [],
                    blocks: [],
                    varRemaps: new Map(),
                    stackData: [],
                    stackLevel: 1,
                };
                this.processInstructionsPass1(field.offset, global_init_state);
                this.write(buf, this.processInstructionsPass2(field.offset, global_init_state));
                this.writeEx(buf, this.processInstructionsPass3(field.offset, global_init_state), -1);
                this.write(buf, `__TABLE_OFFSET_${table_index}__ = 1 - ` + this.getPop(global_init_state) + ";");
                this.newLine(buf);
                this.outdent(buf);
                this.newLine(buf);
                this.write(buf, "end");
                this.newLine(buf);
                state.func_tables[table_index] = field.funcs;
            }
            else if (field.type == "Data") {
                if (field.memoryIndex && field.memoryIndex.type == "NumberLiteral") {
                    this.write(buf, "__MEMORY_INIT__(mem_" + field.memoryIndex.value + ",");
                }
                else {
                    throw new Error("Bad index on memory.");
                }
                if (field.offset && field.offset.type == "Instr" && field.offset.id == "const") {
                    let value = field.offset.args[0];
                    if (value.type == "NumberLiteral") {
                        this.write(buf, value.value + ",");
                    }
                }
                else {
                    throw new Error("Bad offset on memory.");
                }
                this.write(buf, makeBinaryStringLiteral(field.init.values) + ");");
                this.newLine(buf);
            }
            else {
                throw new Error("TODO - Module Section - " + field.type);
            }
        }
        if (this.options.whitelist != null) {
            this.options.whitelist.forEach((whitelist_name) => {
                this.write(buf, `__EXPORTS__.${whitelist_name} = ${whitelist_name}`);
                this.newLine(buf);
            });
        }
        state.func_tables.forEach((table, table_index) => {
            this.write(buf, `__TABLE_FUNCS_${table_index}__ = {`);
            let func_ids = table.map((func_index) => {
                let fstate = this.getFuncByIndex(state, func_index);
                if (!fstate) {
                    throw new Error("Unresolved table entry #" + func_index);
                }
                return fstate.id;
            });
            this.write(buf, func_ids.join(","));
            this.write(buf, "};");
            this.newLine(buf);
        });
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
            else {
                return modState.funcStates[index.value] || false;
            }
        }
        else {
            return modState.funcByName.get(index.value) || false;
        }
        return false;
    }
    initFunc(node, state, renameTo) {
        let funcType;
        if (node.signature.type == "Signature") {
            funcType = node.signature;
        }
        let funcID;
        if (typeof node.name.value === "string") {
            funcID = node.name.value;
        }
        else if (typeof node.name.value === "number") {
            funcID = "func_" + node.name.value;
        }
        else {
            funcID = "func_" + state.funcStates.length;
        }
        let fstate = {
            id: renameTo ? renameTo : sanitizeIdentifier(funcID),
            regManager: new virtualregistermanager_1.VirtualRegisterManager(),
            registersToBeFreed: [],
            insLastRefs: [],
            insCountPass1: 0,
            insCountPass2: 0,
            locals: [],
            blocks: [],
            varRemaps: new Map(),
            funcType,
            modState: state,
            stackData: [],
            stackLevel: 1,
        };
        state.funcStates.push(fstate);
        state.funcByName.set(funcID, fstate);
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
        state.stackLevel = 1;
        this.write(buf, "function ");
        this.write(buf, state.id);
        this.write(buf, "(");
        if (this.options.whitelist != null && this.options.whitelist.indexOf(node.name.value + "") == -1) {
            if (state.id == "__W2L__WRITE_NUM") {
                this.write(buf, `a) print(a) end`);
            }
            else if (state.id == "__W2L__WRITE_STR") {
                this.write(buf, `a) local str="" while mem_0[a]~=0 do str=str..string.char(mem_0[a]) a=a+1 end print(str) end`);
            }
            else {
                this.write(buf, `) print("!!! PRUNED: ${state.id}") end`);
            }
            this.newLine(buf);
            return buf.join("");
        }
        if (node.signature.type == "Signature") {
            let i = 0;
            for (let param of node.signature.params) {
                let reg = state.regManager.createRegister(`arg${i}`);
                state.locals[i] = reg;
                this.write(buf, state.regManager.getPhysicalRegisterName(reg));
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
        this.write(buf, FUNC_VAR_HEADER);
        this.newLine(buf);
        this.processInstructionsPass1(node.body, state);
        this.write(buf, this.processInstructionsPass2(node.body, state));
        this.writeEx(buf, this.processInstructionsPass3(node.body, state), -1);
        this.endAllBlocks(buf, state);
        if (state.stackLevel > 1) {
            this.write(buf, "do return ");
            let nRets = state.funcType ? state.funcType.results.length : 0;
            for (let i = 0; i < nRets; i++) {
                this.write(buf, this.getPop(state));
                if (nRets !== (i + 1)) {
                    this.write(buf, ",");
                }
            }
            this.write(buf, "; end;");
            this.newLine(buf);
        }
        this.outdent(buf);
        this.write(buf, "end");
        this.newLine(buf);
        return buf.join("");
    }
    beginBlock(buf, state, block, customStart) {
        state.blocks.push(block);
        this.write(buf, sanitizeIdentifier(`::${block.id}_start::`));
        this.newLine(buf);
        if (typeof customStart === "string") {
            this.write(buf, customStart);
        }
        else {
            this.write(buf, "do");
        }
        this.indent();
        this.newLine(buf);
        return block;
    }
    endAllBlocks(buf, state) {
        while (state.blocks.length > 0) {
            this.endBlock(buf, state);
        }
    }
    endBlocksUntil(buf, state, tgtBlock) {
        if (tgtBlock.hasClosed) {
            return;
        }
        while (state.blocks.length > 0) {
            if (state.blocks[state.blocks.length - 1] == tgtBlock) {
                break;
            }
            this.endBlock(buf, state);
        }
    }
    endBlocksUntilEx(buf, state, tgtBlock) {
        if (tgtBlock.hasClosed) {
            return;
        }
        while (state.blocks.length > 0) {
            this.endBlock(buf, state);
            if (state.blocks[state.blocks.length - 1] == tgtBlock) {
                break;
            }
        }
    }
    endBlock(buf, state) {
        let block = state.blocks.pop();
        if (block) {
            this.endBlockInternal(buf, block, state);
            if (state.stackLevel > block.enterStackLevel) {
                this.writeLn(buf, "-- WARNING: a block as popped extra information into the stack.");
            }
            return true;
        }
        return false;
    }
    endBlockInternal(buf, block, state) {
        block.hasClosed = true;
        if (block.resultType !== null) {
            this.write(buf, state.regManager.getPhysicalRegisterName(block.resultRegister) + " = " + this.getPop(state));
            this.newLine(buf);
        }
        let popCnt = state.stackLevel - block.enterStackLevel;
        for (let i = 0; i < popCnt; i++) {
            this.getPop(state);
        }
        if (block.resultType !== null) {
            this.writeLn(buf, "-- BLOCK RET (" + block.blockType + "):");
            this.writeLn(buf, this.getPushStack(state, block.resultRegister));
        }
        this.outdent(buf);
        this.write(buf, "end");
        this.newLine(buf);
        this.write(buf, sanitizeIdentifier(`::${block.id}_fin::`));
        this.newLine(buf);
    }
    startElseSubBlock(buf, block, state) {
        if (block.resultType !== null) {
            this.write(buf, state.regManager.getPhysicalRegisterName(block.resultRegister) + " = " + this.getPop(state));
            this.newLine(buf);
        }
        let popCnt = state.stackLevel - block.enterStackLevel;
        for (let i = 0; i < popCnt; i++) {
            this.getPop(state);
        }
        if (block.resultType !== null) {
            this.writeLn(buf, "-- BLOCK RET !!! (" + block.blockType + "):");
            this.writeLn(buf, this.getPushStack(state, block.resultRegister));
        }
        this.outdent(buf);
        this.write(buf, "else");
        this.newLine(buf);
        this.indent();
    }
    writeBranch(buf, state, blocksToExit) {
        let targetBlock = state.blocks[state.blocks.length - blocksToExit - 1];
        if (targetBlock) {
            if (targetBlock.resultType !== null) {
                this.write(buf, state.regManager.getPhysicalRegisterName(targetBlock.resultRegister) + " = " + this.getPeek(state) + "; ");
            }
            this.write(buf, "goto ");
            if (targetBlock.blockType == "loop") {
                this.write(buf, sanitizeIdentifier(`${targetBlock.id}_start`));
            }
            else {
                this.write(buf, sanitizeIdentifier(`${targetBlock.id}_fin`));
            }
        }
        else if (blocksToExit == state.blocks.length) {
            this.writeReturn(buf, state);
        }
        else {
            this.write(buf, "goto ____UNRESOLVED_DEST____");
        }
        this.write(buf, ";");
    }
    writeReturn(buf, state) {
        this.write(buf, "do return ");
        let nRets = state.funcType ? state.funcType.results.length : 0;
        for (let i = 0; i < nRets; i++) {
            this.write(buf, this.getPeek(state, i));
            if (nRets !== (i + 1)) {
                this.write(buf, ",");
            }
        }
        this.write(buf, " end");
    }
    processInstructionsPass1(insArr, state) {
        for (let ins of insArr) {
            state.insCountPass1++;
            switch (ins.type) {
                case "Instr": {
                    switch (ins.id) {
                        case "local": {
                            break;
                        }
                        case "get_local": {
                            let locID = ins.args[0].value;
                            state.insLastRefs[locID] = state.insCountPass1;
                            break;
                        }
                        case "set_local": {
                            let locID = ins.args[0].value;
                            state.insLastRefs[locID] = state.insCountPass1;
                            break;
                        }
                        case "tee_local": {
                            let locID = ins.args[0].value;
                            state.insLastRefs[locID] = state.insCountPass1;
                            break;
                        }
                    }
                    break;
                }
                case "BlockInstruction":
                case "LoopInstruction": {
                    this.processInstructionsPass1(ins.instr, state);
                    break;
                }
                case "IfInstruction": {
                    this.processInstructionsPass1(ins.consequent, state);
                    if (ins.alternate.length > 0) {
                        this.processInstructionsPass1(ins.alternate, state);
                    }
                    break;
                }
            }
        }
    }
    processInstructionsPass2(insArr, state) {
        let buf = [];
        for (let ins of insArr) {
            state.insCountPass2++;
            switch (ins.type) {
                case "Instr": {
                    switch (ins.id) {
                        case "local": {
                            break;
                        }
                        case "const": {
                            if (ins.args[0].type == "LongNumberLiteral") {
                                let _const = ins.args[0].value;
                                this.writeLn(buf, this.getPushStack(state, `__LONG_INT__(${_const.low},${_const.high})`));
                            }
                            else {
                                let _const = ins.args[0].value;
                                this.writeLn(buf, this.getPushStack(state, _const.toString()));
                            }
                            break;
                        }
                        case "get_global": {
                            let globID = ins.args[0].value;
                            this.writeLn(buf, this.getPushStack(state, "__GLOBALS__[" + globID + "]"));
                            break;
                        }
                        case "set_global": {
                            let globID = ins.args[0].value;
                            this.writeLn(buf, "__GLOBALS__[" + globID + "] = " + this.getPop(state) + ";");
                            break;
                        }
                        case "get_local": {
                            let locID = ins.args[0].value;
                            if (!state.locals[locID]) {
                                state.locals[locID] = state.regManager.createRegister(`loc${locID}`);
                            }
                            if (typeof state.locals[locID].firstRef === "undefined") {
                                state.locals[locID].firstRef = state.insCountPass2;
                                state.locals[locID].lastRef = state.insLastRefs[locID];
                            }
                            this.writeLn(buf, this.getPushStack(state, state.locals[locID]));
                            break;
                        }
                        case "set_local": {
                            let locID = ins.args[0].value;
                            if (!state.locals[locID]) {
                                state.locals[locID] = state.regManager.createRegister(`loc${locID}`);
                            }
                            if (typeof state.locals[locID].firstRef === "undefined") {
                                state.locals[locID].firstRef = state.insCountPass2;
                                state.locals[locID].lastRef = state.insLastRefs[locID];
                            }
                            this.write(buf, state.regManager.getPhysicalRegisterName(state.locals[locID]));
                            this.write(buf, " = " + this.getPop(state) + ";");
                            this.newLine(buf);
                            break;
                        }
                        case "tee_local": {
                            let locID = ins.args[0].value;
                            if (!state.locals[locID]) {
                                state.locals[locID] = state.regManager.createRegister(`loc${locID}`);
                            }
                            if (typeof state.locals[locID].firstRef === "undefined") {
                                state.locals[locID].firstRef = state.insCountPass2;
                                state.locals[locID].lastRef = state.insLastRefs[locID];
                            }
                            this.write(buf, state.regManager.getPhysicalRegisterName(state.locals[locID]));
                            this.write(buf, " = " + this.getPop(state) + " ; ");
                            this.writeLn(buf, this.getPushStack(state, state.locals[locID]));
                            break;
                        }
                        case "sqrt": {
                            this.writeLn(buf, this.getPushStack(state, `math.sqrt(${this.getPop(state)})`));
                            break;
                        }
                        case "neg": {
                            this.writeLn(buf, this.getPushStack(state, `-(${this.getPop(state)})`));
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
                                this.write(buf, "__TMP__ = ");
                                this.write(buf, this.getPop(state));
                                this.write(buf, "; ");
                                this.write(buf, "__TMP2__ = ");
                                this.write(buf, this.getPop(state));
                                this.write(buf, "; ");
                                this.write(buf, this.getPushStack(state));
                                if (convert_bool) {
                                    if (unsigned) {
                                        this.write(buf, "(__UNSIGNED__(__TMP2__) " + op + " __UNSIGNED__(__TMP__)) and 1 or 0");
                                    }
                                    else {
                                        this.write(buf, "(__TMP2__ " + op + " __TMP__) and 1 or 0");
                                    }
                                }
                                else if (ins.object == "i32") {
                                    this.write(buf, "bit.tobit(__TMP2__ " + op + " __TMP__)");
                                }
                                else {
                                    this.write(buf, "__TMP2__ " + op + " __TMP__");
                                }
                                this.write(buf, ";");
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
                        case "div_s":
                        case "div_u":
                        case "rem_s":
                        case "rem_u":
                            {
                                if (ins.object == "i32") {
                                    let op_func = wasm2lua.instructionBinOpFuncRemap[ins.id];
                                    this.write(buf, "__TMP__ = ");
                                    this.write(buf, this.getPop(state));
                                    this.write(buf, "; ");
                                    this.write(buf, "__TMP2__ = ");
                                    this.write(buf, this.getPop(state));
                                    this.write(buf, "; ");
                                    this.write(buf, this.getPushStack(state));
                                    this.write(buf, op_func);
                                    this.write(buf, "(__TMP2__,__TMP__);");
                                }
                                else if (ins.object == "i64") {
                                    this.write(buf, "__TMP__ = ");
                                    this.write(buf, this.getPop(state));
                                    this.write(buf, "; ");
                                    this.write(buf, "__TMP2__ = ");
                                    this.write(buf, this.getPop(state));
                                    this.write(buf, "; ");
                                    this.write(buf, this.getPushStack(state));
                                    this.write(buf, `__TMP2__:_${ins.id}(__TMP__);`);
                                }
                                else {
                                    this.write(buf, "error('BIT OP ON UNSUPPORTED TYPE: " + ins.object + "," + ins.id + "');");
                                }
                                this.newLine(buf);
                                break;
                            }
                        case "clz":
                        case "ctz":
                        case "popcnt":
                            {
                                var arg = this.getPop(state);
                                if (ins.object == "i64") {
                                    this.write(buf, this.getPushStack(state, arg + ":_" + ins.id + "()"));
                                }
                                else {
                                    let op_func = wasm2lua.instructionBinOpFuncRemap[ins.id];
                                    this.write(buf, this.getPushStack(state, op_func + "(" + arg + ")"));
                                }
                                break;
                            }
                        case "eqz": {
                            let resultVar = state.regManager.createTempRegister();
                            this.write(buf, `${state.regManager.getPhysicalRegisterName(resultVar)} = (`);
                            this.write(buf, this.getPop(state));
                            this.write(buf, "==0) and 1 or 0; ");
                            this.write(buf, this.getPushStack(state, resultVar));
                            this.newLine(buf);
                            break;
                        }
                        case "select": {
                            let popCondVar = state.regManager.createTempRegister();
                            this.write(buf, state.regManager.getPhysicalRegisterName(popCondVar) + " = ");
                            this.write(buf, this.getPop(state));
                            this.write(buf, "; ");
                            let retVar1 = state.regManager.createTempRegister();
                            this.write(buf, state.regManager.getPhysicalRegisterName(retVar1) + " = ");
                            this.write(buf, this.getPop(state));
                            this.write(buf, "; ");
                            let retVar2 = state.regManager.createTempRegister();
                            this.write(buf, state.regManager.getPhysicalRegisterName(retVar2) + " = ");
                            this.write(buf, this.getPop(state));
                            this.write(buf, "; ");
                            let resultVar = state.regManager.createTempRegister();
                            this.write(buf, `if ${state.regManager.getPhysicalRegisterName(popCondVar)} == 0 then `);
                            this.write(buf, ` ${state.regManager.getPhysicalRegisterName(resultVar)} = ${state.regManager.getPhysicalRegisterName(retVar1)} `);
                            this.write(buf, `else ${state.regManager.getPhysicalRegisterName(resultVar)} = ${state.regManager.getPhysicalRegisterName(retVar2)} `);
                            this.write(buf, "end;");
                            state.regManager.freeRegister(popCondVar);
                            state.regManager.freeRegister(retVar1);
                            state.regManager.freeRegister(retVar2);
                            this.write(buf, this.getPushStack(state, resultVar));
                            this.newLine(buf);
                            break;
                        }
                        case "drop": {
                            this.stackDrop(state);
                            this.write(buf, "-- stack drop");
                            this.newLine(buf);
                            break;
                        }
                        case "promote/f32":
                        case "demote/f64":
                            break;
                        case "extend_u/i32": {
                            this.write(buf, `__TMP__=${this.getPop(state)}; `);
                            this.write(buf, `${this.getPushStack(state)}__LONG_INT__(__TMP__,0);`);
                            this.newLine(buf);
                            break;
                        }
                        case "br_if": {
                            this.write(buf, "if ");
                            this.write(buf, this.getPop(state));
                            this.write(buf, "~=0 then ");
                            this.writeBranch(buf, state, ins.args[0].value);
                            this.write(buf, " end;");
                            this.newLine(buf);
                            break;
                        }
                        case "br": {
                            this.writeBranch(buf, state, ins.args[0].value);
                            this.newLine(buf);
                            break;
                        }
                        case "br_table": {
                            this.write(buf, `__TMP__ = ${this.getPop(state)};`);
                            this.newLine(buf);
                            let arg_count = ins.args.length;
                            if (arg_count > 1000) {
                                this.write(buf, "error('jump table too big')");
                                this.newLine(buf);
                                break;
                            }
                            ins.args.forEach((target, i) => {
                                if (i != 0) {
                                    this.write(buf, "else");
                                }
                                if (i < arg_count - 1) {
                                    this.write(buf, `if __TMP__ == ${i} then `);
                                }
                                else {
                                    this.write(buf, " ");
                                }
                                this.writeBranch(buf, state, target.value);
                                this.newLine(buf);
                            });
                            if (ins.args.length > 1) {
                                this.write(buf, "end");
                                this.newLine(buf);
                            }
                            break;
                        }
                        case "store":
                        case "store8":
                        case "store16":
                        case "store32": {
                            let targ = state.modState.memoryAllocations.get(0);
                            if (targ) {
                                this.write(buf, "__TMP__ = ");
                                this.write(buf, this.getPop(state));
                                this.write(buf, "; ");
                                this.write(buf, "__TMP2__ = ");
                                this.write(buf, this.getPop(state));
                                this.write(buf, "; ");
                                if (ins.object == "u32") {
                                    if (ins.id == "store16") {
                                        this.write(buf, "__MEMORY_WRITE_16__");
                                    }
                                    else if (ins.id == "store8") {
                                        this.write(buf, "__MEMORY_WRITE_8__");
                                    }
                                    else {
                                        this.write(buf, "__MEMORY_WRITE_32__");
                                    }
                                    this.write(buf, `(${targ},__TMP2__+${ins.args[0].value},__TMP__);`);
                                }
                                else if (ins.object == "u64") {
                                    this.write(buf, `__TMP__:${ins.id}(${targ},__TMP2__+${ins.args[0].value});`);
                                }
                                else if (ins.object == "f32") {
                                    this.write(buf, "__MEMORY_WRITE_32F__");
                                    this.write(buf, `(${targ},__TMP2__+${ins.args[0].value},__TMP__);`);
                                }
                                else if (ins.object == "f64") {
                                    this.write(buf, "__MEMORY_WRITE_64F__");
                                    this.write(buf, `(${targ},__TMP2__+${ins.args[0].value},__TMP__);`);
                                }
                                else {
                                    this.write(buf, "-- WARNING: UNSUPPORTED MEMORY OP ON TYPE: " + ins.object);
                                }
                                this.newLine(buf);
                            }
                            else {
                                this.write(buf, "-- WARNING: COULD NOT FIND MEMORY TO WRITE");
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
                            if (targ) {
                                this.write(buf, "__TMP__ = ");
                                let is_narrow_u64_load = (ins.object == "u64" && ins.id != "load");
                                if (ins.object == "u32" || is_narrow_u64_load) {
                                    if (ins.id.startsWith("load16")) {
                                        this.write(buf, "__MEMORY_READ_16__");
                                    }
                                    else if (ins.id.startsWith("load8")) {
                                        this.write(buf, "__MEMORY_READ_8__");
                                    }
                                    else {
                                        this.write(buf, "__MEMORY_READ_32__");
                                    }
                                    this.write(buf, `(${targ},${this.getPop(state)}+${ins.args[0].value});`);
                                    if (ins.id.endsWith("_s") && ins.id != "load32_s") {
                                        let shift;
                                        if (ins.id == "load8_s") {
                                            shift = 24;
                                        }
                                        else if (ins.id == "load16_s") {
                                            shift = 16;
                                        }
                                        else {
                                            throw new Error("signed load " + ins.id);
                                        }
                                        this.write(buf, `__TMP__=bit.arshift(bit.lshift(__TMP__,${shift}),${shift});`);
                                    }
                                }
                                else if (ins.object == "u64") {
                                    if (ins.id == "load") {
                                        this.write(buf, `__LONG_INT__(0,0); __TMP__:${ins.id}(${targ},${this.getPop(state)}+${ins.args[0].value});`);
                                    }
                                    else {
                                        throw new Error("narrow u64 loads NYI " + ins.id);
                                    }
                                }
                                else if (ins.object == "f32") {
                                    this.write(buf, "__MEMORY_READ_32F__");
                                    this.write(buf, `(${targ},${this.getPop(state)}+${ins.args[0].value});`);
                                }
                                else if (ins.object == "f64") {
                                    this.write(buf, "__MEMORY_READ_64F__");
                                    this.write(buf, `(${targ},${this.getPop(state)}+${ins.args[0].value});`);
                                }
                                else {
                                    this.write(buf, "0 -- WARNING: UNSUPPORTED MEMORY OP ON TYPE: " + ins.object);
                                    this.newLine(buf);
                                    break;
                                }
                                if (is_narrow_u64_load) {
                                    if (ins.id.endsWith("_s")) {
                                        this.write(buf, "__TMP__=__LONG_INT__(__TMP__,__TMP__ < 0 and -1 or 0);");
                                    }
                                    else {
                                        this.write(buf, "__TMP__=__LONG_INT__(__TMP__,0);");
                                    }
                                }
                                this.write(buf, this.getPushStack(state) + "__TMP__;");
                                this.newLine(buf);
                            }
                            else {
                                this.write(buf, "-- WARNING: COULD NOT FIND MEMORY TO READ");
                                this.newLine(buf);
                            }
                            break;
                        }
                        case "grow_memory": {
                            let targ = state.modState.memoryAllocations.get(0);
                            this.write(buf, `__TMP__ = __MEMORY_GROW__(${targ},__UNSIGNED__(${this.getPop(state)})); `);
                            this.write(buf, `${this.getPushStack(state)}__TMP__;`);
                            this.newLine(buf);
                            break;
                        }
                        case "return": {
                            this.writeReturn(buf, state);
                            this.newLine(buf);
                            break;
                        }
                        case "end": {
                            this.endBlock(buf, state);
                            break;
                        }
                        case "unreachable": {
                            this.write(buf, "error('unreachable');");
                            this.newLine(buf);
                            break;
                        }
                        case "nop":
                            break;
                        default: {
                            this.write(buf, "error('TODO " + ins.id + "');");
                            this.newLine(buf);
                            break;
                        }
                    }
                    break;
                }
                case "CallInstruction": {
                    let fstate = this.getFuncByIndex(state.modState, ins.index);
                    if (fstate && fstate.funcType) {
                        this.writeFunctionCall(state, buf, fstate.id, fstate.funcType);
                        this.newLine(buf);
                    }
                    else {
                        this.write(buf, `error("UNRESOLVED CALL: ${ins.index.value}")`);
                        this.newLine(buf);
                    }
                    break;
                }
                case "CallIndirectInstruction": {
                    let table_index = 0;
                    let func = `__TABLE_FUNCS_${table_index}__[__TABLE_OFFSET_${table_index}__+${this.getPop(state)}]`;
                    if (ins.signature.type == "Signature") {
                        this.writeFunctionCall(state, buf, func, ins.signature);
                        this.newLine(buf);
                    }
                    else {
                        this.write(buf, `error("BAD SIGNATURE ON INDIRECT CALL?")`);
                        this.newLine(buf);
                    }
                    break;
                }
                case "BlockInstruction":
                case "LoopInstruction": {
                    let blockType = (ins.type == "LoopInstruction") ? "loop" : "block";
                    let block = this.beginBlock(buf, state, {
                        id: ins.label.value,
                        resultType: (ins.type == "LoopInstruction") ? ins.resulttype : ins.result,
                        blockType,
                        enterStackLevel: state.stackLevel,
                    });
                    if (block.resultType !== null) {
                        block.resultRegister = state.regManager.createTempRegister();
                    }
                    this.write(buf, this.processInstructionsPass2(ins.instr, state));
                    break;
                }
                case "IfInstruction": {
                    if (ins.test.length > 0) {
                        this.write(buf, "error('if test nyi')");
                        this.newLine(buf);
                    }
                    let block = this.beginBlock(buf, state, {
                        id: `if_${ins.loc.start.line}_${ins.loc.start.column}`,
                        blockType: "if",
                        resultType: ins.result,
                        enterStackLevel: state.stackLevel
                    }, `if ${this.getPop(state)} ~= 0 then`);
                    if (block.resultType !== null) {
                        block.resultRegister = state.regManager.createTempRegister();
                    }
                    this.write(buf, this.processInstructionsPass2(ins.consequent, state));
                    if (ins.alternate.length > 0) {
                        this.startElseSubBlock(buf, block, state);
                        this.write(buf, this.processInstructionsPass2(ins.alternate, state));
                    }
                    break;
                }
                default: {
                    this.write(buf, "error('TODO " + ins.type + "');");
                    this.newLine(buf);
                    break;
                }
            }
            if (ins.type === "Instr") {
                switch (ins.id) {
                    case "get_local":
                    case "set_local":
                    case "tee_local": {
                        let locID = ins.args[0].value;
                        if (state.insCountPass2 >= state.insLastRefs[locID]) {
                            if (state.locals[locID].stackEntryCount == 0) {
                                state.regManager.freeRegister(state.locals[locID]);
                            }
                        }
                        break;
                    }
                }
            }
            for (let reg of state.registersToBeFreed) {
                state.regManager.freeRegister(reg);
            }
            state.registersToBeFreed = [];
        }
        return buf.join("");
    }
    processInstructionsPass3(insArr, state) {
        let t_buf = [];
        if ((state.regManager.totalRegisters - (state.funcType ? state.funcType.params.length : 0)) > 0) {
            this.write(t_buf, "local ");
            for (let i = (state.funcType ? state.funcType.params.length : 0); i < state.regManager.totalRegisters; i++) {
                this.write(t_buf, `reg${i}`);
                if (i !== (state.regManager.totalRegisters - 1)) {
                    this.write(t_buf, ",");
                }
            }
            if (state.regManager.totalRegisters > 150) {
                console.log(`${state.id}: WARNING: ${state.regManager.totalRegisters} REGISTERS USED`);
            }
            this.write(t_buf, ";");
            this.newLine(t_buf);
        }
        return t_buf.join("");
    }
    writeFunctionCall(state, buf, func, sig) {
        if (sig.results.length > 1) {
            this.write(buf, "__TMP__ = {");
        }
        else if (sig.results.length == 1) {
            this.write(buf, "__TMP__ = ");
        }
        this.write(buf, func + "(");
        let args = [];
        for (let i = 0; i < sig.params.length; i++) {
            args.push(this.getPop(state));
        }
        this.write(buf, args.reverse().join(","));
        this.write(buf, ")");
        if (sig.results.length > 1) {
            this.write(buf, "};");
            for (let i = 0; i < sig.results.length; i++) {
                this.write(buf, this.getPushStack(state));
                this.write(buf, "__TMP__[" + (i + 1) + "];");
            }
        }
        else if (sig.results.length == 1) {
            this.write(buf, "; " + this.getPushStack(state) + " __TMP__;");
        }
        else {
            this.write(buf, ";");
        }
    }
    processModuleExport(node, modState) {
        let buf = [];
        this.write(buf, "__EXPORTS__[\"");
        this.write(buf, node.name);
        this.write(buf, "\"] = ");
        switch (node.descr.exportType) {
            case "Func": {
                let fstate = this.getFuncByIndex(modState, node.descr.id);
                if (fstate) {
                    this.write(buf, fstate.id);
                }
                else {
                    this.write(buf, "--[[WARNING: EXPORT_FAIL]] func_u" + node.descr.id.value);
                }
                break;
            }
            case "Mem": {
                let targ = modState.memoryAllocations.get(node.descr.id.value);
                if (targ) {
                    this.write(buf, targ);
                }
                else {
                    this.write(buf, "nil --[[WARNING: COULDN'T FIND MEMORY TO EXPORT]]");
                }
                break;
            }
            case "Global": {
                this.write(buf, "nil -- TODO global export");
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
        switch (node.descr.type) {
            case "Memory": {
                let memID = `__MODULES__.${node.module}.${node.name}`;
                if (node.descr.id) {
                    modState.memoryAllocations.set(node.descr.id.value, memID);
                }
                else {
                    modState.memoryAllocations.push(memID);
                }
                break;
            }
            case "FuncImportDescr": {
                this.initFunc({
                    signature: node.descr.signature,
                    name: { value: node.descr.id.value },
                }, modState, `__MODULES__.${node.module}.${node.name}`);
                break;
            }
            default: {
                this.write(buf, "-- IMPORT " + JSON.stringify(node));
                this.newLine(buf);
                break;
            }
        }
        return buf.join("");
    }
}
wasm2lua.fileHeader = fs.readFileSync(__dirname + "/../resources/fileheader.lua").toString();
wasm2lua.funcHeader = fs.readFileSync(__dirname + "/../resources/fileheader.lua").toString();
wasm2lua.instructionBinOpRemap = {
    add: { op: "+" },
    sub: { op: "-" },
    mul: { op: "*" },
    div: { op: "/" },
    eq: { op: "==", bool_result: true },
    ne: { op: "~=", bool_result: true },
    lt: { op: "<", bool_result: true },
    le: { op: "<=", bool_result: true },
    ge: { op: ">=", bool_result: true },
    gt: { op: ">", bool_result: true },
    lt_s: { op: "<", bool_result: true },
    le_s: { op: "<=", bool_result: true },
    ge_s: { op: ">=", bool_result: true },
    gt_s: { op: ">", bool_result: true },
    lt_u: { op: "<", bool_result: true, unsigned: true },
    le_u: { op: "<=", bool_result: true, unsigned: true },
    ge_u: { op: ">=", bool_result: true, unsigned: true },
    gt_u: { op: ">", bool_result: true, unsigned: true },
};
wasm2lua.instructionBinOpFuncRemap = {
    and: "bit.band",
    or: "bit.bor",
    xor: "bit.bxor",
    shl: "bit.lshift",
    shr_u: "bit.rshift",
    shr_s: "bit.arshift",
    rotl: "bit.rol",
    rotr: "bit.ror",
    div_s: "__DIVIDE_S__",
    div_u: "__DIVIDE_U__",
    rem_s: "__MODULO_S__",
    rem_u: "__MODULO_U__",
    clz: "__CLZ__",
    ctz: "__CTZ__",
    popcnt: "__POPCNT__"
};
exports.wasm2lua = wasm2lua;
let infile = process.argv[2] || (__dirname + "/../test/testwasi.wasm");
let outfile = process.argv[3] || (__dirname + "/../test/test.lua");
let whitelist = process.argv[4] ? process.argv[4].split(",") : null;
let wasm = fs.readFileSync(infile);
let inst = new wasm2lua(wasm, { whitelist });
fs.writeFileSync(outfile, inst.outBuf.join(""));
//# sourceMappingURL=index.js.map
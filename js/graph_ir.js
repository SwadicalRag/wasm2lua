"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
var IRType;
(function (IRType) {
    IRType[IRType["Int"] = 0] = "Int";
    IRType[IRType["LongInt"] = 1] = "LongInt";
    IRType[IRType["Float"] = 2] = "Float";
    IRType[IRType["Bool"] = 3] = "Bool";
    IRType[IRType["Void"] = 4] = "Void";
})(IRType || (IRType = {}));
var IRConvertMode;
(function (IRConvertMode) {
    IRConvertMode[IRConvertMode["Int"] = 0] = "Int";
    IRConvertMode[IRConvertMode["Bool"] = 1] = "Bool";
    IRConvertMode[IRConvertMode["Any"] = 2] = "Any";
})(IRConvertMode || (IRConvertMode = {}));
function convertWasmTypeToIRType(type) {
    if (type == "i32") {
        return IRType.Int;
    }
    else if (type == "i64") {
        return IRType.LongInt;
    }
    else if (type == "f32" || type == "f64") {
        return IRType.Float;
    }
    else {
        return IRType.Void;
    }
}
let next_block_id;
class IRControlBlock {
    constructor(func_info, input_type, is_exit = false) {
        this.func_info = func_info;
        this.input_type = input_type;
        this.is_exit = is_exit;
        this.id = next_block_id++;
        this.operations = new Array();
        this.prev = new Array();
        this.next = new Array();
    }
    addNextBlock(next) {
        this.next.push(next);
        next.prev.push(this);
    }
    getNextBlock(index) {
        return this.next[index];
    }
    _addOp(x) {
        this.operations.push(x);
    }
    processOpsR(seen) {
        if (seen[this.id]) {
            return;
        }
        seen[this.id] = true;
        let value_stack = [];
        this.operations.forEach((op) => {
            op.update_arg_count();
            for (let i = 0; i < op.arg_count; i++) {
                let arg = value_stack.pop();
                if (arg == null) {
                    arg = new IROpError(this, "negative stack access");
                }
                op.args.push(arg);
                arg.refs.push(op);
            }
            for (let i = 0; i < op.peek_count; i++) {
                let arg = value_stack[value_stack.length - 1 - i];
                if (arg == null) {
                    arg = new IROpError(this, "negative stack access");
                }
                op.args.push(arg);
                arg.refs.push(op);
            }
            if (op.type != IRType.Void) {
                value_stack.push(op);
            }
        });
        this.next.forEach((block) => {
            block.processOpsR(seen);
        });
    }
    emitR(str_builder, str_buffer, seen) {
        if (seen[this.id]) {
            return;
        }
        seen[this.id] = true;
        str_builder.write(str_buffer, `::block_${this.id}:: --> [${this.next.map(x => x.id)}] (${this.input_type})`);
        str_builder.indent();
        if (this.is_exit) {
            str_builder.newLine(str_buffer);
            str_builder.write(str_buffer, "return ");
            for (let i = 0; i < this.func_info.return_types.length; i++) {
                str_builder.write(str_buffer, `ret${i}`);
                if ((i + 1) < this.func_info.return_types.length) {
                    str_builder.write(str_buffer, ", ");
                }
            }
        }
        else {
            this.operations.forEach((op) => {
                str_builder.newLine(str_buffer);
                str_builder.write(str_buffer, op.emit_code());
            });
        }
        str_builder.outdent();
        str_builder.newLine(str_buffer);
        this.next.forEach((block) => {
            block.emitR(str_builder, str_buffer, seen);
        });
    }
}
class IROperation {
    constructor(parent) {
        this.parent = parent;
        this.arg_count = 0;
        this.peek_count = 0;
        this.args = new Array();
        this.refs = new Array();
        this.is_write = false;
        this.is_read = false;
        this.always_inline = false;
        parent._addOp(this);
    }
    update_arg_count() {
    }
}
class IROpConst extends IROperation {
    constructor(parent, value, type) {
        super(parent);
        this.value = value;
        this.always_inline = true;
        this.type = type;
    }
    emit_code() {
        if (this.value.type == "LongNumberLiteral") {
            let value = this.value.value;
            return `__LONG_INT__(${value.low},${value.high})`;
        }
        else {
            let _const = this.value;
            if (_const.inf) {
                if (_const.value > 0) {
                    return "(1/0)";
                }
                else {
                    return "(-1/0)";
                }
            }
            else if (_const.nan) {
                return "(0/0)";
            }
            else if (_const.value == 0 && 1 / _const.value == -Number.POSITIVE_INFINITY) {
                return "(-0)";
            }
            else {
                return _const.value.toString();
            }
        }
    }
}
class IROpBranchAlways extends IROperation {
    constructor() {
        super(...arguments);
        this.is_write = true;
        this.type = IRType.Void;
    }
    update_arg_count() {
        var target = this.parent.getNextBlock(0);
        if (target.is_exit) {
            this.peek_count = this.parent.func_info.return_types.length;
        }
        else {
            this.peek_count = (target.input_type == IRType.Void) ? 0 : 1;
        }
    }
    emit_code() {
        return "goto block_" + this.parent.getNextBlock(0).id;
    }
}
class IROpError extends IROperation {
    constructor(parent, msg) {
        super(parent);
        this.msg = msg;
        this.type = IRType.Void;
    }
    emit_code() {
        return `error("${this.msg}")`;
    }
}
function compileFuncWithIR(node, modState, str_builder) {
    next_block_id = 1;
    let str_buffer = new Array();
    let func_info;
    if (node.signature.type == "Signature") {
        func_info = {
            arg_count: node.signature.params.length,
            local_types: node.signature.params.map((param) => convertWasmTypeToIRType(param.valtype)),
            return_types: node.signature.results.map(convertWasmTypeToIRType)
        };
    }
    else {
        throw new Error("bad signature");
    }
    let entry = new IRControlBlock(func_info, IRType.Void);
    let exit = new IRControlBlock(func_info, IRType.Void, true);
    compileWASMBlockToIRBlocks(func_info, node.body, entry, [exit]);
    entry.processOpsR({});
    str_builder.write(str_buffer, `function __FUNCS__.${node.name.value}(`);
    for (let i = 0; i < func_info.arg_count; i++) {
        str_builder.write(str_buffer, `var${i}`);
        if ((i + 1) < func_info.arg_count) {
            str_builder.write(str_buffer, ", ");
        }
    }
    str_builder.write(str_buffer, `)`);
    str_builder.indent();
    str_builder.newLine(str_buffer);
    str_builder.write(str_buffer, "local blockres");
    str_builder.newLine(str_buffer);
    if (func_info.return_types.length > 0) {
        if (func_info.return_types.length > 1) {
            throw new Error("Fatal: Too many returns from function.");
        }
        str_builder.write(str_buffer, "local ");
        for (let i = 0; i < func_info.return_types.length; i++) {
            str_builder.write(str_buffer, `ret${i}`);
            if ((i + 1) < func_info.return_types.length) {
                str_builder.write(str_buffer, ", ");
            }
        }
        str_builder.newLine(str_buffer);
    }
    entry.emitR(str_builder, str_buffer, {});
    str_builder.outdent();
    str_builder.newLine(str_buffer);
    str_builder.write(str_buffer, "end");
    str_builder.newLine(str_buffer);
    return str_buffer.join("");
}
exports.compileFuncWithIR = compileFuncWithIR;
function compileWASMBlockToIRBlocks(func_info, body, current_block, branch_targets, skip_link_next) {
    for (let i = 0; i < body.length; i++) {
        let instr = body[i];
        if (instr.type == "BlockInstruction") {
            let next_block = new IRControlBlock(func_info, convertWasmTypeToIRType(instr.result));
            compileWASMBlockToIRBlocks(func_info, instr.instr, current_block, branch_targets.concat([next_block]));
            current_block = next_block;
        }
        else if (instr.type == "LoopInstruction") {
            let loop_block = new IRControlBlock(func_info, IRType.Void);
            current_block.addNextBlock(loop_block);
            compileWASMBlockToIRBlocks(func_info, instr.instr, loop_block, branch_targets.concat([loop_block]), true);
            if (instr.resulttype != null) {
            }
            current_block = loop_block;
        }
        else if (instr.type == "IfInstruction") {
            new IROpError(current_block, "conditional branch");
            let next_block = new IRControlBlock(func_info, convertWasmTypeToIRType(instr.result));
            let block_true = new IRControlBlock(func_info, IRType.Void);
            current_block.addNextBlock(block_true);
            compileWASMBlockToIRBlocks(func_info, instr.consequent, block_true, branch_targets.concat([next_block]));
            if (instr.alternate.length > 0) {
                let block_false = new IRControlBlock(func_info, IRType.Void);
                current_block.addNextBlock(block_false);
                compileWASMBlockToIRBlocks(func_info, instr.consequent, block_false, branch_targets.concat([next_block]));
            }
            else {
                current_block.addNextBlock(next_block);
            }
            current_block = next_block;
        }
        else if (instr.type == "CallInstruction" || instr.type == "CallIndirectInstruction") {
            new IROpError(current_block, "call!");
        }
        else if (instr.type == "Instr") {
            if (instr.id == "br") {
                new IROpBranchAlways(current_block);
                let blocks_to_exit = instr.args[0].value;
                current_block.addNextBlock(branch_targets[branch_targets.length - 1 - blocks_to_exit]);
                return;
            }
            else if (instr.id == "br_if") {
                new IROpError(current_block, "conditional branch ~ ");
                let next_block = new IRControlBlock(func_info, IRType.Void);
                let blocks_to_exit = instr.args[0].value;
                current_block.addNextBlock(branch_targets[branch_targets.length - 1 - blocks_to_exit]);
                current_block.addNextBlock(next_block);
                current_block = next_block;
            }
            else if (instr.id == "br_table") {
                new IROpError(current_block, "table branch ~ ");
                instr.args.forEach((arg) => {
                    let blocks_to_exit = arg.value;
                    current_block.addNextBlock(branch_targets[branch_targets.length - 1 - blocks_to_exit]);
                });
                return;
            }
            else if (instr.id == "end" || instr.id == "nop") {
            }
            else {
                switch (instr.id) {
                    case "const":
                        new IROpConst(current_block, instr.args[0], convertWasmTypeToIRType(instr.object));
                        break;
                    default:
                        new IROpError(current_block, "unknown: " + instr.id);
                        break;
                }
            }
        }
        else {
            throw new Error(instr.type + " " + instr.id);
        }
    }
    if (!skip_link_next) {
        new IROpBranchAlways(current_block);
        current_block.addNextBlock(branch_targets[branch_targets.length - 1]);
    }
}
//# sourceMappingURL=graph_ir.js.map
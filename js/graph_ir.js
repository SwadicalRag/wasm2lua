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
    constructor() {
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
    emitR(builder, buffer, seen) {
        if (seen[this.id]) {
            return;
        }
        seen[this.id] = true;
        builder.write(buffer, `::block_${this.id}:: --> [${this.next.map(x => x.id)}]`);
        builder.indent();
        if (this.next.length > 0) {
            this.operations.forEach((op) => {
                builder.newLine(buffer);
                builder.write(buffer, op.emit_code());
            });
        }
        else {
            builder.newLine(buffer);
            builder.write(buffer, "return");
        }
        builder.outdent();
        builder.newLine(buffer);
        this.next.forEach((block) => {
            block.emitR(builder, buffer, seen);
        });
    }
}
class IROperation {
    constructor(parent) {
        this.parent = parent;
        this.arg_count = 0;
        this.is_write = false;
        this.is_read = false;
        this.always_inline = false;
        parent._addOp(this);
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
    let entry = new IRControlBlock();
    let exit = new IRControlBlock();
    compileWASMBlockToIRBlocks(node.body, entry, [exit], IRType.Void);
    str_builder.write(str_buffer, `function __FUNCS__.${node.name.value}(`);
    if (node.signature.type == "Signature") {
        let i = 0;
        for (let param of node.signature.params) {
            str_builder.write(str_buffer, `var${i}`);
            if ((i + 1) !== node.signature.params.length) {
                str_builder.write(str_buffer, ", ");
            }
            i++;
        }
    }
    str_builder.write(str_buffer, `)`);
    str_builder.indent();
    str_builder.newLine(str_buffer);
    str_builder.write(str_buffer, "local blockres");
    str_builder.newLine(str_buffer);
    entry.emitR(str_builder, str_buffer, {});
    str_builder.outdent();
    str_builder.newLine(str_buffer);
    str_builder.write(str_buffer, "end");
    str_builder.newLine(str_buffer);
    return str_buffer.join("");
}
exports.compileFuncWithIR = compileFuncWithIR;
function compileWASMBlockToIRBlocks(body, current_block, branch_targets, result_type, skip_link_next) {
    let value_stack = [];
    function processOp(op) {
        if (op.arg_count > 0) {
            throw "fixme args";
        }
        if (op.type != IRType.Void) {
            value_stack.push(op);
        }
    }
    for (let i = 0; i < body.length; i++) {
        let instr = body[i];
        if (instr.type == "BlockInstruction") {
            let next_block = new IRControlBlock();
            compileWASMBlockToIRBlocks(instr.instr, current_block, branch_targets.concat([next_block]), convertWasmTypeToIRType(instr.result));
            current_block = next_block;
        }
        else if (instr.type == "LoopInstruction") {
            let loop_block = new IRControlBlock();
            current_block.addNextBlock(loop_block);
            compileWASMBlockToIRBlocks(instr.instr, loop_block, branch_targets.concat([loop_block]), convertWasmTypeToIRType(instr.resulttype), true);
            current_block = loop_block;
        }
        else if (instr.type == "IfInstruction") {
            new IROpError(current_block, "conditional branch ~ " + IRType[result_type]);
            let next_block = new IRControlBlock();
            let block_true = new IRControlBlock();
            current_block.addNextBlock(block_true);
            compileWASMBlockToIRBlocks(instr.consequent, block_true, branch_targets.concat([next_block]), convertWasmTypeToIRType(instr.result));
            if (instr.alternate.length > 0) {
                let block_false = new IRControlBlock();
                current_block.addNextBlock(block_false);
                compileWASMBlockToIRBlocks(instr.consequent, block_false, branch_targets.concat([next_block]), convertWasmTypeToIRType(instr.result));
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
                processOp(new IROpBranchAlways(current_block));
                let blocks_to_exit = instr.args[0].value;
                current_block.addNextBlock(branch_targets[branch_targets.length - 1 - blocks_to_exit]);
                return;
            }
            else if (instr.id == "br_if") {
                new IROpError(current_block, "conditional branch ~ " + IRType[result_type]);
                let next_block = new IRControlBlock();
                let blocks_to_exit = instr.args[0].value;
                current_block.addNextBlock(branch_targets[branch_targets.length - 1 - blocks_to_exit]);
                current_block.addNextBlock(next_block);
                current_block = next_block;
            }
            else if (instr.id == "br_table") {
                new IROpError(current_block, "table branch ~ " + IRType[result_type]);
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
                        processOp(new IROpConst(current_block, instr.args[0], convertWasmTypeToIRType(instr.object)));
                        break;
                    default:
                        processOp(new IROpError(current_block, "unknown: " + instr.id));
                        break;
                }
            }
        }
        else {
            throw new Error(instr.type + " " + instr.id);
        }
    }
    if (!skip_link_next) {
        processOp(new IROpBranchAlways(current_block));
        current_block.addNextBlock(branch_targets[branch_targets.length - 1]);
    }
}
//# sourceMappingURL=graph_ir.js.map
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
function getFuncByIndex(modState, index) {
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
    getNextBlockCount() {
        return this.next.length;
    }
    _addOp(x) {
        this.operations.push(x);
    }
    emitR(str_builder, str_buffer, seen) {
        if (seen[this.id]) {
            return;
        }
        seen[this.id] = true;
        str_builder.write(str_buffer, `::block_${this.id}:: --> [${this.next.map(x => x.id)}] (${IRType[this.input_type]})`);
        str_builder.indent();
        if (this.is_exit) {
            str_builder.newLine(str_buffer);
            str_builder.write(str_buffer, "do return ");
            for (let i = 0; i < this.func_info.return_types.length; i++) {
                str_builder.write(str_buffer, `ret${i}`);
                if ((i + 1) < this.func_info.return_types.length) {
                    str_builder.write(str_buffer, ", ");
                }
            }
            str_builder.write(str_buffer, " end");
        }
        else {
            let read_ops = [];
            this.operations.forEach((op) => {
                let code = op.emit_code();
                if (code != "") {
                    str_builder.newLine(str_buffer);
                    str_builder.write(str_buffer, code);
                }
            });
        }
        str_builder.outdent();
        str_builder.newLine(str_buffer);
        this.next.forEach((block) => {
            str_builder.newLine(str_buffer);
            block.emitR(str_builder, str_buffer, seen);
        });
    }
}
const WRITE_ALL = "ALL";
class IROperation {
    constructor(parent) {
        this.parent = parent;
        this.arg_count = 0;
        this.peek_count = 0;
        this.args = new Array();
        this.refs = new Array();
        this.blocked_by_write_barrier = false;
        parent._addOp(this);
    }
    emit_code() {
        if (this.write_group != null) {
            return this.emit();
        }
        else if (this.var_name != null) {
            return this.var_name + " = " + this.emit();
        }
        return "";
    }
    ;
    emit_value() {
        if (this.var_name != null) {
            return this.var_name;
        }
        return this.emit();
    }
    args_linked() {
    }
}
class IROpConst extends IROperation {
    constructor(parent, value, type) {
        super(parent);
        this.value = value;
        this.type = type;
    }
    emit() {
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
class IROpSetGlobal extends IROperation {
    constructor(parent, index) {
        super(parent);
        this.index = index;
        this.type = IRType.Void;
        this.arg_count = 1;
        this.write_group = "G" + this.index;
    }
    emit() {
        return "__GLOBALS__[" + this.index + "] = " + this.args[0].emit_value();
    }
}
class IROpGetLocal extends IROperation {
    constructor(parent, index) {
        super(parent);
        this.index = index;
        this.read_group = "L" + this.index;
        this.type = parent.func_info.local_types[index];
    }
    emit() {
        return "var" + this.index;
    }
}
class IROpSetLocal extends IROperation {
    constructor(parent, index) {
        super(parent);
        this.index = index;
        this.type = IRType.Void;
        this.arg_count = 1;
        this.write_group = "L" + this.index;
    }
    emit() {
        return "var" + this.index + " = " + this.args[0].emit_value();
    }
}
class IROpTeeLocal extends IROperation {
    constructor(parent, index) {
        super(parent);
        this.index = index;
        this.arg_count = 1;
        this.write_group = "L" + this.index;
        this.type = parent.func_info.local_types[index];
    }
    emit_code() {
        return "var" + this.index + " = " + this.args[0].emit_value();
    }
    emit_value() {
        return "var" + this.index;
    }
    emit() {
        return "";
    }
}
class IROpBlockResult extends IROperation {
    constructor(parent, name, type) {
        super(parent);
        this.name = name;
        this.type = type;
    }
    emit() {
        return "blockres";
    }
}
function getBranchDataflowCode(args, parent, results_start, target_block = 0) {
    if (args.length > results_start) {
        if (parent.getNextBlock(target_block).is_exit) {
            let result = "";
            for (var i = results_start; i < args.length; i++) {
                result += ` ret${i - results_start} = ${args[i].emit_value()}`;
            }
            return result;
        }
        else {
            return `blockres = ${args[results_start].emit_value()}`;
        }
    }
    return "";
}
class IROpBranchAlways extends IROperation {
    constructor(parent) {
        super(parent);
        this.type = IRType.Void;
        this.write_group = WRITE_ALL;
        let target = this.parent.getNextBlock(0);
        if (target == null) {
            throw new Error("Target block not linked.");
        }
        if (target.is_exit) {
            this.peek_count = this.parent.func_info.return_types.length;
        }
        else {
            this.peek_count = (target.input_type == IRType.Void) ? 0 : 1;
        }
    }
    emit() {
        return `${getBranchDataflowCode(this.args, this.parent, 0)} goto block_${this.parent.getNextBlock(0).id}`;
    }
}
class IROpBranchConditional extends IROpBranchAlways {
    constructor() {
        super(...arguments);
        this.arg_count = 1;
    }
    emit() {
        return `if ${this.args[0].emit_value()} ~= 0 then ${getBranchDataflowCode(this.args, this.parent, 1)} goto block_${this.parent.getNextBlock(0).id} else goto block_${this.parent.getNextBlock(1).id} end`;
    }
}
class IROpBranchTable extends IROpBranchAlways {
    constructor() {
        super(...arguments);
        this.arg_count = 1;
    }
    emit() {
        let branch_count = this.parent.getNextBlockCount();
        let generated_code = `local tmp = ${this.args[0].emit_value()} `;
        for (var i = 0; i < branch_count; i++) {
            if (i != 0) {
                generated_code += "else";
            }
            if (i < branch_count - 1) {
                generated_code += `if tmp == ${i} then `;
            }
            else {
                generated_code += " ";
            }
            generated_code += `${getBranchDataflowCode(this.args, this.parent, 1, i)} goto block_${this.parent.getNextBlock(i).id} `;
        }
        if (branch_count > 1) {
            generated_code += "end";
        }
        return generated_code;
    }
}
class IROpError extends IROperation {
    constructor(parent, msg) {
        super(parent);
        this.msg = msg;
        this.write_group = WRITE_ALL;
        this.type = IRType.Void;
    }
    emit() {
        return `error("${this.msg}")`;
    }
}
class IROpCall extends IROperation {
    constructor(parent, func) {
        super(parent);
        this.func = func;
        this.too_many_returns = false;
        this.write_group = WRITE_ALL;
        this.arg_count = func.funcType.params.length;
        let retCount = func.funcType.results.length;
        if (retCount == 1) {
            this.type = convertWasmTypeToIRType(func.funcType.results[0]);
        }
        else if (retCount == 0) {
            this.type = IRType.Void;
        }
        else {
            this.too_many_returns = true;
        }
    }
    emit() {
        if (this.too_many_returns) {
            return "error('too many returns')";
        }
        let arg_str = this.args.map((arg) => arg.emit_value()).join(", ");
        return this.func.id + "(" + arg_str + ")";
    }
}
class IROpBinaryOperator extends IROperation {
    constructor(parent, op, type, normalize_result = false, normalize_args = false) {
        super(parent);
        this.op = op;
        this.type = type;
        this.normalize_result = normalize_result;
        this.normalize_args = normalize_args;
        this.arg_count = 2;
    }
    emit() {
        return `(${this.args[0].emit_value()} ${this.op} ${this.args[1].emit_value()})`;
    }
}
class IRStackInfo extends IROperation {
    constructor(parent, stack) {
        super(parent);
        this.type = IRType.Void;
        this.stack = stack.slice();
    }
    emit() {
        return "";
    }
    emit_code() {
        return "-- stack info [ " + this.stack.map((x) => x.emit_value()).join(", ") + " ]";
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
            return_types: node.signature.results.map(convertWasmTypeToIRType),
            module: modState,
            next_tmp_id: 1
        };
    }
    else {
        throw new Error("bad signature");
    }
    let entry = new IRControlBlock(func_info, IRType.Void);
    let exit = new IRControlBlock(func_info, IRType.Void, true);
    compileWASMBlockToIRBlocks(func_info, node.body, entry, [exit]);
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
    let value_stack = [];
    let error_block = new IRControlBlock(func_info, IRType.Void);
    function processOp(op) {
        for (let i = 0; i < op.arg_count; i++) {
            let arg = value_stack.pop();
            if (arg == null) {
                arg = new IROpError(error_block, "negative stack access");
            }
            if (arg.blocked_by_write_barrier) {
                arg.var_name = "_TMP" + (func_info.next_tmp_id++);
            }
            op.args.push(arg);
            arg.refs.push(op);
        }
        for (let i = 0; i < op.peek_count; i++) {
            let arg = value_stack[value_stack.length - 1 - i];
            if (arg == null) {
                arg = new IROpError(error_block, "negative stack access");
            }
            if (arg.blocked_by_write_barrier) {
                arg.var_name = "_TMP" + (func_info.next_tmp_id++);
            }
            op.args.push(arg);
            arg.refs.push(op);
        }
        op.args_linked();
        if (op.type == null) {
            throw new Error("Op missing type.");
        }
        if (op.write_group != null) {
            if (op.write_group == WRITE_ALL) {
                value_stack.forEach((stack_op) => {
                    if (stack_op.read_group != null) {
                        stack_op.blocked_by_write_barrier = true;
                    }
                });
            }
            else {
                value_stack.forEach((stack_op) => {
                    if (stack_op.read_group == op.write_group) {
                        stack_op.blocked_by_write_barrier = true;
                    }
                });
            }
        }
        if (op.type != IRType.Void) {
            value_stack.push(op);
        }
    }
    for (let i = 0; i < body.length; i++) {
        processOp(new IRStackInfo(current_block, value_stack));
        let instr = body[i];
        if (instr.type == "BlockInstruction") {
            let next_block = new IRControlBlock(func_info, convertWasmTypeToIRType(instr.result));
            compileWASMBlockToIRBlocks(func_info, instr.instr, current_block, branch_targets.concat([next_block]));
            current_block = next_block;
            processOp(new IROpBlockResult(current_block, "__br_" + current_block.id, current_block.input_type));
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
            processOp(new IROpBranchConditional(current_block));
            current_block = next_block;
            processOp(new IROpBlockResult(current_block, "__br_" + current_block.id, current_block.input_type));
        }
        else if (instr.type == "CallInstruction" || instr.type == "CallIndirectInstruction") {
            if (instr.type == "CallInstruction") {
                let func = getFuncByIndex(func_info.module, instr.numeric || instr.index);
                if (func) {
                    processOp(new IROpCall(current_block, func));
                }
                else {
                    processOp(new IROpError(current_block, "bad call"));
                }
            }
            else {
                processOp(new IROpError(current_block, "call indirect!"));
            }
        }
        else if (instr.type == "Instr") {
            if (instr.id == "br") {
                let blocks_to_exit = instr.args[0].value;
                current_block.addNextBlock(branch_targets[branch_targets.length - 1 - blocks_to_exit]);
                processOp(new IROpBranchAlways(current_block));
                return;
            }
            else if (instr.id == "return") {
                current_block.addNextBlock(branch_targets[0]);
                processOp(new IROpBranchAlways(current_block));
                return;
            }
            else if (instr.id == "br_if") {
                let next_block = new IRControlBlock(func_info, IRType.Void);
                let blocks_to_exit = instr.args[0].value;
                current_block.addNextBlock(branch_targets[branch_targets.length - 1 - blocks_to_exit]);
                current_block.addNextBlock(next_block);
                processOp(new IROpBranchConditional(current_block));
                current_block = next_block;
            }
            else if (instr.id == "br_table") {
                instr.args.forEach((arg) => {
                    let blocks_to_exit = arg.value;
                    current_block.addNextBlock(branch_targets[branch_targets.length - 1 - blocks_to_exit]);
                });
                processOp(new IROpBranchTable(current_block));
                return;
            }
            else {
                switch (instr.id) {
                    case "const":
                        processOp(new IROpConst(current_block, instr.args[0], convertWasmTypeToIRType(instr.object)));
                        break;
                    case "local":
                        instr.args.forEach((arg) => {
                            if (arg.type == "ValtypeLiteral") {
                                func_info.local_types.push(convertWasmTypeToIRType(arg.name));
                            }
                            else {
                                throw new Error("Bad type???");
                            }
                        });
                        break;
                    case "get_local":
                        processOp(new IROpGetLocal(current_block, instr.args[0].value));
                        break;
                    case "set_local":
                        processOp(new IROpSetLocal(current_block, instr.args[0].value));
                        break;
                    case "tee_local":
                        processOp(new IROpTeeLocal(current_block, instr.args[0].value));
                        break;
                    case "set_global":
                        processOp(new IROpSetGlobal(current_block, instr.args[0].value));
                        break;
                    case "add":
                        processOp(new IROpBinaryOperator(current_block, "+", convertWasmTypeToIRType(instr.object)));
                        break;
                    case "drop":
                        value_stack.pop();
                        break;
                    case "end":
                    case "nop":
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
        current_block.addNextBlock(branch_targets[branch_targets.length - 1]);
        processOp(new IROpBranchAlways(current_block));
    }
}
//# sourceMappingURL=graph_ir.js.map
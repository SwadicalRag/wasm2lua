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
    if (type == "i32" || type == "u32") {
        return IRType.Int;
    }
    else if (type == "i64" || type == "u64") {
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
        if (this.var_name != null) {
            return this.var_name + " = " + this.emit();
        }
        else if (this.write_group != null) {
            return this.emit();
        }
        return "";
    }
    ;
    emit_value() {
        let expr;
        if (this.var_name != null) {
            expr = this.var_name;
        }
        else {
            expr = this.emit();
        }
        if (this.type == IRType.Bool) {
            return `(${unwrap_expr(expr)} and 1 or 0)`;
        }
        else {
            return expr;
        }
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
class IROpGetGlobal extends IROperation {
    constructor(parent, index, type) {
        super(parent);
        this.index = index;
        this.type = type;
        this.arg_count = 0;
        this.read_group = "G" + this.index;
    }
    emit() {
        return "__GLOBALS__[" + this.index + "]";
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
        let generated_code = `do local tmp = ${this.args[0].emit_value()} `;
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
        generated_code += " end";
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
        let arg_str = this.args.slice().reverse().map((arg) => unwrap_expr(arg.emit_value())).join(", ");
        return this.func.id + "(" + arg_str + ")";
    }
}
class IROpCallIndirect extends IROperation {
    constructor(parent, signature, table_index) {
        super(parent);
        this.table_index = table_index;
        this.too_many_returns = false;
        this.write_group = WRITE_ALL;
        this.arg_count = signature.params.length + 1;
        let retCount = signature.results.length;
        if (retCount == 1) {
            this.type = convertWasmTypeToIRType(signature.results[0]);
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
        let args = this.args.slice().reverse();
        let index = args.pop();
        let arg_str = args.map((arg) => unwrap_expr(arg.emit_value())).join(", ");
        let func = `__TABLE_FUNCS_${this.table_index}__[${index.emit_value()}+1]`;
        return func + "(" + arg_str + ")";
    }
}
class IROpCallBuiltin extends IROperation {
    constructor(parent, fname, arg_count, type) {
        super(parent);
        this.fname = fname;
        this.arg_count = arg_count;
        this.type = type;
    }
    emit() {
        if (typeof this.fname == "string") {
            let arg_str = this.args.slice().reverse().map((arg) => unwrap_expr(arg.emit_value())).join(", ");
            return this.fname + "(" + arg_str + ")";
        }
        else {
            let expr = this.args.slice().reverse().map((arg) => unwrap_expr(arg.emit_value())).join(", ");
            this.fname.forEach((fname) => {
                expr = fname + "(" + expr + ")";
            });
            return expr;
        }
    }
}
class IROpGetLongWord extends IROperation {
    constructor(parent, word_num) {
        super(parent);
        this.word_num = word_num;
        this.arg_count = 1;
        this.type = IRType.Int;
    }
    emit() {
        return this.args[0].emit_value() + "[" + this.word_num + "]";
    }
}
class IROpExtendWord extends IROperation {
    constructor(parent, signed) {
        super(parent);
        this.signed = signed;
        this.arg_count = 1;
        this.type = IRType.LongInt;
    }
    emit() {
        let result = "__LONG_INT__(" + unwrap_expr(this.args[0].emit_value()) + ",0)";
        if (this.signed) {
            return result + ":sign_upper_word()";
        }
        return result;
    }
}
class IROpCallMethod extends IROperation {
    constructor(parent, fname, arg_count, type) {
        super(parent);
        this.fname = fname;
        this.arg_count = arg_count;
        this.type = type;
    }
    emit() {
        let arg_exprs = this.args.slice().reverse().map((arg) => unwrap_expr(arg.emit_value()));
        let this_arg = arg_exprs.shift();
        let arg_str = arg_exprs.join(", ");
        return this_arg + ":" + this.fname + "(" + arg_str + ")";
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
        let arg1 = this.args[0].emit_value();
        let arg2 = this.args[1].emit_value();
        if (this.normalize_args) {
            arg1 = "bit_tobit(" + unwrap_expr(arg1) + ")";
            arg2 = "bit_tobit(" + unwrap_expr(arg2) + ")";
        }
        let final_expr = `(${arg2} ${this.op} ${arg1})`;
        if (this.normalize_result) {
            return "bit_tobit" + final_expr;
        }
        return final_expr;
    }
}
class IROpNegate extends IROperation {
    constructor() {
        super(...arguments);
        this.arg_count = 1;
        this.type = IRType.Float;
    }
    emit() {
        return "(-" + this.args[0].emit_value() + ")";
    }
}
class IROpSelect extends IROperation {
    constructor() {
        super(...arguments);
        this.arg_count = 3;
    }
    args_linked() {
        this.type = this.args[1].type;
    }
    emit() {
        if (this.args[1].type != this.args[2].type) {
            return "error('bad select')";
        }
        let arg0 = this.args[0].emit_value();
        let arg1 = this.args[1].emit_value();
        let arg2 = this.args[2].emit_value();
        return `(${arg0} == 0 and ${arg1} or ${arg2})`;
    }
}
function unwrap_expr(expr) {
    if (!expr.startsWith("(") || !expr.endsWith(")")) {
        return expr;
    }
    return expr;
}
class IROpCompare extends IROperation {
    constructor(parent, op_name, arg_wasm_type) {
        super(parent);
        this.op_name = op_name;
        this.arg_wasm_type = arg_wasm_type;
        this.type = IRType.Bool;
        this.arg_count = 2;
        if (op_name == "eqz") {
            this.arg_count = 1;
        }
    }
    emit() {
        let op = {
            eq: "==",
            ne: "~=",
            gt: ">",
            lt: "<",
            ge: ">=",
            le: "<=",
            gt_s: ">",
            lt_s: "<",
            ge_s: ">=",
            le_s: "<=",
            gt_u: ">",
            lt_u: "<",
            ge_u: ">=",
            le_u: "<=",
            eqz: "=="
        }[this.op_name];
        let arg1 = this.args[0].emit_value();
        let arg2;
        if (this.op_name == "eqz") {
            if (this.arg_wasm_type == "i64") {
                arg2 = "__LONG_INT__(0,0)";
            }
            else {
                arg2 = "0";
            }
        }
        else {
            arg2 = this.args[1].emit_value();
        }
        let expr;
        if (this.op_name.endsWith("_u")) {
            if (this.arg_wasm_type == "i64") {
                return arg2 + ":_" + this.op_name + "(" + unwrap_expr(arg1) + ")";
            }
            else {
                expr = `__UNSIGNED__(${unwrap_expr(arg2)}) ${op} __UNSIGNED__(${unwrap_expr(arg1)})`;
            }
        }
        else {
            expr = `${arg2} ${op} ${arg1}`;
        }
        return `(${expr})`;
    }
}
class IROpReadMemory extends IROperation {
    constructor(parent, wasm_type, offset, source_width, signed = false) {
        super(parent);
        this.wasm_type = wasm_type;
        this.offset = offset;
        this.source_width = source_width;
        this.signed = signed;
        this.arg_count = 1;
        this.read_group = "M";
        this.type = convertWasmTypeToIRType(wasm_type);
    }
    emit() {
        let targ = this.parent.func_info.module.memoryAllocations.get(0);
        let addr;
        if (this.offset == 0) {
            addr = unwrap_expr(this.args[0].emit_value());
        }
        else {
            addr = `${this.args[0].emit_value()}+${this.offset}`;
        }
        let expr;
        if (this.wasm_type == "u32" || this.source_width != null) {
            if (this.source_width == 8) {
                expr = `__MEMORY_READ_8__(${targ},${addr})`;
            }
            else if (this.source_width == 16) {
                expr = `__MEMORY_READ_16__(${targ},${addr})`;
            }
            else {
                expr = `__MEMORY_READ_32__(${targ},${addr})`;
            }
        }
        else if (this.wasm_type == "u64") {
            return `__LONG_INT__(0,0):load(${targ},${addr})`;
        }
        else if (this.wasm_type == "f32") {
            return `__MEMORY_READ_32F__(${targ},${addr})`;
        }
        else if (this.wasm_type == "f64") {
            return `__MEMORY_READ_64F__(${targ},${addr})`;
        }
        if (this.signed && this.source_width != null && this.source_width != 32) {
            let shift = 32 - this.source_width;
            expr = `bit_arshift(bit_lshift(${expr},${shift}),${shift})`;
        }
        if (this.wasm_type == "u64") {
            if (this.signed) {
                return `__LONG_INT__(${expr},0):sign_upper_word()`;
            }
            else {
                return `__LONG_INT__(${expr},0)`;
            }
        }
        else {
            return expr;
        }
    }
}
class IROpWriteMemory extends IROperation {
    constructor(parent, wasm_type, offset, dest_width) {
        super(parent);
        this.wasm_type = wasm_type;
        this.offset = offset;
        this.dest_width = dest_width;
        this.type = IRType.Void;
        this.arg_count = 2;
        this.write_group = "M";
    }
    emit() {
        let targ = this.parent.func_info.module.memoryAllocations.get(0);
        let addr;
        if (this.offset == 0) {
            addr = unwrap_expr(this.args[1].emit_value());
        }
        else {
            addr = `${this.args[1].emit_value()}+${this.offset}`;
        }
        let value = unwrap_expr(this.args[0].emit_value());
        let dest_width = this.dest_width;
        if (this.wasm_type == "u64") {
            if (dest_width != null) {
                value = "(" + value + ")[1]";
            }
            else {
                return `(${value}):store(${targ},${addr})`;
            }
        }
        else if (this.wasm_type == "f32") {
            return `__MEMORY_WRITE_32F__(${targ},${addr},${value})`;
        }
        else if (this.wasm_type == "f64") {
            return `__MEMORY_WRITE_64F__(${targ},${addr},${value})`;
        }
        if (dest_width == 32 || dest_width == null) {
            return `__MEMORY_WRITE_32__(${targ},${addr},${value})`;
        }
        else if (dest_width == 16) {
            return `__MEMORY_WRITE_16__(${targ},${addr},${value})`;
        }
        else if (dest_width == 8) {
            return `__MEMORY_WRITE_8__(${targ},${addr},${value})`;
        }
    }
}
class IROpMemoryGrow extends IROperation {
    constructor() {
        super(...arguments);
        this.type = IRType.Int;
        this.arg_count = 1;
        this.write_group = "M";
    }
    emit() {
        let targ = this.parent.func_info.module.memoryAllocations.get(0);
        let arg = unwrap_expr(this.args[0].emit_value());
        return `__MEMORY_GROW__(${targ},__UNSIGNED__(${arg}))`;
    }
}
class IROpMemoryGetSize extends IROperation {
    constructor() {
        super(...arguments);
        this.type = IRType.Int;
        this.read_group = "M";
    }
    emit() {
        let targ = this.parent.func_info.module.memoryAllocations.get(0);
        return `${targ}._page_count;`;
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
    str_builder.write(str_buffer, "local _TMP = {}");
    str_builder.newLine(str_buffer);
    for (let i = func_info.arg_count; i < func_info.local_types.length; i++) {
        let type = func_info.local_types[i];
        let value = ((type == IRType.LongInt) ? "__LONG_INT__(0,0)" : "0");
        str_builder.write(str_buffer, `local var${i} = ${value}`);
        str_builder.newLine(str_buffer);
    }
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
            if (arg.blocked_by_write_barrier || arg.write_group != null) {
                arg.var_name = "_TMP[" + (func_info.next_tmp_id++) + "]";
            }
            op.args.push(arg);
            arg.refs.push(op);
        }
        for (let i = 0; i < op.peek_count; i++) {
            let arg = value_stack[value_stack.length - 1 - i];
            if (arg == null) {
                arg = new IROpError(error_block, "negative stack access");
            }
            if (arg.blocked_by_write_barrier || arg.write_group != null) {
                arg.var_name = "_TMP[" + (func_info.next_tmp_id++) + "]";
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
            let loop_result = compileWASMBlockToIRBlocks(func_info, instr.instr, loop_block, branch_targets.concat([loop_block]), true);
            if (instr.resulttype != null) {
                if (loop_result.stack.length > 0) {
                    value_stack.push(loop_result.stack.pop());
                }
                else {
                    value_stack.push(new IROpError(current_block, "missing value in loop stack"));
                }
            }
            current_block = loop_result.block;
        }
        else if (instr.type == "IfInstruction") {
            let next_block = new IRControlBlock(func_info, convertWasmTypeToIRType(instr.result));
            let block_true = new IRControlBlock(func_info, IRType.Void);
            current_block.addNextBlock(block_true);
            compileWASMBlockToIRBlocks(func_info, instr.consequent, block_true, branch_targets.concat([next_block]));
            if (instr.alternate.length > 0) {
                let block_false = new IRControlBlock(func_info, IRType.Void);
                current_block.addNextBlock(block_false);
                compileWASMBlockToIRBlocks(func_info, instr.alternate, block_false, branch_targets.concat([next_block]));
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
                if (instr.signature.type == "Signature") {
                    processOp(new IROpCallIndirect(current_block, instr.signature, 0));
                }
                else {
                    processOp(new IROpError(current_block, "bad indirect call"));
                }
            }
        }
        else if (instr.type == "Instr") {
            if (instr.id == "br") {
                let blocks_to_exit = instr.args[0].value;
                current_block.addNextBlock(branch_targets[branch_targets.length - 1 - blocks_to_exit]);
                processOp(new IROpBranchAlways(current_block));
                return { block: current_block, stack: value_stack };
            }
            else if (instr.id == "return") {
                current_block.addNextBlock(branch_targets[0]);
                processOp(new IROpBranchAlways(current_block));
                return { block: current_block, stack: value_stack };
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
                return { block: current_block, stack: value_stack };
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
                    case "get_global":
                        let global_index = instr.args[0].value;
                        let global_type = convertWasmTypeToIRType(func_info.module.globalTypes[global_index]);
                        processOp(new IROpGetGlobal(current_block, global_index, global_type));
                        break;
                    case "add": {
                        let is_i32_op = (instr.object == "i32");
                        processOp(new IROpBinaryOperator(current_block, "+", convertWasmTypeToIRType(instr.object), is_i32_op, is_i32_op));
                        break;
                    }
                    case "sub": {
                        let is_i32_op = (instr.object == "i32");
                        processOp(new IROpBinaryOperator(current_block, "-", convertWasmTypeToIRType(instr.object), is_i32_op, is_i32_op));
                        break;
                    }
                    case "mul":
                        processOp(instr.object == "i32" ?
                            new IROpCallBuiltin(current_block, "__IMUL__", 2, IRType.Int) :
                            new IROpBinaryOperator(current_block, "*", convertWasmTypeToIRType(instr.object)));
                        break;
                    case "div":
                        processOp(new IROpBinaryOperator(current_block, "/", convertWasmTypeToIRType(instr.object)));
                        break;
                    case "div_s":
                        processOp(instr.object == "i32" ?
                            new IROpCallBuiltin(current_block, "__IDIV_S__", 2, IRType.Int) :
                            new IROpCallMethod(current_block, "_div_s", 2, IRType.LongInt));
                        break;
                    case "div_u":
                        processOp(instr.object == "i32" ?
                            new IROpCallBuiltin(current_block, "__IDIV_U__", 2, IRType.Int) :
                            new IROpCallMethod(current_block, "_div_u", 2, IRType.LongInt));
                        break;
                    case "rem_s":
                        processOp(instr.object == "i32" ?
                            new IROpCallBuiltin(current_block, "__IMOD_S__", 2, IRType.Int) :
                            new IROpCallMethod(current_block, "_rem_s", 2, IRType.LongInt));
                        break;
                    case "rem_u":
                        processOp(instr.object == "i32" ?
                            new IROpCallBuiltin(current_block, "__IMOD_U__", 2, IRType.Int) :
                            new IROpCallMethod(current_block, "_rem_u", 2, IRType.LongInt));
                        break;
                    case "and":
                        processOp(instr.object == "i32" ?
                            new IROpCallBuiltin(current_block, "bit_band", 2, IRType.Int) :
                            new IROpCallMethod(current_block, "_and", 2, IRType.LongInt));
                        break;
                    case "or":
                        processOp(instr.object == "i32" ?
                            new IROpCallBuiltin(current_block, "bit_bor", 2, IRType.Int) :
                            new IROpCallMethod(current_block, "_or", 2, IRType.LongInt));
                        break;
                    case "xor":
                        processOp(instr.object == "i32" ?
                            new IROpCallBuiltin(current_block, "bit_bxor", 2, IRType.Int) :
                            new IROpCallMethod(current_block, "_xor", 2, IRType.LongInt));
                        break;
                    case "shl":
                        processOp(instr.object == "i32" ?
                            new IROpCallBuiltin(current_block, "bit_lshift", 2, IRType.Int) :
                            new IROpCallMethod(current_block, "_shl", 2, IRType.LongInt));
                        break;
                    case "shr_u":
                        processOp(instr.object == "i32" ?
                            new IROpCallBuiltin(current_block, "bit_rshift", 2, IRType.Int) :
                            new IROpCallMethod(current_block, "_shr_u", 2, IRType.LongInt));
                        break;
                    case "shr_s":
                        processOp(instr.object == "i32" ?
                            new IROpCallBuiltin(current_block, "bit_arshift", 2, IRType.Int) :
                            new IROpCallMethod(current_block, "_shr_s", 2, IRType.LongInt));
                        break;
                    case "rotr":
                        processOp(instr.object == "i32" ?
                            new IROpCallBuiltin(current_block, "bit_ror", 2, IRType.Int) :
                            new IROpCallMethod(current_block, "_rotr", 2, IRType.LongInt));
                        break;
                    case "rotl":
                        processOp(instr.object == "i32" ?
                            new IROpCallBuiltin(current_block, "bit_rol", 2, IRType.Int) :
                            new IROpCallMethod(current_block, "_rotl", 2, IRType.LongInt));
                        break;
                    case "popcnt":
                        processOp(instr.object == "i32" ?
                            new IROpCallBuiltin(current_block, "__POPCNT__", 1, IRType.Int) :
                            new IROpCallMethod(current_block, "_popcnt", 1, IRType.LongInt));
                        break;
                    case "ctz":
                        processOp(instr.object == "i32" ?
                            new IROpCallBuiltin(current_block, "__CTZ__", 1, IRType.Int) :
                            new IROpCallMethod(current_block, "_ctz", 1, IRType.LongInt));
                        break;
                    case "clz":
                        processOp(instr.object == "i32" ?
                            new IROpCallBuiltin(current_block, "__CLZ__", 1, IRType.Int) :
                            new IROpCallMethod(current_block, "_clz", 1, IRType.LongInt));
                        break;
                    case "neg":
                        processOp(new IROpNegate(current_block));
                        break;
                    case "min":
                        processOp(new IROpCallBuiltin(current_block, "__FLOAT__.min", 2, IRType.Float));
                        break;
                    case "max":
                        processOp(new IROpCallBuiltin(current_block, "__FLOAT__.max", 2, IRType.Float));
                        break;
                    case "copysign":
                        processOp(new IROpCallBuiltin(current_block, "__FLOAT__.copysign", 2, IRType.Float));
                        break;
                    case "abs":
                        processOp(new IROpCallBuiltin(current_block, "math_abs", 1, IRType.Float));
                        break;
                    case "sqrt":
                        processOp(new IROpCallBuiltin(current_block, "math_sqrt", 1, IRType.Float));
                        break;
                    case "floor":
                        processOp(new IROpCallBuiltin(current_block, "math_floor", 1, IRType.Float));
                        break;
                    case "ceil":
                        processOp(new IROpCallBuiltin(current_block, "math_ceil", 1, IRType.Float));
                        break;
                    case "trunc":
                        processOp(new IROpCallBuiltin(current_block, "__FLOAT__.truncate", 1, IRType.Float));
                        break;
                    case "nearest":
                        processOp(new IROpCallBuiltin(current_block, "__FLOAT__.nearest", 1, IRType.Float));
                        break;
                    case "eq":
                    case "ne":
                    case "gt":
                    case "lt":
                    case "ge":
                    case "le":
                    case "gt_s":
                    case "lt_s":
                    case "ge_s":
                    case "le_s":
                    case "gt_u":
                    case "lt_u":
                    case "ge_u":
                    case "le_u":
                    case "eqz":
                        processOp(new IROpCompare(current_block, instr.id, instr.object));
                        break;
                    case "load":
                        processOp(new IROpReadMemory(current_block, instr.object, instr.args[0].value));
                        break;
                    case "load32_u":
                        processOp(new IROpReadMemory(current_block, instr.object, instr.args[0].value, 32));
                        break;
                    case "load32_s":
                        processOp(new IROpReadMemory(current_block, instr.object, instr.args[0].value, 32, true));
                        break;
                    case "load16_u":
                        processOp(new IROpReadMemory(current_block, instr.object, instr.args[0].value, 16));
                        break;
                    case "load16_s":
                        processOp(new IROpReadMemory(current_block, instr.object, instr.args[0].value, 16, true));
                        break;
                    case "load8_u":
                        processOp(new IROpReadMemory(current_block, instr.object, instr.args[0].value, 8));
                        break;
                    case "load8_s":
                        processOp(new IROpReadMemory(current_block, instr.object, instr.args[0].value, 8, true));
                        break;
                    case "store":
                        processOp(new IROpWriteMemory(current_block, instr.object, instr.args[0].value));
                        break;
                    case "store32":
                        processOp(new IROpWriteMemory(current_block, instr.object, instr.args[0].value, 32));
                        break;
                    case "store16":
                        processOp(new IROpWriteMemory(current_block, instr.object, instr.args[0].value, 16));
                        break;
                    case "store8":
                        processOp(new IROpWriteMemory(current_block, instr.object, instr.args[0].value, 8));
                        break;
                    case "grow_memory":
                        processOp(new IROpMemoryGrow(current_block));
                        break;
                    case "current_memory":
                        processOp(new IROpMemoryGetSize(current_block));
                        break;
                    case "demote/f64":
                    case "promote/f32":
                    case "convert_s/i32":
                        break;
                    case "extend_s/i32":
                    case "extend_u/i32":
                        processOp(new IROpExtendWord(current_block, instr.id == "extend_s/i32"));
                        break;
                    case "wrap/i64":
                        processOp(new IROpGetLongWord(current_block, 1));
                        break;
                    case "convert_u/i32":
                        processOp(new IROpCallBuiltin(current_block, "__UNSIGNED__", 1, IRType.Int));
                        break;
                    case "convert_s/i64":
                        processOp(new IROpCallMethod(current_block, "to_double_signed", 1, IRType.Float));
                        break;
                    case "convert_u/i64":
                        processOp(new IROpCallMethod(current_block, "to_double_unsigned", 1, IRType.Float));
                        break;
                    case "trunc_s/f32":
                    case "trunc_s/f64":
                    case "trunc_u/f32":
                    case "trunc_u/f64": {
                        if (instr.object == "i64") {
                            processOp(new IROpCallBuiltin(current_block, ["__TRUNC__", "__LONG_INT_N__"], 1, IRType.LongInt));
                        }
                        else {
                            processOp(new IROpCallBuiltin(current_block, ["__TRUNC__", "bit_tobit"], 1, IRType.Int));
                        }
                        break;
                    }
                    case "reinterpret/i32":
                        processOp(new IROpCallBuiltin(current_block, "UInt32ToFloat", 1, IRType.Float));
                        break;
                    case "reinterpret/i64":
                        processOp(new IROpCallMethod(current_block, "to_double_reinterpret", 1, IRType.Float));
                        break;
                    case "reinterpret/f32":
                        processOp(new IROpCallBuiltin(current_block, "FloatToUInt32", 1, IRType.Int));
                        break;
                    case "reinterpret/f64":
                        processOp(new IROpCallBuiltin(current_block, ["DoubleToUInt32s", "__LONG_INT__"], 1, IRType.LongInt));
                        break;
                    case "select":
                        processOp(new IROpSelect(current_block));
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
    return { block: current_block, stack: value_stack };
}
//# sourceMappingURL=graph_ir.js.map
import { WASMModuleState, WASMFuncState } from "./common";
import { StringCompiler } from "./stringcompiler";

enum IRType {
    Int,
    LongInt,
    Float,
    Bool,
    Void
}

enum IRConvertMode {
    Int,
    Bool,
    Any
}

function convertWasmTypeToIRType(type: Valtype) {
    if (type == "i32") {
        return IRType.Int;
    } else if (type == "i64") {
        return IRType.LongInt;
    } else if (type == "f32" || type == "f64") {
        return IRType.Float;
    } else {
        return IRType.Void;
    }
}

function getFuncByIndex(modState: WASMModuleState, index: Index) {
    if(index.type == "NumberLiteral") {
        if(modState.funcByName.get(`func_${index.value}`)) {
            return modState.funcByName.get(`func_${index.value}`);
        }
        else if(modState.funcByName.get(`func_u${index.value}`)) {
            return modState.funcByName.get(`func_u${index.value}`);
        } else {
            return modState.funcStates[index.value] || false;
        }
    }
    else {
        return modState.funcByName.get(index.value) || false;
    }
}

let next_block_id: number;

class IRControlBlock {
    // This is mostly for debugging.
    readonly id = next_block_id++;

    // Contains a list of IR operations.
    private operations = new Array<IROperation>();

    // Note that the last operation in any block should be a branch, unless it is an exit block.
    
    // Can have any number of preceding and following blocks.
    private prev = new Array<IRControlBlock>();
    private next = new Array<IRControlBlock>();

    constructor(readonly func_info: IRFunctionInfo, readonly input_type: IRType, readonly is_exit = false) {

    }

    // Double-link this block and another block.
    addNextBlock(next: IRControlBlock) {
        this.next.push(next);
        next.prev.push(this);
    }

    getNextBlock(index: number) {
        return this.next[index];
    }

    getNextBlockCount() {
        return this.next.length;
    }

    _addOp(x: IROperation) {
        this.operations.push(x);
    }

    // recursively link together operations
    // this pass runs afer blocks are initially generated
    // it must run in a separate pass because blocks may not be
    // properly linked together when operations are first encountered
    /*processOpsR(seen: any) {
        if (seen[this.id]) {
            return;
        }
        seen[this.id] = true;

        // Virtual stack of values
        let value_stack: IROperation[] = [];
    
        this.operations.forEach((op)=>{
            op.update_arg_count();

            for (let i=0;i<op.arg_count;i++) {
                let arg = value_stack.pop();
                if (arg == null) {
                    arg = new IROpError(this, "negative stack access");
                }

                op.args.push(arg);
                arg.refs.push(op);
            }

            for (let i=0;i<op.peek_count;i++) {
                let arg = value_stack[value_stack.length-1-i];
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

        this.next.forEach((block)=>{
            block.processOpsR(seen);
        });
    }*/


    // recursively emit blocks
    // this is *roughly* how this should work in the future, but it should also eliminate unneeded jumps
    emitR(str_builder: StringCompiler, str_buffer: string[], seen: any) {
        if (seen[this.id]) {
            return;
        }
        seen[this.id] = true;

        //data.push(`BLOCK ${this.id} - ${this.prev.length} - ${this.next.length} - ${this.operations.length} - ${this.operations.map((x)=>"\n\t\t\t\t\t\t"+x)}`);

        str_builder.write(str_buffer,`::block_${this.id}:: --> [${this.next.map(x=>x.id)}] (${IRType[this.input_type]})`);

        str_builder.indent();

        if (this.is_exit) {
            // exit block
            str_builder.newLine(str_buffer);
            str_builder.write(str_buffer,"do return ");

            for (let i=0; i<this.func_info.return_types.length; i++) {
                str_builder.write(str_buffer, `ret${i}`);
        
                if((i+1) < this.func_info.return_types.length) {
                    str_builder.write(str_buffer,", ");
                }
            }
            str_builder.write(str_buffer," end");
        } else {
            // normal block
            let read_ops = [];
            this.operations.forEach((op)=>{

                let code = op.emit_code();

                if (code != "") {
                    str_builder.newLine(str_buffer);
                    str_builder.write(str_buffer,code);
                }
            });
        }

        str_builder.outdent();
        str_builder.newLine(str_buffer);

        this.next.forEach((block)=>{
            str_builder.newLine(str_buffer);
            block.emitR(str_builder,str_buffer,seen);
        });
    }
}

const WRITE_ALL = "ALL";

abstract class IROperation {
    constructor(protected parent: IRControlBlock) {
        parent._addOp(this);
    }

    // The codegen and type information must be implemented by child classes.
    abstract type: IRType;

    abstract emit(): string;

    // The code directly emitted into the generated code.
    emit_code() {
        //return "-- no code";
        if (this.write_group != null) {
            return this.emit();
        } else if (this.var_name != null) {
            return this.var_name+" = "+this.emit();
        }
        return "";
    };

    // What should be inserted when other operations use our value.
    emit_value() {
        if (this.var_name != null) {
            return this.var_name;
        }
        return this.emit();
    }

    // called after arguments are linked
    args_linked() {

    }

    // Number of arguments to pop from the virtual stack.
    arg_count = 0;

    // Number of arguments to peek from the virtual stack. Passed after popped args.
    peek_count = 0;

    // Set if we don't pop the arguments from the stack.
    // arg_peek = false; NOTE: ditch this and just push args back, since the only ops that need to do this still need to pop one arg

    // Set to override how to compiler forces integer/bool conversions. If unset, defaults to IRConvertMode.Int.
    arg_conversion_mode?: Array<IRConvertMode>;

    // automatically filled
    args = new Array<IROperation>();
    refs = new Array<IROperation>();
    
    // If set, all pending reads should be emitted before this operation.
    // All writes must also be ordered.
    // Should be set for:
        // Any write to a global or memory.
        // Any write to a local. *(Until local dataflow is implemented.)
        // Any function call.
        // Any branch. **(MAYBE NOT, I NEED TO THINK ABOUT THIS SOME MORE.)
    write_group?: string;

    // Indicates that this op is a read and should be ordered before any writes.
    read_group?: string;

    // Set if we should always inline, regardless of refcount. Used for constants.
    // always_inline = false;

    blocked_by_write_barrier = false;

    // Set if stored to a register instead of inlined.
    var_name?: string;
}

class IROpConst extends IROperation {

    constructor(parent: IRControlBlock, private value: LongNumberLiteral | NumberLiteral, type: IRType) {
        super(parent);
        this.type = type;
    }

    type: IRType;
    
    emit() {
        if(this.value.type == "LongNumberLiteral") {
            let value = (this.value as LongNumberLiteral).value;
            return `__LONG_INT__(${value.low},${value.high})`;
        }
        else {
            let _const = (this.value as NumberLiteral);
            if (_const.inf) {
                if (_const.value > 0) {
                    return "(1/0)";
                } else {
                    return "(-1/0)";
                }
            } else if (_const.nan) {
                return "(0/0)";
            } else if (_const.value == 0 && 1/_const.value == -Number.POSITIVE_INFINITY) {
                return "(-0)";
            } else {
                return _const.value.toString();
            }
        }
    }
}

class IROpSetGlobal extends IROperation {
    type = IRType.Void;

    constructor(parent: IRControlBlock, private index) {
        super(parent);
    }

    emit() {
        return "__GLOBALS__["+this.index+"] = "+this.args[0].emit_value();
    }
    
    arg_count = 1;

    write_group = "G"+this.index;
}

class IROpGetLocal extends IROperation {
    type: IRType;

    constructor(parent: IRControlBlock, private index) {
        super(parent);
        this.type = parent.func_info.local_types[index];
    }

    emit() {
        return "var"+this.index;
    }

    read_group = "L"+this.index;
}

class IROpSetLocal extends IROperation {
    type = IRType.Void;

    constructor(parent: IRControlBlock, private index) {
        super(parent);
    }

    emit() {
        return "var"+this.index+" = "+this.args[0].emit_value();
    }

    arg_count = 1;

    write_group = "L"+this.index;
}

class IROpTeeLocal extends IROperation {
    type: IRType;

    constructor(parent: IRControlBlock, private index) {
        super(parent);
        this.type = parent.func_info.local_types[index];
    }

    emit_code() {
        return "var"+this.index+" = "+this.args[0].emit_value();
    }

    emit_value() {
        return "var"+this.index;
    }

    emit() {
        return "";
    }

    arg_count = 1;

    write_group = "L"+this.index;
}

// this is temporary, it should almost certainly not appear in the final IR
class IROpBlockResult extends IROperation {
    constructor(parent: IRControlBlock, private name: string, public type: IRType) {
        super(parent);
    }
    
    emit() {
        return "blockres";
    }
}

// mostly temporary garbage for block results
function getBranchDataflowCode(args: IROperation[], parent: IRControlBlock, results_start: number, target_block = 0) {

    if (args.length > results_start) {

        if (parent.getNextBlock(target_block).is_exit) {
            let result = "";
            for (var i=results_start;i<args.length;i++) {

                result += ` ret${i-results_start} = ${args[i].emit_value()}`;
            }
            return result;
        } else {
            return `blockres = ${args[results_start].emit_value()}`;
        }
    }

    return "";
}

class IROpBranchAlways extends IROperation {

    constructor(parent: IRControlBlock) {
        super(parent);

        let target = this.parent.getNextBlock(0);
        if (target == null) {
            throw new Error("Target block not linked.");
        }
        if (target.is_exit) {
            this.peek_count = this.parent.func_info.return_types.length;
        } else {
            this.peek_count = (target.input_type == IRType.Void) ? 0 : 1;
        }
    }

    type = IRType.Void;

    write_group = WRITE_ALL;

    emit() {
        return `${getBranchDataflowCode(this.args,this.parent,0)} goto block_${this.parent.getNextBlock(0).id}`;
    }
}

class IROpBranchConditional extends IROpBranchAlways {

    arg_count = 1;

    emit() {
        return `if ${this.args[0].emit_value()} ~= 0 then ${getBranchDataflowCode(this.args,this.parent,1)} goto block_${this.parent.getNextBlock(0).id} else goto block_${this.parent.getNextBlock(1).id} end`;
    }
}

class IROpBranchTable extends IROpBranchAlways {

    arg_count = 1;

    emit() {
        // get count of next blocks?
        let branch_count = this.parent.getNextBlockCount();

        let generated_code = `local tmp = ${this.args[0].emit_value()} `;

        for (var i=0;i<branch_count;i++) {

            if (i!=0) {
                generated_code += "else";
            }

            if (i<branch_count-1) {
                generated_code += `if tmp == ${i} then `;
            } else {
                generated_code += " ";
            }

            generated_code += `${getBranchDataflowCode(this.args,this.parent,1,i)} goto block_${this.parent.getNextBlock(i).id} `;
        }
        if (branch_count>1) {
            generated_code += "end";
        }

        return generated_code;
    }
}

class IROpError extends IROperation {

    constructor(parent: IRControlBlock, private msg: string) {
        super(parent);
    }

    emit() {
        return `error("${this.msg}")`;
    }

    // Should be ordered with any writes.
    write_group = WRITE_ALL;
    
    type = IRType.Void;
}

class IROpCall extends IROperation {

    too_many_returns = false;

    constructor(parent: IRControlBlock, private func: WASMFuncState) {
        super(parent);

        this.arg_count = func.funcType.params.length;

        let retCount = func.funcType.results.length;
        if (retCount == 1) {
            this.type = convertWasmTypeToIRType(func.funcType.results[0]);
        } else if (retCount == 0) {
            this.type = IRType.Void;
        } else {
            this.too_many_returns = true;
        }
    }

    emit() {
        if (this.too_many_returns) {
            return "error('too many returns')"
        }
        let arg_str = this.args.map((arg)=>arg.emit_value()).join(", ");
        return this.func.id+"("+arg_str+")";
    }

    write_group = WRITE_ALL;
    
    type: IRType;
}

class IROpBinaryOperator extends IROperation {
    constructor(parent: IRControlBlock, private op: string, public type: IRType, private normalize_result = false, private normalize_args = false) {
        super(parent);
    }

    arg_count = 2;

    //type: IRType;

    /*args_linked() {
        this.type = this.args[0].type;
    }*/

    emit() {
        return `(${this.args[0].emit_value()} ${this.op} ${this.args[1].emit_value()})`;
    }
}

class IRStackInfo extends IROperation {

    stack: IROperation[];

    constructor(parent: IRControlBlock, stack: IROperation[]) {
        super(parent);
        this.stack = stack.slice();
    }

    emit() {
        return "";
    }

    emit_code() {
        return "-- stack info [ "+this.stack.map((x)=>x.emit_value()).join(", ")+" ]";
    }

    type = IRType.Void;
}

interface IRFunctionInfo {
    arg_count: number;
    local_types: IRType[];
    return_types: IRType[];
    module: WASMModuleState;
    next_tmp_id: number;
}

export function compileFuncWithIR(node: Func, modState: WASMModuleState, str_builder: StringCompiler) {
    next_block_id = 1;

    let str_buffer = new Array<string>();

    let func_info: IRFunctionInfo;

    // build function info
    if(node.signature.type == "Signature") {
        func_info = {
            arg_count: node.signature.params.length,
            local_types: node.signature.params.map((param)=>convertWasmTypeToIRType(param.valtype)),
            return_types: node.signature.results.map(convertWasmTypeToIRType),
            module: modState,

            next_tmp_id: 1
        }
    } else {
        throw new Error("bad signature");
    }

    let entry = new IRControlBlock(func_info, IRType.Void);
    let exit = new IRControlBlock(func_info, IRType.Void, true);

    compileWASMBlockToIRBlocks(func_info, node.body, entry, [exit]);

    str_builder.write(str_buffer, `function __FUNCS__.${node.name.value}(`);

    // todo longs may require two args/locals in future?
    for(let i=0;i<func_info.arg_count;i++) {
        str_builder.write(str_buffer, `var${i}`);

        if((i+1) < func_info.arg_count) {
            str_builder.write(str_buffer,", ");
        }
    }
    
    str_builder.write(str_buffer, `)`);
    str_builder.indent();
    str_builder.newLine(str_buffer);

    str_builder.write(str_buffer, "local blockres");
    // todo write locals here
    str_builder.newLine(str_buffer);

    if (func_info.return_types.length>0) {
        if (func_info.return_types.length>1) {
            throw new Error("Fatal: Too many returns from function.");
        }

        str_builder.write(str_buffer, "local ");

        for(let i=0;i<func_info.return_types.length;i++) {
            str_builder.write(str_buffer, `ret${i}`);
    
            if((i+1) < func_info.return_types.length) {
                str_builder.write(str_buffer,", ");
            }
        }

        str_builder.newLine(str_buffer);
    }

    entry.emitR(str_builder,str_buffer,{});

    str_builder.outdent();
    str_builder.newLine(str_buffer);
    str_builder.write(str_buffer, "end");
    str_builder.newLine(str_buffer);

    return str_buffer.join("");
}

function compileWASMBlockToIRBlocks(func_info: IRFunctionInfo, body: Instruction[], current_block: IRControlBlock, branch_targets: IRControlBlock[], skip_link_next?: boolean) {

    let value_stack: IROperation[] = [];

    let error_block = new IRControlBlock(func_info,IRType.Void);

    function processOp(op: IROperation) {
        for (let i=0;i<op.arg_count;i++) {
            let arg = value_stack.pop();
            if (arg == null) {
                arg = new IROpError(error_block, "negative stack access");
            }
            if (arg.blocked_by_write_barrier) {
                arg.var_name = "_TMP"+(func_info.next_tmp_id++);
            }

            op.args.push(arg);
            arg.refs.push(op);
        }

        for (let i=0;i<op.peek_count;i++) {
            let arg = value_stack[value_stack.length-1-i];
            if (arg == null) {
                arg = new IROpError(error_block, "negative stack access");
            }
            if (arg.blocked_by_write_barrier) {
                arg.var_name = "_TMP"+(func_info.next_tmp_id++);
            }

            op.args.push(arg);
            arg.refs.push(op);
        }

        op.args_linked();

        if (op.type == null) {
            throw new Error("Op missing type.");
        }

        if (op.write_group != null) {
            // FIXME: Search args recursively?
            if (op.write_group == WRITE_ALL) {
                value_stack.forEach((stack_op)=>{
                    if (stack_op.read_group != null) {
                        stack_op.blocked_by_write_barrier = true;
                    }
                });
            } else {
                value_stack.forEach((stack_op)=>{
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

    for (let i=0;i<body.length;i++) {
        processOp(new IRStackInfo(current_block,value_stack));

        let instr = body[i];
        if (instr.type == "BlockInstruction") {
            // continue adding to our current block, cut it at the end of the wasm block
            let next_block = new IRControlBlock(func_info, convertWasmTypeToIRType(instr.result) );
            compileWASMBlockToIRBlocks(func_info, instr.instr,current_block,branch_targets.concat([next_block]));
            current_block = next_block;

            processOp(new IROpBlockResult(current_block,"__br_"+current_block.id,current_block.input_type));

        } else if (instr.type == "LoopInstruction") {
            // start a new block for the loop, but allow it to continue after the loop ends
            // NOTE: The actual loop takes nothing as input. If the loop is supposed to return something, just push the stack at the end of the block.
            let loop_block = new IRControlBlock(func_info, IRType.Void );
            current_block.addNextBlock(loop_block);
            compileWASMBlockToIRBlocks(func_info,instr.instr,loop_block,branch_targets.concat([loop_block]),true);
            
            if (instr.resulttype != null) {
                // TODO push result!
            }

            current_block = loop_block;
        } else if (instr.type == "IfInstruction") {

            let next_block = new IRControlBlock(func_info, convertWasmTypeToIRType(instr.result) );

            let block_true = new IRControlBlock(func_info, IRType.Void);
            current_block.addNextBlock(block_true);

            compileWASMBlockToIRBlocks(func_info,instr.consequent,block_true,branch_targets.concat([next_block]));

            if (instr.alternate.length > 0) {
                let block_false = new IRControlBlock(func_info, IRType.Void);
                current_block.addNextBlock(block_false);
                
                compileWASMBlockToIRBlocks(func_info,instr.consequent,block_false,branch_targets.concat([next_block]));
            } else {
                // just link to the next block if there's nothing to compile for the alternate.
                current_block.addNextBlock(next_block);
            }

            processOp(new IROpBranchConditional(current_block));

            current_block = next_block;

            processOp(new IROpBlockResult(current_block,"__br_"+current_block.id,current_block.input_type));

        } else if (instr.type == "CallInstruction" || instr.type == "CallIndirectInstruction") {
            // TODO split block on setjmp / handle longjmp
            if (instr.type == "CallInstruction") {

                let func = getFuncByIndex(func_info.module, instr.numeric || instr.index);
                if (func) {
                    processOp(new IROpCall(current_block, func));
                } else {
                    processOp(new IROpError(current_block,"bad call"));
                }

            } else {
                processOp(new IROpError(current_block,"call indirect!"));
            }
        } else if (instr.type == "Instr") {
            if (instr.id == "br") {
                let blocks_to_exit = (instr.args[0] as NumberLiteral).value;

                current_block.addNextBlock(branch_targets[branch_targets.length-1-blocks_to_exit]);

                processOp(new IROpBranchAlways(current_block));

                return;
            } else if (instr.id == "return") {

                current_block.addNextBlock(branch_targets[0]);

                processOp(new IROpBranchAlways(current_block));

                return;
            } else if (instr.id == "br_if") {

                let next_block = new IRControlBlock(func_info, IRType.Void);

                // branch is taken
                let blocks_to_exit = (instr.args[0] as NumberLiteral).value;
                current_block.addNextBlock(branch_targets[branch_targets.length-1-blocks_to_exit]);

                // branch is not taken
                current_block.addNextBlock(next_block);

                processOp(new IROpBranchConditional(current_block));

                current_block = next_block;
            } else if (instr.id == "br_table") {

                instr.args.forEach((arg)=>{
                    let blocks_to_exit = (arg as NumberLiteral).value;
                    current_block.addNextBlock(branch_targets[branch_targets.length-1-blocks_to_exit]);
                });

                processOp(new IROpBranchTable(current_block));

                return;
            } else {

                switch (instr.id) {
                    case "const":
                        processOp(new IROpConst(current_block,instr.args[0] as any,convertWasmTypeToIRType(instr.object)));
                        break;
                    
                    // Locals
                    case "local":
                        // record local types here
                        instr.args.forEach((arg)=> {
                            if (arg.type=="ValtypeLiteral") {
                                func_info.local_types.push(convertWasmTypeToIRType(arg.name));
                            } else {
                                throw new Error("Bad type???");
                            }
                        });
                        break;
                    case "get_local":
                        processOp(new IROpGetLocal(current_block, (instr.args[0] as NumberLiteral).value ));
                        break;
                    case "set_local":
                        processOp(new IROpSetLocal(current_block, (instr.args[0] as NumberLiteral).value ));
                        break;
                    case "tee_local":
                        processOp(new IROpTeeLocal(current_block, (instr.args[0] as NumberLiteral).value ));
                        break;
                    // Globals
                    case "set_global":
                        processOp(new IROpSetGlobal(current_block, (instr.args[0] as NumberLiteral).value ));
                        break;
                    
                    // Operators
                    case "add":
                        processOp(new IROpBinaryOperator(current_block, "+", convertWasmTypeToIRType(instr.object)));
                        break;
                    
                    case "drop":
                        value_stack.pop();
                        break;
                    case "end":
                    case "nop":
                        // don't care
                        break;
                    default:
                        processOp(new IROpError(current_block,"unknown: "+instr.id));
                        break;
                }
            }
        } else {
            throw new Error(instr.type+" "+instr.id);
        }
    }

    
    // We don't auto-link to the next block for loops, since loop IR blocks don't end with the loop.
    if (!skip_link_next) {
        // Link to the next block.
        current_block.addNextBlock(branch_targets[branch_targets.length-1]);

        processOp(new IROpBranchAlways(current_block));
    }
}
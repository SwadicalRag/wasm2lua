import { WASMModuleState } from "./common";
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

    // Double-link this block and another block.
    addNextBlock(next: IRControlBlock) {
        this.next.push(next);
        next.prev.push(this);
    }

    getNextBlock(index: number) {
        return this.next[index];
    }

    _addOp(x: IROperation) {
        this.operations.push(x);
    }

    emitR(builder: StringCompiler, buffer: string[], seen: any) {
        if (seen[this.id]) {
            return;
        }
        seen[this.id] = true;

        //data.push(`BLOCK ${this.id} - ${this.prev.length} - ${this.next.length} - ${this.operations.length} - ${this.operations.map((x)=>"\n\t\t\t\t\t\t"+x)}`);

        builder.write(buffer,`::block_${this.id}:: --> [${this.next.map(x=>x.id)}]`);

        builder.indent();

        if (this.next.length > 0) {
            this.operations.forEach((op)=>{
                builder.newLine(buffer);
                builder.write(buffer,op.emit_code());
            });
        } else {
            // exit block
            builder.newLine(buffer);
            builder.write(buffer,"return"); // todo actually return stuff
        }

        builder.outdent();
        builder.newLine(buffer);

        this.next.forEach((block)=>{
            block.emitR(builder,buffer,seen);
        })
    }
}

abstract class IROperation {
    constructor(protected parent: IRControlBlock) {
        parent._addOp(this);
    }

    // The codegen and type information must be implemented by child classes.
    abstract type: IRType;

    abstract emit_code(): string;

    // Number of arguments to pop from the virtual stack.
    arg_count = 0;

    // Set if we don't pop the arguments from the stack.
    // arg_peek = false; NOTE: ditch this and just push args back, since the only ops that need to do this still need to pop one arg

    // Set to override how to compiler forces integer/bool conversions. If unset, defaults to IRConvertMode.Int.
    arg_conversion_mode?: Array<IRConvertMode>;

    // automatically filled
    args: Array<IROperation>;
    refs: Array<IROperation>;
    
    // If set, all pending reads should be emitted before this operation.
    // All writes must also be ordered.
    // Should be set for:
        // Any write to a global or memory.
        // Any write to a local. *(Until local dataflow is implemented.)
        // Any function call.
        // Any branch. **(MAYBE NOT, I NEED TO THINK ABOUT THIS SOME MORE.)
    is_write = false;

    // Indicates that this op is a read and should be ordered before any writes.
    is_read = false;

    // Set if we should always inline, regardless of refcount. Used for constants.
    always_inline = false;
}

class IROpConst extends IROperation {

    constructor(parent: IRControlBlock, private value: LongNumberLiteral | NumberLiteral, type: IRType) {
        super(parent);
        this.type = type;
    }

    always_inline = true;

    type: IRType;
    
    emit_code() {
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

class IROpBranchAlways extends IROperation {

    is_write = true; // todo change?

    type = IRType.Void;

    emit_code() {
        return "goto block_"+this.parent.getNextBlock(0).id;
    }
}

class IROpError extends IROperation {

    constructor(parent: IRControlBlock, private msg: string) {
        super(parent);
    }

    emit_code() {
        return `error("${this.msg}")`;
    }
    
    type = IRType.Void;
}

/*interface IROperation {
    // Data that this operation uses.
    inputs: IROperation[];
    // Any operations that reference this operation.
    refs: IROperation[];

    parent: IRControlBlock;

    // the variable containing this value, if one exists
    register_name?: string;

    type: IRType;

    emit_code(): string;

    // special garbage
    resolve_local?: number;
    
    // Writes to memory or a global, or is a function call. Should always emit code.
    has_side_effects?: boolean;
}*/

export function compileFuncWithIR(node: Func,modState: WASMModuleState, str_builder: StringCompiler) {
    next_block_id = 1;

    let str_buffer = new Array<string>();
    
    let entry = new IRControlBlock();
    let exit = new IRControlBlock();

    compileWASMBlockToIRBlocks(node.body, entry, [exit], IRType.Void);

    str_builder.write(str_buffer, `function __FUNCS__.${node.name.value}(`);

    // todo setup type info for these locals
    // todo longs may require two locals in future
    if(node.signature.type == "Signature") {
        let i = 0;
        for(let param of node.signature.params) {
            str_builder.write(str_buffer, `var${i}`);

            if((i+1) !== node.signature.params.length) {
                str_builder.write(str_buffer,", ");
            }
            i++;
        }
    }
    
    str_builder.write(str_buffer, `)`);
    str_builder.indent();
    str_builder.newLine(str_buffer);

    str_builder.write(str_buffer, "local blockres");
    str_builder.newLine(str_buffer);

    entry.emitR(str_builder,str_buffer,{});

    str_builder.outdent();
    str_builder.newLine(str_buffer);
    str_builder.write(str_buffer, "end");
    str_builder.newLine(str_buffer);

    return str_buffer.join("");
}

function compileWASMBlockToIRBlocks(body: Instruction[], current_block: IRControlBlock, branch_targets: IRControlBlock[], result_type: IRType, skip_link_next?: boolean) {

    // Virtual stack of values
    let value_stack: IROperation[] = [];

    function processOp(op: IROperation) {
        if (op.arg_count > 0) {
            throw "fixme args";
        }

        if (op.type != IRType.Void) {
            value_stack.push(op);
        }
    }

    for (let i=0;i<body.length;i++) {
        let instr = body[i];
        if (instr.type == "BlockInstruction") {
            // continue adding to our current block, cut it at the end of the wasm block
            let next_block = new IRControlBlock();
            compileWASMBlockToIRBlocks(instr.instr,current_block,branch_targets.concat([next_block]),convertWasmTypeToIRType(instr.result));
            current_block = next_block;
            // todo push block result pseudo-register?
        } else if (instr.type == "LoopInstruction") {
            // start a new block for the loop, but allow it to continue after the loop ends
            let loop_block = new IRControlBlock();
            current_block.addNextBlock(loop_block);
            compileWASMBlockToIRBlocks(instr.instr,loop_block,branch_targets.concat([loop_block]),convertWasmTypeToIRType(instr.resulttype),true);
            current_block = loop_block;
            // todo push block result pseudo-register?
        } else if (instr.type == "IfInstruction") {

            new IROpError(current_block,"conditional branch ~ "+IRType[result_type]); // todo push block result pseudo-register?

            let next_block = new IRControlBlock();

            let block_true = new IRControlBlock();
            current_block.addNextBlock(block_true);

            compileWASMBlockToIRBlocks(instr.consequent,block_true,branch_targets.concat([next_block]),convertWasmTypeToIRType(instr.result));

            if (instr.alternate.length > 0) {
                let block_false = new IRControlBlock();
                current_block.addNextBlock(block_false);
                
                compileWASMBlockToIRBlocks(instr.consequent,block_false,branch_targets.concat([next_block]),convertWasmTypeToIRType(instr.result));
            } else {
                // just link to the next block if there's nothing to compile for the alternate.
                current_block.addNextBlock(next_block);
            }

            current_block = next_block;
            // todo push block result pseudo-register?

        } else if (instr.type == "CallInstruction" || instr.type == "CallIndirectInstruction") {
            // TODO split block on setjmp / handle longjmp
            new IROpError(current_block,"call!");
        } else if (instr.type == "Instr") {
            if (instr.id == "br") {
                processOp(new IROpBranchAlways(current_block));

                let blocks_to_exit = (instr.args[0] as NumberLiteral).value;

                current_block.addNextBlock(branch_targets[branch_targets.length-1-blocks_to_exit]);
                return;
            } else if (instr.id == "br_if") {

                new IROpError(current_block,"conditional branch ~ "+IRType[result_type]); // todo push block result pseudo-register?

                let next_block = new IRControlBlock();

                // branch is taken
                let blocks_to_exit = (instr.args[0] as NumberLiteral).value;
                current_block.addNextBlock(branch_targets[branch_targets.length-1-blocks_to_exit]);

                // branch is not taken
                current_block.addNextBlock(next_block);

                current_block = next_block;
            } else if (instr.id == "br_table") {

                new IROpError(current_block,"table branch ~ "+IRType[result_type]); // todo push block result pseudo-register?

                instr.args.forEach((arg)=>{
                    let blocks_to_exit = (arg as NumberLiteral).value;
                    current_block.addNextBlock(branch_targets[branch_targets.length-1-blocks_to_exit]);
                });
                return;
            } else if (instr.id == "end" || instr.id == "nop") {
                // don't care
            } else {

                switch (instr.id) {
                    case "const":
                        processOp(new IROpConst(current_block,instr.args[0] as any,convertWasmTypeToIRType(instr.object)));
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
        processOp(new IROpBranchAlways(current_block));

        // Link to the next block.
        current_block.addNextBlock(branch_targets[branch_targets.length-1]);
    }
}

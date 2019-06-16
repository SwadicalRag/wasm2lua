import { WASMModuleState } from "./common";
import { StringCompiler } from "./stringcompiler";

type IRType = "i32" | "i64" | "f32" | "f64" | "bool" | "void";

let next_block_id = 1;

class IRControlBlock {
    // This is mostly for debugging.
    private id = next_block_id++;

    // Contains a list of IR operations.
    private operations = new Array<IROperation>();

    // The operation that decides which next block to branch to. Can be i32 or bool.
    // Not included in the normal list of operations.
    private branch_op?: IROperation;
    
    // Can have any number of preceding and following blocks.
    private prev = new Array<IRControlBlock>();
    private next = new Array<IRControlBlock>();

    // Double-link this block and another block.
    addNextBlock(next: IRControlBlock) {
        this.next.push(next);
        next.prev.push(this);
    }

    addOp(x: IROperation) {
        this.operations.push(x);
        // todo double link the operation to us
    }

    // each function should have exactly one entry and one exit
    // maybe should add some explicit fields for this, IDK
    /*get is_entry() {
        return this.prev.length == 0;
    }
    get is_exit() {
        return this.next.length == 0;
    }*/
    debugInfoR(builder: StringCompiler, buffer: string[], seen: any) {
        if (seen[this.id]) {
            return;
        }
        seen[this.id] = true;

        //data.push(`BLOCK ${this.id} - ${this.prev.length} - ${this.next.length} - ${this.operations.length} - ${this.operations.map((x)=>"\n\t\t\t\t\t\t"+x)}`);

        builder.write(buffer,`BLOCK ${this.id} -> [${this.next.map(x=>x.id)}]`);

        builder.indent();

        this.operations.forEach((str)=>{
            builder.newLine(buffer);
            builder.write(buffer,str);
        })

        builder.outdent();
        builder.newLine(buffer);

        this.next.forEach((block)=>{
            block.debugInfoR(builder,buffer,seen);
        })
    }
}

type IROperation = string;

/*interface IROperation {
    // Data that this operation uses.
    inputs: IROperation[];
    // Any operations that reference this operation.
    refs: IROperation[];

    parent: IRControlBlock;

    // the variable containing this value, if one exists
    register_name?: string;

    type: IRType;

    emitCode(): string;

    // special garbage
    resolve_local?: number;
    
    // Writes to memory or a global, or is a function call. Should always emit code.
    has_side_effects?: boolean;
}*/

export function compileFuncWithIR(node: Func,modState: WASMModuleState) {
    let entry = new IRControlBlock();
    let exit = new IRControlBlock();

    compileWASMBlockToIRBlocks(node.body, entry, [exit]);

    // debug output
    let compiler = new StringCompiler();
    let buffer = new Array<string>();

    compiler.write(buffer, "FUNC "+node.name.value);
    compiler.indent();
    compiler.newLine(buffer);

    entry.debugInfoR(compiler,buffer,{});

    return `--[[\n${buffer.join("")}\n]]\n`;
}

function compileWASMBlockToIRBlocks(body: Instruction[], current_block: IRControlBlock, branch_targets: IRControlBlock[], skip_link_next?: boolean) {

    // Virtual stack of values, TODO.
    let value_stack: number[] = [];

    for (let i=0;i<body.length;i++) {
        let instr = body[i];
        if (instr.type == "BlockInstruction") {
            // continue adding to our current block, cut it at the end of the wasm block
            let next_block = new IRControlBlock();
            compileWASMBlockToIRBlocks(instr.instr,current_block,branch_targets.concat([next_block]));
            current_block = next_block;
            // todo push block result pseudo-register?
        } else if (instr.type == "LoopInstruction") {
            // start a new block for the loop, but allow it to continue after the loop ends
            let loop_block = new IRControlBlock();
            current_block.addNextBlock(loop_block);
            compileWASMBlockToIRBlocks(instr.instr,loop_block,branch_targets.concat([loop_block]),true);
            current_block = loop_block;
            // todo push block result pseudo-register?
        } else if (instr.type == "IfInstruction") {

            current_block.addOp("br_if"); // decides next block

            let next_block = new IRControlBlock();

            let block_true = new IRControlBlock();
            current_block.addNextBlock(block_true);

            compileWASMBlockToIRBlocks(instr.consequent,block_true,branch_targets.concat([next_block]));

            if (instr.alternate.length > 0) {
                let block_false = new IRControlBlock();
                current_block.addNextBlock(block_false);
                
                compileWASMBlockToIRBlocks(instr.consequent,block_false,branch_targets.concat([next_block]));
            } else {
                // just link to the next block if there's nothing to compile for the alternate.
                current_block.addNextBlock(next_block);
            }

            current_block = next_block;
            // todo push block result pseudo-register?

        } else if (instr.type == "CallInstruction" || instr.type == "CallIndirectInstruction") {
            // TODO split block on setjmp / handle longjmp
            current_block.addOp(instr.id);
        } else if (instr.type == "Instr") {
            if (instr.id == "br") {
                current_block.addOp("br"); // todo push block result pseudo-register?

                let blocks_to_exit = (instr.args[0] as NumberLiteral).value;

                current_block.addNextBlock(branch_targets[branch_targets.length-1-blocks_to_exit]);
                return;
            } else if (instr.id == "br_if") {

                current_block.addOp("br_if"); // decides next block, todo push block result pseudo-register?

                let next_block = new IRControlBlock();

                // branch is taken
                let blocks_to_exit = (instr.args[0] as NumberLiteral).value;
                current_block.addNextBlock(branch_targets[branch_targets.length-1-blocks_to_exit]);

                // branch is not taken
                current_block.addNextBlock(next_block);

                current_block = next_block;
            } else if (instr.id == "br_table") {

                current_block.addOp("br_table"); // decides next block, todo push block result pseudo-register?

                instr.args.forEach((arg)=>{
                    let blocks_to_exit = (arg as NumberLiteral).value;
                    current_block.addNextBlock(branch_targets[branch_targets.length-1-blocks_to_exit]);
                });
                return;
            } else if (instr.id == "end" || instr.id == "nop") {
                // don't care
            } else {
                current_block.addOp(instr.id);
            }
        } else {
            throw new Error(instr.type+" "+instr.id);
        }
    }

    // We don't auto-link to the next block for loops, since loop IR blocks don't end with the loop.
    if (!skip_link_next) {
        // Link to the next block.
        current_block.addNextBlock(branch_targets[branch_targets.length-1]);
    }
}

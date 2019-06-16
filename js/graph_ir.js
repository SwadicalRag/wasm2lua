"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const stringcompiler_1 = require("./stringcompiler");
let next_block_id = 1;
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
    addOp(x) {
        this.operations.push(x);
    }
    debugInfoR(builder, buffer, seen) {
        if (seen[this.id]) {
            return;
        }
        seen[this.id] = true;
        builder.write(buffer, `BLOCK ${this.id} -> [${this.next.map(x => x.id)}]`);
        builder.indent();
        this.operations.forEach((str) => {
            builder.newLine(buffer);
            builder.write(buffer, str);
        });
        builder.outdent();
        builder.newLine(buffer);
        this.next.forEach((block) => {
            block.debugInfoR(builder, buffer, seen);
        });
    }
}
function compileFuncWithIR(node, modState) {
    let entry = new IRControlBlock();
    let exit = new IRControlBlock();
    compileWASMBlockToIRBlocks(node.body, entry, [exit]);
    let compiler = new stringcompiler_1.StringCompiler();
    let buffer = new Array();
    compiler.write(buffer, "FUNC " + node.name.value);
    compiler.indent();
    compiler.newLine(buffer);
    entry.debugInfoR(compiler, buffer, {});
    return `--[[\n${buffer.join("")}\n]]\n`;
}
exports.compileFuncWithIR = compileFuncWithIR;
function compileWASMBlockToIRBlocks(body, current_block, branch_targets, skip_link_next) {
    let value_stack = [];
    for (let i = 0; i < body.length; i++) {
        let instr = body[i];
        if (instr.type == "BlockInstruction") {
            let next_block = new IRControlBlock();
            compileWASMBlockToIRBlocks(instr.instr, current_block, branch_targets.concat([next_block]));
            current_block = next_block;
        }
        else if (instr.type == "LoopInstruction") {
            let loop_block = new IRControlBlock();
            current_block.addNextBlock(loop_block);
            compileWASMBlockToIRBlocks(instr.instr, loop_block, branch_targets.concat([loop_block]), true);
            current_block = loop_block;
        }
        else if (instr.type == "IfInstruction") {
            current_block.addOp("br_if");
            let next_block = new IRControlBlock();
            let block_true = new IRControlBlock();
            current_block.addNextBlock(block_true);
            compileWASMBlockToIRBlocks(instr.consequent, block_true, branch_targets.concat([next_block]));
            if (instr.alternate.length > 0) {
                let block_false = new IRControlBlock();
                current_block.addNextBlock(block_false);
                compileWASMBlockToIRBlocks(instr.consequent, block_false, branch_targets.concat([next_block]));
            }
            else {
                current_block.addNextBlock(next_block);
            }
            current_block = next_block;
        }
        else if (instr.type == "CallInstruction" || instr.type == "CallIndirectInstruction") {
            current_block.addOp(instr.id);
        }
        else if (instr.type == "Instr") {
            if (instr.id == "br") {
                current_block.addOp("br");
                let blocks_to_exit = instr.args[0].value;
                current_block.addNextBlock(branch_targets[branch_targets.length - 1 - blocks_to_exit]);
                return;
            }
            else if (instr.id == "br_if") {
                current_block.addOp("br_if");
                let next_block = new IRControlBlock();
                let blocks_to_exit = instr.args[0].value;
                current_block.addNextBlock(branch_targets[branch_targets.length - 1 - blocks_to_exit]);
                current_block.addNextBlock(next_block);
                current_block = next_block;
            }
            else if (instr.id == "br_table") {
                current_block.addOp("br_table");
                instr.args.forEach((arg) => {
                    let blocks_to_exit = arg.value;
                    current_block.addNextBlock(branch_targets[branch_targets.length - 1 - blocks_to_exit]);
                });
                return;
            }
            else if (instr.id == "end" || instr.id == "nop") {
            }
            else {
                current_block.addOp(instr.id);
            }
        }
        else {
            throw new Error(instr.type + " " + instr.id);
        }
    }
    if (!skip_link_next) {
        current_block.addNextBlock(branch_targets[branch_targets.length - 1]);
    }
}
//# sourceMappingURL=graph_ir.js.map
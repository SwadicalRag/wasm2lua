"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const util_1 = require("util");
class StringCompiler {
    constructor() {
        this.indentLevel = 0;
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
    getNewLine() {
        return "\n" + (("    ").repeat(this.indentLevel));
    }
    newLine(buf) {
        buf.push(this.getNewLine());
    }
    write(buf, str) { return buf.push(str) - 1; }
    writeLn(buf, str) {
        if (str !== "") {
            buf.push(str + this.getNewLine());
        }
        return buf.length - 1;
    }
    writeEx(buf, str, offset) {
        if (offset < 0) {
            offset += buf.length;
        }
        buf.splice(offset, 0, str);
    }
}
exports.StringCompiler = StringCompiler;
//# sourceMappingURL=stringcompiler.js.map
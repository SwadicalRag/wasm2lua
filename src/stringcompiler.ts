import { isArray } from "util";

export class StringCompiler {
    indentLevel = 0;

    indent() {this.indentLevel++;}


    outdent(buf?: string[]) {
        this.indentLevel--;
        if(isArray(buf)) {
            while(buf[buf.length - 1] === "") {
                buf.pop();
            }

            if (buf.length>0) {
                let mat = buf[buf.length - 1].match(/^([\s\S]*?)\n(?:    )*$/);
                if(mat) {
                    // fix up indent
                    buf[buf.length - 1] = mat[1] + "\n" + (("    ").repeat(this.indentLevel));
                }
            }
        }
    }

    getNewLine() {
        return "\n" + (("    ").repeat(this.indentLevel));
    }

    newLine(buf: string[]) {
        buf.push(this.getNewLine());
    }

    write(buf: string[],str: string) {return buf.push(str) - 1;}
    writeLn(buf: string[],str: string) {
        if(str !== "") {
            buf.push(str + this.getNewLine());
        }
        return buf.length - 1;
    }
    writeEx(buf: string[],str: string,offset: number) {
        if(offset < 0) {offset += buf.length;}
        buf.splice(offset,0,str);
    }
}
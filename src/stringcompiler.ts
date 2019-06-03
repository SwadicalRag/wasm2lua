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

    newLine(buf: string[]) {
        buf.push("\n" + (("    ").repeat(this.indentLevel)));
    }

    write(buf: string[],str: string) {buf.push(str);}
    writeLn(buf: string[],str: string) {
        if(str !== "") {
            buf.push(str);
            this.newLine(buf);
        }
    }
    writeEx(buf: string[],str: string,offset: number) {
        if(offset < 0) {offset += buf.length;}
        buf.splice(offset,0,str);
    }
}
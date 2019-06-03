import * as program from "commander"
import * as fs from "fs"
import * as fsExtra from "fs-extra"
import * as path from "path"
import { wasm2lua, WASM2LuaOptions } from "..";

let infile,outfile;

program.version("0.1.0")
    .arguments("<in.wasm> <out.lua>")
    .option("--heapBase <__GLOBALS__[0]>","Specify custom `heapBase` symbol name")
    .option("--freeName <free>","Specify custom `free` symbol name")
    .option("--mallocName <malloc>","Specify custom `malloc` symbol name")
    .option("--pureLua","Compiles without using `ffi`")
    .option("-b, --bindings <bindings.idl>","Generates Lua-WebIDL bindings from the specified file")
    .option("--libmode","Adds a dummy main function to use this as a library (for WASI)")
    .action(function (inf, outf) {
        if((typeof inf === "string") && (typeof outf === "string")) {
            if((inf.trim() !== "") && (outf.trim() !== "")) {
                infile = path.resolve(inf.trim());
                outfile = path.resolve(outf.trim());
            }
        }
    })
    .parse(process.argv);

if((typeof infile === "undefined") || (typeof outfile === "undefined")) {
    program.outputHelp();
    process.exit(-1);
}

if(!fs.existsSync(infile)) {
    console.error(`Could not find input file ${infile}`);
}

fsExtra.ensureDirSync(path.dirname(outfile));

let conf: WASM2LuaOptions = {

};

if(program.bindings) {
    conf.webidl = {
        idlFilePath: program.bindings,
    }
}

if(program.bindings && program.mallocName) {
    conf.webidl.mallocName = program.mallocName;
}

if(program.bindings && program.freeName) {
    conf.webidl.freeName = program.freeName;
}

if(program.heapBase) {
    conf.heapBase = program.heapBase;
}

if(program.pureLua) {
    conf.pureLua = program.pureLua;
}

if(program.libMode) {
    conf.libMode = program.libMode;
}

let inst = new wasm2lua(fs.readFileSync(infile),conf)

fs.writeFileSync(outfile,inst.outBuf.join(""));

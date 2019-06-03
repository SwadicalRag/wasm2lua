"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const program = require("commander");
const fs = require("fs");
const fsExtra = require("fs-extra");
const path = require("path");
const webidlbinder_1 = require("../webidlbinder");
let infile, outfile, includedHeaders;
program.version("0.1.0")
    .arguments("<in.idl> <out> [includedHeaders...]")
    .option("--libmode", "Adds a dummy main function to use this as a library (for WASI)")
    .option("--cpp", "Runs Lua-WebIDL in C++ mode")
    .action(function (inf, outf, incH) {
    if ((typeof inf === "string") && (typeof outf === "string")) {
        if ((inf.trim() !== "") && (outf.trim() !== "")) {
            infile = path.resolve(inf.trim());
            outfile = path.resolve(outf.trim());
        }
    }
    includedHeaders = incH || [];
})
    .parse(process.argv);
if ((typeof infile === "undefined") || (typeof outfile === "undefined")) {
    program.outputHelp();
    process.exit(-1);
}
if (!fs.existsSync(infile)) {
    console.error(`Could not find input file ${infile}`);
}
fsExtra.ensureDirSync(path.dirname(outfile));
let mode = webidlbinder_1.BinderMode.WEBIDL_NONE;
if (program.cpp) {
    mode = webidlbinder_1.BinderMode.WEBIDL_CPP;
}
if (mode === webidlbinder_1.BinderMode.WEBIDL_NONE) {
    console.error("Binder mode was not specified. Terminating.");
    process.exit(-2);
}
let inst = new webidlbinder_1.WebIDLBinder(fs.readFileSync(infile).toString(), mode, program.libmode);
inst.buildOut();
let out = "";
if (mode === webidlbinder_1.BinderMode.WEBIDL_CPP) {
    for (let header of includedHeaders) {
        out += `#include "${header}"\n`;
    }
}
out += inst.outBufCPP.join("");
fs.writeFileSync(outfile, out);
//# sourceMappingURL=lua-webidl.js.map
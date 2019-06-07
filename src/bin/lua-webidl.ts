#!/usr/bin/env node

import * as program from "commander"
import * as fs from "fs"
import * as fsExtra from "fs-extra"
import * as path from "path"
import { WebIDLBinder, BinderMode } from "../webidlbinder";

let infile,outfile,includedHeaders;

let manifest = JSON.parse(fs.readFileSync(__dirname + "/../../package.json").toString());

program.version(manifest.version)
    .arguments("<in.idl> <out> [includedHeaders...]")
    .option("--libmode","Adds a dummy main function to use this as a library (for WASI)")
    .option("--cpp","Runs Lua-WebIDL in C++ mode")
    .action(function (inf, outf, incH) {
        if((typeof inf === "string") && (typeof outf === "string")) {
            if((inf.trim() !== "") && (outf.trim() !== "")) {
                infile = path.resolve(inf.trim());
                outfile = path.resolve(outf.trim());
            }
        }

        includedHeaders = incH || [];
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

let mode = BinderMode.WEBIDL_NONE;
if(program.cpp) {
    mode = BinderMode.WEBIDL_CPP;
}

if(mode === BinderMode.WEBIDL_NONE) {
    console.error("Binder mode was not specified. Terminating.");
    process.exit(-2);
}

let inst = new WebIDLBinder(fs.readFileSync(infile).toString(),mode,program.libmode);

inst.buildOut();

let out = "";

if(mode === BinderMode.WEBIDL_CPP) {
    for(let header of includedHeaders) {
        out += `#include "${header}"\n`;
    }
}

out += inst.outBufCPP.join("");
fs.writeFileSync(outfile,out);

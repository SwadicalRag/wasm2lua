import * as program from "commander"
import * as fs from "fs"
import * as fsExtra from "fs-extra"
import * as path from "path"
import { WebIDLBinder } from "../webidlbinder";

let infile,outfile,includedHeaders;

program.version("0.1.0")
    .arguments("<in.idl> <out.cpp> [includedHeaders...]")
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

let inst = new WebIDLBinder(fs.readFileSync(infile).toString());

inst.buildOut();

let out = "";

for(let header of includedHeaders) {
    out += `#include "${header}"\n`;
}

out += inst.outBufCPP.join("");
fs.writeFileSync(outfile,out);

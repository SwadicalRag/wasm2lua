
import * as fs from "fs";
import { wasm2lua } from ".";

let infile  = process.argv[2] || (__dirname + "/../test/addTwo.wasm");
let outfile = process.argv[3] || (__dirname + "/../test/test.lua");

let wasm = fs.readFileSync(infile);

let inst = new wasm2lua(wasm);

fs.writeFileSync(outfile,inst.outBuf.join(""));

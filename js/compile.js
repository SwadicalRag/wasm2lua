"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const fs = require("fs");
const _1 = require(".");
let infile = process.argv[2] || (__dirname + "/../test/addTwo.wasm");
let outfile = process.argv[3] || (__dirname + "/../test/test.lua");
let wasm = fs.readFileSync(infile);
let inst = new _1.wasm2lua(wasm);
fs.writeFileSync(outfile, inst.outBuf.join(""));
//# sourceMappingURL=compile.js.map
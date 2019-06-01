"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const fs = require("fs");
const cp = require("child_process");
const _1 = require(".");
let files = fs.readdirSync(__dirname + "/../../c-testsuite/tests/single-exec/");
let totalTests = 0;
let passedTests = 0;
for (let fileName of files) {
    if (fileName.match(/\.c$/)) {
        console.log(`Running test ${fileName}...`);
        let fullPath = `${__dirname}/../../c-testsuite/tests/single-exec/${fileName}`;
        let wasmPath = `${fullPath}.wasm`;
        let expectedOutPath = `${fullPath}.expected`;
        let wasm = fs.readFileSync(wasmPath);
        let inst = new _1.wasm2lua(wasm, {});
        fs.writeFileSync(`${__dirname}/../test/test.lua`, inst.outBuf.join("") + ` __MODULES__.wasi_unstable=dofile("src/wasilib.lua")(__MODULES__.UNKNOWN.memory)os.exit(_start())`);
        console.log(`compile finished.`);
        let expectedOut = fs.readFileSync(expectedOutPath);
        let prog = cp.spawnSync(`nilajit`, ["test/test.lua"], {});
        totalTests++;
        if (prog.status != 0) {
            console.error(`test (${fileName}) failed with code ${prog.status}...`);
        }
        else if (prog.stderr.toString().length != 0) {
            console.error(`test (${fileName}) failed due to stderr...`);
            console.error(prog.stderr.toString());
        }
        else if (prog.stdout.toString().replace(/\r\n?/g, "\n") !== expectedOut.toString().replace(/\r\n?/g, "\n")) {
            console.error(`test failed... (${fileName})`);
            console.error(`expected: ${expectedOut.toString()}`);
            console.error(`actual: ${prog.stdout.toString()}`);
        }
        else {
            console.log(`test passed!`);
            passedTests++;
        }
    }
}
console.log(`All done! ${passedTests}/${totalTests} tests passed :)`);
//# sourceMappingURL=c-testsuite.js.map
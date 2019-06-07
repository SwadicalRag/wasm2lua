"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const fs = require("fs");
const fsExtra = require("fs-extra");
const cp = require("child_process");
const _1 = require(".");
fsExtra.ensureDirSync(__dirname + "/../test/");
let totalTests = 0;
let passedTests = 0;
let ignoredFailedTests = 0;
const ignoredTests = [
    "00174.c",
    "00187.c",
    "00204.c",
    "array.optimized.wat.wasm",
    "binary.untouched.wat.wasm",
    "dataview.optimized.wat.wasm",
    "math.optimized.wat.wasm",
    "math.untouched.wat.wasm",
    "string.optimized.wat.wasm",
];
const LUA_PROGRAM = "nilajit";
let files = fs.readdirSync(__dirname + "/../resources/tests/c-testsuite/");
for (let fileName of files) {
    if (fileName.match(/\.c$/)) {
        console.log(`Running test ${fileName}...`);
        let fullPath = `${__dirname}/../resources/tests/c-testsuite/${fileName}`;
        let wasmPath = `${fullPath}.wasm`;
        let expectedOutPath = `${fullPath}.expected`;
        let wasm = fs.readFileSync(wasmPath);
        let inst = new _1.wasm2lua(wasm, {});
        fs.writeFileSync(`${__dirname}/../test/test.lua`, inst.outBuf.join(""));
        console.log(`compile finished.`);
        let expectedOut = fs.readFileSync(expectedOutPath);
        let prog = cp.spawnSync(LUA_PROGRAM, ["resources/testsuite-host.lua"], {});
        totalTests++;
        let didPass = false;
        if (prog.stderr.toString().length != 0) {
            console.error(`test (${fileName}) failed due to stderr...`);
            console.error(prog.stderr.toString());
        }
        else if (prog.status != 0) {
            console.error(`test (${fileName}) failed with code ${prog.status}...`);
        }
        else if (prog.stdout.toString().replace(/\r\n?/g, "\n") !== expectedOut.toString().replace(/\r\n?/g, "\n")) {
            console.error(`test failed... (${fileName})`);
            console.error(`expected: ${expectedOut.toString()}`);
            console.error(`actual: ${prog.stdout.toString()}`);
        }
        else {
            console.log(`test passed!`);
            passedTests++;
            didPass = true;
        }
        if (!didPass && (ignoredTests.indexOf(fileName) !== -1)) {
            passedTests++;
            ignoredFailedTests++;
        }
    }
}
let files2 = fs.readdirSync(__dirname + "/../resources/tests/assemblyscript/");
for (let fileName of files2) {
    if (fileName.match(/\.wasm$/)) {
        console.log(`Running test ${fileName}...`);
        let wasmPath = `${__dirname}/../resources/tests/assemblyscript/${fileName}`;
        let wasm = fs.readFileSync(wasmPath);
        let inst = new _1.wasm2lua(wasm, {});
        fs.writeFileSync(`${__dirname}/../test/test.lua`, inst.outBuf.join(""));
        console.log(`compile finished.`);
        let prog = cp.spawnSync(LUA_PROGRAM, ["resources/testsuite-host.lua"], {});
        totalTests++;
        let didPass = false;
        if (prog.stderr.toString().length != 0) {
            console.error(`test (${fileName}) failed due to stderr...`);
            console.error(prog.stderr.toString());
        }
        else if (prog.status != 0) {
            console.error(`test (${fileName}) failed with code ${prog.status}...`);
        }
        else {
            console.log(`test passed!`);
            passedTests++;
            didPass = true;
        }
        if (!didPass && (ignoredTests.indexOf(fileName) !== -1)) {
            passedTests++;
            ignoredFailedTests++;
        }
    }
}
console.log(`All done! (${passedTests - ignoredFailedTests} + ${ignoredFailedTests})/${totalTests} tests passed :)`);
if (passedTests !== totalTests) {
    process.exit(-100);
}
//# sourceMappingURL=testsuite.js.map
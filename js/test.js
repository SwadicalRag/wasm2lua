"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const path_1 = require("path");
const fs = require("fs");
const child_process = require("child_process");
function fixWSLPath(path) {
    path = path.replace(/(.):\\/g, (_, x) => { console.log(x); return `/mnt/${x.toLowerCase()}/`; });
    path = path.replace(/\\/g, "/");
    return path;
}
let target = process.argv[2];
let test_dir = path_1.join(__dirname, "../test/");
let fileHeader = fs.readFileSync(__dirname + "/../resources/fileheader_test.lua").toString();
if (target.endsWith(".json")) {
    processTestFile(target);
}
else {
}
function processTestFile(filename) {
    let testFile = JSON.parse(fs.readFileSync(filename).toString());
    let commandQueue = [];
    console.log(`==========> ${testFile.source_filename}`);
    testFile.commands.forEach((cmd) => {
        switch (cmd.type) {
            case "module":
                compileAndRunTests(commandQueue);
                let wasm_file = path_1.join(path_1.dirname(filename), cmd.filename);
                compileModule(wasm_file);
                break;
            case "assert_malformed":
                break;
            default:
                commandQueue.push(cmd);
        }
    });
    compileAndRunTests(commandQueue);
}
function compileModule(file) {
    console.log("COMPILE", file);
    let result = child_process.spawnSync(process.argv0, [
        path_1.join(__dirname, "index.js"),
        file
    ]);
    if (result.status != 0) {
        console.log(result.stderr.toString());
        throw new Error("compile failed");
    }
}
function compileAndRunTests(commands) {
    if (commands.length > 0) {
        let compiled = commands.map(compileCommand).join("\n");
        fs.writeFileSync(test_dir + "test_run.lua", fileHeader + compiled);
        let result = child_process.spawnSync("bash", [
            "-c",
            "luajit " + fixWSLPath(test_dir + "test_run.lua")
        ]);
        console.log(result.stdout.toString());
        console.log(result.stderr.toString());
        throw "meh";
    }
    commands.length = 0;
}
function compileCommand(cmd, test_num) {
    if (cmd.type == "assert_return" || cmd.type == "assert_trap") {
        let instr = cmd.action;
        return `runTest(${test_num},"${instr.field}",{${instr.args.map(compileValue).join(",")}},"trap")`;
    }
    else {
        throw new Error("Unhandled command: " + cmd.type);
    }
}
function compileValue(value) {
    if (value.type == "i32") {
        return value.value;
    }
    else {
        throw new Error("ugh");
    }
}
//# sourceMappingURL=test.js.map
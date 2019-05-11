"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const path_1 = require("path");
const fs = require("fs");
const child_process = require("child_process");
function fixWSLPath(path) {
    path = path.replace(/(.):\\/g, (_, x) => `/mnt/${x.toLowerCase()}/`);
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
    console.log("Compiling:", file);
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
        console.log(`Running ${commands.length} tests...`);
        let compiled = commands.map(compileCommand).join("\n");
        fs.writeFileSync(test_dir + "test_run.lua", fileHeader + compiled);
        let result = child_process.spawnSync("bash", [
            "-c",
            "luajit " + fixWSLPath(test_dir + "test_run.lua")
        ]);
        console.log(result.stdout.toString());
        if (result.status != 0) {
            console.log(result.stderr.toString());
            throw new Error("execution failed");
        }
    }
    commands.length = 0;
}
function compileCommand(cmd, test_num) {
    if (cmd.type == "assert_return" || cmd.type == "assert_trap") {
        let instr = cmd.action;
        let expected = cmd.type == "assert_trap" ? `"trap"` :
            `{${cmd.expected.map(compileValue).join(",")}}`;
        return `runTest(${cmd.line},"${instr.field}",{${instr.args.map(compileValue).join(",")}},${expected})`;
    }
    else {
        throw new Error("Unhandled command: " + cmd.type);
    }
}
function compileValue(value) {
    if (value.type == "i32") {
        return value.value;
    }
    else if (value.type == "i64") {
        let num = BigInt(value.value);
        let low = num & BigInt(0xFFFFFFFF);
        let high = num >> BigInt(32);
        return `__LONG_INT__(${low},${high})`;
    }
    else if (value.type == "f32") {
        let convert_buffer = Buffer.alloc(4);
        convert_buffer.writeInt32LE(+value.value, 0);
        let float_val = convert_buffer.readFloatLE(0);
        return compileFloatValue(float_val);
    }
    else if (value.type == "f64") {
        let num = BigInt(value.value);
        let array = new BigInt64Array(1);
        array[0] = num;
        let float_val = new Float64Array(array.buffer)[0];
        return compileFloatValue(float_val);
    }
    else {
        throw new Error("bad type " + value.type);
    }
}
function compileFloatValue(value) {
    if (value != value) {
        return "(0/0)";
    }
    return value.toString();
}
//# sourceMappingURL=test.js.map
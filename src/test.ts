
import { join as pathJoin, dirname } from "path";
import * as fs from "fs";

import * as child_process from "child_process";

import Int64 = require("node-int64");

interface TestValue {
    type: "i32" | "i64";
    value: string;
}

interface TestInstr {
    type: "invoke";
    field: string;
    args: TestValue[]
}

interface TestFile {
    source_filename: string;
    commands: TestCmd[]
}

interface TestCmdModule {
    type: "module";
    filename: string;
}

interface TestCmdAssertReturn {
    type: "assert_return";
    action: TestInstr;
    expected: TestValue[];
}

interface TestCmdAssertTrap {
    type: "assert_trap";
    action: TestInstr;
    expected: TestValue[];
    text: string;
}

interface TestCmdAssertMalformed {
    type: "assert_malformed";
}

type TestCmd = (TestCmdModule | TestCmdAssertReturn | TestCmdAssertTrap | TestCmdAssertMalformed) & {line: number};

function fixWSLPath(path) {
    path = path.replace(/(.):\\/g,(_,x)=>`/mnt/${x.toLowerCase()}/`);
    path = path.replace(/\\/g,"/");
    return path;
}

let target = process.argv[2];

let test_dir = pathJoin(__dirname,"../test/");

let fileHeader = fs.readFileSync(__dirname + "/../resources/fileheader_test.lua").toString();

if (target.endsWith(".json")) {
    processTestFile(target);
} else {
    // todo entire test directory
}

function processTestFile(filename: string) {
    let testFile: TestFile = JSON.parse(fs.readFileSync(filename).toString());
    
    let commandQueue: TestCmd[] = [];

    console.log(`==========> ${testFile.source_filename}`);

    testFile.commands.forEach((cmd)=>{

        switch (cmd.type) {
            case "module":
                compileAndRunTests(commandQueue);

                let wasm_file = pathJoin(dirname(filename),cmd.filename);
                compileModule(wasm_file);
                break;
            case "assert_malformed":
                // Don't care.
                break;
            default:
                commandQueue.push(cmd);
        }

    });

    compileAndRunTests(commandQueue);
}

function compileModule(file: string) {
    console.log("Compiling:",file);
    let result = child_process.spawnSync(process.argv0,[
        pathJoin(__dirname,"index.js"),
        file
    ]);
    if (result.status!=0) {
        console.log(result.stderr.toString());
        throw new Error("compile failed");
    }
}

function compileAndRunTests(commands: TestCmd[]) {
    if (commands.length>0) {
        let compiled = commands.map(compileCommand).join("\n");
        fs.writeFileSync(test_dir+"test_run.lua",fileHeader+compiled);

        let result = child_process.spawnSync("bash",[
            "-c",
            "luajit "+fixWSLPath(test_dir+"test_run.lua")
        ]);

        console.log(result.stdout.toString());
        if (result.status!=0) {
            console.log(result.stderr.toString());
            throw new Error("execution failed");
        }
    }
    commands.length = 0;
}

function compileCommand(cmd: TestCmd, test_num: number) {
    if (cmd.type == "assert_return" || cmd.type == "assert_trap") {
        let instr = cmd.action;

        let expected = cmd.type == "assert_trap" ? `"trap"` :
            `{${cmd.expected.map(compileValue).join(",")}}`;

        return `runTest(${cmd.line},"${instr.field}",{${instr.args.map(compileValue).join(",")}},${expected})`

    } else {
        throw new Error("Unhandled command: "+(<any>cmd).type);
    }
}

function compileValue(value: TestValue) {
    if (value.type=="i32") {
        return value.value;
    } else if (value.type=="i64") {
        var num = BigInt(value.value);
        let low = num & BigInt(0xFFFFFFFF);
        let high = num >> BigInt(32);

        return `__LONG_INT__(${low},${high})`;
    } else {
        throw new Error("bad type "+value.type);
    }
}


import { join as pathJoin, dirname } from "path";
import * as fs from "fs";

import * as child_process from "child_process";

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

interface TestCmdAssertExhaust {
    type: "assert_exhaustion";
    action: TestInstr;
    expected: TestValue[];
}

interface TestCmdAssertMalformed {
    type: "assert_malformed";
}

interface TestCmdAssertInvalid {
    type: "assert_invalid";
}

type TestCmd = (TestCmdModule | TestCmdAssertReturn | TestCmdAssertTrap | TestCmdAssertMalformed | TestCmdAssertInvalid | TestCmdAssertExhaust) & {line: number};

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
            case "assert_malformed": // should not compile to binary
            case "assert_invalid":   // compiled to binary but should be rejected by compiler / vm 
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
        file,
        test_dir+"test.lua",
        "correct-multiply"
    ]);
    if (result.status!=0) {
        console.log(result.stderr.toString());
        throw new Error("compile failed");
    }
}

function compileAndRunTests(commands: TestCmd[]) {
    if (commands.length>0) {
        console.log(`Running ${commands.length} tests...`);
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
    if (cmd.type == "assert_return" || cmd.type == "assert_trap" || cmd.type == "assert_exhaustion") {
        let instr = cmd.action;
        if (instr.type != "invoke") {
            throw new Error("Unhandled instr type: "+instr.type);
        }

        let expected =
            cmd.type == "assert_trap" ? `"${cmd.text}"` :
            cmd.type == "assert_exhaustion" ? `"exhaustion"` :
            `{${cmd.expected.map(compileValue).join(",")}}`;

        return `runTest(${cmd.line},"${instr.field}",{${instr.args.map(compileValue).join(",")}},${expected})`

    } else {
        console.log(cmd);
        throw new Error("Unhandled command: "+(<any>cmd).type);
    }
}

function compileValue(value: TestValue) {
    if (value.type=="i32") {
        return (+value.value)|0;
    } else if (value.type=="i64") {
        let num = BigInt(value.value);
        let low = num & BigInt(0xFFFFFFFF);
        let high = num >> BigInt(32);

        return `__LONG_INT__(${low},${high})`;
    } else if (value.type=="f32") {
        let convert_buffer = Buffer.alloc(4);
        convert_buffer.writeUInt32LE(+value.value,0);
        let float_val = convert_buffer.readFloatLE(0);

        return compileFloatValue(float_val);
    } else if (value.type=="f64") {
        let num = BigInt(value.value);
        let array = new BigInt64Array(1);
        array[0] = num;
        let float_val = new Float64Array(array.buffer)[0];

        return compileFloatValue(float_val);
    } else {
        throw new Error("bad type "+value.type);
    }
}

function compileFloatValue(value: number) {
    if (value != value) {
        return "(0/0)"
    }
    return value.toString(); // eugh
}
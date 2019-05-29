import * as webidl from "webidl2"
import { StringCompiler } from "./stringcompiler";
import * as fs from "fs"

export class WebIDLBinder {
    luaC = new StringCompiler();
    cppC = new StringCompiler();
    outBufLua: string[] = [];
    outBufCPP: string[] = [];
    ast: webidl.IDLRootType[];

    constructor(public source: string) {
        this.ast = webidl.parse(source);

        this.buildOut();
    }

    buildOut() {
        for(let i=0;i < this.ast.length;i++) {
            this.walkRootType(this.ast[i]);
        }
    }

    walkRootType(node: webidl.IDLRootType) {
        if(node.type == "interface") {
            this.walkInterface(node)
        }
    }

    walkInterface(node: webidl.InterfaceType) {
        this.luaC.writeLn(this.outBufLua,`${node.name} = {} ${node.name}.__index = ${node.name}`);

        this.luaC.write(this.outBufLua,`setmetatable(${node.name},{__call = function(self)`)
        this.luaC.write(this.outBufLua,`local ins = setmetatable({ptr = 0},self)`)
        this.luaC.write(this.outBufLua,`ins:${node.name}()`)
        this.luaC.write(this.outBufLua,`return ins`)
        this.luaC.write(this.outBufLua,` end})`)

        let hasConstructor = false;

        this.luaC.indent(); this.luaC.newLine(this.outBufLua);
        for(let i=0;i < node.members.length;i++) {
            let member = node.members[i];
            if(member.type == "operation") {
                this.luaC.write(this.outBufLua,`function ${node.name}:${member.name}(`);
                for(let j=0;j < member.arguments.length;j++) {
                    this.luaC.write(this.outBufLua,`${member.arguments[j].name}`);
                    if((j+1) !== member.arguments.length) {
                        this.luaC.write(this.outBufLua,",");
                    }
                }
                this.luaC.write(this.outBufLua,") end");
                this.luaC.newLine(this.outBufLua);
            }
        }
        this.luaC.outdent(); this.luaC.newLine(this.outBufLua);

    }
}

let infile  = process.argv[2] || (__dirname + "/../test/test.idl");
let outfile_lua = process.argv[3] || (__dirname + "/../test/test_bind.lua");
let outfile_cpp = process.argv[3] || (__dirname + "/../test/test_bind.cpp");

let idl = fs.readFileSync(infile);

// console.log(JSON.stringify(ast,null,4));

let inst = new WebIDLBinder(idl.toString());
fs.writeFileSync(outfile_lua,inst.outBufLua.join(""));
fs.writeFileSync(outfile_cpp,inst.outBufCPP.join(""));

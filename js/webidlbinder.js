"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const webidl = require("webidl2");
const stringcompiler_1 = require("./stringcompiler");
const fs = require("fs");
class WebIDLBinder {
    constructor(source) {
        this.source = source;
        this.luaC = new stringcompiler_1.StringCompiler();
        this.cppC = new stringcompiler_1.StringCompiler();
        this.outBufLua = [];
        this.outBufCPP = [];
        this.ast = webidl.parse(source);
        this.buildOut();
    }
    buildOut() {
        for (let i = 0; i < this.ast.length; i++) {
            this.walkRootType(this.ast[i]);
        }
    }
    walkRootType(node) {
        if (node.type == "interface") {
            this.walkInterface(node);
        }
    }
    walkInterface(node) {
        this.luaC.writeLn(this.outBufLua, `${node.name} = {} ${node.name}.__index = ${node.name}`);
        this.luaC.write(this.outBufLua, `setmetatable(${node.name},{__call = function(self)`);
        this.luaC.write(this.outBufLua, `local ins = setmetatable({ptr = 0},self)`);
        this.luaC.write(this.outBufLua, `ins:${node.name}()`);
        this.luaC.write(this.outBufLua, `return ins`);
        this.luaC.write(this.outBufLua, ` end})`);
        let hasConstructor = false;
        this.luaC.indent();
        this.luaC.newLine(this.outBufLua);
        for (let i = 0; i < node.members.length; i++) {
            let member = node.members[i];
            if (member.type == "operation") {
                this.luaC.write(this.outBufLua, `function ${node.name}:${member.name}(`);
                for (let j = 0; j < member.arguments.length; j++) {
                    this.luaC.write(this.outBufLua, `${member.arguments[j].name}`);
                    if ((j + 1) !== member.arguments.length) {
                        this.luaC.write(this.outBufLua, ",");
                    }
                }
                this.luaC.write(this.outBufLua, ") end");
                this.luaC.newLine(this.outBufLua);
            }
        }
        this.luaC.outdent();
        this.luaC.newLine(this.outBufLua);
    }
}
exports.WebIDLBinder = WebIDLBinder;
let infile = process.argv[2] || (__dirname + "/../test/test.idl");
let outfile_lua = process.argv[3] || (__dirname + "/../test/test_bind.lua");
let outfile_cpp = process.argv[3] || (__dirname + "/../test/test_bind.cpp");
let idl = fs.readFileSync(infile);
let inst = new WebIDLBinder(idl.toString());
fs.writeFileSync(outfile_lua, inst.outBufLua.join(""));
fs.writeFileSync(outfile_cpp, inst.outBufCPP.join(""));
//# sourceMappingURL=webidlbinder.js.map
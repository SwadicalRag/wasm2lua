"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const webidl = require("webidl2");
const stringcompiler_1 = require("./stringcompiler");
var BinderMode;
(function (BinderMode) {
    BinderMode[BinderMode["WEBIDL_NONE"] = -1] = "WEBIDL_NONE";
    BinderMode[BinderMode["WEBIDL_LUA"] = 0] = "WEBIDL_LUA";
    BinderMode[BinderMode["WEBIDL_CPP"] = 1] = "WEBIDL_CPP";
})(BinderMode = exports.BinderMode || (exports.BinderMode = {}));
class WebIDLBinder {
    constructor(source, mode) {
        this.source = source;
        this.mode = mode;
        this.luaC = new stringcompiler_1.StringCompiler();
        this.cppC = new stringcompiler_1.StringCompiler();
        this.outBufLua = [];
        this.outBufCPP = [];
        this.classLookup = {};
        this.ast = webidl.parse(source);
    }
    mangleFunctionName(node, namespace, isImpl) {
        let out = "_webidl_lua_";
        if (isImpl) {
            out += "internalimpl_";
        }
        out += namespace + "_";
        out += node.name;
        for (let i = 0; i < node.arguments.length; i++) {
            let arg = node.arguments[i];
            out += "_";
            out += arg.idlType.idlType.toString().replace(/\s+/g, "_");
        }
        return out;
    }
    getExtendedAttribute(attribute, extAttrs) {
        for (let i = 0; i < extAttrs.length; i++) {
            if (extAttrs[i].name === attribute) {
                return extAttrs[i];
            }
        }
        return false;
    }
    hasExtendedAttribute(attribute, extAttrs) {
        return this.getExtendedAttribute(attribute, extAttrs) !== false;
    }
    idlTypeToCType(idlType, extAttrs = []) {
        let prefixes = "";
        let suffixes = "";
        if (this.hasExtendedAttribute("Const", extAttrs)) {
            prefixes += "const ";
        }
        if (this.hasExtendedAttribute("Ref", extAttrs)) {
            suffixes += "*";
        }
        let body = idlType.idlType;
        if (WebIDLBinder.CTypeRenames[body]) {
            body = WebIDLBinder.CTypeRenames[body];
        }
        return `${prefixes} ${body} ${suffixes}`.replace(/\s+/g, " ").trim();
    }
    buildOut() {
        if (this.mode == BinderMode.WEBIDL_LUA) {
            this.luaC.writeLn(this.outBufLua, "local __CFUNCS__ = {}");
            this.luaC.writeLn(this.outBufLua, "__IMPORTS__.webidl_cfuncs = __CFUNCS__");
        }
        for (let i = 0; i < this.ast.length; i++) {
            let node = this.ast[i];
            if ((node.type == "interface") || (node.type == "interface mixin")) {
                this.classLookup[node.name] = true;
                if (this.mode == BinderMode.WEBIDL_CPP) {
                }
            }
        }
        for (let i = 0; i < this.ast.length; i++) {
            this.walkRootType(this.ast[i]);
        }
    }
    walkRootType(node) {
        if ((node.type == "interface") || (node.type == "interface mixin")) {
            if (this.mode == BinderMode.WEBIDL_LUA) {
                this.walkInterfaceLua(node);
            }
            else if (this.mode == BinderMode.WEBIDL_CPP) {
                this.walkInterfaceCPP(node);
            }
        }
    }
    walkInterfaceLua(node) {
        let JsImpl = this.getExtendedAttribute("JSImplementation", node.extAttrs);
        let hasConstructor = false;
        this.luaC.writeLn(this.outBufLua, `__BINDINGS__.${node.name} = {__cache = {}} __BINDINGS__.${node.name}.__index = __BINDINGS__.${node.name}`);
        this.luaC.write(this.outBufLua, `setmetatable(__BINDINGS__.${node.name},{__call = function(self)`);
        this.luaC.write(this.outBufLua, `local ins = setmetatable({__ptr = 0},self)`);
        this.luaC.write(this.outBufLua, `ins:${node.name}()`);
        this.luaC.write(this.outBufLua, `return ins`);
        this.luaC.write(this.outBufLua, ` end})`);
        this.luaC.indent();
        this.luaC.newLine(this.outBufLua);
        for (let i = 0; i < node.members.length; i++) {
            let member = node.members[i];
            if (member.type == "operation") {
                if (member.name == node.name) {
                    hasConstructor = true;
                }
                if (!JsImpl || (node.name == member.name)) {
                    this.luaC.write(this.outBufLua, `function __BINDINGS__.${node.name}:${member.name}(`);
                    for (let j = 0; j < member.arguments.length; j++) {
                        this.luaC.write(this.outBufLua, `${member.arguments[j].name}`);
                        if ((j + 1) !== member.arguments.length) {
                            this.luaC.write(this.outBufLua, ",");
                        }
                    }
                    this.luaC.write(this.outBufLua, `)`);
                    for (let j = 0; j < member.arguments.length; j++) {
                        if (member.arguments[j].idlType.idlType == "DOMString") {
                            this.luaC.write(this.outBufLua, `local __arg${j} = vm.stringify(${member.arguments[j].name})`);
                        }
                    }
                    if (member.name == node.name) {
                        this.luaC.write(this.outBufLua, `self.__ptr = `);
                        this.luaC.write(this.outBufLua, `__FUNCS__.${this.mangleFunctionName(member, node.name)}(`);
                    }
                    else {
                        this.luaC.write(this.outBufLua, `local ret = `);
                        this.luaC.write(this.outBufLua, `__FUNCS__.${this.mangleFunctionName(member, node.name)}(self.__ptr`);
                        if (member.arguments.length > 0) {
                            this.luaC.write(this.outBufLua, ",");
                        }
                    }
                    for (let j = 0; j < member.arguments.length; j++) {
                        if (member.arguments[j].idlType.idlType == "DOMString") {
                            this.luaC.write(this.outBufLua, `arg${j}`);
                        }
                        else {
                            this.luaC.write(this.outBufLua, `${member.arguments[j].name}`);
                        }
                        if (this.classLookup[member.arguments[j].idlType.idlType]) {
                            this.luaC.write(this.outBufLua, ".__ptr");
                        }
                        else if (member.arguments[j].idlType.idlType == "boolean") {
                            this.luaC.write(this.outBufLua, " and 1 or 0");
                        }
                        if ((j + 1) !== member.arguments.length) {
                            this.luaC.write(this.outBufLua, ",");
                        }
                    }
                    this.luaC.write(this.outBufLua, ")");
                    for (let j = 0; j < member.arguments.length; j++) {
                        if (member.arguments[j].idlType.idlType == "DOMString") {
                            this.luaC.write(this.outBufLua, `vm.freeString(arg${j})`);
                        }
                    }
                    if (member.name !== node.name) {
                        if (this.classLookup[member.idlType.idlType]) {
                            this.luaC.write(this.outBufLua, `local __obj = ${member.idlType.idlType}.__cache[ret] `);
                            this.luaC.write(this.outBufLua, `if not __obj then __obj = setmetatable({__ptr = ret},${member.idlType.idlType}) ${member.idlType.idlType}.__cache[ret] = __obj end `);
                            this.luaC.write(this.outBufLua, "return __obj");
                        }
                        else if (member.idlType.idlType == "DOMString") {
                            this.luaC.write(this.outBufLua, "return vm.readString(ret)");
                        }
                        else {
                            this.luaC.write(this.outBufLua, "return ret");
                        }
                    }
                    this.luaC.write(this.outBufLua, " end");
                    this.luaC.newLine(this.outBufLua);
                }
                if (JsImpl && (member.name !== node.name)) {
                    this.luaC.write(this.outBufLua, `function __CFUNCS__.${this.mangleFunctionName(member, node.name, true)}(selfPtr`);
                    for (let j = 0; j < member.arguments.length; j++) {
                        this.luaC.write(this.outBufLua, ",");
                        this.luaC.write(this.outBufLua, `${member.arguments[j].name}`);
                    }
                    this.luaC.write(this.outBufLua, `)`);
                    this.luaC.write(this.outBufLua, `local self = ${node.name}.__cache[selfPtr] return self.${member.name}(self`);
                    for (let j = 0; j < member.arguments.length; j++) {
                        this.luaC.write(this.outBufLua, ",");
                        this.luaC.write(this.outBufLua, `${member.arguments[j].name}`);
                    }
                    this.luaC.write(this.outBufLua, `)`);
                    this.luaC.write(this.outBufLua, " end");
                    this.luaC.newLine(this.outBufLua);
                }
            }
        }
        if (!hasConstructor) {
            this.luaC.writeLn(this.outBufLua, `function __BINDINGS__.${node.name}:${node.name}() error("Class ${node.name} has no WebIDL constructor and therefore cannot be instantiated via Lua") end`);
        }
        this.luaC.outdent(this.outBufLua);
        this.luaC.newLine(this.outBufLua);
    }
    walkInterfaceCPP(node) {
        let JsImpl = this.getExtendedAttribute("JSImplementation", node.extAttrs);
        let hasConstructor = false;
        for (let i = 0; i < node.members.length; i++) {
            let member = node.members[i];
            if (member.type == "operation") {
                if (member.name == node.name) {
                    hasConstructor = true;
                }
                if (member.name == node.name) {
                    this.cppC.write(this.outBufCPP, `extern "C" ${node.name}* ${this.mangleFunctionName(member, node.name)}(`);
                }
                else {
                    this.cppC.write(this.outBufCPP, `extern "C" ${this.idlTypeToCType(member.idlType, member.extAttrs)} ${this.mangleFunctionName(member, node.name)}(${node.name}* self`);
                    if (member.arguments.length > 0) {
                        this.cppC.write(this.outBufCPP, `,`);
                    }
                }
                for (let j = 0; j < member.arguments.length; j++) {
                    this.cppC.write(this.outBufCPP, `${this.idlTypeToCType(member.arguments[j].idlType, member.arguments[j].extAttrs)} ${member.arguments[j].name}`);
                    if ((j + 1) !== member.arguments.length) {
                        this.cppC.write(this.outBufCPP, ",");
                    }
                }
                this.cppC.write(this.outBufCPP, `) {return `);
                if (member.name == node.name) {
                    this.cppC.write(this.outBufCPP, `new ${member.name}`);
                }
                else {
                    this.cppC.write(this.outBufCPP, `self->${member.name}`);
                }
                this.cppC.write(this.outBufCPP, `(`);
                for (let j = 0; j < member.arguments.length; j++) {
                    this.cppC.write(this.outBufCPP, `${member.arguments[j].name}`);
                    if ((j + 1) !== member.arguments.length) {
                        this.cppC.write(this.outBufCPP, ",");
                    }
                }
                this.cppC.write(this.outBufCPP, `); };`);
                this.cppC.newLine(this.outBufCPP);
            }
        }
        if (JsImpl) {
            this.cppC.writeLn(this.outBufCPP, `#define __CFUNC(name) \\`);
            this.cppC.writeLn(this.outBufCPP, `    __attribute__((__import_module__("webidl_cfuncs"), __import_name__(#name)))`);
            for (let i = 0; i < node.members.length; i++) {
                let member = node.members[i];
                if (member.type == "operation") {
                    if (member.name == node.name) {
                        continue;
                    }
                    this.cppC.write(this.outBufCPP, `extern "C" ${this.idlTypeToCType(member.idlType, node.extAttrs)} ${this.mangleFunctionName(member, node.name, true)}(${node.name}* self`);
                    for (let j = 0; j < member.arguments.length; j++) {
                        this.cppC.write(this.outBufCPP, ",");
                        this.cppC.write(this.outBufCPP, `${this.idlTypeToCType(member.arguments[j].idlType, member.arguments[j].extAttrs)} ${member.arguments[j].name}`);
                    }
                    this.cppC.writeLn(this.outBufCPP, `) __CFUNC(${this.mangleFunctionName(member, node.name, true)});`);
                }
            }
            this.cppC.writeLn(this.outBufCPP, `#undef __CFUNC`);
            this.cppC.writeLn(this.outBufCPP, `class ${node.name} {`);
            this.cppC.write(this.outBufCPP, `public:`);
            this.cppC.indent();
            this.cppC.newLine(this.outBufCPP);
            for (let i = 0; i < node.members.length; i++) {
                let member = node.members[i];
                if (member.type == "operation") {
                    if (member.name == node.name) {
                        hasConstructor = true;
                        continue;
                    }
                    this.cppC.write(this.outBufCPP, `${this.idlTypeToCType(member.idlType, node.extAttrs)} `);
                    this.cppC.write(this.outBufCPP, `${member.name}(`);
                    for (let j = 0; j < member.arguments.length; j++) {
                        this.cppC.write(this.outBufCPP, `${this.idlTypeToCType(member.arguments[j].idlType, member.arguments[j].extAttrs)} ${member.arguments[j].name}`);
                        if ((j + 1) !== member.arguments.length) {
                            this.cppC.write(this.outBufCPP, ",");
                        }
                    }
                    this.cppC.write(this.outBufCPP, `) {`);
                    this.cppC.write(this.outBufCPP, `return `);
                    this.cppC.write(this.outBufCPP, `${this.mangleFunctionName(member, node.name, true)}(this`);
                    for (let j = 0; j < member.arguments.length; j++) {
                        this.cppC.write(this.outBufCPP, ",");
                        this.cppC.write(this.outBufCPP, `${member.arguments[j].name}`);
                    }
                    this.cppC.write(this.outBufCPP, ");");
                    this.cppC.write(this.outBufCPP, " };");
                    this.cppC.newLine(this.outBufCPP);
                }
            }
            this.cppC.outdent(this.outBufCPP);
            this.cppC.write(this.outBufCPP, "};");
            this.cppC.newLine(this.outBufCPP);
        }
    }
}
WebIDLBinder.CTypeRenames = {
    ["DOMString"]: "char*"
};
exports.WebIDLBinder = WebIDLBinder;
//# sourceMappingURL=webidlbinder.js.map
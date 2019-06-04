"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const webidl = require("webidl2");
const stringcompiler_1 = require("./stringcompiler");
const fs = require("fs");
var BinderMode;
(function (BinderMode) {
    BinderMode[BinderMode["WEBIDL_NONE"] = -1] = "WEBIDL_NONE";
    BinderMode[BinderMode["WEBIDL_LUA"] = 0] = "WEBIDL_LUA";
    BinderMode[BinderMode["WEBIDL_CPP"] = 1] = "WEBIDL_CPP";
})(BinderMode = exports.BinderMode || (exports.BinderMode = {}));
class WebIDLBinder {
    constructor(source, mode, addYieldStub) {
        this.source = source;
        this.mode = mode;
        this.addYieldStub = addYieldStub;
        this.luaC = new stringcompiler_1.StringCompiler();
        this.cppC = new stringcompiler_1.StringCompiler();
        this.outBufLua = [];
        this.outBufCPP = [];
        this.classLookup = {};
        this.ast = webidl.parse(source);
    }
    unquote(arg) {
        if (Array.isArray(arg)) {
            arg = arg.join("");
        }
        return arg.replace(/^"/, "").replace(/"$/, "");
    }
    getWithRefs(arg) {
        if (this.hasExtendedAttribute("Ref", arg.extAttrs)) {
            return `*${arg.name}`;
        }
        else {
            return arg.name;
        }
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
        else if (this.mode == BinderMode.WEBIDL_CPP) {
            this.cppC.writeLn(this.outBufCPP, `#define __CFUNC(name) \\`);
            this.cppC.writeLn(this.outBufCPP, `    __attribute__((__import_module__("webidl_cfuncs"), __import_name__(#name)))`);
            this.cppC.writeLn(this.outBufCPP, `#define export __attribute__((visibility( "default" )))`);
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
        for (let i = 0; i < this.ast.length; i++) {
            if (this.ast[i].type == "interface") {
                let int = this.ast[i];
                if (int.inheritance) {
                    this.luaC.writeLn(this.outBufLua, `setmetatable(__BINDINGS__.${int.name},{__index = __BINDINGS__.${int.inheritance}})`);
                }
            }
        }
        if (this.addYieldStub) {
            if (this.mode == BinderMode.WEBIDL_LUA) {
                this.luaC.writeLn(this.outBufLua, "__IMPORTS__.webidl_internal = {main_yield = coroutine.yield}");
                this.luaC.writeLn(this.outBufLua, "module.init = coroutine.wrap(module.init)");
            }
            else if (this.mode == BinderMode.WEBIDL_CPP) {
                this.cppC.writeLn(this.outBufCPP, `extern "C" void _webidl_main_yield() __attribute__((__import_module__("webidl_internal"), __import_name__("main_yield")));`);
                this.cppC.writeLn(this.outBufCPP, `int main() {_webidl_main_yield(); return 0;}`);
            }
        }
        if (this.mode == BinderMode.WEBIDL_CPP) {
            this.cppC.writeLn(this.outBufCPP, `#undef __CFUNC`);
        }
    }
    writeCArgs(buf, args, needsType, needsStartingComma) {
        if (needsStartingComma) {
            if (args.length > 0) {
                this.cppC.write(buf, ",");
            }
        }
        for (let j = 0; j < args.length; j++) {
            if (needsType) {
                this.cppC.write(buf, `${this.idlTypeToCType(args[j].idlType, args[j].extAttrs)} `);
            }
            this.cppC.write(buf, `${args[j].name}`);
            if ((j + 1) !== args.length) {
                this.cppC.write(buf, ",");
            }
        }
    }
    writeLuaArgs(buf, args, needsStartingComma) {
        if (needsStartingComma) {
            if (args.length > 0) {
                this.luaC.write(buf, ",");
            }
        }
        for (let j = 0; j < args.length; j++) {
            this.luaC.write(buf, `${args[j].name}`);
            if ((j + 1) !== args.length) {
                this.luaC.write(buf, ",");
            }
        }
    }
    walkRootType(node) {
        if (node.type == "interface") {
            if (this.mode == BinderMode.WEBIDL_LUA) {
                this.walkInterfaceLua(node);
            }
            else if (this.mode == BinderMode.WEBIDL_CPP) {
                this.walkInterfaceCPP(node);
            }
        }
        else if ((node.type == "namespace")) {
            if (this.mode == BinderMode.WEBIDL_LUA) {
                this.walkNamespaceLua(node);
            }
            else if (this.mode == BinderMode.WEBIDL_CPP) {
                this.walkNamespaceCPP(node);
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
                this.luaC.write(this.outBufLua, `function __BINDINGS__.${node.name}:${member.name}(`);
                this.writeLuaArgs(this.outBufLua, member.arguments, false);
                this.luaC.write(this.outBufLua, `)`);
                if (!JsImpl || (node.name == member.name)) {
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
                            this.luaC.write(this.outBufLua, `__arg${j}`);
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
                    this.luaC.write(this.outBufLua, ");");
                    if (member.name == node.name) {
                        this.luaC.write(this.outBufLua, `__BINDINGS__.${node.name}.__cache[self.__ptr] = self;`);
                    }
                    for (let j = 0; j < member.arguments.length; j++) {
                        if (member.arguments[j].idlType.idlType == "DOMString") {
                            this.luaC.write(this.outBufLua, `vm.freeString(__arg${j})`);
                        }
                    }
                    if (member.name !== node.name) {
                        if (this.classLookup[member.idlType.idlType]) {
                            this.luaC.write(this.outBufLua, `local __obj = __BINDINGS__.${member.idlType.idlType}.__cache[ret] `);
                            this.luaC.write(this.outBufLua, `if not __obj then __obj = setmetatable({__ptr = ret},${member.idlType.idlType}) __BINDINGS__.${member.idlType.idlType}.__cache[ret] = __obj end `);
                            this.luaC.write(this.outBufLua, "return __obj");
                        }
                        else if (member.idlType.idlType == "DOMString") {
                            this.luaC.write(this.outBufLua, "return vm.readString(ret)");
                        }
                        else {
                            this.luaC.write(this.outBufLua, "return ret");
                        }
                    }
                }
                else {
                    this.luaC.write(this.outBufLua, `error("Unimplemented -> ${node.name}::${member.name}()")`);
                }
                this.luaC.write(this.outBufLua, " end");
                this.luaC.newLine(this.outBufLua);
                if (JsImpl && (member.name !== node.name)) {
                    this.luaC.write(this.outBufLua, `function __CFUNCS__.${this.mangleFunctionName(member, node.name, true)}(selfPtr`);
                    this.writeLuaArgs(this.outBufLua, member.arguments, true);
                    this.luaC.write(this.outBufLua, `)`);
                    this.luaC.write(this.outBufLua, `local self = __BINDINGS__.${node.name}.__cache[selfPtr] return self.${member.name}(self`);
                    this.writeLuaArgs(this.outBufLua, member.arguments, true);
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
        let Prefix = this.getExtendedAttribute("Prefix", node.extAttrs) || "";
        let hasConstructor = false;
        if (JsImpl) {
            this.cppC.writeLn(this.outBufCPP, `class ${node.name};`);
            for (let i = 0; i < node.members.length; i++) {
                let member = node.members[i];
                if (member.type == "operation") {
                    if (member.name == node.name) {
                        continue;
                    }
                    this.cppC.write(this.outBufCPP, `export extern "C" ${this.idlTypeToCType(member.idlType, node.extAttrs)} ${Prefix}${this.mangleFunctionName(member, node.name, true)}(${node.name}* self`);
                    this.writeCArgs(this.outBufCPP, member.arguments, true, true);
                    this.cppC.writeLn(this.outBufCPP, `) __CFUNC(${this.mangleFunctionName(member, node.name, true)});`);
                }
            }
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
                    this.writeCArgs(this.outBufCPP, member.arguments, true, false);
                    this.cppC.write(this.outBufCPP, `) {`);
                    if (member.idlType.idlType !== "void") {
                        this.cppC.write(this.outBufCPP, "return");
                    }
                    this.cppC.write(this.outBufCPP, ` `);
                    this.cppC.write(this.outBufCPP, `${Prefix}${this.mangleFunctionName(member, node.name, true)}(this`);
                    this.writeCArgs(this.outBufCPP, member.arguments, false, true);
                    this.cppC.write(this.outBufCPP, ");");
                    this.cppC.write(this.outBufCPP, " };");
                    this.cppC.newLine(this.outBufCPP);
                }
            }
            this.cppC.outdent(this.outBufCPP);
            this.cppC.write(this.outBufCPP, "};");
            this.cppC.newLine(this.outBufCPP);
        }
        for (let i = 0; i < node.members.length; i++) {
            let member = node.members[i];
            if (member.type == "operation") {
                let Operator = this.getExtendedAttribute("Operator", member.extAttrs);
                let NoReturn = this.getExtendedAttribute("NoReturn", member.extAttrs);
                if (member.name == node.name) {
                    hasConstructor = true;
                }
                else if (JsImpl) {
                    continue;
                }
                if (member.name == node.name) {
                    this.cppC.write(this.outBufCPP, `export extern "C" ${node.name}* ${this.mangleFunctionName(member, node.name)}(`);
                }
                else {
                    this.cppC.write(this.outBufCPP, `export extern "C" ${this.idlTypeToCType(member.idlType, member.extAttrs)} ${this.mangleFunctionName(member, node.name)}(${node.name}* self`);
                    if (member.arguments.length > 0) {
                        this.cppC.write(this.outBufCPP, `,`);
                    }
                }
                this.writeCArgs(this.outBufCPP, member.arguments, true, false);
                this.cppC.write(this.outBufCPP, `) {`);
                if (((member.idlType.idlType !== "void") && !NoReturn) || (member.name == node.name)) {
                    this.cppC.write(this.outBufCPP, "return");
                }
                this.cppC.write(this.outBufCPP, ` `);
                if (Operator === false) {
                    if (member.name == node.name) {
                        this.cppC.write(this.outBufCPP, `new ${member.name}`);
                    }
                    else {
                        this.cppC.write(this.outBufCPP, `self->${member.name}`);
                    }
                    this.cppC.write(this.outBufCPP, `(`);
                    this.writeCArgs(this.outBufCPP, member.arguments, false, false);
                    this.cppC.write(this.outBufCPP, `); `);
                }
                else {
                    if (member.arguments.length > 0) {
                        if (this.hasExtendedAttribute("Ref", member.extAttrs)) {
                            this.cppC.write(this.outBufCPP, "&");
                        }
                        this.cppC.write(this.outBufCPP, `(*self ${this.unquote(Operator.rhs.value)} ${this.getWithRefs(member.arguments[0])});`);
                    }
                    else {
                        this.cppC.write(this.outBufCPP, `${this.unquote(Operator.rhs.value)} self;`);
                    }
                }
                this.cppC.write(this.outBufCPP, `};`);
                this.cppC.newLine(this.outBufCPP);
            }
        }
    }
    walkNamespaceLua(node) {
        let JsImpl = this.getExtendedAttribute("JSImplementation", node.extAttrs);
        let hasConstructor = false;
        this.luaC.write(this.outBufLua, `__BINDINGS__.${node.name} = {}`);
        this.luaC.indent();
        this.luaC.newLine(this.outBufLua);
        for (let i = 0; i < node.members.length; i++) {
            let member = node.members[i];
            if (member.type == "operation") {
                if (member.name == node.name) {
                    hasConstructor = true;
                }
                this.luaC.write(this.outBufLua, `function __BINDINGS__.${node.name}.${member.name}(`);
                this.writeLuaArgs(this.outBufLua, member.arguments, false);
                this.luaC.write(this.outBufLua, `)`);
                if (JsImpl) {
                    this.luaC.write(this.outBufLua, `error("Unimplemented -> ${node.name}::${member.name}()")`);
                }
                else {
                    for (let j = 0; j < member.arguments.length; j++) {
                        if (member.arguments[j].idlType.idlType == "DOMString") {
                            this.luaC.write(this.outBufLua, `local __arg${j} = vm.stringify(${member.arguments[j].name})`);
                        }
                    }
                    this.luaC.write(this.outBufLua, `local ret = `);
                    this.luaC.write(this.outBufLua, `__FUNCS__.${this.mangleFunctionName(member, node.name)}(`);
                    for (let j = 0; j < member.arguments.length; j++) {
                        if (member.arguments[j].idlType.idlType == "DOMString") {
                            this.luaC.write(this.outBufLua, `__arg${j}`);
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
                            this.luaC.write(this.outBufLua, `vm.freeString(__arg${j})`);
                        }
                    }
                    if (this.classLookup[member.idlType.idlType]) {
                        this.luaC.write(this.outBufLua, `local __obj = __BINDINGS__.${member.idlType.idlType}.__cache[ret] `);
                        this.luaC.write(this.outBufLua, `if not __obj then __obj = setmetatable({__ptr = ret},${member.idlType.idlType}) __BINDINGS__.${member.idlType.idlType}.__cache[ret] = __obj end `);
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
                if (JsImpl) {
                    this.luaC.write(this.outBufLua, `function __CFUNCS__.${this.mangleFunctionName(member, node.name, true)}(`);
                    this.writeLuaArgs(this.outBufLua, member.arguments, false);
                    this.luaC.write(this.outBufLua, `)`);
                    this.luaC.write(this.outBufLua, `return __BINDINGS__.${node.name}.${member.name}(`);
                    this.writeLuaArgs(this.outBufLua, member.arguments, false);
                    this.luaC.write(this.outBufLua, `)`);
                    this.luaC.write(this.outBufLua, " end");
                    this.luaC.newLine(this.outBufLua);
                }
            }
        }
        this.luaC.outdent(this.outBufLua);
        this.luaC.newLine(this.outBufLua);
    }
    walkNamespaceCPP(node) {
        let JsImpl = this.getExtendedAttribute("JSImplementation", node.extAttrs);
        let Prefix = this.getExtendedAttribute("Prefix", node.extAttrs) || "";
        let hasConstructor = false;
        if (JsImpl) {
            for (let i = 0; i < node.members.length; i++) {
                let member = node.members[i];
                if (member.type == "operation") {
                    this.cppC.write(this.outBufCPP, `extern "C" ${this.idlTypeToCType(member.idlType, node.extAttrs)} ${Prefix}${this.mangleFunctionName(member, node.name, true)}(`);
                    this.writeCArgs(this.outBufCPP, member.arguments, true, false);
                    this.cppC.writeLn(this.outBufCPP, `) __CFUNC(${this.mangleFunctionName(member, node.name, true)});`);
                }
            }
            this.cppC.write(this.outBufCPP, `namespace ${node.name} {`);
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
                    this.writeCArgs(this.outBufCPP, member.arguments, true, false);
                    this.cppC.write(this.outBufCPP, `) {`);
                    if (member.idlType.idlType !== "void") {
                        this.cppC.write(this.outBufCPP, "return");
                    }
                    this.cppC.write(this.outBufCPP, ` `);
                    this.cppC.write(this.outBufCPP, `${Prefix}${this.mangleFunctionName(member, node.name, true)}(`);
                    this.writeCArgs(this.outBufCPP, member.arguments, false, false);
                    this.cppC.write(this.outBufCPP, ");");
                    this.cppC.write(this.outBufCPP, " };");
                    this.cppC.newLine(this.outBufCPP);
                }
            }
            this.cppC.outdent(this.outBufCPP);
            this.cppC.write(this.outBufCPP, "};");
            this.cppC.newLine(this.outBufCPP);
        }
        else {
            for (let i = 0; i < node.members.length; i++) {
                let member = node.members[i];
                if (member.type == "operation") {
                    let NoReturn = this.getExtendedAttribute("NoReturn", member.extAttrs);
                    this.cppC.write(this.outBufCPP, `export extern "C" ${this.idlTypeToCType(member.idlType, member.extAttrs)} ${this.mangleFunctionName(member, node.name)}(`);
                    this.writeCArgs(this.outBufCPP, member.arguments, true, false);
                    this.cppC.write(this.outBufCPP, `) {`);
                    if ((member.idlType.idlType !== "void") && !NoReturn) {
                        this.cppC.write(this.outBufCPP, "return");
                    }
                    this.cppC.write(this.outBufCPP, ` `);
                    if (node.name === "global") {
                        this.cppC.write(this.outBufCPP, `${member.name}`);
                    }
                    else {
                        this.cppC.write(this.outBufCPP, `${node.name}::${member.name}`);
                    }
                    this.cppC.write(this.outBufCPP, `(`);
                    this.writeCArgs(this.outBufCPP, member.arguments, false, false);
                    this.cppC.write(this.outBufCPP, `); `);
                    this.cppC.write(this.outBufCPP, `};`);
                    this.cppC.newLine(this.outBufCPP);
                }
            }
        }
    }
}
WebIDLBinder.CTypeRenames = {
    ["DOMString"]: "char*"
};
exports.WebIDLBinder = WebIDLBinder;
let infile = process.argv[2] || (__dirname + "/../test/test.idl");
let outfile_lua = process.argv[3] || (__dirname + "/../test/test_bind.lua");
let outfile_cpp = process.argv[3] || (__dirname + "/../test/test_bind.cpp");
let idl = fs.readFileSync(infile);
let inst = new WebIDLBinder(idl.toString(), BinderMode.WEBIDL_CPP, true);
inst.buildOut();
fs.writeFileSync(outfile_lua, inst.outBufLua.join(""));
fs.writeFileSync(outfile_cpp, inst.outBufCPP.join(""));
//# sourceMappingURL=webidlbinder.js.map
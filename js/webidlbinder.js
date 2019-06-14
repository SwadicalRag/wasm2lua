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
class SemanticError extends Error {
}
exports.SemanticError = SemanticError;
var ETypeConversion;
(function (ETypeConversion) {
    ETypeConversion[ETypeConversion["NONE"] = 0] = "NONE";
    ETypeConversion[ETypeConversion["CPP_TO_LUA"] = 1] = "CPP_TO_LUA";
    ETypeConversion[ETypeConversion["LUA_TO_CPP"] = 2] = "LUA_TO_CPP";
})(ETypeConversion = exports.ETypeConversion || (exports.ETypeConversion = {}));
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
        this.classPrefixLookup = {};
        this.arrayTypes = {};
        this.ptrArrayTypes = {};
        this.specialTypes = {
            ["DOMString"]: true,
            ["boolean"]: true,
        };
        this.symbolResolver = (symName) => { return `__EXPORTS__.${symName}`; };
        this.ast = webidl.parse(source);
    }
    setSymbolResolver(fn) {
        this.symbolResolver = fn;
    }
    unquote(arg) {
        if (Array.isArray(arg)) {
            arg = arg.join("");
        }
        return arg.replace(/^"/, "").replace(/"$/, "");
    }
    unquoteEx(arg) {
        if (arg === false) {
            return "";
        }
        return this.unquote(arg.rhs.value);
    }
    getWithRefs(arg, noMask) {
        if (this.hasExtendedAttribute("Ref", arg.extAttrs)) {
            if (noMask) {
                return `&${arg.name}`;
            }
            else {
                return `*${arg.name}`;
            }
        }
        else {
            return arg.name;
        }
    }
    rawMangle(ident) {
        return ident.toString().replace(/\s*/g, "").replace(/[^A-Za-z0-9_]/g, (str) => {
            return `__x${str.charCodeAt(0).toString(16)}`;
        });
    }
    mangleFunctionName(node, namespace, isImpl) {
        let out = "_webidl_lua_";
        if (isImpl) {
            out += "internalimpl_";
        }
        out += namespace + "_";
        if (typeof node === "string") {
            out += node;
            out += "_void";
        }
        else {
            out += node.name;
            for (let i = 0; i < node.arguments.length; i++) {
                let arg = node.arguments[i];
                out += "_";
                out += arg.idlType.idlType.toString().replace(/\s+/g, "_");
            }
        }
        return out;
    }
    mangleIndexerName(node, namespace, isNewindex) {
        let out = "_webidl_lua_";
        out += namespace + "_";
        out += node.name;
        if (isNewindex) {
            out += "_set";
        }
        else {
            out += "_get";
        }
        return out;
    }
    mangleArrayIndexerName(opName, arrTypeName) {
        let out = "_webidl_lua_arr_";
        arrTypeName = this.rawMangle(arrTypeName);
        out += arrTypeName;
        out += "_" + opName;
        return out;
    }
    mangleArrayIndexerNameEx(opName, idlType, extAttrs = []) {
        return this.mangleArrayIndexerName(opName, this.idlTypeToCType(idlType, extAttrs, true));
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
    idlTypeToCType(idlType, extAttrs, maskRef, tempVar) {
        let prefixes = "";
        let suffixes = "";
        if (this.hasExtendedAttribute("Const", extAttrs)) {
            if (!tempVar) {
                prefixes += "const ";
            }
        }
        if (this.hasExtendedAttribute("Ref", extAttrs)) {
            if (!tempVar) {
                if (maskRef) {
                    suffixes += "*";
                }
                else {
                    suffixes += "&";
                }
            }
        }
        else if (this.classLookup[idlType.idlType]) {
            if (!tempVar) {
                suffixes += "*";
            }
        }
        let body;
        if (this.hasExtendedAttribute("Size", extAttrs) && (idlType.idlType == "any")) {
            body = "size_t";
        }
        else if (this.hasExtendedAttribute("ArrayLength", extAttrs) && (idlType.idlType == "any")) {
            body = "size_t";
        }
        else if (this.hasExtendedAttribute("ArrayLengthRef", extAttrs) && (idlType.idlType == "any")) {
            body = "size_t*";
        }
        else if (this.hasExtendedAttribute("Enum", extAttrs) && (idlType.idlType == "any")) {
            let enAttr = this.getExtendedAttribute("Enum", extAttrs);
            if (enAttr && enAttr.rhs) {
                body = this.unquote(enAttr.rhs.value);
            }
            else {
                throw new SemanticError("Enum attribute needs a value (enum name)");
            }
        }
        else {
            body = idlType.idlType;
        }
        if (WebIDLBinder.CTypeRenames[body]) {
            body = WebIDLBinder.CTypeRenames[body];
        }
        else if (this.classPrefixLookup[body]) {
            body = this.classPrefixLookup[body] + body;
        }
        if (this.hasExtendedAttribute("Array", extAttrs)) {
            body = `_LuaArray<${body}>*`;
        }
        else if (this.hasExtendedAttribute("PointerArray", extAttrs)) {
            body = `_LuaArray<${body}*>*`;
        }
        return `${prefixes} ${body} ${suffixes}`.replace(/\s+/g, " ").trim();
    }
    idlTypeToCTypeLite(idlType, extAttrs) {
        let body;
        if (this.hasExtendedAttribute("Size", extAttrs) && (idlType.idlType == "any")) {
            body = "size_t";
        }
        else if (this.hasExtendedAttribute("ArrayLength", extAttrs) && (idlType.idlType == "any")) {
            body = "size_t";
        }
        else if (this.hasExtendedAttribute("ArrayLengthRef", extAttrs) && (idlType.idlType == "any")) {
            body = "psize_t";
        }
        else if (this.hasExtendedAttribute("Enum", extAttrs) && (idlType.idlType == "any")) {
            let enAttr = this.getExtendedAttribute("Enum", extAttrs);
            if (enAttr && enAttr.rhs) {
                body = "enum_" + this.unquote(enAttr.rhs.value);
            }
            else {
                throw new SemanticError("Enum attribute needs a value (enum name)");
            }
        }
        else {
            body = idlType.idlType;
        }
        if (WebIDLBinder.CTypeRenames[body]) {
            body = WebIDLBinder.CTypeRenames[body];
        }
        else if (this.classPrefixLookup[body]) {
            body = this.classPrefixLookup[body] + body;
        }
        return body;
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
            this.cppC.write(this.outBufCPP, `template <typename T> struct _LuaArray {`);
            this.cppC.indent();
            this.cppC.newLine(this.outBufCPP);
            this.cppC.writeLn(this.outBufCPP, `public:`);
            this.cppC.writeLn(this.outBufCPP, `_LuaArray(size_t inLen) : totalLen(inLen), len(inLen) {array = new T[inLen]; knownLen = true;};`);
            this.cppC.writeLn(this.outBufCPP, `_LuaArray(size_t inLen,T* inArray) : totalLen(inLen), len(inLen) {array = inArray; knownLen = true; isOwner = false;};`);
            this.cppC.writeLn(this.outBufCPP, `_LuaArray(T* inArray) {array = inArray; isOwner = false;};`);
            this.cppC.writeLn(this.outBufCPP, `~_LuaArray() {if(isOwner) {delete[] array;}};`);
            this.cppC.writeLn(this.outBufCPP, `bool isOwner = true;`);
            this.cppC.writeLn(this.outBufCPP, `bool knownLen = false;`);
            this.cppC.writeLn(this.outBufCPP, `size_t totalLen = 0;`);
            this.cppC.writeLn(this.outBufCPP, `size_t len = 0;`);
            this.cppC.write(this.outBufCPP, `T* array;`);
            this.cppC.newLine(this.outBufCPP);
            this.cppC.outdent(this.outBufCPP);
            this.cppC.writeLn(this.outBufCPP, `};`);
        }
        for (let i = 0; i < this.ast.length; i++) {
            let node = this.ast[i];
            if ((node.type == "interface") || (node.type == "interface mixin")) {
                this.classLookup[node.name] = true;
                let prefix = this.getExtendedAttribute("Prefix", node.extAttrs);
                if (prefix) {
                    this.classPrefixLookup[node.name] = this.unquote(prefix.rhs.value);
                }
                if (this.mode == BinderMode.WEBIDL_CPP) {
                }
            }
        }
        for (let i = 0; i < this.ast.length; i++) {
            let node = this.ast[i];
            if ((node.type == "interface") || (node.type == "namespace")) {
                let JsImpl = this.getExtendedAttribute("JSImplementation", node.extAttrs) || this.getExtendedAttribute("LuaImplementation", node.extAttrs);
                for (let j = 0; j < node.members.length; j++) {
                    let member = node.members[j];
                    if ((member.type == "operation") || (member.type == "attribute")) {
                        if (member.type == "operation") {
                            for (let k = member.arguments.length - 1; k >= 0; k--) {
                                let arrEA = this.getExtendedAttribute("Array", member.arguments[k].extAttrs);
                                if (arrEA) {
                                    this.arrayTypes[this.idlTypeToCTypeLite(member.arguments[k].idlType, member.arguments[k].extAttrs)] = member.arguments[k].idlType;
                                    if (this.getExtendedAttribute("ArrayLength", member.extAttrs) && JsImpl) {
                                        throw new SemanticError("ArrayLength extended attribute is incompatible with functions implemented in Lua");
                                    }
                                    else if (this.getExtendedAttribute("ArrayLengthRef", member.extAttrs) && JsImpl) {
                                        throw new SemanticError("ArrayLengthRef extended attribute is incompatible with functions implemented in Lua");
                                    }
                                }
                                else {
                                    arrEA = this.getExtendedAttribute("PointerArray", member.arguments[k].extAttrs);
                                    if (arrEA) {
                                        if (!this.classLookup[member.arguments[k].idlType.idlType]) {
                                            throw new SemanticError(`PointerArrays are unsupported for non-class types like '${member.arguments[k].idlType.idlType}'. Are you sure you defined an interface for this type?`);
                                        }
                                        this.ptrArrayTypes[this.idlTypeToCTypeLite(member.arguments[k].idlType, member.arguments[k].extAttrs)] = member.arguments[k].idlType;
                                    }
                                }
                            }
                        }
                        let arrEARet = this.getExtendedAttribute("Array", member.extAttrs);
                        if (arrEARet) {
                            this.arrayTypes[this.idlTypeToCTypeLite(member.idlType, member.extAttrs)] = member.idlType;
                            if (this.getExtendedAttribute("ArrayLength", member.extAttrs)) {
                                throw new SemanticError("ArrayLength extended attribute is incompatible with return types");
                            }
                            else if (this.getExtendedAttribute("ArrayLengthRef", member.extAttrs)) {
                                throw new SemanticError("ArrayLengthRef extended attribute is incompatible with return types");
                            }
                        }
                        else {
                            arrEARet = this.getExtendedAttribute("PointerArray", member.extAttrs);
                            if (arrEARet) {
                                if (!this.classLookup[member.idlType.idlType]) {
                                    throw new SemanticError(`PointerArrays are unsupported for non-class types like '${member.idlType.idlType}'. Are you sure you defined an interface for this type?`);
                                }
                                this.ptrArrayTypes[this.idlTypeToCTypeLite(member.idlType, member.extAttrs)] = member.idlType;
                            }
                        }
                    }
                }
            }
        }
        for (let i = 0; i < this.ast.length; i++) {
            let node = this.ast[i];
            if (node.type == "interface") {
                let toAdd = [];
                for (let j = 0; j < node.members.length; j++) {
                    let member = node.members[j];
                    if (member.type == "operation") {
                        for (let k = member.arguments.length - 1; k >= 0; k--) {
                            if (member.arguments[k].optional) {
                                let copy = JSON.parse(JSON.stringify(member));
                                copy.arguments.splice(k, member.arguments.length - k);
                                toAdd.push(copy);
                            }
                        }
                    }
                }
                node.members.push(...toAdd);
            }
        }
        for (let i = 0; i < this.ast.length; i++) {
            this.walkRootType(this.ast[i]);
        }
        if (this.mode == BinderMode.WEBIDL_LUA) {
            for (let i = 0; i < this.ast.length; i++) {
                if (this.ast[i].type == "interface") {
                    let int = this.ast[i];
                    if (int.inheritance) {
                        this.luaC.writeLn(this.outBufLua, `getmetatable(__BINDINGS__.${int.name}).__index = __BINDINGS__.${int.inheritance};`);
                    }
                    else {
                        let JsImpl = this.getExtendedAttribute("JSImplementation", int.extAttrs) || this.getExtendedAttribute("LuaImplementation", int.extAttrs);
                        if (JsImpl) {
                            let jsImplExtends = this.unquote(JsImpl.rhs.value);
                            if (jsImplExtends !== "") {
                                this.luaC.writeLn(this.outBufLua, `getmetatable(__BINDINGS__.${int.name}).__index = __BINDINGS__.${jsImplExtends};`);
                            }
                        }
                    }
                }
            }
        }
        if (this.mode == BinderMode.WEBIDL_CPP) {
            for (let arrTypeNameKey in this.arrayTypes) {
                let arrType = this.arrayTypes[arrTypeNameKey];
                let arrTypeName = WebIDLBinder.CTypeRenames[arrType.idlType] || arrType.idlType;
                let arrTypeNameAdj = arrTypeName;
                if (this.classLookup[arrTypeName]) {
                    arrTypeNameAdj += "*";
                }
                this.cppC.write(this.outBufCPP, `export extern "C" ${arrTypeNameAdj} ${this.mangleArrayIndexerName("get", arrTypeNameKey)}(_LuaArray<${arrTypeName}>* arr,size_t index) {`);
                this.cppC.write(this.outBufCPP, `return `);
                if (this.classLookup[arrTypeName]) {
                    this.cppC.write(this.outBufCPP, `&`);
                }
                this.cppC.write(this.outBufCPP, `arr->array[index];`);
                this.cppC.writeLn(this.outBufCPP, `};`);
                this.cppC.write(this.outBufCPP, `export extern "C" void ${this.mangleArrayIndexerName("set", arrTypeNameKey)}(_LuaArray<${arrTypeName}>* arr,size_t index,${arrTypeNameAdj} val) {`);
                this.cppC.write(this.outBufCPP, `arr->array[index] = `);
                if (this.classLookup[arrTypeName]) {
                    this.cppC.write(this.outBufCPP, `*`);
                }
                this.cppC.write(this.outBufCPP, `val;`);
                this.cppC.writeLn(this.outBufCPP, `};`);
                this.cppC.write(this.outBufCPP, `export extern "C" _LuaArray<${arrTypeName}>* ${this.mangleArrayIndexerName("new", arrTypeNameKey)}(size_t len) {`);
                this.cppC.write(this.outBufCPP, `return new _LuaArray<${arrTypeName}>(len);`);
                this.cppC.writeLn(this.outBufCPP, `};`);
                this.cppC.write(this.outBufCPP, `export extern "C" void ${this.mangleArrayIndexerName("delete", arrTypeNameKey)}(_LuaArray<${arrTypeName}>* arr) {`);
                this.cppC.write(this.outBufCPP, `delete arr;`);
                this.cppC.writeLn(this.outBufCPP, `};`);
                this.cppC.write(this.outBufCPP, `export extern "C" size_t ${this.mangleArrayIndexerName("len", arrTypeNameKey)}(_LuaArray<${arrTypeName}>* arr) {`);
                this.cppC.write(this.outBufCPP, `return arr->len;`);
                this.cppC.writeLn(this.outBufCPP, `};`);
            }
            for (let arrTypeNameKey in this.ptrArrayTypes) {
                let arrType = this.ptrArrayTypes[arrTypeNameKey];
                let arrTypeName = arrType.idlType;
                this.cppC.write(this.outBufCPP, `export extern "C" ${arrTypeName}* ${this.mangleArrayIndexerName("get", arrTypeNameKey)}(_LuaArray<${arrTypeName}*>* arr,size_t index) {`);
                this.cppC.write(this.outBufCPP, `return arr->array[index];`);
                this.cppC.writeLn(this.outBufCPP, `};`);
                this.cppC.write(this.outBufCPP, `export extern "C" void ${this.mangleArrayIndexerName("set", arrTypeNameKey)}(_LuaArray<${arrTypeName}*>* arr,size_t index,${arrTypeName}* val) {`);
                this.cppC.write(this.outBufCPP, `arr->array[index] = `);
                this.cppC.write(this.outBufCPP, `val;`);
                this.cppC.writeLn(this.outBufCPP, `};`);
                this.cppC.write(this.outBufCPP, `export extern "C" _LuaArray<${arrTypeName}*>* ${this.mangleArrayIndexerName("new", arrTypeNameKey)}(size_t len) {`);
                this.cppC.write(this.outBufCPP, `return new _LuaArray<${arrTypeName}*>(len);`);
                this.cppC.writeLn(this.outBufCPP, `};`);
                this.cppC.write(this.outBufCPP, `export extern "C" void ${this.mangleArrayIndexerName("delete", arrTypeNameKey)}(_LuaArray<${arrTypeName}*>* arr) {`);
                this.cppC.write(this.outBufCPP, `delete arr;`);
                this.cppC.writeLn(this.outBufCPP, `};`);
                this.cppC.write(this.outBufCPP, `export extern "C" size_t ${this.mangleArrayIndexerName("len", arrTypeNameKey)}(_LuaArray<${arrTypeName}*>* arr) {`);
                this.cppC.write(this.outBufCPP, `return arr->len;`);
                this.cppC.writeLn(this.outBufCPP, `};`);
            }
            this.cppC.writeLn(this.outBufCPP, `#undef __CFUNC`);
            this.cppC.writeLn(this.outBufCPP, `#undef export`);
        }
        else if (this.mode == BinderMode.WEBIDL_LUA) {
            for (let arrTypeNameKey in this.arrayTypes) {
                this.luaC.write(this.outBufLua, `__BINDER__.arrays.${this.rawMangle(arrTypeNameKey)} = {`);
                if (this.specialTypes[arrTypeNameKey]) {
                    if (arrTypeNameKey == "DOMString") {
                        this.luaC.write(this.outBufLua, `get = function(ptr,idx)`);
                        this.luaC.write(this.outBufLua, `local val = ${this.symbolResolver(this.mangleArrayIndexerName("get", arrTypeNameKey))}(ptr,idx)`);
                        this.luaC.write(this.outBufLua, `return __BINDER__.readString(val) end,`);
                        this.luaC.write(this.outBufLua, `set = function(ptr,idx,val)`);
                        this.luaC.write(this.outBufLua, `val = __BINDER__.stringify(val)`);
                        this.luaC.write(this.outBufLua, `${this.symbolResolver(this.mangleArrayIndexerName("set", arrTypeNameKey))}(ptr,idx,val)`);
                        this.luaC.write(this.outBufLua, `end,`);
                        this.luaC.write(this.outBufLua, `delete = function(ptr,len)`);
                        this.luaC.write(this.outBufLua, `for i=1,len or 0 do __BINDER__.freeString(${this.symbolResolver(this.mangleArrayIndexerName("get", arrTypeNameKey))}(ptr)) end `);
                        this.luaC.write(this.outBufLua, `${this.symbolResolver(this.mangleArrayIndexerName("delete", arrTypeNameKey))}(ptr)`);
                        this.luaC.write(this.outBufLua, `end,`);
                    }
                    else if (arrTypeNameKey == "boolean") {
                        this.luaC.write(this.outBufLua, `get = function(ptr,idx)`);
                        this.luaC.write(this.outBufLua, `local val = ${this.symbolResolver(this.mangleArrayIndexerName("get", arrTypeNameKey))}(ptr,idx)`);
                        this.luaC.write(this.outBufLua, `return val ~= 0 end,`);
                        this.luaC.write(this.outBufLua, `set = function(ptr,idx,val)`);
                        this.luaC.write(this.outBufLua, `val = val and 1 or 0`);
                        this.luaC.write(this.outBufLua, `${this.symbolResolver(this.mangleArrayIndexerName("set", arrTypeNameKey))}(ptr,idx,val)`);
                        this.luaC.write(this.outBufLua, `end,`);
                        this.luaC.write(this.outBufLua, `delete = ${this.symbolResolver(this.mangleArrayIndexerName("delete", arrTypeNameKey))},`);
                    }
                }
                else {
                    this.luaC.write(this.outBufLua, `get = ${this.symbolResolver(this.mangleArrayIndexerName("get", arrTypeNameKey))},`);
                    this.luaC.write(this.outBufLua, `set = ${this.symbolResolver(this.mangleArrayIndexerName("set", arrTypeNameKey))},`);
                    this.luaC.write(this.outBufLua, `delete = ${this.symbolResolver(this.mangleArrayIndexerName("delete", arrTypeNameKey))},`);
                }
                this.luaC.write(this.outBufLua, `new = ${this.symbolResolver(this.mangleArrayIndexerName("new", arrTypeNameKey))},`);
                this.luaC.write(this.outBufLua, `len = ${this.symbolResolver(this.mangleArrayIndexerName("len", arrTypeNameKey))},`);
                this.luaC.write(this.outBufLua, `isClass = ${this.classLookup[arrTypeNameKey] ? "true" : "false"},`);
                this.luaC.writeLn(this.outBufLua, `}`);
            }
            for (let arrTypeNameKey in this.ptrArrayTypes) {
                this.luaC.write(this.outBufLua, `__BINDER__.ptrArrays.${this.rawMangle(arrTypeNameKey)} = {`);
                this.luaC.write(this.outBufLua, `get = ${this.symbolResolver(this.mangleArrayIndexerName("get", arrTypeNameKey))},`);
                this.luaC.write(this.outBufLua, `set = ${this.symbolResolver(this.mangleArrayIndexerName("set", arrTypeNameKey))},`);
                this.luaC.write(this.outBufLua, `new = ${this.symbolResolver(this.mangleArrayIndexerName("new", arrTypeNameKey))},`);
                this.luaC.write(this.outBufLua, `delete = ${this.symbolResolver(this.mangleArrayIndexerName("delete", arrTypeNameKey))},`);
                this.luaC.write(this.outBufLua, `len = ${this.symbolResolver(this.mangleArrayIndexerName("len", arrTypeNameKey))},`);
                this.luaC.write(this.outBufLua, `isClass = ${this.classLookup[arrTypeNameKey] ? "true" : "false"},`);
                this.luaC.writeLn(this.outBufLua, `}`);
            }
        }
        if (this.addYieldStub) {
            if (this.mode == BinderMode.WEBIDL_LUA) {
                this.luaC.writeLn(this.outBufLua, "__IMPORTS__.webidl_internal = {main_yield = coroutine.yield}");
                this.luaC.writeLn(this.outBufLua, "module.init = coroutine.wrap(module.init)");
            }
            else if (this.mode == BinderMode.WEBIDL_CPP) {
                this.cppC.writeLn(this.outBufCPP, `extern "C" void _webidl_main_yield() __attribute__((__import_module__("_webidl_main_yield"), __import_name__("main_yield")));`);
                this.cppC.writeLn(this.outBufCPP, `int main() {_webidl_main_yield(); return 0;}`);
            }
        }
    }
    writeCArgs(buf, args, needsType, needsStartingComma, refToPtr, maskRef = true) {
        if (needsStartingComma) {
            if (args.length > 0) {
                this.cppC.write(buf, ",");
            }
        }
        for (let j = 0; j < args.length; j++) {
            let overrideVName = false;
            let skipArg = false;
            if (needsType) {
                let lenAttr = this.getExtendedAttribute("ArrayLength", args[j].extAttrs) || this.getExtendedAttribute("ArrayLengthRef", args[j].extAttrs);
                if (lenAttr) {
                    skipArg = true;
                }
                else {
                    this.cppC.write(buf, `${this.idlTypeToCType(args[j].idlType, args[j].extAttrs, maskRef)} `);
                }
            }
            else {
                let arrAttr = this.getExtendedAttribute("Array", args[j].extAttrs);
                if (arrAttr) {
                    overrideVName = true;
                    this.cppC.write(buf, `${args[j].name}->array`);
                }
                else {
                    let lenAttr = this.getExtendedAttribute("ArrayLength", args[j].extAttrs);
                    if (lenAttr) {
                        overrideVName = true;
                        let arrVarName = this.unquote(lenAttr.rhs.value);
                        if (arrVarName == "") {
                            throw new SemanticError("ArrayLength attribute needs parameter 'Array name'");
                        }
                        this.cppC.write(buf, `${arrVarName}->len`);
                    }
                    else {
                        let lenAttr = this.getExtendedAttribute("ArrayLengthRef", args[j].extAttrs);
                        if (lenAttr) {
                            overrideVName = true;
                            let arrVarName = this.unquote(lenAttr.rhs.value);
                            if (arrVarName == "") {
                                throw new SemanticError("ArrayLengthRef attribute needs parameter 'Array name'");
                            }
                            this.cppC.write(buf, `&${arrVarName}->len`);
                        }
                    }
                }
            }
            if (!skipArg) {
                if (!overrideVName) {
                    this.cppC.write(buf, `${refToPtr ? this.getWithRefs(args[j], !maskRef) : args[j].name}`);
                }
                if ((j + 1) !== args.length) {
                    this.cppC.write(buf, ",");
                }
            }
        }
    }
    writeLuaArgs(buf, args, needsStartingComma, typeConversionMode) {
        if (needsStartingComma) {
            if (args.length > 0) {
                this.luaC.write(buf, ",");
            }
        }
        for (let j = 0; j < args.length; j++) {
            let skipWrite = false;
            if (this.getExtendedAttribute("ArrayLengthRef", args[j].extAttrs)) {
                skipWrite = true;
            }
            else if (this.getExtendedAttribute("ArrayLength", args[j].extAttrs)) {
                skipWrite = true;
            }
            else {
                if (typeConversionMode == ETypeConversion.LUA_TO_CPP) {
                    this.convertLuaToCPP_Arg(buf, args[j], j);
                }
                else if (typeConversionMode == ETypeConversion.CPP_TO_LUA) {
                    this.convertCPPToLua_Arg(buf, args[j], j);
                }
                else {
                    this.luaC.write(buf, `${args[j].name}`);
                }
            }
            if (!skipWrite) {
                this.luaC.write(buf, ",");
            }
        }
        if (buf[buf.length - 1] == ",") {
            buf.pop();
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
    convertLuaToCPP_Pre(buf, arg, argID) {
        if (this.getExtendedAttribute("ArrayLengthRef", arg.extAttrs)) {
            return;
        }
        else if (this.getExtendedAttribute("ArrayLength", arg.extAttrs)) {
            return;
        }
        if (this.getExtendedAttribute("Array", arg.extAttrs)) {
            let arrAttr = this.getExtendedAttribute("Array", arg.extAttrs);
            this.luaC.write(buf, `assert(type(${arg.name}) == "table","Parameter ${arg.name} (${argID + 1}) must be a table")`);
            this.luaC.write(buf, `local __arg${argID} =`);
            this.luaC.write(buf, `__BINDER__.luaToWasmArrayInternal(__BINDER__.arrays.${this.rawMangle(this.idlTypeToCTypeLite(arg.idlType, arg.extAttrs))},${arg.name}`);
            if (arrAttr && arrAttr.rhs) {
                let arrLen = this.unquote(arrAttr.rhs.value);
                if (!parseInt(arrLen) || isNaN(parseInt(arrLen))) {
                    throw new SemanticError("Attribute 'Array' must have a numeric value (denoting max array length)");
                }
                this.luaC.write(buf, `,${arrLen}`);
            }
            this.luaC.write(buf, `)`);
            return;
        }
        else if (this.getExtendedAttribute("PointerArray", arg.extAttrs)) {
            let ptrArrAttr = this.getExtendedAttribute("PointerArray", arg.extAttrs);
            this.luaC.write(buf, `assert(type(${arg.name}) == "table","Parameter ${arg.name} (${argID + 1}) must be a table")`);
            this.luaC.write(buf, `local __arg${argID} =`);
            this.luaC.write(buf, `__BINDER__.luaToWasmArrayInternal(__BINDER__.ptrArrays.${this.rawMangle(this.idlTypeToCTypeLite(arg.idlType, arg.extAttrs))},${arg.name}`);
            if (ptrArrAttr && ptrArrAttr.rhs) {
                let arrLen = this.unquote(ptrArrAttr.rhs.value);
                if (!parseInt(arrLen) || isNaN(parseInt(arrLen))) {
                    throw new SemanticError("Attribute 'PointerArray' must have a numeric value (denoting max array length)");
                }
                this.luaC.write(buf, `,${arrLen}`);
            }
            this.luaC.write(buf, `)`);
            return;
        }
        if (arg.idlType.idlType == "DOMString") {
            this.luaC.write(buf, `assert(type(${arg.name}) == "string","Parameter ${arg.name} (${argID + 1}) must be a string")`);
            this.luaC.write(buf, `local __arg${argID} = __BINDER__.stringify(${arg.name})`);
        }
        else if (arg.idlType.idlType == "boolean") {
            this.luaC.write(buf, `assert(type(${arg.name}) == "boolean","Parameter ${arg.name} (${argID + 1}) must be a boolean")`);
        }
        else if (this.classLookup[arg.idlType.idlType]) {
            this.luaC.write(buf, `assert((type(${arg.name}) == "table") and __BINDER__.isClassInstance(${arg.name},__BINDINGS__.${arg.idlType.idlType}),"Parameter ${arg.name} (${argID + 1}) must be an instance of ${arg.idlType.idlType}")`);
            if (this.hasExtendedAttribute("WASMOwned", arg.extAttrs)) {
                this.luaC.write(buf, `${arg.name}.__luaOwned = false `);
            }
        }
        else {
            this.luaC.write(buf, `assert(type(${arg.name}) == "number","Parameter ${arg.name} (${argID + 1}) must be a number")`);
        }
    }
    convertLuaToCPP_Arg(buf, arg, argID) {
        let arrAttr = this.getExtendedAttribute("Array", arg.extAttrs) || this.getExtendedAttribute("PointerArray", arg.extAttrs);
        if (arrAttr) {
            this.luaC.write(buf, `__arg${argID}`);
            return;
        }
        if (arg.idlType.idlType == "DOMString") {
            this.luaC.write(buf, `__arg${argID}`);
        }
        else {
            this.luaC.write(buf, `${arg.name}`);
        }
        if (this.classLookup[arg.idlType.idlType]) {
            this.luaC.write(buf, ".__ptr");
        }
        else if (arg.idlType.idlType == "boolean") {
            this.luaC.write(buf, " and 1 or 0");
        }
    }
    convertLuaToCPP_Post(buf, arg, argID) {
        if (!this.getExtendedAttribute("ConvertInputArray", arg.extAttrs)) {
            if (this.getExtendedAttribute("Array", arg.extAttrs)) {
                this.luaC.write(buf, `__BINDER__.arrays.${this.rawMangle(this.idlTypeToCTypeLite(arg.idlType, arg.extAttrs))}.delete(__arg${argID},#${arg.name})`);
                return;
            }
            else if (this.getExtendedAttribute("PointerArray", arg.extAttrs)) {
                this.luaC.write(buf, `__BINDER__.ptrArrays.${this.rawMangle(this.idlTypeToCTypeLite(arg.idlType, arg.extAttrs))}.delete(__arg${argID})`);
                return;
            }
        }
        else {
            let luaOwned = this.hasExtendedAttribute("LuaOwned", arg.extAttrs);
            if (this.getExtendedAttribute("Array", arg.extAttrs)) {
                this.luaC.write(buf, `__BINDER__.wasmToWrappedLuaArrayConvertInternal(${arg.name},__BINDER__.arrays.${this.rawMangle(this.idlTypeToCTypeLite(arg.idlType, arg.extAttrs))},__arg${argID},${luaOwned})`);
                return;
            }
            else if (this.getExtendedAttribute("PointerArray", arg.extAttrs)) {
                this.luaC.write(buf, `__BINDER__.wasmToWrappedLuaArrayConvertInternal(${arg.name},__BINDER__.ptrArrays.${this.rawMangle(this.idlTypeToCTypeLite(arg.idlType, arg.extAttrs))},__arg${argID},${luaOwned})`);
                return;
            }
        }
        if (arg.idlType.idlType == "DOMString") {
            this.luaC.write(buf, `__BINDER__.freeString(__arg${argID})`);
        }
    }
    convertCPPToLuaReturn(buf, argType, extAttrs, argName) {
        if (this.getExtendedAttribute("Array", extAttrs)) {
            let luaOwned = this.hasExtendedAttribute("LuaOwned", extAttrs);
            this.luaC.write(buf, `return __BINDER__.wasmToWrappedLuaArrayInternal(__BINDER__.arrays.${this.rawMangle(this.idlTypeToCTypeLite(argType, extAttrs))},${argName},${luaOwned})`);
            return;
        }
        else if (this.getExtendedAttribute("PointerArray", extAttrs)) {
            let luaOwned = this.hasExtendedAttribute("LuaOwned", extAttrs);
            this.luaC.write(buf, `return __BINDER__.wasmToWrappedLuaArrayInternal(__BINDER__.ptrArrays.${this.rawMangle(this.idlTypeToCTypeLite(argType, extAttrs))},${argName},${luaOwned})`);
            return;
        }
        if (this.classLookup[argType.idlType]) {
            let luaOwned = this.hasExtendedAttribute("LuaOwned", extAttrs);
            this.luaC.write(buf, `local __obj = __BINDINGS__.${argType.idlType}.__cache[${argName}] `);
            this.luaC.write(buf, `if not __obj then __obj = setmetatable({__ptr = ${argName},__luaOwned = ${luaOwned}},__BINDINGS__.${argType.idlType}) __BINDINGS__.${argType.idlType}.__cache[${argName}] = __obj end `);
            this.luaC.write(buf, "return __obj");
        }
        else if (argType.idlType == "DOMString") {
            this.luaC.write(buf, `return __BINDER__.readString(${argName})`);
        }
        else if (argType.idlType == "boolean") {
            this.luaC.write(buf, `return ${argName} ~= 0`);
        }
        else {
            this.luaC.write(buf, `return ${argName}`);
        }
    }
    convertLuaToCPPReturn(buf, argType, extAttrs, argName) {
        if (this.getExtendedAttribute("ArrayLengthRef", extAttrs)) {
            return;
        }
        else if (this.getExtendedAttribute("ArrayLength", extAttrs)) {
            return;
        }
        if (this.getExtendedAttribute("Array", extAttrs)) {
            this.luaC.write(buf, `assert(type(${argName}) == "table","Return value ${argName} must be a table")`);
        }
        else if (this.getExtendedAttribute("PointerArray", extAttrs)) {
            this.luaC.write(buf, `assert(type(${argName}) == "table","Return value ${argName} must be a table")`);
        }
        else if (argType.idlType == "DOMString") {
            this.luaC.write(buf, `assert(type(${argName}) == "string","Return value ${argName} must be a string")`);
        }
        else if (argType.idlType == "boolean") {
            this.luaC.write(buf, `assert(type(${argName}) == "boolean","Return value ${argName} must be a boolean")`);
        }
        else if (this.classLookup[argType.idlType]) {
            this.luaC.write(buf, `assert((type(${argName}) == "table") and __BINDER__.isClassInstance(${argName},__BINDINGS__.${argType.idlType}),"Return ${argName} must be an instance of ${argType.idlType}")`);
        }
        else {
            this.luaC.write(buf, `assert(type(${argName}) == "number","Return value ${argName} must be a number")`);
        }
        this.luaC.write(buf, `return `);
        if (this.getExtendedAttribute("Array", extAttrs)) {
            let arrAttr = this.getExtendedAttribute("Array", extAttrs);
            this.luaC.write(buf, `__BINDER__.luaToWasmArrayInternal(__BINDER__.arrays.${this.rawMangle(this.idlTypeToCTypeLite(argType, extAttrs))},${argName}`);
            if (arrAttr && arrAttr.rhs) {
                let arrLen = this.unquote(arrAttr.rhs.value);
                if (!parseInt(arrLen) || isNaN(parseInt(arrLen))) {
                    throw new SemanticError("Attribute 'Array' must have a numeric value (denoting max array length)");
                }
                this.luaC.write(buf, `,${arrLen}`);
            }
            return;
        }
        else if (this.getExtendedAttribute("PointerArray", extAttrs)) {
            let ptrArrAttr = this.getExtendedAttribute("PointerArray", extAttrs);
            this.luaC.write(buf, `__BINDER__.luaToWasmArrayInternal(__BINDER__.ptrArrays.${this.rawMangle(this.idlTypeToCTypeLite(argType, extAttrs))},${argName}`);
            if (ptrArrAttr && ptrArrAttr.rhs) {
                let arrLen = this.unquote(ptrArrAttr.rhs.value);
                if (!parseInt(arrLen) || isNaN(parseInt(arrLen))) {
                    throw new SemanticError("Attribute 'PointerArray' must have a numeric value (denoting max array length)");
                }
                this.luaC.write(buf, `,${arrLen}`);
            }
            this.luaC.write(buf, `)`);
            return;
        }
        if (argType.idlType == "DOMString") {
            this.luaC.write(buf, `__BINDER__.stringify(${argName})`);
        }
        else {
            this.luaC.write(buf, `${argName}`);
            if (this.classLookup[argType.idlType]) {
                this.luaC.write(buf, ".__ptr");
            }
            else if (argType.idlType == "boolean") {
                this.luaC.write(buf, " and 1 or 0");
            }
        }
    }
    convertCPPToLua_Pre(buf, arg, argID) {
        if (this.getExtendedAttribute("Array", arg.extAttrs)) {
            return;
        }
        else if (this.getExtendedAttribute("PointerArray", arg.extAttrs)) {
            return;
        }
        if (this.classLookup[arg.idlType.idlType]) {
            let wasmOwned = this.hasExtendedAttribute("WASMOwned", arg.extAttrs);
            this.luaC.write(buf, `local __arg${argID} = __BINDINGS__.${arg.idlType.idlType}.__cache[arg.name] `);
            this.luaC.write(buf, `if not __arg${argID} then __arg${argID} = setmetatable({__ptr = __arg${argID},__luaOwned = ${!wasmOwned}},__BINDINGS__.${arg.idlType.idlType}) __BINDINGS__.${arg.idlType.idlType}.__cache[${arg.name}] = __arg${argID} end `);
            if (wasmOwned) {
                this.luaC.write(buf, `__arg${argID}.__luaOwned = false `);
            }
        }
        else if (arg.idlType.idlType == "DOMString") {
            this.luaC.write(buf, `local __arg${argID} = __BINDER__.readString(${arg.name}) `);
        }
    }
    convertCPPToLua_Arg(buf, arg, argID) {
        if (this.getExtendedAttribute("Array", arg.extAttrs)) {
            let wasmOwned = this.hasExtendedAttribute("WASMOwned", arg.extAttrs);
            this.luaC.write(buf, `__BINDER__.wasmToWrappedLuaArrayInternal(__BINDER__.arrays.${this.rawMangle(this.idlTypeToCTypeLite(arg.idlType, arg.extAttrs))},${arg.name},${!wasmOwned})`);
            return;
        }
        else if (this.getExtendedAttribute("PointerArray", arg.extAttrs)) {
            let wasmOwned = this.hasExtendedAttribute("WASMOwned", arg.extAttrs);
            this.luaC.write(buf, `__BINDER__.wasmToWrappedLuaArrayInternal(__BINDER__.ptrArrays.${this.rawMangle(this.idlTypeToCTypeLite(arg.idlType, arg.extAttrs))},${arg.name},${!wasmOwned})`);
            return;
        }
        if (this.classLookup[arg.idlType.idlType]) {
            this.luaC.write(buf, `__arg${argID}`);
        }
        else if (arg.idlType.idlType == "DOMString") {
            this.luaC.write(buf, `__arg${argID}`);
        }
        else if (arg.idlType.idlType == "boolean") {
            this.luaC.write(buf, `${arg.name} ~= 0`);
        }
        else {
            this.luaC.write(buf, `${arg.name}`);
        }
    }
    convertCPPToLua_Post(buf, arg, argID) {
        if (this.getExtendedAttribute("Array", arg.extAttrs)) {
            return;
        }
        else if (this.getExtendedAttribute("PointerArray", arg.extAttrs)) {
            return;
        }
    }
    startWrappedCReturnValue(buf, idlType, extAttrs) {
        if (this.hasExtendedAttribute("Array", extAttrs)) {
            let arrType = this.getExtendedAttribute("Array", extAttrs);
            if (arrType.rhs) {
                this.cppC.write(buf, `new _LuaArray<${idlType.idlType}>(${this.unquote(arrType.rhs.value)},`);
            }
            else {
                this.cppC.write(buf, `new _LuaArray<${idlType.idlType}>(`);
            }
        }
        else if (this.hasExtendedAttribute("PointerArray", extAttrs)) {
            let arrType = this.getExtendedAttribute("PointerArray", extAttrs);
            if (arrType.rhs) {
                this.cppC.write(buf, `new _LuaArray<${idlType.idlType}*>(${this.unquote(arrType.rhs.value)},`);
            }
            else {
                this.cppC.write(buf, `new _LuaArray<${idlType.idlType}*>(`);
            }
        }
    }
    endWrappedCReturnValue(buf, idlType, extAttrs) {
        if (this.hasExtendedAttribute("Array", extAttrs) || this.hasExtendedAttribute("PointerArray", extAttrs)) {
            this.cppC.write(buf, `)`);
        }
    }
    startWrappedCValue(buf, idlType, extAttrs) {
    }
    endWrappedCValue(buf, idlType, extAttrs) {
        if (this.hasExtendedAttribute("Array", extAttrs) || this.hasExtendedAttribute("PointerArray", extAttrs)) {
            this.cppC.write(buf, `->array`);
        }
    }
    walkInterfaceLua(node) {
        let JsImpl = this.getExtendedAttribute("JSImplementation", node.extAttrs) || this.getExtendedAttribute("LuaImplementation", node.extAttrs);
        let hasConstructor = false;
        this.luaC.writeLn(this.outBufLua, `__BINDINGS__.${node.name} = {} __BINDER__.createClass(__BINDINGS__.${node.name},"${node.name}")`);
        let funcSig = {};
        for (let i = 0; i < node.members.length; i++) {
            let member = node.members[i];
            if (member.type == "operation") {
                funcSig[member.name] = funcSig[member.name] || [];
                for (let otherSig of funcSig[member.name]) {
                    if (otherSig == member.arguments.length) {
                        throw new SemanticError(`Function ${node.name}::${member.name} has incompatible overloaded signatures`);
                    }
                }
                funcSig[member.name].push(member.arguments.length);
            }
        }
        this.luaC.write(this.outBufLua, `setmetatable(__BINDINGS__.${node.name},{__call = function(self`);
        if (funcSig[node.name]) {
            if (funcSig[node.name].length > 1) {
                this.luaC.write(this.outBufLua, `,`);
                let maxArg = Math.max(...funcSig[node.name]);
                for (let i = 0; i < maxArg; i++) {
                    this.luaC.write(this.outBufLua, `arg${i}`);
                    if ((i + 1) !== maxArg) {
                        this.luaC.write(this.outBufLua, ",");
                    }
                }
            }
            else {
                let maxArg = Math.max(...funcSig[node.name]);
                if (maxArg > 0) {
                    this.luaC.write(this.outBufLua, `,`);
                    for (let i = 0; i < maxArg; i++) {
                        this.luaC.write(this.outBufLua, `arg${i}`);
                        if ((i + 1) !== maxArg) {
                            this.luaC.write(this.outBufLua, ",");
                        }
                    }
                }
            }
        }
        this.luaC.write(this.outBufLua, `)`);
        this.luaC.write(this.outBufLua, `local ins = setmetatable({__ptr = 0,__luaOwned = true},self)`);
        this.luaC.write(this.outBufLua, `ins:${node.name}(`);
        if (funcSig[node.name]) {
            if (funcSig[node.name].length > 1) {
                let maxArg = Math.max(...funcSig[node.name]);
                for (let i = 0; i < maxArg; i++) {
                    this.luaC.write(this.outBufLua, `arg${i}`);
                    if ((i + 1) !== maxArg) {
                        this.luaC.write(this.outBufLua, ",");
                    }
                }
            }
            else {
                let maxArg = Math.max(...funcSig[node.name]);
                if (maxArg > 0) {
                    for (let i = 0; i < maxArg; i++) {
                        this.luaC.write(this.outBufLua, `arg${i}`);
                        if ((i + 1) !== maxArg) {
                            this.luaC.write(this.outBufLua, ",");
                        }
                    }
                }
            }
        }
        this.luaC.write(this.outBufLua, `)`);
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
                this.luaC.write(this.outBufLua, `function __BINDINGS__.${node.name}:${member.name}`);
                if (funcSig[member.name].length > 1) {
                    this.luaC.write(this.outBufLua, `__internal${member.arguments.length}`);
                }
                this.luaC.write(this.outBufLua, `(`);
                this.writeLuaArgs(this.outBufLua, member.arguments, false, ETypeConversion.NONE);
                this.luaC.write(this.outBufLua, `)`);
                if (!JsImpl || (node.name == member.name)) {
                    for (let j = 0; j < member.arguments.length; j++) {
                        this.convertLuaToCPP_Pre(this.outBufLua, member.arguments[j], j);
                    }
                    if (member.name == node.name) {
                        this.luaC.write(this.outBufLua, `self.__ptr = `);
                        this.luaC.write(this.outBufLua, `${this.symbolResolver(this.mangleFunctionName(member, node.name))}(`);
                    }
                    else {
                        this.luaC.write(this.outBufLua, `local ret = `);
                        this.luaC.write(this.outBufLua, `${this.symbolResolver(this.mangleFunctionName(member, node.name))}(self.__ptr`);
                        if (member.arguments.length > 0) {
                            this.luaC.write(this.outBufLua, ",");
                        }
                    }
                    this.writeLuaArgs(this.outBufLua, member.arguments, false, ETypeConversion.LUA_TO_CPP);
                    this.luaC.write(this.outBufLua, ");");
                    if (member.name == node.name) {
                        this.luaC.write(this.outBufLua, `__BINDINGS__.${node.name}.__cache[self.__ptr] = self;`);
                    }
                    for (let j = 0; j < member.arguments.length; j++) {
                        this.convertLuaToCPP_Post(this.outBufLua, member.arguments[j], j);
                    }
                    if (member.name !== node.name) {
                        this.convertCPPToLuaReturn(this.outBufLua, member.idlType, member.extAttrs, "ret");
                    }
                }
                else {
                    this.luaC.write(this.outBufLua, `error("Unimplemented -> ${node.name}::${member.name}()")`);
                }
                this.luaC.write(this.outBufLua, " end");
                this.luaC.newLine(this.outBufLua);
                if (JsImpl && (member.name !== node.name)) {
                    this.luaC.write(this.outBufLua, `function __CFUNCS__.${this.mangleFunctionName(member, node.name, true)}(selfPtr`);
                    this.writeLuaArgs(this.outBufLua, member.arguments, true, ETypeConversion.NONE);
                    this.luaC.write(this.outBufLua, `)`);
                    for (let j = 0; j < member.arguments.length; j++) {
                        this.convertLuaToCPP_Pre(this.outBufLua, member.arguments[j], j);
                    }
                    this.luaC.write(this.outBufLua, `local self = __BINDINGS__.${node.name}.__cache[selfPtr] local ret = self.${member.name}(self`);
                    this.writeLuaArgs(this.outBufLua, member.arguments, true, ETypeConversion.CPP_TO_LUA);
                    this.luaC.write(this.outBufLua, `)`);
                    for (let j = 0; j < member.arguments.length; j++) {
                        this.convertLuaToCPP_Post(this.outBufLua, member.arguments[j], j);
                    }
                    this.convertLuaToCPPReturn(this.outBufLua, member.idlType, member.extAttrs, "ret");
                    this.luaC.write(this.outBufLua, " end");
                    this.luaC.newLine(this.outBufLua);
                }
            }
            else if (member.type == "attribute") {
                this.luaC.write(this.outBufLua, `function __BINDINGS__.${node.name}.__specialIndex.${member.name}(self,k) `);
                this.luaC.write(this.outBufLua, `local ret = ${this.symbolResolver(this.mangleIndexerName(member, node.name, false))}(self.__ptr)`);
                this.convertCPPToLuaReturn(this.outBufLua, member.idlType, member.extAttrs, "ret");
                this.luaC.writeLn(this.outBufLua, ` end`);
                this.luaC.write(this.outBufLua, `function __BINDINGS__.${node.name}.__specialNewIndex.${member.name}(self,k,v) `);
                this.convertLuaToCPP_Pre(this.outBufLua, { name: "v", idlType: member.idlType, extAttrs: member.extAttrs }, 0);
                this.luaC.write(this.outBufLua, `${this.symbolResolver(this.mangleIndexerName(member, node.name, true))}(self.__ptr,`);
                this.convertLuaToCPP_Arg(this.outBufLua, { name: "v", idlType: member.idlType, extAttrs: member.extAttrs }, 0);
                this.luaC.write(this.outBufLua, `)`);
                this.convertLuaToCPP_Post(this.outBufLua, { name: "v", idlType: member.idlType, extAttrs: member.extAttrs }, 0);
                this.luaC.writeLn(this.outBufLua, ` end`);
            }
        }
        for (let ident in funcSig) {
            let memberData = funcSig[ident];
            if (memberData.length > 1) {
                this.luaC.write(this.outBufLua, `function __BINDINGS__.${node.name}:${ident}(`);
                let maxArg = Math.max(...memberData);
                for (let i = 0; i < maxArg; i++) {
                    this.luaC.write(this.outBufLua, `arg${i}`);
                    if ((i + 1) !== maxArg) {
                        this.luaC.write(this.outBufLua, ",");
                    }
                }
                this.luaC.write(this.outBufLua, ") ");
                memberData.sort().reverse();
                this.luaC.write(this.outBufLua, "if ");
                for (let i = 0; i < memberData.length; i++) {
                    if (memberData[i] != 0) {
                        this.luaC.write(this.outBufLua, `arg${memberData[i] - 1} ~= nil then `);
                    }
                    this.luaC.write(this.outBufLua, `return self:${ident}__internal${memberData[i]}(`);
                    for (let j = 0; j < memberData[i]; j++) {
                        this.luaC.write(this.outBufLua, `arg${j}`);
                        if ((j + 1) !== memberData[i]) {
                            this.luaC.write(this.outBufLua, ",");
                        }
                    }
                    this.luaC.write(this.outBufLua, ") ");
                    if ((i + 1) !== memberData.length) {
                        if (memberData[i + 1] != 0) {
                            this.luaC.write(this.outBufLua, "elseif ");
                        }
                        else {
                            this.luaC.write(this.outBufLua, "else ");
                        }
                    }
                }
                this.luaC.writeLn(this.outBufLua, "end end");
            }
        }
        this.luaC.write(this.outBufLua, `function __BINDINGS__.${node.name}:_delete()`);
        this.luaC.write(this.outBufLua, `return ${this.symbolResolver(this.mangleFunctionName("_delete", node.name))}(self.__ptr)`);
        this.luaC.writeLn(this.outBufLua, `end`);
        if (!hasConstructor) {
            this.luaC.writeLn(this.outBufLua, `function __BINDINGS__.${node.name}:${node.name}() error("Class ${node.name} has no WebIDL constructor and therefore cannot be instantiated via Lua") end`);
        }
        this.luaC.outdent(this.outBufLua);
        this.luaC.newLine(this.outBufLua);
    }
    walkInterfaceCPP(node) {
        let JsImpl = this.getExtendedAttribute("JSImplementation", node.extAttrs) || this.getExtendedAttribute("LuaImplementation", node.extAttrs);
        let Prefix = this.unquoteEx(this.getExtendedAttribute("Prefix", node.extAttrs));
        let hasConstructor = false;
        if (JsImpl) {
            this.cppC.writeLn(this.outBufCPP, `class ${Prefix}${node.name};`);
            for (let i = 0; i < node.members.length; i++) {
                let member = node.members[i];
                if (member.type == "operation") {
                    if (member.name == node.name) {
                        continue;
                    }
                    this.cppC.write(this.outBufCPP, `export extern "C" ${this.idlTypeToCType(member.idlType, node.extAttrs, true)} ${this.mangleFunctionName(member, node.name, true)}(${Prefix}${node.name}* self`);
                    this.writeCArgs(this.outBufCPP, member.arguments, true, true);
                    this.cppC.writeLn(this.outBufCPP, `) __CFUNC(${this.mangleFunctionName(member, node.name, true)});`);
                }
            }
            this.cppC.write(this.outBufCPP, `class ${Prefix}${node.name}`);
            let jsImplExtends = this.unquote(JsImpl.rhs.value);
            if (jsImplExtends !== "") {
                if (this.classPrefixLookup[jsImplExtends]) {
                    jsImplExtends = `${this.classPrefixLookup[jsImplExtends]}${jsImplExtends}`;
                }
                this.cppC.write(this.outBufCPP, ` : ${jsImplExtends}`);
            }
            this.cppC.writeLn(this.outBufCPP, ` {`);
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
                    this.cppC.write(this.outBufCPP, `${this.idlTypeToCType(member.idlType, node.extAttrs, false)} `);
                    this.cppC.write(this.outBufCPP, `${member.name}(`);
                    this.writeCArgs(this.outBufCPP, member.arguments, true, false, false, false);
                    this.cppC.write(this.outBufCPP, `) {`);
                    if (member.idlType.idlType !== "void") {
                        this.cppC.write(this.outBufCPP, "return");
                    }
                    this.cppC.write(this.outBufCPP, ` `);
                    this.cppC.write(this.outBufCPP, `${this.mangleFunctionName(member, node.name, true)}(this`);
                    this.writeCArgs(this.outBufCPP, member.arguments, false, true, true, false);
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
                let Value = this.getExtendedAttribute("Value", member.extAttrs);
                if (member.name == node.name) {
                    hasConstructor = true;
                }
                else if (JsImpl) {
                    continue;
                }
                if (member.name == node.name) {
                    this.cppC.write(this.outBufCPP, `export extern "C" ${Prefix}${node.name}* ${this.mangleFunctionName(member, node.name)}(`);
                }
                else {
                    this.cppC.write(this.outBufCPP, `export extern "C" ${this.idlTypeToCType(member.idlType, member.extAttrs, true)} ${this.mangleFunctionName(member, node.name)}(${Prefix}${node.name}* self`);
                    if (member.arguments.length > 0) {
                        this.cppC.write(this.outBufCPP, `,`);
                    }
                }
                this.writeCArgs(this.outBufCPP, member.arguments, true, false);
                this.cppC.write(this.outBufCPP, `) {`);
                if (Value && (member.name !== node.name)) {
                    this.cppC.write(this.outBufCPP, `static ${this.idlTypeToCType(member.idlType, [], false, true)} temp; return (temp = `);
                }
                else if ((member.idlType.idlType !== "void") || (member.name == node.name)) {
                    this.cppC.write(this.outBufCPP, "return");
                }
                this.cppC.write(this.outBufCPP, ` `);
                if (Operator === false) {
                    if (member.name == node.name) {
                        this.cppC.write(this.outBufCPP, `new ${Prefix}${node.name}`);
                    }
                    else {
                        if (this.hasExtendedAttribute("Ref", member.extAttrs)) {
                            this.cppC.write(this.outBufCPP, "&");
                        }
                        this.cppC.write(this.outBufCPP, `self->${member.name}`);
                    }
                    this.cppC.write(this.outBufCPP, `(`);
                    this.writeCArgs(this.outBufCPP, member.arguments, false, false, true);
                    this.cppC.write(this.outBufCPP, `) `);
                }
                else {
                    if (member.arguments.length > 0) {
                        if (this.hasExtendedAttribute("Ref", member.extAttrs)) {
                            this.cppC.write(this.outBufCPP, "&");
                        }
                        this.cppC.write(this.outBufCPP, `(*self ${this.unquote(Operator.rhs.value)} ${this.getWithRefs(member.arguments[0])})`);
                    }
                    else {
                        this.cppC.write(this.outBufCPP, `${this.unquote(Operator.rhs.value)} self`);
                    }
                }
                if (Value && (member.name !== node.name)) {
                    this.cppC.write(this.outBufCPP, `, &temp)`);
                }
                this.cppC.write(this.outBufCPP, `;`);
                this.cppC.write(this.outBufCPP, `};`);
                this.cppC.newLine(this.outBufCPP);
            }
            else if (member.type == "attribute") {
                this.cppC.write(this.outBufCPP, `export extern "C" ${this.idlTypeToCType(member.idlType, member.extAttrs, true)} ${this.mangleIndexerName(member, node.name, false)}(${Prefix}${node.name}* self) {`);
                this.cppC.write(this.outBufCPP, `return `);
                this.startWrappedCReturnValue(this.outBufCPP, member.idlType, member.extAttrs);
                if (this.hasExtendedAttribute("Value", member.extAttrs)) {
                    this.cppC.write(this.outBufCPP, "&");
                }
                this.cppC.write(this.outBufCPP, `self->${member.name}`);
                this.endWrappedCReturnValue(this.outBufCPP, member.idlType, member.extAttrs);
                this.cppC.writeLn(this.outBufCPP, `; };`);
                this.cppC.write(this.outBufCPP, `export extern "C" void ${this.mangleIndexerName(member, node.name, true)}(${Prefix}${node.name}* self,${this.idlTypeToCType(member.idlType, member.extAttrs, true)} val) {`);
                this.cppC.write(this.outBufCPP, `self->${member.name} = `);
                if (this.hasExtendedAttribute("Value", member.extAttrs)) {
                    this.cppC.write(this.outBufCPP, "*");
                }
                this.startWrappedCValue(this.outBufCPP, member.idlType, member.extAttrs);
                this.cppC.write(this.outBufCPP, `val`);
                this.endWrappedCValue(this.outBufCPP, member.idlType, member.extAttrs);
                this.cppC.writeLn(this.outBufCPP, `; };`);
            }
        }
        this.cppC.write(this.outBufCPP, `export extern "C" void ${this.mangleFunctionName("_delete", node.name, true)}(${Prefix}${node.name}* self) {`);
        this.cppC.write(this.outBufCPP, `delete self;`);
        this.cppC.writeLn(this.outBufCPP, `};`);
    }
    walkNamespaceLua(node) {
        let JsImpl = this.getExtendedAttribute("JSImplementation", node.extAttrs) || this.getExtendedAttribute("LuaImplementation", node.extAttrs);
        this.luaC.write(this.outBufLua, `__BINDINGS__.${node.name} = __BINDER__.createNamespace()`);
        this.luaC.indent();
        this.luaC.newLine(this.outBufLua);
        let funcSig = {};
        for (let i = 0; i < node.members.length; i++) {
            let member = node.members[i];
            if (member.type == "operation") {
                funcSig[member.name] = funcSig[member.name] || [];
                for (let otherSig of funcSig[member.name]) {
                    if (otherSig == member.arguments.length) {
                        throw new SemanticError(`Function ${node.name}::${member.name} has incompatible overloaded signatures`);
                    }
                }
                funcSig[member.name].push(member.arguments.length);
            }
        }
        for (let i = 0; i < node.members.length; i++) {
            let member = node.members[i];
            if (member.type == "operation") {
                this.luaC.write(this.outBufLua, `function __BINDINGS__.${node.name}.${member.name}`);
                if (funcSig[member.name].length > 1) {
                    this.luaC.write(this.outBufLua, `__internal${member.arguments.length}`);
                }
                this.luaC.write(this.outBufLua, `(`);
                this.writeLuaArgs(this.outBufLua, member.arguments, false, ETypeConversion.NONE);
                this.luaC.write(this.outBufLua, `)`);
                if (JsImpl) {
                    this.luaC.write(this.outBufLua, `error("Unimplemented -> ${node.name}::${member.name}()")`);
                }
                else {
                    for (let j = 0; j < member.arguments.length; j++) {
                        this.convertLuaToCPP_Pre(this.outBufLua, member.arguments[j], j);
                    }
                    this.luaC.write(this.outBufLua, `local ret = `);
                    this.luaC.write(this.outBufLua, `${this.symbolResolver(this.mangleFunctionName(member, node.name))}(`);
                    this.writeLuaArgs(this.outBufLua, member.arguments, false, ETypeConversion.LUA_TO_CPP);
                    this.luaC.write(this.outBufLua, ")");
                    for (let j = 0; j < member.arguments.length; j++) {
                        this.convertLuaToCPP_Post(this.outBufLua, member.arguments[j], j);
                    }
                    this.convertCPPToLuaReturn(this.outBufLua, member.idlType, member.extAttrs, "ret");
                }
                this.luaC.write(this.outBufLua, " end");
                this.luaC.newLine(this.outBufLua);
                if (JsImpl) {
                    this.luaC.write(this.outBufLua, `function __CFUNCS__.${this.mangleFunctionName(member, node.name, true)}(`);
                    this.writeLuaArgs(this.outBufLua, member.arguments, false, ETypeConversion.NONE);
                    this.luaC.write(this.outBufLua, `)`);
                    for (let j = 0; j < member.arguments.length; j++) {
                        this.convertLuaToCPP_Pre(this.outBufLua, member.arguments[j], j);
                    }
                    this.luaC.write(this.outBufLua, `local ret = __BINDINGS__.${node.name}.${member.name}(`);
                    this.writeLuaArgs(this.outBufLua, member.arguments, false, ETypeConversion.CPP_TO_LUA);
                    this.luaC.write(this.outBufLua, `)`);
                    for (let j = 0; j < member.arguments.length; j++) {
                        this.convertLuaToCPP_Post(this.outBufLua, member.arguments[j], j);
                    }
                    this.convertLuaToCPPReturn(this.outBufLua, member.idlType, member.extAttrs, "ret");
                    this.luaC.write(this.outBufLua, " end");
                    this.luaC.newLine(this.outBufLua);
                }
            }
            else if (member.type == "attribute") {
                this.luaC.write(this.outBufLua, `function __BINDINGS__.${node.name}.__specialIndex.${member.name}(self,k) `);
                this.luaC.write(this.outBufLua, `local ret = ${this.symbolResolver(this.mangleIndexerName(member, node.name, false))}()`);
                this.convertCPPToLuaReturn(this.outBufLua, member.idlType, member.extAttrs, "ret");
                this.luaC.writeLn(this.outBufLua, ` end`);
                this.luaC.write(this.outBufLua, `function __BINDINGS__.${node.name}.__specialNewIndex.${member.name}(self,k,v) `);
                if (!member.readonly || this.hasExtendedAttribute("OverrideCanWrite", member.extAttrs)) {
                    this.convertLuaToCPP_Pre(this.outBufLua, { name: "v", idlType: member.idlType, extAttrs: member.extAttrs }, 0);
                    this.luaC.write(this.outBufLua, `${this.symbolResolver(this.mangleIndexerName(member, node.name, true))}(`);
                    this.convertLuaToCPP_Arg(this.outBufLua, { name: "v", idlType: member.idlType, extAttrs: member.extAttrs }, 0);
                    this.luaC.write(this.outBufLua, `)`);
                    this.convertLuaToCPP_Post(this.outBufLua, { name: "v", idlType: member.idlType, extAttrs: member.extAttrs }, 0);
                }
                else {
                    this.luaC.write(this.outBufLua, `error("Cannot modify read-only attribute ${node.name}::${member.name}")`);
                }
                this.luaC.writeLn(this.outBufLua, ` end`);
            }
        }
        for (let ident in funcSig) {
            let memberData = funcSig[ident];
            if (memberData.length > 1) {
                this.luaC.write(this.outBufLua, `function __BINDINGS__.${node.name}.${ident}(`);
                let maxArg = Math.max(...memberData);
                for (let i = 0; i < maxArg; i++) {
                    this.luaC.write(this.outBufLua, `arg${i}`);
                    if ((i + 1) !== maxArg) {
                        this.luaC.write(this.outBufLua, ",");
                    }
                }
                this.luaC.write(this.outBufLua, ") ");
                memberData.sort().reverse();
                this.luaC.write(this.outBufLua, "if ");
                for (let i = 0; i < memberData.length; i++) {
                    if (memberData[i] != 0) {
                        this.luaC.write(this.outBufLua, `arg${memberData[i] - 1} ~= nil then `);
                    }
                    this.luaC.write(this.outBufLua, `return __BINDINGS__.${node.name}.${ident}__internal${memberData[i]}(`);
                    for (let j = 0; j < memberData[i]; j++) {
                        this.luaC.write(this.outBufLua, `arg${j}`);
                        if ((j + 1) !== memberData[i]) {
                            this.luaC.write(this.outBufLua, ",");
                        }
                    }
                    this.luaC.write(this.outBufLua, ") ");
                    if ((i + 1) !== memberData.length) {
                        if (memberData[i + 1] != 0) {
                            this.luaC.write(this.outBufLua, "elseif ");
                        }
                        else {
                            this.luaC.write(this.outBufLua, "else ");
                        }
                    }
                }
                this.luaC.writeLn(this.outBufLua, "end end");
            }
        }
        this.luaC.outdent(this.outBufLua);
        this.luaC.newLine(this.outBufLua);
    }
    walkNamespaceCPP(node) {
        let JsImpl = this.getExtendedAttribute("JSImplementation", node.extAttrs) || this.getExtendedAttribute("LuaImplementation", node.extAttrs);
        if (JsImpl) {
            for (let i = 0; i < node.members.length; i++) {
                let member = node.members[i];
                if (member.type == "operation") {
                    this.cppC.write(this.outBufCPP, `extern "C" ${this.idlTypeToCType(member.idlType, node.extAttrs, true)} ${this.mangleFunctionName(member, node.name, true)}(`);
                    this.writeCArgs(this.outBufCPP, member.arguments, true, false);
                    this.cppC.writeLn(this.outBufCPP, `) __CFUNC(${this.mangleFunctionName(member, node.name, true)});`);
                }
            }
            if (node.name !== "global") {
                this.cppC.write(this.outBufCPP, `namespace ${node.name} {`);
            }
            this.cppC.indent();
            this.cppC.newLine(this.outBufCPP);
            for (let i = 0; i < node.members.length; i++) {
                let member = node.members[i];
                if (member.type == "operation") {
                    this.cppC.write(this.outBufCPP, `${this.idlTypeToCType(member.idlType, node.extAttrs, true)} `);
                    this.cppC.write(this.outBufCPP, `${member.name}(`);
                    this.writeCArgs(this.outBufCPP, member.arguments, true, false, false, false);
                    this.cppC.write(this.outBufCPP, `) {`);
                    if (member.idlType.idlType !== "void") {
                        this.cppC.write(this.outBufCPP, "return");
                    }
                    this.cppC.write(this.outBufCPP, ` `);
                    this.cppC.write(this.outBufCPP, `${this.mangleFunctionName(member, node.name, true)}(`);
                    this.writeCArgs(this.outBufCPP, member.arguments, false, false, true, false);
                    this.cppC.write(this.outBufCPP, ");");
                    this.cppC.write(this.outBufCPP, " };");
                    this.cppC.newLine(this.outBufCPP);
                }
            }
            this.cppC.outdent(this.outBufCPP);
            if (node.name !== "global") {
                this.cppC.write(this.outBufCPP, "};");
            }
            this.cppC.newLine(this.outBufCPP);
        }
        else {
            for (let i = 0; i < node.members.length; i++) {
                let member = node.members[i];
                if (member.type == "operation") {
                    let Value = this.getExtendedAttribute("Value", member.extAttrs);
                    this.cppC.write(this.outBufCPP, `export extern "C" ${this.idlTypeToCType(member.idlType, member.extAttrs, true)} ${this.mangleFunctionName(member, node.name)}(`);
                    this.writeCArgs(this.outBufCPP, member.arguments, true, false);
                    this.cppC.write(this.outBufCPP, `) {`);
                    if (Value) {
                        this.cppC.write(this.outBufCPP, `static ${this.idlTypeToCType(member.idlType, [], false, true)} temp; return (temp = `);
                    }
                    else if (member.idlType.idlType !== "void") {
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
                    this.writeCArgs(this.outBufCPP, member.arguments, false, false, true);
                    this.cppC.write(this.outBufCPP, `) `);
                    if (Value && (member.name !== node.name)) {
                        this.cppC.write(this.outBufCPP, `, &temp)`);
                    }
                    this.cppC.write(this.outBufCPP, `;`);
                    this.cppC.write(this.outBufCPP, `};`);
                    this.cppC.newLine(this.outBufCPP);
                }
                else if (member.type == "attribute") {
                    this.cppC.write(this.outBufCPP, `export extern "C" ${this.idlTypeToCType(member.idlType, member.extAttrs, true)} ${this.mangleIndexerName(member, node.name, false)}(${node.name}* self) {`);
                    this.cppC.write(this.outBufCPP, `return `);
                    this.startWrappedCReturnValue(this.outBufCPP, member.idlType, member.extAttrs);
                    if (this.hasExtendedAttribute("Value", member.extAttrs)) {
                        this.cppC.write(this.outBufCPP, "&");
                    }
                    if (node.name === "global") {
                        this.cppC.write(this.outBufCPP, `${member.name}`);
                    }
                    else {
                        this.cppC.write(this.outBufCPP, `${node.name}::${member.name}`);
                    }
                    this.endWrappedCReturnValue(this.outBufCPP, member.idlType, member.extAttrs);
                    this.cppC.write(this.outBufCPP, `; `);
                    this.cppC.writeLn(this.outBufCPP, `};`);
                    if (!member.readonly || this.hasExtendedAttribute("OverrideCanWrite", member.extAttrs)) {
                        this.cppC.write(this.outBufCPP, `export extern "C" void ${this.mangleIndexerName(member, node.name, true)}(${node.name}* self,${this.idlTypeToCType(member.idlType, member.extAttrs, true)} val) {`);
                        if (node.name === "global") {
                            this.cppC.write(this.outBufCPP, `${member.name}`);
                        }
                        else {
                            this.cppC.write(this.outBufCPP, `${node.name}::${member.name}`);
                        }
                        this.cppC.write(this.outBufCPP, ` = `);
                        this.startWrappedCValue(this.outBufCPP, member.idlType, member.extAttrs);
                        if (this.hasExtendedAttribute("Value", member.extAttrs)) {
                            this.cppC.write(this.outBufCPP, "*");
                        }
                        this.cppC.write(this.outBufCPP, `val`);
                        this.endWrappedCValue(this.outBufCPP, member.idlType, member.extAttrs);
                        this.cppC.writeLn(this.outBufCPP, `; };`);
                    }
                }
            }
        }
    }
}
WebIDLBinder.CTypeRenames = {
    ["DOMString"]: "char*",
    ["boolean"]: "bool",
    ["byte"]: "char",
    ["octet"]: "unsigned char",
    ["unsigned short"]: "unsigned short int",
    ["long"]: "int",
    ["any"]: "void*",
    ["VoidPtr"]: "void*",
};
exports.WebIDLBinder = WebIDLBinder;
let infile = process.argv[2] || (__dirname + "/../test/test.idl");
let outfile_lua = process.argv[3] || (__dirname + "/../test/test_bind.lua");
let outfile_cpp = process.argv[3] || (__dirname + "/../test/test_bind.cpp");
let idl = fs.readFileSync(infile);
let inst = new WebIDLBinder(idl.toString(), BinderMode.WEBIDL_LUA, true);
inst.buildOut();
fs.writeFileSync(outfile_lua, inst.outBufLua.join(""));
fs.writeFileSync(outfile_cpp, inst.outBufCPP.join(""));
//# sourceMappingURL=webidlbinder.js.map
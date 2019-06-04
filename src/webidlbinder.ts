import * as webidl from "webidl2"
import { StringCompiler } from "./stringcompiler";
import * as fs from "fs"
import { O_NOCTTY } from "constants";
import { maxHeaderSize } from "http";

export enum BinderMode {
    WEBIDL_NONE = -1,
    WEBIDL_LUA = 0,
    WEBIDL_CPP = 1,
}

export class SemanticError extends Error {

}

export class WebIDLBinder {
    luaC = new StringCompiler();
    cppC = new StringCompiler();
    outBufLua: string[] = [];
    outBufCPP: string[] = [];
    ast: webidl.IDLRootType[];
    classLookup: {[n: string]: boolean} = {};
    classPrefixLookup: {[n: string]: string} = {};

    static CTypeRenames: {[type: string]: string} = {
        ["DOMString"]: "char*",
        ["boolean"]: "bool",
        ["byte"]: "char",
        ["octet"]: "unsigned char",
        ["unsigned short"]: "unsigned short int",
        ["long"]: "int",
        ["any"]: "void*",
        ["VoidPtr"]: "void*",
    };

    constructor(public source: string,public mode: BinderMode,public addYieldStub: boolean) {
        this.ast = webidl.parse(source);
    }

    unquote(arg: string | string[]) {
        if(Array.isArray(arg)) {arg = arg.join("");}

        return arg.replace(/^"/,"").replace(/"$/,"");
    }

    unquoteEx(arg: webidl.ExtendedAttributes | false) {
        if(arg === false) {return "";}

        return this.unquote(arg.rhs.value);
    }

    getWithRefs(arg: webidl.Argument) {
        if(this.hasExtendedAttribute("Ref",arg.extAttrs)) {
            return `*${arg.name}`;
        }
        else {
            return arg.name;
        }
    }

    mangleFunctionName(node: webidl.OperationMemberType,namespace: string,isImpl?: boolean) {
        let out = "_webidl_lua_";

        if(isImpl) {out += "internalimpl_";}

        out += namespace + "_"

        out += node.name;

        for(let i=0;i < node.arguments.length;i++) {
            let arg = node.arguments[i];

            out += "_";
            out += arg.idlType.idlType.toString().replace(/\s+/g,"_");
        }

        return out;
    }

    mangleIndexerName(node: webidl.AttributeMemberType,namespace: string,isNewindex?: boolean) {
        let out = "_webidl_lua_";

        out += namespace + "_"

        out += node.name;

        if(isNewindex) {
            out += "_set";
        }
        else {
            out += "_get";
        }

        return out;
    }

    getExtendedAttribute(attribute: string,extAttrs: webidl.ExtendedAttributes[]) {
        for(let i=0;i < extAttrs.length;i++) {
            if(extAttrs[i].name === attribute) {
                return extAttrs[i];
            }
        }

        return false;
    }

    hasExtendedAttribute(attribute: string,extAttrs: webidl.ExtendedAttributes[]) {
        return this.getExtendedAttribute(attribute,extAttrs) !== false;
    }

    idlTypeToCType(idlType: webidl.IDLTypeDescription,extAttrs: webidl.ExtendedAttributes[],maskRef: boolean,tempVar?: boolean) {
        let prefixes = "";
        let suffixes = "";

        if(this.hasExtendedAttribute("Const",extAttrs)) {
            if(!tempVar) {
                prefixes += "const ";
            }
        }
        if(this.hasExtendedAttribute("Ref",extAttrs)) {
            if(!tempVar) {
                if(maskRef) {
                    suffixes += "*";
                }
                else {
                    suffixes += "&";
                }
            }
        }
        else if(this.classLookup[idlType.idlType as string]) {
            if(!tempVar) {
                suffixes += "*";
            }
        }

        if(this.hasExtendedAttribute("Array",extAttrs)) {
            if(!tempVar) {
                // TODO: convert in Lua
                suffixes += "*";
            }
            else {
                // TODO: what even??? Throw error???
                suffixes += "[]";
            }
        }

        let body = idlType.idlType as string;
        if(WebIDLBinder.CTypeRenames[body]) {
            body = WebIDLBinder.CTypeRenames[body];
        }
        else if(this.classPrefixLookup[body]) {
            body = this.classPrefixLookup[body] + body;
        }

        return `${prefixes} ${body} ${suffixes}`.replace(/\s+/g," ").trim();
    }

    buildOut() {
        if(this.mode == BinderMode.WEBIDL_LUA) {
            this.luaC.writeLn(this.outBufLua,"local __CFUNCS__ = {}")
            this.luaC.writeLn(this.outBufLua,"__IMPORTS__.webidl_cfuncs = __CFUNCS__")
        }
        else if(this.mode == BinderMode.WEBIDL_CPP) {
            this.cppC.writeLn(this.outBufCPP,`#define __CFUNC(name) \\`);
            this.cppC.writeLn(this.outBufCPP,`    __attribute__((__import_module__("webidl_cfuncs"), __import_name__(#name)))`);
            this.cppC.writeLn(this.outBufCPP,`#define export __attribute__((visibility( "default" )))`);
        }

        for(let i=0;i < this.ast.length;i++) {
            let node = this.ast[i];
            if((node.type == "interface") || (node.type == "interface mixin")) {
                this.classLookup[node.name] = true;

                let prefix = this.getExtendedAttribute("Prefix",node.extAttrs);
                if(prefix) {
                    this.classPrefixLookup[node.name] = this.unquote(prefix.rhs.value);
                }

                if(this.mode == BinderMode.WEBIDL_CPP) {
                    // this.cppC.writeLn(this.outBufCPP,`class ${node.name};`);
                }
            }
        }
        for(let i=0;i < this.ast.length;i++) {
            this.walkRootType(this.ast[i]);
        }
        for(let i=0;i < this.ast.length;i++) {
            if(this.ast[i].type == "interface") {
                let int = this.ast[i] as webidl.InterfaceType;
                if(int.inheritance) {
                    this.luaC.writeLn(this.outBufLua,`setmetatable(__BINDINGS__.${int.name},{__index = __BINDINGS__.${int.inheritance}})`);
                }
            }
        }

        if(this.addYieldStub) {
            if(this.mode == BinderMode.WEBIDL_LUA) {
                this.luaC.writeLn(this.outBufLua,"__IMPORTS__.webidl_internal = {main_yield = coroutine.yield}");
                this.luaC.writeLn(this.outBufLua,"module.init = coroutine.wrap(module.init)");
            }
            else if(this.mode == BinderMode.WEBIDL_CPP) {
                this.cppC.writeLn(this.outBufCPP,`extern "C" void _webidl_main_yield() __attribute__((__import_module__("webidl_internal"), __import_name__("main_yield")));`)
                this.cppC.writeLn(this.outBufCPP,`int main() {_webidl_main_yield(); return 0;}`);
            }
        }

        if(this.mode == BinderMode.WEBIDL_CPP) {
            this.cppC.writeLn(this.outBufCPP,`#undef __CFUNC`);
        }
    }

    writeCArgs(buf: string[],args: webidl.Argument[], needsType: boolean,needsStartingComma: boolean,refToPtr?: boolean) {
        if(needsStartingComma) {
            if(args.length > 0) {
                this.cppC.write(buf,",");
            }
        }

        for(let j=0;j < args.length;j++) {
            if(needsType) {
                this.cppC.write(buf,`${this.idlTypeToCType(args[j].idlType,args[j].extAttrs,true)} `);
            }
            this.cppC.write(buf,`${refToPtr ? this.getWithRefs(args[j]) : args[j].name}`);
            if((j+1) !== args.length) {
                this.cppC.write(buf,",");
            }
        }
    }

    writeLuaArgs(buf: string[],args: webidl.Argument[], needsStartingComma: boolean,useTypeConversion?: boolean) {
        if(needsStartingComma) {
            if(args.length > 0) {
                this.luaC.write(buf,",");
            }
        }

        for(let j=0;j < args.length;j++) {
            if(useTypeConversion) {
                this.convertLuaToCPP_Arg(buf,args[j],j);
            }
            else {
                this.luaC.write(buf,`${args[j].name}`);
            }
            if((j+1) !== args.length) {
                this.luaC.write(buf,",");
            }
        }
    }

    walkRootType(node: webidl.IDLRootType) {
        if(node.type == "interface") {
            if(this.mode == BinderMode.WEBIDL_LUA) {
                this.walkInterfaceLua(node);
            }
            else if(this.mode == BinderMode.WEBIDL_CPP) {
                this.walkInterfaceCPP(node);
            }
        }
        else if((node.type == "namespace")) {
            if(this.mode == BinderMode.WEBIDL_LUA) {
                this.walkNamespaceLua(node);
            }
            else if(this.mode == BinderMode.WEBIDL_CPP) {
                this.walkNamespaceCPP(node);
            }
        }
    }

    convertLuaToCPP_Pre(buf: string[],arg: {name: string,idlType: webidl.IDLTypeDescription} | webidl.Argument,argID: number) {
        if(arg.idlType.idlType == "DOMString") {
            this.luaC.write(buf,`local __arg${argID} = vm.stringify(${arg.name})`);
        }
    }

    convertLuaToCPP_Arg(buf: string[],arg: {name: string,idlType: webidl.IDLTypeDescription} | webidl.Argument,argID: number) {
        if(arg.idlType.idlType == "DOMString") {
            this.luaC.write(buf,`__arg${argID}`);
        }
        else {
            this.luaC.write(buf,`${arg.name}`);
        }
        if(this.classLookup[arg.idlType.idlType as string]) {
            this.luaC.write(buf,".__ptr");
        }
        else if(arg.idlType.idlType == "boolean") {
            this.luaC.write(buf," and 1 or 0");
        }
    }

    convertLuaToCPP_Post(buf: string[],arg: {name: string,idlType: webidl.IDLTypeDescription} | webidl.Argument,argID: number) {
        if(arg.idlType.idlType == "DOMString") {
            this.luaC.write(buf,`vm.freeString(__arg${argID})`);
        }
    }

    convertCPPToLuaReturn(buf: string[],argType: webidl.IDLTypeDescription,argName: string) {
        if(this.classLookup[argType.idlType as string]) {
            this.luaC.write(buf,`local __obj = __BINDINGS__.${argType.idlType}.__cache[${argName}] `);
            this.luaC.write(buf,`if not __obj then __obj = setmetatable({__ptr = ${argName}},__BINDINGS__.${argType.idlType}) __BINDINGS__.${argType.idlType}.__cache[${argName}] = __obj end `);
            this.luaC.write(buf,"return __obj");
        }
        else if(argType.idlType == "DOMString") {
            // null terminated only :(
            this.luaC.write(buf,`return vm.readString(${argName})`);
        }
        else {
            this.luaC.write(buf,`return ${argName}`);
        }
    }

    walkInterfaceLua(node: webidl.InterfaceType) {
        let JsImpl = this.getExtendedAttribute("JSImplementation",node.extAttrs);

        let hasConstructor = false;

        this.luaC.writeLn(this.outBufLua,`__BINDINGS__.${node.name} = {} vm.createClass(__BINDINGS__.${node.name},"${node.name}")`);

        let funcSig: {[ident: string]: number[]} = {};
        for(let i=0;i < node.members.length;i++) {
            let member = node.members[i];
            if(member.type == "operation") {
                funcSig[member.name] = funcSig[member.name] || []
                for(let otherSig of funcSig[member.name]) {
                    if(otherSig == member.arguments.length) {
                        throw new SemanticError(`Function ${node.name}::${member.name} has incompatible overloaded signatures`);
                    }
                }
                funcSig[member.name].push(member.arguments.length);
            }
        }

        this.luaC.write(this.outBufLua,`setmetatable(__BINDINGS__.${node.name},{__call = function(self`)
        if(funcSig[node.name]) {
            if(funcSig[node.name].length > 1) {
                this.luaC.write(this.outBufLua,`,`)
                
                let maxArg = Math.max(...funcSig[node.name]);
                for(let i=0;i < maxArg;i++) {
                    this.luaC.write(this.outBufLua,`arg${i}`);
                    if((i+1) !== maxArg) {
                        this.luaC.write(this.outBufLua,",");
                    }
                }
            }
        }
        this.luaC.write(this.outBufLua,`)`)
        this.luaC.write(this.outBufLua,`local ins = setmetatable({__ptr = 0},self)`)
        this.luaC.write(this.outBufLua,`ins:${node.name}(`)
        if(funcSig[node.name]) {
            if(funcSig[node.name].length > 1) {
                let maxArg = Math.max(...funcSig[node.name]);
                for(let i=0;i < maxArg;i++) {
                    this.luaC.write(this.outBufLua,`arg${i}`);
                    if((i+1) !== maxArg) {
                        this.luaC.write(this.outBufLua,",");
                    }
                }
            }
        }
        this.luaC.write(this.outBufLua,`)`)
        this.luaC.write(this.outBufLua,`return ins`)
        this.luaC.write(this.outBufLua,` end})`)

        this.luaC.indent(); this.luaC.newLine(this.outBufLua);

        for(let i=0;i < node.members.length;i++) {
            let member = node.members[i];
            if(member.type == "operation") {
                if(member.name == node.name) {
                    hasConstructor = true;
                }

                this.luaC.write(this.outBufLua,`function __BINDINGS__.${node.name}:${member.name}`);
                if(funcSig[member.name].length > 1) {
                    this.luaC.write(this.outBufLua,`__internal${member.arguments.length}`);
                }
                this.luaC.write(this.outBufLua,`(`);
                this.writeLuaArgs(this.outBufLua,member.arguments,false);
                this.luaC.write(this.outBufLua,`)`);

                if(!JsImpl || (node.name == member.name)) {
                    for(let j=0;j < member.arguments.length;j++) {
                        this.convertLuaToCPP_Pre(this.outBufLua,member.arguments[j],j);
                    }

                    if(member.name == node.name) {
                        this.luaC.write(this.outBufLua,`self.__ptr = `);
                        this.luaC.write(this.outBufLua,`__FUNCS__.${this.mangleFunctionName(member,node.name)}(`);
                    }
                    else {
                        this.luaC.write(this.outBufLua,`local ret = `);
                        this.luaC.write(this.outBufLua,`__FUNCS__.${this.mangleFunctionName(member,node.name)}(self.__ptr`);
                        if(member.arguments.length > 0) {
                            this.luaC.write(this.outBufLua,",");
                        }
                    }

                    this.writeLuaArgs(this.outBufLua,member.arguments,false,true);
                    this.luaC.write(this.outBufLua,");");

                    if(member.name == node.name) {
                        this.luaC.write(this.outBufLua,`__BINDINGS__.${node.name}.__cache[self.__ptr] = self;`)
                    }

                    for(let j=0;j < member.arguments.length;j++) {
                        this.convertLuaToCPP_Post(this.outBufLua,member.arguments[j],j);
                    }

                    if(member.name !== node.name) {
                        this.convertCPPToLuaReturn(this.outBufLua,member.idlType,"ret");
                    }
                }
                else {
                    this.luaC.write(this.outBufLua,`error("Unimplemented -> ${node.name}::${member.name}()")`);
                }

                this.luaC.write(this.outBufLua," end");
                this.luaC.newLine(this.outBufLua);

                if(JsImpl && (member.name !== node.name)) {
                    this.luaC.write(this.outBufLua,`function __CFUNCS__.${this.mangleFunctionName(member,node.name,true)}(selfPtr`);
                    this.writeLuaArgs(this.outBufLua,member.arguments,true);
                    this.luaC.write(this.outBufLua,`)`);

                    for(let j=0;j < member.arguments.length;j++) {
                        this.convertLuaToCPP_Pre(this.outBufLua,member.arguments[j],j);
                    }
    
                    this.luaC.write(this.outBufLua,`local self = __BINDINGS__.${node.name}.__cache[selfPtr] local ret = self.${member.name}(self`);
                    this.writeLuaArgs(this.outBufLua,member.arguments,true,true);
                    this.luaC.write(this.outBufLua,`)`);

                    for(let j=0;j < member.arguments.length;j++) {
                        this.convertLuaToCPP_Post(this.outBufLua,member.arguments[j],j);
                    }
    
                    this.convertCPPToLuaReturn(this.outBufLua,member.idlType,"ret");

                    this.luaC.write(this.outBufLua," end");
                    this.luaC.newLine(this.outBufLua);
                }
            }
            else if(member.type == "attribute") {
                this.luaC.write(this.outBufLua,`function __BINDINGS__.${node.name}.__specialIndex.${member.name}(self,k) `);
                this.luaC.write(this.outBufLua,`local ret = __FUNCS__.${this.mangleIndexerName(member,node.name,false)}(self)`);
                this.convertCPPToLuaReturn(this.outBufLua,member.idlType,"ret");
                this.luaC.writeLn(this.outBufLua,` end`);

                this.luaC.write(this.outBufLua,`function __BINDINGS__.${node.name}.__specialNewIndex.${member.name}(self,k,v) `);
                this.convertLuaToCPP_Pre(this.outBufLua,{name: "v",idlType: member.idlType},0);
                this.luaC.write(this.outBufLua,`__FUNCS__.${this.mangleIndexerName(member,node.name,true)}(self,`);
                this.convertLuaToCPP_Arg(this.outBufLua,{name: "v",idlType: member.idlType},0);
                this.luaC.write(this.outBufLua,`)`);
                this.convertLuaToCPP_Post(this.outBufLua,{name: "v",idlType: member.idlType},0);
                this.luaC.writeLn(this.outBufLua,` end`);
            }
        }

        for(let ident in funcSig) {
            let memberData = funcSig[ident];

            if(memberData.length > 1) {
                // needs resolution

                this.luaC.write(this.outBufLua,`function __BINDINGS__.${node.name}:${ident}(`);
                let maxArg = Math.max(...memberData);
                for(let i=0;i < maxArg;i++) {
                    this.luaC.write(this.outBufLua,`arg${i}`);
                    if((i+1) !== maxArg) {
                        this.luaC.write(this.outBufLua,",");
                    }
                }
                this.luaC.write(this.outBufLua,") ");

                memberData.sort().reverse(); // I'm lazy

                this.luaC.write(this.outBufLua,"if ");
                for(let i=0;i < memberData.length;i++) {
                    if(memberData[i] != 0) {
                        this.luaC.write(this.outBufLua,`arg${memberData[i]-1} ~= nil then `);
                    }
                    this.luaC.write(this.outBufLua,`return self:${ident}__internal${memberData[i]}(`);
                    for(let j=0;j < memberData[i];j++) {
                        this.luaC.write(this.outBufLua,`arg${j}`);
                        if((j+1) !== memberData[i]) {
                            this.luaC.write(this.outBufLua,",");
                        }
                    }
                    this.luaC.write(this.outBufLua,") ");
                    if((i+1) !== memberData.length) {
                        if(memberData[i+1] != 0) {
                            this.luaC.write(this.outBufLua,"elseif ");
                        }
                        else {
                            this.luaC.write(this.outBufLua,"else ");
                        }
                    }
                }
                this.luaC.writeLn(this.outBufLua,"end end");
            }
        }

        if(!hasConstructor) {
            this.luaC.writeLn(this.outBufLua,`function __BINDINGS__.${node.name}:${node.name}() error("Class ${node.name} has no WebIDL constructor and therefore cannot be instantiated via Lua") end`)
        }

        this.luaC.outdent(this.outBufLua); this.luaC.newLine(this.outBufLua);
    }

    walkInterfaceCPP(node: webidl.InterfaceType) {
        let JsImpl = this.getExtendedAttribute("JSImplementation",node.extAttrs);
        let Prefix = this.unquoteEx(this.getExtendedAttribute("Prefix",node.extAttrs));

        let hasConstructor = false;

        if(JsImpl) {
            this.cppC.writeLn(this.outBufCPP,`class ${Prefix}${node.name};`);
            for(let i=0;i < node.members.length;i++) {
                let member = node.members[i];
                if(member.type == "operation") {
                    if(member.name == node.name) {continue;}
                    this.cppC.write(this.outBufCPP,`export extern "C" ${this.idlTypeToCType(member.idlType,node.extAttrs,true)} ${this.mangleFunctionName(member,node.name,true)}(${Prefix}${node.name}* self`);
                    this.writeCArgs(this.outBufCPP,member.arguments,true,true);
                    this.cppC.writeLn(this.outBufCPP,`) __CFUNC(${this.mangleFunctionName(member,node.name,true)});`);
                }
            }

            this.cppC.writeLn(this.outBufCPP,`class ${Prefix}${node.name} {`);
            this.cppC.write(this.outBufCPP,`public:`);
            this.cppC.indent();
            this.cppC.newLine(this.outBufCPP);

            for(let i=0;i < node.members.length;i++) {
                let member = node.members[i];
                if(member.type == "operation") {
                    if(member.name == node.name) {
                        hasConstructor = true;
                        continue;
                    }

                    this.cppC.write(this.outBufCPP,`${this.idlTypeToCType(member.idlType,node.extAttrs,true)} `);
                    this.cppC.write(this.outBufCPP,`${member.name}(`);
                    this.writeCArgs(this.outBufCPP,member.arguments,true,false);
                    this.cppC.write(this.outBufCPP,`) {`);

                    if(member.idlType.idlType !== "void") {
                        this.cppC.write(this.outBufCPP,"return");
                    }
                    this.cppC.write(this.outBufCPP,` `);

                    this.cppC.write(this.outBufCPP,`${this.mangleFunctionName(member,node.name,true)}(this`);
                    this.writeCArgs(this.outBufCPP,member.arguments,false,true);
                    this.cppC.write(this.outBufCPP,");");

                    this.cppC.write(this.outBufCPP," };");
                    this.cppC.newLine(this.outBufCPP);
                }
            }
            
            this.cppC.outdent(this.outBufCPP)
            this.cppC.write(this.outBufCPP,"};");
            this.cppC.newLine(this.outBufCPP);
        }

        for(let i=0;i < node.members.length;i++) {
            let member = node.members[i];
            if(member.type == "operation") {
                let Operator = this.getExtendedAttribute("Operator",member.extAttrs);
                let Value = this.getExtendedAttribute("Value",member.extAttrs);
                // TODO: we're using emscripten's way of wrapping values into static temp vars
                // I think this is unsafe. We should allocate new memory per return
                // and make lua garbage collect the result..
                if(member.name == node.name) {
                    hasConstructor = true;
                }
                else if(JsImpl) {continue;}

                if(member.name == node.name) {
                    this.cppC.write(this.outBufCPP,`export extern "C" ${Prefix}${node.name}* ${this.mangleFunctionName(member,node.name)}(`);
                }
                else {
                    this.cppC.write(this.outBufCPP,`export extern "C" ${this.idlTypeToCType(member.idlType,member.extAttrs,true)} ${this.mangleFunctionName(member,node.name)}(${Prefix}${node.name}* self`);
                    if(member.arguments.length > 0) {
                        this.cppC.write(this.outBufCPP,`,`);
                    }
                }
                this.writeCArgs(this.outBufCPP,member.arguments,true,false);
                this.cppC.write(this.outBufCPP,`) {`);
                if(Value && (member.name !== node.name)) {
                    this.cppC.write(this.outBufCPP,`static ${this.idlTypeToCType(member.idlType,[],false,true)} temp; return (temp = `);
                }
                else if((member.idlType.idlType !== "void") || (member.name == node.name)) {
                    this.cppC.write(this.outBufCPP,"return");
                }
                this.cppC.write(this.outBufCPP,` `);
                if(Operator === false) {
                    if(member.name == node.name) {
                        this.cppC.write(this.outBufCPP,`new ${Prefix}${node.name}`);
                    }
                    else {
                        if(this.hasExtendedAttribute("Ref",member.extAttrs)) {
                            this.cppC.write(this.outBufCPP,"&");
                        }
                        this.cppC.write(this.outBufCPP,`self->${member.name}`);
                    }
                    this.cppC.write(this.outBufCPP,`(`);
                    this.writeCArgs(this.outBufCPP,member.arguments,false,false,true);
                    this.cppC.write(this.outBufCPP,`) `);
                }
                else {
                    if(member.arguments.length > 0) {
                        if(this.hasExtendedAttribute("Ref",member.extAttrs)) {
                            this.cppC.write(this.outBufCPP,"&");
                        }
                        this.cppC.write(this.outBufCPP,`(*self ${this.unquote(Operator.rhs.value)} ${this.getWithRefs(member.arguments[0])})`);
                    }
                    else {
                        this.cppC.write(this.outBufCPP,`${this.unquote(Operator.rhs.value)} self`);
                    }
                }
                if(Value && (member.name !== node.name)) {
                    this.cppC.write(this.outBufCPP,`, &temp)`);
                }
                this.cppC.write(this.outBufCPP,`;`);
                this.cppC.write(this.outBufCPP,`};`);
                this.cppC.newLine(this.outBufCPP);
            }
            else if(member.type == "attribute") {
                this.cppC.write(this.outBufCPP,`export extern "C" ${this.idlTypeToCType(member.idlType,member.extAttrs,true)} ${this.mangleIndexerName(member,node.name,false)}(${Prefix}${node.name}* self) {`);
                this.cppC.write(this.outBufCPP,`return `);
                if(this.hasExtendedAttribute("Value",member.extAttrs)) {
                    this.cppC.write(this.outBufCPP,"&");
                }
                this.cppC.write(this.outBufCPP,`self->${member.name}; `);
                this.cppC.writeLn(this.outBufCPP,`};`);
                
                this.cppC.write(this.outBufCPP,`export extern "C" void ${this.mangleIndexerName(member,node.name,true)}(${Prefix}${node.name}* self,${this.idlTypeToCType(member.idlType,member.extAttrs,true)} val) {`);
                this.cppC.write(this.outBufCPP,`self->${member.name} = `);
                if(this.hasExtendedAttribute("Value",member.extAttrs)) {
                    this.cppC.write(this.outBufCPP,"*");
                }
                this.cppC.write(this.outBufCPP,`val;`);
                this.cppC.writeLn(this.outBufCPP,`};`);
            }
        }
    }

    walkNamespaceLua(node: webidl.NamespaceType) {
        let JsImpl = this.getExtendedAttribute("JSImplementation",node.extAttrs);

        this.luaC.write(this.outBufLua,`__BINDINGS__.${node.name} = vm.createNamespace()`);

        this.luaC.indent(); this.luaC.newLine(this.outBufLua);

        let funcSig: {[ident: string]: number[]} = {};
        for(let i=0;i < node.members.length;i++) {
            let member = node.members[i];
            if(member.type == "operation") {
                funcSig[member.name] = funcSig[member.name] || []
                for(let otherSig of funcSig[member.name]) {
                    if(otherSig == member.arguments.length) {
                        throw new SemanticError(`Function ${node.name}::${member.name} has incompatible overloaded signatures`);
                    }
                }
                funcSig[member.name].push(member.arguments.length);
            }
        }

        for(let i=0;i < node.members.length;i++) {
            let member = node.members[i];
            if(member.type == "operation") {
                this.luaC.write(this.outBufLua,`function __BINDINGS__.${node.name}.${member.name}`);
                if(funcSig[member.name].length > 1) {
                    this.luaC.write(this.outBufLua,`__internal${member.arguments.length}`);
                }
                this.luaC.write(this.outBufLua,`(`);
                this.writeLuaArgs(this.outBufLua,member.arguments,false);
                this.luaC.write(this.outBufLua,`)`);

                if(JsImpl) {
                    this.luaC.write(this.outBufLua,`error("Unimplemented -> ${node.name}::${member.name}()")`);
                }
                else {
                    for(let j=0;j < member.arguments.length;j++) {
                        this.convertLuaToCPP_Pre(this.outBufLua,member.arguments[j],j);
                    }

                    this.luaC.write(this.outBufLua,`local ret = `);
                    this.luaC.write(this.outBufLua,`__FUNCS__.${this.mangleFunctionName(member,node.name)}(`);

                    this.writeLuaArgs(this.outBufLua,member.arguments,false,true);
                    this.luaC.write(this.outBufLua,")");

                    for(let j=0;j < member.arguments.length;j++) {
                        this.convertLuaToCPP_Post(this.outBufLua,member.arguments[j],j);
                    }

                    this.convertCPPToLuaReturn(this.outBufLua,member.idlType,"ret");
                }

                this.luaC.write(this.outBufLua," end");
                this.luaC.newLine(this.outBufLua);

                if(JsImpl) {
                    this.luaC.write(this.outBufLua,`function __CFUNCS__.${this.mangleFunctionName(member,node.name,true)}(`);
                    this.writeLuaArgs(this.outBufLua,member.arguments,false);
                    this.luaC.write(this.outBufLua,`)`);
                    
                    for(let j=0;j < member.arguments.length;j++) {
                        this.convertLuaToCPP_Pre(this.outBufLua,member.arguments[j],j);
                    }
    
                    this.luaC.write(this.outBufLua,`local ret = __BINDINGS__.${node.name}.${member.name}(`);
                    this.writeLuaArgs(this.outBufLua,member.arguments,false,true);
                    this.luaC.write(this.outBufLua,`)`);
                    
                    for(let j=0;j < member.arguments.length;j++) {
                        this.convertLuaToCPP_Post(this.outBufLua,member.arguments[j],j);
                    }

                    this.convertCPPToLuaReturn(this.outBufLua,member.idlType,"ret");
    
                    this.luaC.write(this.outBufLua," end");
                    this.luaC.newLine(this.outBufLua);
                }
            }
            else if(member.type == "attribute") {
                this.luaC.write(this.outBufLua,`function __BINDINGS__.${node.name}.__specialIndex.${member.name}(self,k) `);
                this.luaC.write(this.outBufLua,`local ret = __FUNCS__.${this.mangleIndexerName(member,node.name,false)}()`);
                this.convertCPPToLuaReturn(this.outBufLua,member.idlType,"ret");
                this.luaC.writeLn(this.outBufLua,` end`);

                this.luaC.write(this.outBufLua,`function __BINDINGS__.${node.name}.__specialNewIndex.${member.name}(self,k,v) `);
                this.convertLuaToCPP_Pre(this.outBufLua,{name: "v",idlType: member.idlType},0);
                this.luaC.write(this.outBufLua,`__FUNCS__.${this.mangleIndexerName(member,node.name,true)}(`);
                this.convertLuaToCPP_Arg(this.outBufLua,{name: "v",idlType: member.idlType},0);
                this.luaC.write(this.outBufLua,`)`);
                this.convertLuaToCPP_Post(this.outBufLua,{name: "v",idlType: member.idlType},0);
                this.luaC.writeLn(this.outBufLua,` end`);
            }
        }

        for(let ident in funcSig) {
            let memberData = funcSig[ident];

            if(memberData.length > 1) {
                // needs resolution

                this.luaC.write(this.outBufLua,`function __BINDINGS__.${node.name}.${ident}(`);
                let maxArg = Math.max(...memberData);
                for(let i=0;i < maxArg;i++) {
                    this.luaC.write(this.outBufLua,`arg${i}`);
                    if((i+1) !== maxArg) {
                        this.luaC.write(this.outBufLua,",");
                    }
                }
                this.luaC.write(this.outBufLua,") ");

                memberData.sort().reverse(); // I'm lazy

                this.luaC.write(this.outBufLua,"if ");
                for(let i=0;i < memberData.length;i++) {
                    if(memberData[i] != 0) {
                        this.luaC.write(this.outBufLua,`arg${memberData[i]-1} ~= nil then `);
                    }
                    this.luaC.write(this.outBufLua,`return __BINDINGS__.${node.name}.${ident}__internal${memberData[i]}(`);
                    for(let j=0;j < memberData[i];j++) {
                        this.luaC.write(this.outBufLua,`arg${j}`);
                        if((j+1) !== memberData[i]) {
                            this.luaC.write(this.outBufLua,",");
                        }
                    }
                    this.luaC.write(this.outBufLua,") ");
                    if((i+1) !== memberData.length) {
                        if(memberData[i+1] != 0) {
                            this.luaC.write(this.outBufLua,"elseif ");
                        }
                        else {
                            this.luaC.write(this.outBufLua,"else ");
                        }
                    }
                }
                this.luaC.writeLn(this.outBufLua,"end end");
            }
        }

        this.luaC.outdent(this.outBufLua); this.luaC.newLine(this.outBufLua);
    }

    walkNamespaceCPP(node: webidl.NamespaceType) {
        let JsImpl = this.getExtendedAttribute("JSImplementation",node.extAttrs);

        if(JsImpl) {
            for(let i=0;i < node.members.length;i++) {
                let member = node.members[i];
                if(member.type == "operation") {
                    this.cppC.write(this.outBufCPP,`extern "C" ${this.idlTypeToCType(member.idlType,node.extAttrs,true)} ${this.mangleFunctionName(member,node.name,true)}(`);
                    this.writeCArgs(this.outBufCPP,member.arguments,true,false);
                    this.cppC.writeLn(this.outBufCPP,`) __CFUNC(${this.mangleFunctionName(member,node.name,true)});`);
                }
            }

            if(node.name !== "global") {
                this.cppC.write(this.outBufCPP,`namespace ${node.name} {`);
            }
            this.cppC.indent();
            this.cppC.newLine(this.outBufCPP);

            for(let i=0;i < node.members.length;i++) {
                let member = node.members[i];
                if(member.type == "operation") {
                    this.cppC.write(this.outBufCPP,`${this.idlTypeToCType(member.idlType,node.extAttrs,true)} `);
                    this.cppC.write(this.outBufCPP,`${member.name}(`);
                    this.writeCArgs(this.outBufCPP,member.arguments,true,false);
                    this.cppC.write(this.outBufCPP,`) {`);

                    if(member.idlType.idlType !== "void") {
                        this.cppC.write(this.outBufCPP,"return");
                    }
                    this.cppC.write(this.outBufCPP,` `);

                    this.cppC.write(this.outBufCPP,`${this.mangleFunctionName(member,node.name,true)}(`);
                    this.writeCArgs(this.outBufCPP,member.arguments,false,false);
                    this.cppC.write(this.outBufCPP,");");

                    this.cppC.write(this.outBufCPP," };");
                    this.cppC.newLine(this.outBufCPP);
                }
            }
            
            this.cppC.outdent(this.outBufCPP)
            if(node.name !== "global") {
                this.cppC.write(this.outBufCPP,"};");
            }
            this.cppC.newLine(this.outBufCPP);
        }
        else {
            for(let i=0;i < node.members.length;i++) {
                let member = node.members[i];
                if(member.type == "operation") {
                    let Value = this.getExtendedAttribute("Value",member.extAttrs);
                    this.cppC.write(this.outBufCPP,`export extern "C" ${this.idlTypeToCType(member.idlType,member.extAttrs,true)} ${this.mangleFunctionName(member,node.name)}(`);
                    this.writeCArgs(this.outBufCPP,member.arguments,true,false);
                    this.cppC.write(this.outBufCPP,`) {`);
                    if(Value) {
                        this.cppC.write(this.outBufCPP,`static ${this.idlTypeToCType(member.idlType,[],false,true)} temp; return (temp = `);
                    }
                    else if(member.idlType.idlType !== "void") {
                        this.cppC.write(this.outBufCPP,"return");
                    }
                    this.cppC.write(this.outBufCPP,` `);
                    if(node.name === "global") {
                        this.cppC.write(this.outBufCPP,`${member.name}`);
                    }
                    else {
                        this.cppC.write(this.outBufCPP,`${node.name}::${member.name}`);
                    }
                    this.cppC.write(this.outBufCPP,`(`);
                    this.writeCArgs(this.outBufCPP,member.arguments,false,false,true);
                    this.cppC.write(this.outBufCPP,`) `);
                    if(Value && (member.name !== node.name)) {
                        this.cppC.write(this.outBufCPP,`, &temp)`);
                    }
                    this.cppC.write(this.outBufCPP,`;`);
                    this.cppC.write(this.outBufCPP,`};`);
                    this.cppC.newLine(this.outBufCPP);
                }
                else if(member.type == "attribute") {
                    this.cppC.write(this.outBufCPP,`export extern "C" ${this.idlTypeToCType(member.idlType,member.extAttrs,true)} ${this.mangleIndexerName(member,node.name,false)}(${node.name}* self) {`);
                    this.cppC.write(this.outBufCPP,`return `);
                    if(this.hasExtendedAttribute("Value",member.extAttrs)) {
                        this.cppC.write(this.outBufCPP,"&");
                    }
                    if(node.name === "global") {
                        this.cppC.write(this.outBufCPP,`${member.name}`);
                    }
                    else {
                        this.cppC.write(this.outBufCPP,`${node.name}::${member.name}`);
                    }
                    this.cppC.write(this.outBufCPP,`; `);
                    this.cppC.writeLn(this.outBufCPP,`};`);
                    
                    this.cppC.write(this.outBufCPP,`export extern "C" void ${this.mangleIndexerName(member,node.name,true)}(${node.name}* self,${this.idlTypeToCType(member.idlType,member.extAttrs,true)} val) {`);
                    if(node.name === "global") {
                        this.cppC.write(this.outBufCPP,`${member.name}`);
                    }
                    else {
                        this.cppC.write(this.outBufCPP,`${node.name}::${member.name}`);
                    }
                    this.cppC.write(this.outBufCPP,` = `);
                    if(this.hasExtendedAttribute("Value",member.extAttrs)) {
                        this.cppC.write(this.outBufCPP,"*");
                    }
                    this.cppC.write(this.outBufCPP,`val;`);
                    this.cppC.writeLn(this.outBufCPP,`};`);
                }
            }
        }
    }
}

// let infile  = process.argv[2] || (__dirname + "/../test/test.idl");
// let outfile_lua = process.argv[3] || (__dirname + "/../test/test_bind.lua");
// let outfile_cpp = process.argv[3] || (__dirname + "/../test/test_bind.cpp");

// let idl = fs.readFileSync(infile);

// // console.log(JSON.stringify(ast,null,4));

// let inst = new WebIDLBinder(idl.toString(),BinderMode.WEBIDL_CPP,true);
// inst.buildOut()
// fs.writeFileSync(outfile_lua,inst.outBufLua.join(""));
// fs.writeFileSync(outfile_cpp,inst.outBufCPP.join(""));

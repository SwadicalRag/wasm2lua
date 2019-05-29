import * as webidl from "webidl2"
import { StringCompiler } from "./stringcompiler";
import * as fs from "fs"
import { O_NOCTTY } from "constants";

export class WebIDLBinder {
    luaC = new StringCompiler();
    cppC = new StringCompiler();
    outBufLua: string[] = [];
    outBufCPP: string[] = [];
    ast: webidl.IDLRootType[];

    static CTypeRenames: {[type: string]: string} = {
        
    };

    constructor(public source: string) {
        this.ast = webidl.parse(source);

        this.buildOut();
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

    idlTypeToCType(idlType: webidl.IDLTypeDescription,extAttrs: webidl.ExtendedAttributes[] = []) {
        let prefixes = "";
        let suffixes = "";

        if(this.hasExtendedAttribute("Const",extAttrs)) {
            prefixes += "const ";
        }
        if(this.hasExtendedAttribute("Ref",extAttrs)) {
            suffixes += "*";
        }

        let body = idlType.idlType as string;
        if(WebIDLBinder.CTypeRenames[body]) {
            body = WebIDLBinder.CTypeRenames[body];
        }

        return `${prefixes} ${body} ${suffixes}`.replace(/\s+/g," ").trim();
    }

    buildOut() {
        this.luaC.writeLn(this.outBufLua,"local cfuncs = {}")
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
        let JsImpl = this.getExtendedAttribute("JSImplementation",node.extAttrs);

        let hasConstructor = false;

        this.luaC.writeLn(this.outBufLua,`${node.name} = {__cache = {}} ${node.name}.__index = ${node.name}`);

        this.luaC.write(this.outBufLua,`setmetatable(${node.name},{__call = function(self)`)
        this.luaC.write(this.outBufLua,`local ins = setmetatable({__ptr = 0},self)`)
        this.luaC.write(this.outBufLua,`ins:${node.name}()`)
        this.luaC.write(this.outBufLua,`return ins`)
        this.luaC.write(this.outBufLua,` end})`)

        this.luaC.indent(); this.luaC.newLine(this.outBufLua);

        if(JsImpl) {
            this.cppC.writeLn(this.outBufCPP,`class ${node.name};`);
        }

        for(let i=0;i < node.members.length;i++) {
            let member = node.members[i];
            if(member.type == "operation") {
                if(member.name == node.name) {
                    hasConstructor = true;
                }

                if(member.name == node.name) {
                    this.cppC.write(this.outBufCPP,`extern "C" ${node.name}* ${this.mangleFunctionName(member,node.name)}(`);
                }
                else {
                    this.cppC.write(this.outBufCPP,`extern "C" ${this.idlTypeToCType(member.idlType,member.extAttrs)} ${this.mangleFunctionName(member,node.name)}(${node.name}* self`);
                }
                for(let j=0;j < member.arguments.length;j++) {
                    this.cppC.write(this.outBufCPP,",");
                    this.cppC.write(this.outBufCPP,`${this.idlTypeToCType(member.arguments[j].idlType,member.arguments[j].extAttrs)} ${member.arguments[j].name}`);
                }
                this.cppC.write(this.outBufCPP,`) {return `);
                if(member.name == node.name) {
                    this.cppC.write(this.outBufCPP,`new ${member.name}`);
                }
                else {
                    this.cppC.write(this.outBufCPP,`self->${member.name}`);
                }
                this.cppC.write(this.outBufCPP,`(`);
                for(let j=0;j < member.arguments.length;j++) {
                    this.cppC.write(this.outBufCPP,`${member.arguments[j].name}`);
                    if((j+1) !== member.arguments.length) {
                        this.cppC.write(this.outBufCPP,",");
                    }
                }
                this.cppC.write(this.outBufCPP,`); };`);
                this.cppC.newLine(this.outBufCPP);

                if(!JsImpl || (node.name == member.name)) {
                    this.luaC.write(this.outBufLua,`function ${node.name}:${member.name}(`);
                    for(let j=0;j < member.arguments.length;j++) {
                        this.luaC.write(this.outBufLua,`${member.arguments[j].name}`);
                        if((j+1) !== member.arguments.length) {
                            this.luaC.write(this.outBufLua,",");
                        }
                    }
                    this.luaC.write(this.outBufLua,`)`);

                    if(member.name == node.name) {
                        this.luaC.write(this.outBufLua,`self.__ptr = `);
                    }
                    else {
                        this.luaC.write(this.outBufLua,`return `);
                    }

                    this.luaC.write(this.outBufLua,`${this.mangleFunctionName(member,node.name)}(self.__ptr`);
                    for(let j=0;j < member.arguments.length;j++) {
                        this.luaC.write(this.outBufLua,",");
                        this.luaC.write(this.outBufLua,`${member.arguments[j].name}`);
                    }
                    this.luaC.write(this.outBufLua,")");

                    this.luaC.write(this.outBufLua," end");
                    this.luaC.newLine(this.outBufLua);
                }

                if(JsImpl && (member.name !== node.name)) {
                    this.luaC.write(this.outBufLua,`function cfuncs.${this.mangleFunctionName(member,node.name,true)}(selfPtr`);
                    for(let j=0;j < member.arguments.length;j++) {
                        this.luaC.write(this.outBufLua,",");
                        this.luaC.write(this.outBufLua,`${member.arguments[j].name}`);
                    }
                    this.luaC.write(this.outBufLua,`)`);
    
                    this.luaC.write(this.outBufLua,`local self = ${node.name}.__cache[selfPtr] return self.${member.name}(self`);
                    for(let j=0;j < member.arguments.length;j++) {
                        this.luaC.write(this.outBufLua,",");
                        this.luaC.write(this.outBufLua,`${member.arguments[j].name}`);
                    }
                    this.luaC.write(this.outBufLua,`)`);
    
                    this.luaC.write(this.outBufLua," end");
                    this.luaC.newLine(this.outBufLua);
                }
            }
        }

        if(JsImpl) {
            for(let i=0;i < node.members.length;i++) {
                let member = node.members[i];
                if(member.type == "operation") {
                    if(member.name == node.name) {continue;}
                    this.cppC.write(this.outBufCPP,`extern "C" ${this.idlTypeToCType(member.idlType,node.extAttrs)} ${this.mangleFunctionName(member,node.name,true)}(${node.name}* self`);
                    for(let j=0;j < member.arguments.length;j++) {
                        this.cppC.write(this.outBufCPP,",");
                        this.cppC.write(this.outBufCPP,`${this.idlTypeToCType(member.arguments[j].idlType,member.arguments[j].extAttrs)} ${member.arguments[j].name}`);
                    }
                    this.cppC.writeLn(this.outBufCPP,`);`);
                }
            }

            this.cppC.writeLn(this.outBufCPP,`class ${node.name} {`);
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

                    this.cppC.write(this.outBufCPP,`${this.idlTypeToCType(member.idlType,node.extAttrs)} `);
                    this.cppC.write(this.outBufCPP,`${member.name}(`);
                    for(let j=0;j < member.arguments.length;j++) {
                        this.cppC.write(this.outBufCPP,`${this.idlTypeToCType(member.arguments[j].idlType,member.arguments[j].extAttrs)} ${member.arguments[j].name}`);
                        if((j+1) !== member.arguments.length) {
                            this.cppC.write(this.outBufCPP,",");
                        }
                    }
                    this.cppC.write(this.outBufCPP,`) {`);

                    this.cppC.write(this.outBufCPP,`return `);

                    this.cppC.write(this.outBufCPP,`${this.mangleFunctionName(member,node.name,true)}(this`);
                    for(let j=0;j < member.arguments.length;j++) {
                        this.cppC.write(this.outBufCPP,",");
                        this.cppC.write(this.outBufCPP,`${member.arguments[j].name}`);
                    }
                    this.cppC.write(this.outBufCPP,");");

                    this.cppC.write(this.outBufCPP," };");
                    this.cppC.newLine(this.outBufCPP);
                }
            }
            
            this.cppC.outdent(this.outBufCPP)
            this.cppC.write(this.outBufCPP,"};");
            this.cppC.newLine(this.outBufCPP);
        }

        if(!hasConstructor) {
            this.luaC.writeLn(this.outBufLua,`function ${node.name}:${node.name}() error("Class ${node.name} has no WebIDL constructor and therefore cannot be instantiated via Lua") end`)
        }

        this.luaC.outdent(this.outBufCPP); this.luaC.newLine(this.outBufLua);
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
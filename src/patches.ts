const fs = require("fs");
const path = require("path");
const Module = require("module");

let origRequire = Module.prototype.require;
Module.prototype.require = function(request) {
    const absPath = Module._resolveFilename(request, this);
    const filename = path.relative(__dirname,absPath);
    
    if(filename == "../node_modules/@webassemblyjs/wasm-parser/lib/decoder.js") {
        fs.writeFileSync(absPath,fs.readFileSync(__dirname + "/../resources/patches/decoder.js"));
    }
    else if(filename == "../node_modules/@webassemblyjs/leb128/lib/leb.js") {
        fs.writeFileSync(absPath,fs.readFileSync(__dirname + "/../resources/patches/leb.js"));
    }

    return origRequire.apply(this, arguments);
};

const path = require("path");
const Module = require("module");
let origRequire = Module.prototype.require;
Module.prototype.require = function (request) {
    const absPath = Module._resolveFilename(request, this);
    const filename = path.relative(__dirname, absPath).replace(/\\/g, "/");
    if (filename == "../node_modules/@webassemblyjs/wasm-parser/lib/decoder.js") {
        return require("./../resources/patches/decoder.js");
    }
    else if (filename == "../node_modules/@webassemblyjs/leb128/lib/leb.js") {
        return require("./../resources/patches/leb.js");
    }
    else if (filename == "../node_modules/luamin/luamin.js") {
        return require("./../resources/patches/luamin.js");
    }
    return origRequire.apply(this, arguments);
};
//# sourceMappingURL=patches.js.map
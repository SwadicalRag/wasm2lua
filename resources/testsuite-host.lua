local module = dofile("test/test.lua")

module.imports.env = {
    abort = function()
        error "ABORT"
    end,
}

module.init()

if module.exports._start then
    module.exports._start()
end

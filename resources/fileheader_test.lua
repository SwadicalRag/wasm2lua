ffi = require("ffi")

dofile("test.lua")

local function runTest(num,func,args,result)
    print(__MODULES__.UNKNOWN[func])
end


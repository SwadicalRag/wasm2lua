ffi = require("ffi")

local dir = debug.getinfo(1, "S").source:sub(2):match("(.*/)")

dofile(dir.."test.lua")

local function checkResults(expected,results)
    if #expected ~= #results then
        return false
    end
    for i=1,#expected do
        if expected[i] ~= results[i] then
            return false
        end
    end
    return true
end

local function runTest(num,func,args,expected)

    local results

    local function printResults(name,list)
        local str_list = {}
        for i=1,#list do
            str_list[i] = tostring(list[i])
        end
        print("\t" .. name .. ": " .. table.concat(str_list,","))
    end

    local success, error = pcall(function()

        results = {__MODULES__.UNKNOWN[func](unpack(args))}

        if type(expected) == "table" and not checkResults(expected,results) then
            print()
            print("BAD RESULT -- LINE " .. num .. " -- " .. func)
            printResults("Expected",expected)
            printResults("Received",results)
        end
    end)

    if type(expected)=="string" then
        if success then
            print()
            print(">>>  TEST @ LINE " .. num .. " FAIL (NO TRAP)")
            printResults("Expected",expected)
            printResults("Received",results)
        end
    elseif not success then
        print()
        print(">>>  TEST @ LINE " .. num .. " FAIL (TRAP)")
        printResults("Expected",expected)
        printResults("Received",error)
    end
end

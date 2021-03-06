ffi = require("ffi")

local dir = debug.getinfo(1, "S").source:sub(2):match("(.*/)")

local MODULE = dofile(dir..TEST_FILE)
MODULE.init()

local function checkResults(expected,results)
    if #expected ~= #results then
        return false
    end
    for i=1,#expected do
        if expected[i] ~= expected[i] then
            return results[i] ~= results[i]
        elseif type(expected[i]) == "table" or math.abs(expected[i]) == math.huge then
            return results[i] == expected[i]
        elseif math.abs((results[i] / expected[i]) - 1) > .0000001 then
            return false
        end
    end
    return true
end

local function invoke(func,args)
    return {MODULE.exports[func](unpack(args))}
end

local function runTest(num,func,args,expected)

    local results

    local function printResults(name,list)
        local str
        if type(list)=="string" then
            str = list
        else
            local str_list = {}
            for i=1,#list do
                str_list[i] = tostring(list[i])
            end
            str = table.concat(str_list,",")
        end
        print("\t" .. name .. ": " .. str)
    end

    local success, error = pcall(function()

        results = invoke(func,args)

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
            print("NO TRAP -- LINE " .. num .. " -- " .. func)
            printResults("Expected",expected)
            printResults("Received",results)
        end
    elseif not success then
        print()
        print("TRAP -- LINE " .. num .. " -- " .. func)
        printResults("Expected",expected)
        printResults("Received",error)
    end
end

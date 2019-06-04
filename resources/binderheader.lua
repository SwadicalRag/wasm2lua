local vm = {}

local rawget = rawget
local rawset = rawset

function vm.freeString(ptr)
    __FREE__(ptr)
end

function vm.readString(ptr)
    local out = {}

    local i = 0
    while true do
        local c = __MEMORY_READ_8__(module.memory,ptr + i)
        i = i + 1

        if c ~= 0 then
            out[#out + 1] = string.char(c)
        else
            break
        end
    end

    return table.concat(out,"")
end

function vm.stringify(str)
    local ptr = __MALLOC__(#str)

    for i=1,#str do
        __MEMORY_WRITE_8__(module.memory,ptr + i - 1,str:byte(i,i))
    end

    return ptr
end

function vm.createClass(tbl)
    tbl.__cache = {}
    tbl.__specialIndex = {}
    tbl.__specialNewIndex = {}

    function tbl:__index(k)
        if tbl.__specialIndex[k] then
            return tbl.__specialIndex[k](self)
        end

        if tbl[k] then return tbl[k] end

        return nil
    end

    function tbl:__newindex(k,v)
        if tbl.__specialNewIndex[k] then
            return tbl.__specialNewIndex[k](self,v)
        end

        rawset(self,k,v)
    end
end

function vm.createNamespace()
    local meta = {}
    meta.__specialIndex = {}
    meta.__specialNewIndex = {}

    function meta:__index(k)
        if k == "__specialIndex" then return meta.__specialIndex end
        if k == "__specialNewIndex" then return meta.__specialNewIndex end

        if meta.__specialIndex[k] then
            return meta.__specialIndex[k](self)
        end

        return nil
    end

    function meta:__newindex(k,v)
        if k == "__specialIndex" then return end
        if k == "__specialNewIndex" then return end

        if meta.__specialNewIndex[k] then
            return meta.__specialNewIndex[k](self,v)
        end

        rawset(self,k,v)
    end

    return setmetatable({},meta)
end

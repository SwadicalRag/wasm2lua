local rawget = rawget
local rawset = rawset

function __BINDER__.freeString(ptr)
    __FREE__(ptr)
end

function __BINDER__.readString(ptr)
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

function __BINDER__.stringify(str)
    local ptr = __MALLOC__(#str + 1)

    for i=1,#str do
        __MEMORY_WRITE_8__(module.memory,ptr + i - 1,str:byte(i,i))
    end
    __MEMORY_WRITE_8__(module.memory,ptr + #str,0)

    return ptr
end

function __BINDER__.createClass(tbl,tblName)
    tbl.__cache = {}
    tbl.__specialIndex = {}
    tbl.__specialNewIndex = {}

    function tbl:__tostring()
        if self.__ptr == 0 then
            return string.format("wasm.%s: NULL",tblName)
        else
            return string.format("wasm.%s: 0x%08x",tblName,self.__ptr)
        end
    end

    function tbl:__eq(obj2)
        -- TODO: operator overload
        return self.__ptr == obj2.__ptr
    end

    function tbl:__index(k)
        if tbl.__specialIndex[k] then
            return tbl.__specialIndex[k](self)
        end

        if tbl[k] then return tbl[k] end

        return nil
    end

    function tbl:__newindex(k,v)
        if tbl.__specialNewIndex[k] then
            return tbl.__specialNewIndex[k](self,k,v)
        end

        rawset(self,k,v)
    end
end

function __BINDER__.createNamespace()
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
            return meta.__specialNewIndex[k](self,k,v)
        end

        rawset(self,k,v)
    end

    return setmetatable({},meta)
end

function __BINDER__.ptrToClass(ptr,classBase)
    if type(ptr) == "number" then
        if not classBase.__cache[ptr] then
            classBase.__cache[ptr] = setmetatable({__ptr = ptr},classBase)
        end
        
        return classBase.__cache[ptr]
    else
        return ptr
    end
end

function __BINDER__.luaToWasmArrayInternal(interface,tbl)
    local wasmPtr = interface.new(#tbl)

    if interface.isClass then
        for i=1,#tbl do
            interface.set(wasmPtr,i-1,tbl[i].__ptr)
        end
    else
        for i=1,#tbl do
            interface.set(wasmPtr,i-1,tbl[i])
        end
    end

    return wasmPtr
end

function __BINDER__.wasmToWrappedLuaArrayConvertInternal(out,interface,wasmPtr)
    if getmetatable(out) then return end

    for i=1,#out do
        out[i] = nil
    end

    if interface.isClass then
        setmetatable(out,{
            __index = function(self,idx)
                assert(type(idx) == "number","Array indexer must be a number")
                return __BINDER__.ptrToClass(interface.get(wasmPtr,idx-1))
            end,
            __newindex = function(self,idx,val)
                assert(type(idx) == "number","Array indexer must be a number")
                interface.set(wasmPtr,idx-1,val.__ptr)
            end,
        })
    else
        setmetatable(out,{
            __index = function(self,idx)
                assert(type(idx) == "number","Array indexer must be a number")
                return interface.get(wasmPtr,idx-1)
            end,
            __newindex = function(self,idx,val)
                assert(type(idx) == "number","Array indexer must be a number")
                interface.set(wasmPtr,idx-1,val)
            end,
        })
    end

    return out
end

function __BINDER__.wasmToWrappedLuaArrayInternal(interface,wasmPtr)
    return __BINDER__.wasmToWrappedLuaArrayConvertInternal({},interface,wasmPtr,len)
end

function __BINDER__.wasmToLuaArrayInternal(interface,wasmPtr,len)
    local out = {}

    if interface.isClass then
        for i=1,len do
            out[i] = __BINDER__.ptrToClass(interface.get(wasmPtr,i-1))
        end
    else
        for i=1,len do
            out[i] = interface.get(wasmPtr,i-1)
        end
    end

    return out
end

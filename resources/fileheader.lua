__MODULES__ = __MODULES__ or {}
__GLOBALS__ = __GLOBALS__ or {}

local function __STACK_POP__(__STACK__)
    local v = __STACK__[#__STACK__]
    __STACK__[#__STACK__] = nil
    return v
end

local function __MEMORY_ALLOC__(pages)
    local mem = {}
    for i = 1,pages * 64 * 1024 do
        mem[i-1] = 0
    end
    return mem
end

local function __MEMORY_READ_8__(mem,loc)
    return mem[loc]
end

local function __MEMORY_READ_16__(mem,loc)
    return bit.bor(mem[loc], bit.lshift(mem[loc + 1],8))
end

local function __MEMORY_READ_32__(mem,loc)
    return bit.bor(mem[loc], bit.lshift(mem[loc + 1],8), bit.lshift(mem[loc + 2],16), bit.lshift(mem[loc + 3],24))
end

local function __MEMORY_WRITE_8__(mem,loc,val)
    mem[loc] = bit.band(val,0xFF)
end

local function __MEMORY_WRITE_16__(mem,loc,val)
    mem[loc]     = bit.band(val,0xFF)
    mem[loc + 1] = bit.band(bit.rshift(val,8),0xFF)
end

local function __MEMORY_WRITE_32__(mem,loc,val)
    mem[loc]     = bit.band(val,0xFF)
    mem[loc + 1] = bit.band(bit.rshift(val,8),0xFF)
    mem[loc + 2] = bit.band(bit.rshift(val,16),0xFF)
    mem[loc + 3] = bit.band(bit.rshift(val,24),0xFF)
end

local function __MEMORY_INIT__(mem,loc,data)
    for i = 1, #data do
        mem[loc + i-1] = data:byte(i)
    end
end

local function __UNSIGNED__(value)
    if value < 0 then
        value = value + 4294967296
    end

    return value
end

local __LONG_INT_CLASS__ = {
    __index = {
        store = function(self,mem,loc)
            local low = self[1]
            local high = self[2]

            mem[loc]     = bit.band(low,0xFF)
            mem[loc + 1] = bit.band(bit.rshift(low,8),0xFF)
            mem[loc + 2] = bit.band(bit.rshift(low,16),0xFF)
            mem[loc + 3] = bit.band(bit.rshift(low,24),0xFF)

            mem[loc + 4] = bit.band(high,0xFF)
            mem[loc + 5] = bit.band(bit.rshift(high,8),0xFF)
            mem[loc + 6] = bit.band(bit.rshift(high,16),0xFF)
            mem[loc + 7] = bit.band(bit.rshift(high,24),0xFF)
        end
    }
}

local function __LONG_INT__(low,high)
    return setmetatable({low,high},__LONG_INT_CLASS__)
end

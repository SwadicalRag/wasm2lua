__MODULES__ = __MODULES__ or {}
__GLOBALS__ = __GLOBALS__ or {}

local function __STACK_POP__(__STACK__)
    local v = __STACK__[#__STACK__]
    __STACK__[#__STACK__] = nil
    return v
end

local function __MEMORY_ALLOC__(pages)
    local mem = {}
    for i=1,pages * 64 * 1024 do
        mem[i-1] = 0
    end
    return mem
end

local function __MEMORY_READ_8__(mem,loc)
    return mem[loc]
end

local function __MEMORY_READ_16__(mem,loc)
    return bit.lshift(mem[loc],8) + mem[loc + 1]
end

local function __MEMORY_READ_32__(mem,loc)
    return bit.lshift(mem[loc],24) + bit.lshift(mem[loc + 1],16) + bit.lshift(mem[loc + 2],8) + mem[loc + 3]
end

local function __MEMORY_WRITE_8__(mem,loc,val)
    mem[loc] = bit.band(val,0xFF)
end

local function __MEMORY_WRITE_16__(mem,loc,val)
    mem[loc] = bit.band(bit.rshift(val,8),0xFF)
    mem[loc + 1] = bit.band(val,0xFF)
end

local function __MEMORY_WRITE_32__(mem,loc,val)
    mem[loc] = bit.band(bit.rshift(val,24),0xFF)
    mem[loc + 1] = bit.band(bit.rshift(val,16),0xFF)
    mem[loc + 2] = bit.band(bit.rshift(val,8),0xFF)
    mem[loc + 3] = bit.band(val,0xFF)
end

local function __MEMORY_INIT__(mem,loc,data)
    print("todo memory init")
end
__MODULES__ = __MODULES__ or {}
__GLOBALS__ = __GLOBALS__ or {}

local function __STACK_POP__(__STACK__)
    local v = __STACK__[#__STACK__]
    __STACK__[#__STACK__] = nil
    return v
end

local function __MEMORY_GROW__(mem,pages)
    local old_pages = mem._page_count
    local old_data = mem.data

    mem._page_count = mem._page_count + pages
    mem._len = mem._page_count * 64 * 1024
    mem.data = ffi.new("uint8_t[?]",mem._page_count * 64 * 1024)
    ffi.copy(mem.data,old_data,old_pages * 64 * 1024)

    return old_pages
end

local function __MEMORY_READ_8__(mem,loc)
    assert((loc >= 0) and (loc < mem._len),"out of memory access")
    return mem.data[loc]
end

local function __MEMORY_READ_16__(mem,loc)
    assert((loc >= 0) and (loc < (mem._len - 1)),"out of memory access")
    return ffi.cast("uint16_t*",mem.data + loc)[0]
end

local function __MEMORY_READ_32__(mem,loc)
    assert((loc >= 0) and (loc < (mem._len - 3)),"out of memory access")
    return ffi.cast("uint32_t*",mem.data + loc)[0]
end

local function __MEMORY_READ_32F__(mem,loc)
    assert((loc >= 0) and (loc < (mem._len - 3)),"out of memory access")
    return ffi.cast("float*",mem.data + loc)[0]
end

local function __MEMORY_READ_64F__(mem,loc)
    assert((loc >= 0) and (loc < (mem._len - 7)),"out of memory access")
    return ffi.cast("double*",mem.data + loc)[0]
end

local function __MEMORY_WRITE_8__(mem,loc,val)
    assert((loc >= 0) and (loc < mem._len),"out of memory access")
    mem.data[loc] = val
end

local function __MEMORY_WRITE_16__(mem,loc,val)
    assert((loc >= 0) and (loc < (mem._len - 1)),"out of memory access")
    ffi.cast("uint16_t*",mem.data + loc)[0] = val
end

local function __MEMORY_WRITE_32__(mem,loc,val)
    assert((loc >= 0) and (loc < (mem._len - 3)),"out of memory access")
    ffi.cast("uint32_t*",mem.data + loc)[0] = val
end

local function __MEMORY_WRITE_32F__(mem,loc,val)
    assert((loc >= 0) and (loc < (mem._len - 3)),"out of memory access")
    ffi.cast("float*",mem.data + loc)[0] = val
end

local function __MEMORY_WRITE_64F__(mem,loc,val)
    assert((loc >= 0) and (loc < (mem._len - 7)),"out of memory access")
    ffi.cast("double*",mem.data + loc)[0] = val
end

local function __MEMORY_INIT__(mem,loc,data)
    assert(#data <= (mem._len - loc),"attempt to write more data than memory size")
    ffi.copy(mem.data + loc,data)
end

local function __MEMORY_ALLOC__(pages)
    local mem = {}
    mem.data = ffi.new("uint8_t[?]",pages * 64 * 1024)
    mem._page_count = pages
    mem._len = pages * 64 * 1024

    mem.write32 = __MEMORY_WRITE_32__

    return mem
end

local function __UNSIGNED__(value)
    if value < 0 then
        value = value + 4294967296
    end

    return value
end

local __LONG_INT_CLASS__

local function __LONG_INT__(low,high)
    return setmetatable({low,high},__LONG_INT_CLASS__)
end

__LONG_INT_CLASS__ = {
    __index = {
        store = function(self,mem,loc)
            local low = self[1]
            local high = self[2]

            __MEMORY_WRITE_32__(mem,loc,low)
            __MEMORY_WRITE_32__(mem,loc+4,high)
        end,
        load = function(self,mem,loc)
            local low =  __MEMORY_READ_32__(mem,loc)
            local high = __MEMORY_READ_32__(mem,loc+4)

            self[1] = low
            self[2] = high
        end,
        _shl = function(a,b)
            local shift = b[1]
            if shift < 0 then
                return __LONG_INT__(0,0)
            end
            local low =   a[1]
            local high =  a[2]
            -- TODO might be a better way to do this with rotates and masks...
            if shift >= 32 then
                high = bit.lshift(low,shift-32)
                return __LONG_INT__(0,high)
            else
                high = bit.lshift(high,shift)
                -- bits shifted from low part
                high = bit.bor(high, bit.rshift(low,32-shift))
                low = bit.lshift(low,shift)
                return __LONG_INT__(low,high)
            end
        end,
        _or = function(a,b)
            return __LONG_INT__(bit.bor(a[1],b[1]), bit.bor(a[2],b[2]))
        end
    }
}

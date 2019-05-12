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

    mem.write8 = __MEMORY_WRITE_8__
    mem.write16 = __MEMORY_WRITE_16__
    mem.write32 = __MEMORY_WRITE_32__

    mem.read8 = __MEMORY_READ_8__
    mem.read16 = __MEMORY_READ_16__
    mem.read32 = __MEMORY_READ_32__

    return mem
end

local function __UNSIGNED__(value)
    if value < 0 then
        value = value + 4294967296
    end

    return value
end

-- extra bit ops

local __clz_tab = {3, 2, 2, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0}
__clz_tab[0] = 4

local function __CLZ__(x)
    local n = 0
    if bit.band(x,0xFFFF0000) == 0 then n    = 16; x = bit.lshift(x,16) end
    if bit.band(x,0xFF000000) == 0 then n = n + 8; x = bit.lshift(x,8) end
    if bit.band(x,0xF0000000) == 0 then n = n + 4; x = bit.lshift(x,4) end
    n = n + __clz_tab[bit.rshift(x,28)]
    return n
end

local __ctz_tab = {}

for i = 0,31 do
    __ctz_tab[ bit.rshift( 125613361 * bit.lshift(1,i) , 27 ) ] = i
end

local function __CTZ__(x)
    if x == 0 then return 32 end
    return __ctz_tab[ bit.rshift( bit.band(x,-x) * 125613361 , 27 ) ]
end

local function __POPCNT__(x)
    -- the really cool algorithm uses a multiply that can overflow, so we're stuck with this
    -- TODO 256 bit LUT
    return -1
end

local __LONG_INT_CLASS__

local function __LONG_INT__(low,high)
    return setmetatable({low,high},__LONG_INT_CLASS__)
end

_G.__LONG_INT__ = __LONG_INT__

__LONG_INT_CLASS__ = {
    __tostring = function(self)
        return "__LONG_INT__("..self[1]..","..self[2]..")"
    end,
    __eq = function(a,b)
        return a[1]==b[1] and a[2]==b[2]
    end,
    __index = {
        store = function(self,mem,loc)
            assert((loc >= 0) and (loc < (mem._len - 7)),"out of memory access")

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
        store32 = function(self,mem,loc)
           __MEMORY_WRITE_32__(mem,loc,self[1])
        end,
        store16 = function(self,mem,loc)
            __MEMORY_WRITE_16__(mem,loc,self[1])
        end,
        store8 = function(self,mem,loc)
            __MEMORY_WRITE_8__(mem,loc,self[1])
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

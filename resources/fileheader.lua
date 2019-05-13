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
    if bit.band(x,-65536)     == 0 then n = 16;    x = bit.lshift(x,16) end
    if bit.band(x,-16777216)  == 0 then n = n + 8; x = bit.lshift(x,8) end
    if bit.band(x,-268435456) == 0 then n = n + 4; x = bit.lshift(x,4) end
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

local __popcnt_tab = {
      1,1,2,1,2,2,3,1,2,2,3,2,3,3,4,1,2,2,3,2,3,3,4,2,3,3,4,3,4,4,5,1,2,2,3,2,3,3,4,2,3,3,4,3,4,4,5,2,3,3,4,3,4,4,5,3,4,4,5,4,5,5,6,
    1,2,2,3,2,3,3,4,2,3,3,4,3,4,4,5,2,3,3,4,3,4,4,5,3,4,4,5,4,5,5,6,2,3,3,4,3,4,4,5,3,4,4,5,4,5,5,6,3,4,4,5,4,5,5,6,4,5,5,6,5,6,6,7,
    1,2,2,3,2,3,3,4,2,3,3,4,3,4,4,5,2,3,3,4,3,4,4,5,3,4,4,5,4,5,5,6,2,3,3,4,3,4,4,5,3,4,4,5,4,5,5,6,3,4,4,5,4,5,5,6,4,5,5,6,5,6,6,7,
    2,3,3,4,3,4,4,5,3,4,4,5,4,5,5,6,3,4,4,5,4,5,5,6,4,5,5,6,5,6,6,7,3,4,4,5,4,5,5,6,4,5,5,6,5,6,6,7,4,5,5,6,5,6,6,7,5,6,6,7,6,7,7,8
}
__popcnt_tab[0] = 0

local function __POPCNT__(x)
    -- the really cool algorithm uses a multiply that can overflow, so we're stuck with a LUT
    return __popcnt_tab[bit.band(x,255)]
    + __popcnt_tab[bit.band(bit.rshift(x,8),255)]
    + __popcnt_tab[bit.band(bit.rshift(x,16),255)]
    + __popcnt_tab[bit.rshift(x,24)]
end

-- division helpers

local function __DIVIDE_S__(a,b)
    local res_1 = a / b
    res_2 = math.floor(res_1)
    if res_1 ~= res_2 and res_2 < 0 then res_2 = res_2 + 1 end
    local int = bit.tobit(res_2)
    if res_2 ~= int then error("bad division") end
    return int
end

local function __DIVIDE_U__(a,b)
    local res = math.floor(__UNSIGNED__(a) / __UNSIGNED__(b))
    local int = bit.tobit(res)
    if res ~= int then error("bad division") end
    return int
end

local function __MODULO_S__(a,b)
    if b == 0 then error("bad modulo") end
    local res = math.abs(a) % math.abs(b)
    if a < 0 then  res = -res end
    return bit.tobit(res)
end

local function __MODULO_U__(a,b)
    if b == 0 then error("bad modulo") end
    local res = __UNSIGNED__(a) % __UNSIGNED__(b)
    return bit.tobit(res)
end

-- Multiply two 32 bit integers without busting due to precision loss on overflow
local function __MULTIPLY_CORRECT__(a,b)
    local a_low = bit.band(a,65535)
    local b_low = bit.band(b,65535)

    return bit.tobit(
        a_low * b_low +
        bit.lshift(a_low * bit.rshift(b,16),16) +
        bit.lshift(b_low * bit.rshift(a,16),16)
    )
end

-- Extra math functions for floats, stored in their own table since they're not likely to be used often.
local __FLOAT__ = {
    nearest = function(x)
        if x % 1 == .5 then
            -- Must round toward even in the event of a tie.
            local y = math.floor(x)
            return y + (y % 2)
        end
        return math.floor(x + .5)
    end,
    truncate = function(x)
        return x > 0 and math.floor(x) or math.ceil(x)
    end,
    min = function(x,y)
        if x ~= x or y ~= y then return 0 / 0 end
        return math.min(x,y)
    end,
    max = function(x,y)
        if x ~= x or y ~= y then return 0 / 0 end
        return math.max(x,y)
    end
}

local __LONG_INT_CLASS__

local function __LONG_INT__(low,high)
    return setmetatable({low,high},__LONG_INT_CLASS__)
end

_G.__LONG_INT__ = __LONG_INT__

__LONG_INT_CLASS__ = {
    __tostring = function(self)
        return "__LONG_INT__(" .. self[1] .. "," .. self[2] .. ")"
    end,
    __eq = function(a,b)
        return a[1] == b[1] and a[2] == b[2]
    end,
    __index = {
        store = function(self,mem,loc)
            assert((loc >= 0) and (loc < (mem._len - 7)),"out of memory access")

            local low = self[1]
            local high = self[2]

            __MEMORY_WRITE_32__(mem,loc,low)
            __MEMORY_WRITE_32__(mem,loc + 4,high)
        end,
        load = function(self,mem,loc)

            local low =  __MEMORY_READ_32__(mem,loc)
            local high = __MEMORY_READ_32__(mem,loc + 4)

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

-- pure lua memory lib

local function __MEMORY_GROW__(mem,pages)
    local old_pages = mem._page_count
    mem._len = (mem._page_count + pages) * 64 * 1024

    -- TODO: check if this exceeds the maximum memory size
    for i = 1,pages * 16 * 1024 do -- 16k cells = 64kb = 1 page
        mem.data[#mem.data + 1] = 0
    end

    mem._page_count = old_pages + pages
    return old_pages
end

-- Adapted from https://github.com/notcake/glib/blob/master/lua/glib/bitconverter.lua
-- with permission from notcake
local function UInt32ToFloat(int)
    local negative = int < 0 -- check if first bit is 0
    if negative then int = int - 0x80000000 end

    local exponent = bit_rshift(bit_band(int, 0x7F800000), 23) -- and capture lowest 9 bits
    local significand = bit_band(int, 0x007FFFFF) / (2 ^ 23) -- discard lowest 9 bits and turn into a fraction

    local float

    if exponent == 0 then
        -- special case 1
        float = significand == 0 and 0 or math_ldexp(significand,-126)
    elseif exponent == 0xFF then
        -- special case 2
        float = significand == 0 and math_huge or (math_huge - math_huge) -- inf or nan
    else
        float = math_ldexp(significand + 1,exponent - 127)
    end

    return negative and -float or float
end

local function FloatToUInt32(float)
    local int = 0

    -- wtf -0
    if (float < 0) or ((1 / float) < 0) then
        int = int + 0x80000000
        float = -float
    end

    local exponent = 0
    local significand = 0

    if float == math_huge then
        -- special case 2.1
        exponent = 0xFF
        -- significand stays 0
    elseif float ~= float then -- nan
        -- special case 2.2
        exponent = 0xFF
        significand = 1
    elseif float ~= 0 then
        significand,exponent = math_frexp(float)
        exponent = exponent + 126 -- limit to 8 bits (u get what i mean)

        if exponent <= 0 then
            -- denormal float

            significand = math_floor(significand * 2 ^ (23 + exponent) + 0.5)
            -- ^ convert to back to whole number

            exponent = 0
        else
            significand = math_floor((significand * 2 - 1) * 2 ^ 23 + 0.5)
            -- ^ convert to back to whole number
        end
    end

    int = int + bit_lshift(bit_band(exponent, 0xFF), 23) -- stuff high 8 bits with exponent (after first sign bit)
    int = int + bit_band(significand, 0x007FFFFF) -- stuff low 23 bits with significand

    return bit_tobit(int)
end

local function UInt32sToDouble(uint_low,uint_high)
    local negative = false
    -- check if first bit is 0
    if uint_high < 0 then
        uint_high = uint_high - 0x80000000
        -- set first bit to  0 ^
        negative = true
    end

    local exponent = bit_rshift(uint_high, 20) -- and capture lowest 11 bits
    local significand = (bit_band(uint_high, 0x000FFFFF) * 0x100000000 + uint_low) / (2 ^ 52) -- discard low bits and turn into a fraction

    local double = 0

    if exponent == 0 then
        -- special case 1
        double = significand == 0 and 0 or math_ldexp(significand,-1022)
    elseif exponent == 0x07FF then
        -- special case 2
        double = significand == 0 and math_huge or (math_huge - math_huge) -- inf or nan
    else
        double = math_ldexp(significand + 1,exponent - 1023)
    end

    return negative and -double or double
end

local function DoubleToUInt32s(double)
    local uint_low = 0
    local uint_high = 0

    -- wtf -0
    if (double < 0) or ((1 / double) < 0) then
        uint_high = uint_high + 0x80000000
        double = -double
    end

    local exponent = 0
    local significand = 0

    if double == math_huge then
        -- special case 2.1
        exponent = 0x07FF
        -- significand stays 0
    elseif double ~= double then -- nan
        -- special case 2.2
        exponent = 0x07FF
        significand = 1
    elseif double ~= 0 then
        significand,exponent = math_frexp(double)
        exponent = exponent + 1022 -- limit to 10 bits (u get what i mean)

        if exponent <= 0 then
            -- denormal double

            significand = math_floor(significand * 2 ^ (52 + exponent) + 0.5)
            -- ^ convert to back to whole number

            exponent = 0
        else
            significand = math_floor((significand * 2 - 1) * 2 ^ 52 + 0.5)
            -- ^ convert to back to whole number
        end
    end

    -- significand is partially in low and high uints
    uint_low = significand % 0x100000000
    uint_high = uint_high + bit_lshift(bit_band(exponent, 0x07FF), 20)
    uint_high = uint_high + bit_band(math_floor(significand / 0x100000000), 0x000FFFFF)

    return bit_tobit(uint_low), bit_tobit(uint_high)
end

--[[
    Float mapping overview:
    - mem._fp_map is a sparse map that indicates where floats and doubles are stored in memory.
    - The mapping system only works when floats are cell-aligned (the float or double's address is a multiple of 4).
    - Any memory write can update the map: writing a byte in a cell occupied by a float will force the entire cell to revert to an integer value.
    - In the interest of speed and local slot conservation, all constants have been inlined. Their values:
        - nil: Cell is occupied by integer data.
        -   1: Cell is occupied by a single-width float.
        -   2: Cell contains the low half of a double-width float. GUARANTEES that a (3) follows.
        -   3: Cell contains the high half of a double-width float. GUARANTEES that a (2) precedes.
]]

local function __MEMORY_READ_8__(mem,loc)
    assert((loc >= 0) and (loc < mem._len),"out of memory access")

    local cell_loc = bit_rshift(loc,2)
    local byte_loc = bit_band(loc,3)

    local cell_value
    local mem_t = mem._fp_map[cell_loc]
    if mem_t == nil then
        cell_value = mem.data[cell_loc]
    else
        if mem_t == 1 then
            cell_value = FloatToUInt32(mem.data[cell_loc])
        else
            local low, high = DoubleToUInt32s(mem.data[cell_loc])
            if mem_t == 2 then
                cell_value = low
            else
                cell_value = high
            end
        end
    end

    return bit_band(bit_rshift(cell_value, byte_loc * 8),255)
end

local function __MEMORY_READ_16__(mem,loc)
    assert((loc >= 0) and (loc < (mem._len - 1)),"out of memory access")
    -- 16 bit reads/writes are less common, they can be optimized later
    return bit_bor(
        __MEMORY_READ_8__(mem,loc),
        bit_lshift(__MEMORY_READ_8__(mem,loc + 1),8)
    )
end

local function __MEMORY_READ_32__(mem,loc)
    assert((loc >= 0) and (loc < (mem._len - 3)),"out of memory access")

    if bit_band(loc,3) == 0 then
        -- aligned read, fast path
        local cell_loc = bit_rshift(loc,2)

        local mem_t = mem._fp_map[cell_loc]
        if mem_t ~= nil then
            if mem_t == 1 then
                return FloatToUInt32(mem.data[cell_loc])
            else
                local low, high = DoubleToUInt32s(mem.data[cell_loc])
                if mem_t == 2 then
                    return low
                else
                    return high
                end
            end
        end

        local val = mem.data[cell_loc]
        -- It breaks in some way I don't understand if you don't normalize the value.
        return bit_tobit(val)
    else
        --print("bad alignment (read 32)",alignment)
        return bit_bor(
            __MEMORY_READ_8__(mem,loc),
            bit_lshift(__MEMORY_READ_8__(mem,loc + 1),8),
            bit_lshift(__MEMORY_READ_8__(mem,loc + 2),16),
            bit_lshift(__MEMORY_READ_8__(mem,loc + 3),24)
        )
    end
end

-- I also tried some weird shift/xor logic,
-- both had similar performance but I kept this becuase it was simpler.
local mask_table = {0xFFFF00FF,0xFF00FFFF,0x00FFFFFF}
mask_table[0] = 0xFFFFFF00
local function __MEMORY_WRITE_8__(mem,loc,val)
    assert((loc >= 0) and (loc < mem._len),"out of memory access")
    val = bit_band(val,255)

    local cell_loc = bit_rshift(loc,2)
    local byte_loc = bit_band(loc,3)

    local mem_t = mem._fp_map[cell_loc]
    local old_cell
    if mem_t == nil then
        -- fast path, the cell is already an integer
        old_cell = mem.data[cell_loc]
    else
        -- bad news, a float is stored here and we have to convert it to an integer
        mem._fp_map[cell_loc] = nil
        if mem_t == 1 then
            -- float
            old_cell = FloatToUInt32(mem.data[cell_loc])
        else
            -- double: we must also update the matching cell
            local low, high = DoubleToUInt32s(mem.data[cell_loc])
            if mem_t == 2 then
                -- this cell is the low half
                old_cell = low

                mem.data[cell_loc + 1] = high
                mem._fp_map[cell_loc + 1] = nil
            else
                -- this cell is the high half
                old_cell = high

                mem.data[cell_loc - 1] = low
                mem._fp_map[cell_loc - 1] = nil
            end
        end
    end

    old_cell = bit_band(old_cell, mask_table[byte_loc])
    local new_cell = bit_bor(old_cell, bit_lshift(val,byte_loc * 8))

    mem.data[cell_loc] = new_cell
end

local function __MEMORY_WRITE_16__(mem,loc,val)
    assert((loc >= 0) and (loc < (mem._len - 1)),"out of memory access")
    -- 16 bit reads/writes are less common, they can be optimized later
    __MEMORY_WRITE_8__(mem,loc,     val)
    __MEMORY_WRITE_8__(mem,loc + 1, bit_rshift(val,8))
end

local function __MEMORY_WRITE_32__(mem,loc,val)
    assert((loc >= 0) and (loc < (mem._len - 3)),"out of memory access")

    if bit_band(loc,3) == 0 then
        -- aligned write, fast path
        local cell_loc = bit_rshift(loc,2)
        mem._fp_map[cell_loc] = nil -- mark this cell as an integer
        mem.data[cell_loc] = val
    else
        --print("bad alignment (write 32)",alignment)
        __MEMORY_WRITE_8__(mem,loc,     val)
        __MEMORY_WRITE_8__(mem,loc + 1, bit_rshift(val,8))
        __MEMORY_WRITE_8__(mem,loc + 2, bit_rshift(val,16))
        __MEMORY_WRITE_8__(mem,loc + 3, bit_rshift(val,24))
    end
end

local function __MEMORY_READ_32F__(mem,loc)
    assert((loc >= 0) and (loc < (mem._len - 3)),"out of memory access")

    local cell_loc = bit_rshift(loc,2)
    local byte_loc = bit_band(loc,3)

    if byte_loc == 0 and mem._fp_map[cell_loc] == 1 then
        return mem.data[cell_loc]
    else
        -- Let __MEMORY_READ_32__ handle any issues.
        return UInt32ToFloat(__MEMORY_READ_32__(mem,loc))
    end
end

local function __MEMORY_READ_64F__(mem,loc)
    assert((loc >= 0) and (loc < (mem._len - 7)),"out of memory access")

    local cell_loc = bit_rshift(loc,2)
    local byte_loc = bit_band(loc,3)

    local mem_t = mem._fp_map[cell_loc]

    if byte_loc == 0 and mem_t == 2 then
        return mem.data[cell_loc]
    else
        -- Let __MEMORY_READ_32__ handle any issues.
        return UInt32sToDouble(__MEMORY_READ_32__(mem,loc),__MEMORY_READ_32__(mem,loc + 4))
    end
end

local function __MEMORY_WRITE_32F__(mem,loc,val)
    assert((loc >= 0) and (loc < (mem._len - 3)),"out of memory access")

    if bit_band(loc,3) == 0 then
        local cell_loc = bit_rshift(loc,2)
        mem._fp_map[cell_loc] = 1
        mem.data[cell_loc] = val
    else
        -- unaligned writes can't use the float map.
        __MEMORY_WRITE_32__(mem,loc,FloatToUInt32(val))
    end
end

local function __MEMORY_WRITE_64F__(mem,loc,val)
    assert((loc >= 0) and (loc < (mem._len - 7)),"out of memory access")

    if bit_band(loc,3) == 0 then
        local cell_loc = bit_rshift(loc,2)
        mem._fp_map[cell_loc] = 2
        mem.data[cell_loc] = val
        mem._fp_map[cell_loc + 1] = 3
        mem.data[cell_loc + 1] = val
    else
        -- unaligned writes can't use the float map.
        local low,high = DoubleToUInt32s(val)
        __MEMORY_WRITE_32__(mem,loc,low)
        __MEMORY_WRITE_32__(mem,loc + 4,high)
    end
end

local function __MEMORY_INIT__(mem,loc,data)
    for i = 1, #data do -- TODO RE-OPTIMIZE
        __MEMORY_WRITE_8__(mem, loc + i-1, data:byte(i))
    end
end

local function __MEMORY_ALLOC__(pages)
    local mem = {}
    mem.data = {}
    mem._page_count = pages
    mem._len = pages * 64 * 1024
    mem._fp_map = {}

    local cellLength = pages * 64 * 1024 -- 16k cells = 64kb = 1 page
    for i=0,cellLength - 1 do mem.data[i] = 0 end

    mem.write8 = __MEMORY_WRITE_8__
    mem.write16 = __MEMORY_WRITE_16__
    mem.write32 = __MEMORY_WRITE_32__

    mem.read8 = __MEMORY_READ_8__
    mem.read16 = __MEMORY_READ_16__
    mem.read32 = __MEMORY_READ_32__

    __SETJMP_STATES__[mem] = {}

    return mem
end

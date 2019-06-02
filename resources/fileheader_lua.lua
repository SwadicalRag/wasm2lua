-- pure lua memory lib

local function __MEMORY_GROW__(mem,pages)
    local old_pages = mem._page_count
    local new_pages = old_pages + pages

    -- check if new size exceeds the size limit
    if new_pages > mem._max_pages then
        return -1
    end

    -- 16k cells = 64kb = 1 page
    local cell_start = old_pages * 16 * 1024
    local cell_end = new_pages * 16 * 1024 - 1

    for i = cell_start, cell_end do 
        mem.data[i] = 0
    end

    mem._len = new_pages * 64 * 1024
    mem._page_count = new_pages
    return old_pages
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

local function __MEMORY_ALLOC__(pages, max_pages)
    local mem = {}
    mem.data = {}
    mem._page_count = pages
    mem._len = pages * 64 * 1024
    mem._fp_map = {}
    mem._max_pages = max_pages or 1024

    local cellLength = pages * 16 * 1024 -- 16k cells = 64kb = 1 page
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

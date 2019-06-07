-- ffi based memory lib

local ffi = ffi or require "ffi"
local ffi_new = ffi.new
local ffi_copy = ffi.copy
local ffi_cast = ffi.cast

local function __MEMORY_GROW__(mem,pages)
    local old_pages = mem._page_count
    local old_data = mem.data

    -- check if new size exceeds the size limit
    if old_pages + pages > mem._max_pages then
        return -1
    end

    mem._page_count = mem._page_count + pages
    mem._len = mem._page_count * 64 * 1024
    mem.data = ffi_new("uint8_t[?]",mem._page_count * 64 * 1024)
    ffi_copy(mem.data,old_data,old_pages * 64 * 1024)
    mem.dataF = ffi_cast("float*",mem.data)
    mem.dataD = ffi_cast("double*",mem.data)
    mem.dataI16 = ffi_cast("int16_t*",mem.data)
    mem.dataI32 = ffi_cast("int32_t*",mem.data)
    mem.dataU16 = ffi_cast("uint16_t*",mem.data)
    mem.dataU32 = ffi_cast("uint32_t*",mem.data)

    return old_pages
end

local function __MEMORY_READ_8__(mem,loc)
    assert((loc >= 0) and (loc < mem._len),"out of memory access")
    return mem.data[loc]
end

local function __MEMORY_READ_16__(mem,loc)
    assert((loc >= 0) and (loc < (mem._len - 1)),"out of memory access")

    if bit_band(loc,1) == 0 then
        return mem.dataU16[bit_rshift(loc,1)]
    else
        return ffi_cast("uint16_t*",mem.data + loc)[0]
    end
end

local function __MEMORY_READ_32__(mem,loc)
    assert((loc >= 0) and (loc < (mem._len - 3)),"out of memory access")

    if bit_band(loc,3) == 0 then
        return mem.dataI32[bit_rshift(loc,2)]
    else
        return ffi_cast("int32_t*",mem.data + loc)[0]
    end
end

local function __MEMORY_READ_32F__(mem,loc)
    assert((loc >= 0) and (loc < (mem._len - 3)),"out of memory access")

    if bit_band(loc,3) == 0 then
        return mem.dataF[bit_rshift(loc,2)]
    else
        return ffi_cast("float*",mem.data + loc)[0]
    end
end

local function __MEMORY_READ_64F__(mem,loc)
    assert((loc >= 0) and (loc < (mem._len - 7)),"out of memory access")

    if bit_band(loc,7) == 0 then
        return mem.dataD[bit_rshift(loc,3)]
    else
        return ffi_cast("double*",mem.data + loc)[0]
    end
end

local function __MEMORY_WRITE_8__(mem,loc,val)
    assert((loc >= 0) and (loc < mem._len),"out of memory access")
    mem.data[loc] = val
end

local function __MEMORY_WRITE_16__(mem,loc,val)
    assert((loc >= 0) and (loc < (mem._len - 1)),"out of memory access")

    if bit_band(loc,1) == 0 then
        mem.dataI16[bit_rshift(loc,1)] = val
    else
        ffi_cast("int16_t*",mem.data + loc)[0] = val
    end
end

local function __MEMORY_WRITE_32__(mem,loc,val)
    assert((loc >= 0) and (loc < (mem._len - 3)),"out of memory access")

    if bit_band(loc,3) == 0 then
        mem.dataI32[bit_rshift(loc,2)] = val
    else
        ffi_cast("int32_t*",mem.data + loc)[0] = val
    end
end

local function __MEMORY_WRITE_32F__(mem,loc,val)
    assert((loc >= 0) and (loc < (mem._len - 3)),"out of memory access")

    if bit_band(loc,3) == 0 then
        mem.dataF[bit_rshift(loc,2)] = val
    else
        ffi_cast("float*",mem.data + loc)[0] = val
    end
end

local function __MEMORY_WRITE_64F__(mem,loc,val)
    assert((loc >= 0) and (loc < (mem._len - 7)),"out of memory access")

    if bit_band(loc,7) == 0 then
        mem.dataD[bit_rshift(loc,3)] = val
    else
        ffi_cast("double*",mem.data + loc)[0] = val
    end
end

local function __MEMORY_INIT__(mem,loc,data)
    assert(#data <= (mem._len - loc),"attempt to write more data than memory size")
    ffi_copy(mem.data + loc,data)
end

local function __MEMORY_ALLOC__(pages,max_pages)
    local mem = {}
    mem.data = ffi_new("uint8_t[?]",pages * 64 * 1024)
    mem.dataF = ffi_cast("float*",mem.data)
    mem.dataD = ffi_cast("double*",mem.data)
    mem.dataI16 = ffi_cast("int16_t*",mem.data)
    mem.dataI32 = ffi_cast("int32_t*",mem.data)
    mem.dataU16 = ffi_cast("uint16_t*",mem.data)
    mem.dataU32 = ffi_cast("uint32_t*",mem.data)
    mem._page_count = pages
    mem._len = pages * 64 * 1024
    mem._max_pages = max_pages or 1024

    mem.write8 = __MEMORY_WRITE_8__
    mem.write16 = __MEMORY_WRITE_16__
    mem.write32 = __MEMORY_WRITE_32__

    mem.read8 = __MEMORY_READ_8__
    mem.read16 = __MEMORY_READ_16__
    mem.read32 = __MEMORY_READ_32__

    __SETJMP_STATES__[mem] = {}

    return mem
end

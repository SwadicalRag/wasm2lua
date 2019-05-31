-- ffi based memory lib

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

    __SETJMP_STATES__[mem] = {}

    return mem
end

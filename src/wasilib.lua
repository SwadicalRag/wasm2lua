
local __WASI_ESUCCESS = 0
local __WASI_EBADF = 8

local __WASI_FILETYPE_UNKNOWN = 0
local __WASI_FILETYPE_BLOCK_DEVICE = 1
local __WASI_FILETYPE_CHARACTER_DEVICE = 2
local __WASI_FILETYPE_DIRECTORY = 3
local __WASI_FILETYPE_REGULAR_FILE = 4
local __WASI_FILETYPE_SOCKET_DGRAM = 5
local __WASI_FILETYPE_SOCKET_STREAM = 6
local __WASI_FILETYPE_SYMBOLIC_LINK = 7

-- fdstat struct (24 bytes)
-- 0    1       filetype
-- 2    2       fs flags
-- 8    8       rights base
-- 16   8       rights inheriting

return function(memory)
    local WASI = {}

    function WASI.fd_prestat_get(fd, out_buf)
        -- unsupported
        return __WASI_EBADF
    end

    function WASI.fd_fdstat_get(fd, out_buf)

        if fd <= 2 then
            -- only stdio supported, note that I'm basically just passing in
            -- the right values to make the client code I've seen happy
            memory:write8(  out_buf+0,  __WASI_FILETYPE_CHARACTER_DEVICE)
            memory:write16( out_buf+2,  0)

            memory:write32( out_buf+8,  0)
            memory:write32( out_buf+12, 0)

            memory:write32( out_buf+16, 0)
            memory:write32( out_buf+20, 0)

            return __WASI_ESUCCESS
        end

        return __WASI_EBADF
    end

    function WASI.fd_write(fd,iovec,iovec_len,out_count)
        local len_written = 0

        -- only stdio supported
        if fd == 1 or fd==2 then
            local str = ""
            for i = 1,iovec_len do
                local ptr = memory:read32(iovec)
                local len = memory:read32(iovec+4)

                for j=ptr,ptr+len-1 do
                    str=str..string.char(memory:read8(j))
                end

                len_written = len_written + len

                iovec = iovec + 8
            end

            if fd == 1 then
                io.stdout:write(str)
            else
                io.stderr:write(str)
            end

        else
            return __WASI_EBADF
        end

        memory:write32(out_count,len_written)

        return __WASI_ESUCCESS
    end

    function WASI.environ_sizes_get(out_count, out_size)
        -- unsupported
        --print("environ_sizes_get",out_count,out_size)
        memory:write32(out_count, 0)
        memory:write32(out_size, 0)

        return __WASI_ESUCCESS
    end

    function WASI.args_sizes_get(out_argc, out_argv_buf_size)
        -- unsupported
        --print("args_sizes_get",out_argc,out_argv_buf_size)
        memory:write32(out_argc, 0)
        memory:write32(out_argv_buf_size, 0)

        return __WASI_ESUCCESS
    end

    return WASI
end

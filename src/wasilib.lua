
local __WASI_ESUCCESS = 0
local __WASI_EBADF = 8
local __WASI_EINVAL = 28

local __WASI_FILETYPE_UNKNOWN = 0
local __WASI_FILETYPE_BLOCK_DEVICE = 1
local __WASI_FILETYPE_CHARACTER_DEVICE = 2
local __WASI_FILETYPE_DIRECTORY = 3
local __WASI_FILETYPE_REGULAR_FILE = 4
local __WASI_FILETYPE_SOCKET_DGRAM = 5
local __WASI_FILETYPE_SOCKET_STREAM = 6
local __WASI_FILETYPE_SYMBOLIC_LINK = 7

local __WASI_CLOCK_MONOTONIC = 0;
local __WASI_CLOCK_PROCESS_CPUTIME_ID = 1;
local __WASI_CLOCK_REALTIME = 2;
local __WASI_CLOCK_THREAD_CPUTIME_ID = 3;

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

    function WASI.environ_get(addr_argv, addr_argv_buf)
        -- unsupported
        --print("environ_get",addr_argv, addr_argv_buf)
        memory:write32(addr_argv, 0)
        memory:write32(addr_argv_buf, 0)

        return __WASI_ESUCCESS
    end

    function WASI.args_sizes_get(out_argc, out_argv_buf_size)
        memory:write32(out_argc, #(args or _ARGS))
        memory:write32(out_argv_buf_size, #table.concat((args or _ARGS),"\0"))

        return __WASI_ESUCCESS
    end

    function WASI.args_get(addr_argv, addr_argv_buf)
        local idx = 0
        for char in table.concat((args or _ARGS),"\0"):gmatch(".") do
            memory:write8(addr_argv_buf + idx, char:byte())
            idx = idx + 1
        end

        local tot = 0
        for i,arg in ipairs((args or _ARGS)) do
            memory:write32(addr_argv + (i-1)*4, addr_argv_buf + tot)
            tot = tot + #arg + 1
        end

        return __WASI_ESUCCESS
    end

    function WASI.random_get(buf,len)
        for i=1,len do
            memory:write8(buf + i - 1,math.random(0,255))
        end

        return __WASI_ESUCCESS
    end

    function WASI.clock_time_get(clockID,precision,timeAddr)
        if (clockID == __WASI_CLOCK_MONOTONIC) or (clockID == __WASI_CLOCK_REALTIME) then
            __LONG_INT_N__(os.time() * 1000 * 1000 * 1000):store(memory,timeAddr) -- to nanoseconds
        elseif (clockID == __WASI_CLOCK_PROCESS_CPUTIME_ID) or (clockID == __WASI_CLOCK_THREAD_CPUTIME_ID) then
            __LONG_INT_N__(os.clock() * 1000 * 1000 * 1000):store(memory,timeAddr) -- to nanoseconds
        else
            return __WASI_EBADF
        end

        return __WASI_ESUCCESS
    end

    function WASI.proc_exit(code)
        -- print("exiting with code ",code)
        os.exit(code)
    end

    return WASI
end

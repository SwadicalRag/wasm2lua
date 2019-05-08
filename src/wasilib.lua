
local __WASI_ESUCCESS = 0
local __WASI_EBADF = 8

return function(memory)
    local WASI = {}

    function WASI.fd_prestat_get(fd, out_buf)
        -- unsupported
        return __WASI_EBADF
    end

    function WASI.environ_sizes_get(out_count, out_size)
        -- unsupported
        print("environ_sizes_get",out_count,out_size)
        memory:write32(out_count, 0)
        memory:write32(out_size, 0)

        return __WASI_ESUCCESS
    end

    function WASI.args_sizes_get(out_argc, out_argv_buf_size)
        -- unsupported
        print("args_sizes_get",out_argc,out_argv_buf_size)
        memory:write32(out_argc, 0)
        memory:write32(out_argv_buf_size, 0)

        return __WASI_ESUCCESS
    end

    return WASI
end

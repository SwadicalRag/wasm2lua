local mem = __MEMORY_ALLOC__(1)

local tests = {
    {__MEMORY_READ_8__,__MEMORY_WRITE_8__,function() return math.random(0,2 ^ 8 - 1) end},
    {__MEMORY_READ_16__,__MEMORY_WRITE_16__,function() return math.random(0,2 ^ 16 - 1) end},
    {__MEMORY_READ_32__,__MEMORY_WRITE_32__,function() return bit.tobit(math.random(0,2 ^ 32 - 1)) end},
    {__MEMORY_READ_32F__,__MEMORY_WRITE_32F__,function() return math.random() end},
    {__MEMORY_READ_64F__,__MEMORY_WRITE_64F__,function() return math.random() end},
}

for i=1,10000000 do
    for i,test in ipairs(tests) do
        local loc = math.random(0,255)
        local val = test[3]()
        test[2](mem,loc,val)
        local ret = test[1](mem,loc)
        if math.abs(val - ret) >= 0.01 then error("What") end
    end
end


local function __MEMORY_DUMP__(mem)
    for i=0,mem._len - 1 do
        if (((i) % 16 == 0) or (i == (mem._len - 1))) then
            io.write(string.format("%04x ",i))
        end

        io.write(string.format("%02x ",__MEMORY_READ_8__(mem,i)))
        
        if (((i+1) % 16 == 0) or (i == (mem._len - 1))) and (i ~= 1) then
            if i == (mem._len - 1) then
                for j=1,mem._len % 16 do
                    io.write("-- ")
                end
            end
            io.write("   ")
            for j=15,0,-1 do
                local data = 0
                if mem.data[i-j] then
                    data = __MEMORY_READ_8__(mem,i-j)
                end
                local char = string.char(data)

                if char:match("[A-Za-z0-9_]") then
                    io.write(" "..char)
                else
                    io.write(" .")
                end
            end
            if i == (mem._len - 1) then
                for j=1,mem._len % 16 do
                    io.write("- ")
                end
            end
            io.write("\n")
        end
    end
end

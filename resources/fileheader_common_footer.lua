-- fileheader (common:footer)

-- extra bit ops

local __clz_tab = {3, 2, 2, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0}
__clz_tab[0] = 4

local function __CLZ__(x)
    local n = 0
    if bit_band(x,-65536)     == 0 then n = 16;    x = bit_lshift(x,16) end
    if bit_band(x,-16777216)  == 0 then n = n + 8; x = bit_lshift(x,8) end
    if bit_band(x,-268435456) == 0 then n = n + 4; x = bit_lshift(x,4) end
    n = n + __clz_tab[bit_rshift(x,28)]
    return n
end

local __ctz_tab = {}

for i = 0,31 do
    __ctz_tab[ bit_rshift( 125613361 * bit_lshift(1,i) , 27 ) ] = i
end

local function __CTZ__(x)
    if x == 0 then return 32 end
    return __ctz_tab[ bit_rshift( bit_band(x,-x) * 125613361 , 27 ) ]
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
    return __popcnt_tab[bit_band(x,255)]
    + __popcnt_tab[bit_band(bit_rshift(x,8),255)]
    + __popcnt_tab[bit_band(bit_rshift(x,16),255)]
    + __popcnt_tab[bit_rshift(x,24)]
end

-- division helpers

local function __IDIV_S__(a,b)
    local res_1 = a / b
    local res_2 = math_floor(res_1)
    if res_1 ~= res_2 and res_2 < 0 then res_2 = res_2 + 1 end
    local int = bit_tobit(res_2)
    if res_2 ~= int then error("bad division") end
    return int
end

local function __IDIV_U__(a,b)
    local res = math_floor(__UNSIGNED__(a) / __UNSIGNED__(b))
    local int = bit_tobit(res)
    if res ~= int then error("bad division") end
    return int
end

local function __IMOD_S__(a,b)
    if b == 0 then error("bad modulo") end
    local res = math_abs(a) % math_abs(b)
    if a < 0 then  res = -res end
    return bit_tobit(res)
end

local function __IMOD_U__(a,b)
    if b == 0 then error("bad modulo") end
    local res = __UNSIGNED__(a) % __UNSIGNED__(b)
    return bit_tobit(res)
end

-- Multiply two 32 bit integers without busting due to precision loss on overflow
local function __IMUL__(a,b)
    local a_low = bit_band(a,65535)
    local b_low = bit_band(b,65535)

    return bit_tobit(
        a_low * b_low +
        bit_lshift(a_low * bit_rshift(b,16),16) +
        bit_lshift(b_low * bit_rshift(a,16),16)
    )
end

-- Extra math functions for floats, stored in their own table since they're not likely to be used often.
local __FLOAT__ = {
    nearest = function(x)
        if x % 1 == .5 then
            -- Must round toward even in the event of a tie.
            local y = math_floor(x)
            return y + (y % 2)
        end
        return math_floor(x + .5)
    end,
    truncate = function(x)
        return x > 0 and math_floor(x) or math_ceil(x)
    end,
    copysign = function(x,y)
        -- Does not handle signed zero, but who really cares?
        local sign = y > 0 and 1 or -1
        return x * sign
    end,
    min = function(x,y)
        if x ~= x or y ~= y then return 0 / 0 end
        return math_min(x,y)
    end,
    max = function(x,y)
        if x ~= x or y ~= y then return 0 / 0 end
        return math_max(x,y)
    end
}

-- Multiply and divide code adapted from 
    -- https://github.com/BixData/lua-long/ which is adapted from
    -- https://github.com/dcodeIO/long.js which is adapted from
    -- https://github.com/google/closure-library

-- This is the core division routine used by other division functions.
local function __LONG_INT_DIVIDE__(rem,divisor)
    assert(divisor[1] ~= 0 or divisor[2] ~= 0,"divide by zero")

    local res = __LONG_INT__(0,0)

    local d_approx = __UNSIGNED__(divisor[1]) + __UNSIGNED__(divisor[2]) * 4294967296

    while rem:_ge_u(divisor) do
        local n_approx = __UNSIGNED__(rem[1]) + __UNSIGNED__(rem[2]) * 4294967296

        -- Don't allow our approximation to be larger than an i64
        n_approx = math_min(n_approx, 18446744073709549568)

        local q_approx = math_max(1, math_floor(n_approx / d_approx))

        -- dark magic from long.js / closure lib
        local log2 = math_ceil(math_log(q_approx, 2))
        local delta = math_pow(2,math_max(0,log2 - 48))

        local res_approx = __LONG_INT_N__(q_approx)
        local rem_approx = res_approx * divisor

        -- decrease approximation until smaller than remainder and the multiply hopefully
        while rem_approx:_gt_u(rem) do
            q_approx = q_approx - delta
            res_approx = __LONG_INT_N__(q_approx)
            rem_approx = res_approx * divisor
        end

        -- res must be at least one, lib I copied the algo from had this check
        -- but I'm not sure is necessary or makes sense
        if res_approx[1] == 0 and res_approx[2] == 0 then
            error("res_approx = 0")
            res_approx[1] = 1
        end

        res = res + res_approx
        rem = rem - rem_approx
    end

    return res, rem
end

__LONG_INT_CLASS__ = {
    __tostring = function(self)
        return "__LONG_INT__(" .. self[1] .. "," .. self[2] .. ")"
    end,
    __add = function(a,b)
        local low = __UNSIGNED__(a[1]) + __UNSIGNED__(b[1])
        local high = a[2] + b[2] + (low >= 4294967296 and 1 or 0)
        return __LONG_INT__( bit_tobit(low), bit_tobit(high) )
    end,
    __sub = function(a,b)
        local low = __UNSIGNED__(a[1]) - __UNSIGNED__(b[1])
        local high = a[2] - b[2] - (low < 0 and 1 or 0)
        return __LONG_INT__( bit_tobit(low), bit_tobit(high) )
    end,
    __mul = function(a,b)
        -- I feel like this is excessive but I'm going to
        -- defer to the better wizard here.

        local a48 = bit_rshift(a[2],16)
        local a32 = bit_band(a[2],65535)
        local a16 = bit_rshift(a[1],16)
        local a00 = bit_band(a[1],65535)

        local b48 = bit_rshift(b[2],16)
        local b32 = bit_band(b[2],65535)
        local b16 = bit_rshift(b[1],16)
        local b00 = bit_band(b[1],65535)

        local c00 = a00 * b00
        local c16 = bit_rshift(c00,16)
        c00 = bit_band(c00,65535)

        c16 = c16 + a16 * b00
        local c32 = bit_rshift(c16,16)
        c16 = bit_band(c16,65535)

        c16 = c16 + a00 * b16
        c32 = c32 + bit_rshift(c16,16)
        c16 = bit_band(c16,65535)

        c32 = c32 + a32 * b00
        local c48 = bit_rshift(c32,16)
        c32 = bit_band(c32,65535)

        c32 = c32 + a16 * b16
        c48 = c48 + bit_rshift(c32,16)
        c32 = bit_band(c32,65535)

        c32 = c32 + a00 * b32
        c48 = c48 + bit_rshift(c32,16)
        c32 = bit_band(c32,65535)

        c48 = c48 + a48 * b00 + a32 * b16 + a16 * b32 + a00 * b48
        c48 = bit_band(c48,65535)

        return __LONG_INT__(
            bit_bor(c00,bit_lshift(c16,16)),
            bit_bor(c32,bit_lshift(c48,16))
        )
    end,
    __eq = function(a,b)
        return a[1] == b[1] and a[2] == b[2]
    end,
    __lt = function(a,b) -- <
        if a[2] == b[2] then return a[1] < b[1] else return a[2] < b[2] end
    end,
    __le = function(a,b) -- <=
        if a[2] == b[2] then return a[1] <= b[1] else return a[2] <= b[2] end
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

            return self
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
        _div_s = function(a,b)
            local negate_result = false
            if a[2] < 0 then
                a = __LONG_INT__(0,0) - a
                negate_result = not negate_result
            end

            if b[2] < 0 then
                b = __LONG_INT__(0,0) - b
                negate_result = not negate_result
            end

            local res, rem = __LONG_INT_DIVIDE__(a,b)
            if res[2] < 0 then
                error("division overflow")
            end
            if negate_result then
                res = __LONG_INT__(0,0) - res
            end
            return res
        end,
        _div_u = function(a,b)
            local res, rem = __LONG_INT_DIVIDE__(a,b)
            return res
        end,
        _rem_s = function(a,b)
            local negate_result = false
            if a[2] < 0 then
                a = __LONG_INT__(0,0) - a
                negate_result = not negate_result
            end

            if b[2] < 0 then
                b = __LONG_INT__(0,0) - b
            end

            local res, rem = __LONG_INT_DIVIDE__(a,b)

            if negate_result then
                rem = __LONG_INT__(0,0) - rem
            end

            return rem
        end,
        _rem_u = function(a,b)
            local res, rem = __LONG_INT_DIVIDE__(a,b)
            return rem
        end,
        _lt_u = function(a,b)
            if __UNSIGNED__(a[2]) == __UNSIGNED__(b[2]) then
                return __UNSIGNED__(a[1]) < __UNSIGNED__(b[1])
            else
                return __UNSIGNED__(a[2]) < __UNSIGNED__(b[2])
            end
        end,
        _le_u = function(a,b)
            if __UNSIGNED__(a[2]) == __UNSIGNED__(b[2]) then
                return __UNSIGNED__(a[1]) <= __UNSIGNED__(b[1])
            else
                return __UNSIGNED__(a[2]) <= __UNSIGNED__(b[2])
            end
        end,
        _gt_u = function(a,b)
            if __UNSIGNED__(a[2]) == __UNSIGNED__(b[2]) then
                return __UNSIGNED__(a[1]) > __UNSIGNED__(b[1])
            else
                return __UNSIGNED__(a[2]) > __UNSIGNED__(b[2])
            end
        end,
        _ge_u = function(a,b)
            if __UNSIGNED__(a[2]) == __UNSIGNED__(b[2]) then
                return __UNSIGNED__(a[1]) >= __UNSIGNED__(b[1])
            else
                return __UNSIGNED__(a[2]) >= __UNSIGNED__(b[2])
            end
        end,
        _shl = function(a,b)
            local shift = bit_band(b[1],63)

            local low, high
            if shift < 32 then
                high = bit_bor( bit_lshift(a[2],shift), shift == 0 and 0 or bit_rshift(a[1], 32-shift) )
                low = bit_lshift(a[1],shift)
            else
                low = 0
                high = bit_lshift(a[1],shift-32)
            end

            return __LONG_INT__(low,high)
        end,
        _shr_u = function(a,b)
            local shift = bit_band(b[1],63)

            local low, high
            if shift < 32 then
                low = bit_bor( bit_rshift(a[1],shift), shift == 0 and 0 or bit_lshift(a[2], 32-shift) )
                high = bit_rshift(a[2],shift)
            else
                low = bit_rshift(a[2],shift-32)
                high = 0
            end

            return __LONG_INT__(low,high)
        end,
        _shr_s = function(a,b)
            local shift = bit_band(b[1],63)

            local low, high
            if shift < 32 then
                low = bit_bor( bit_rshift(a[1],shift), shift == 0 and 0 or bit_lshift(a[2], 32-shift) )
                high = bit_arshift(a[2],shift)
            else
                low = bit_arshift(a[2],shift-32)
                high = bit_arshift(a[2],31)
            end

            return __LONG_INT__(low,high)
        end,
        _rotr = function(a,b)
            local shift = bit_band(b[1],63)
            local short_shift = bit_band(shift,31)

            local res1, res2
            if short_shift == 0 then
                -- Need this special case because shifts of 32 aren't valid :(
                res1 = a[1]
                res2 = a[2]
            else
                res1 = bit_bor( bit_rshift(a[1],short_shift), bit_lshift(a[2], 32-short_shift) )
                res2 = bit_bor( bit_rshift(a[2],short_shift), bit_lshift(a[1], 32-short_shift) )
            end

            if shift < 32 then
                return __LONG_INT__(res1,res2)
            else
                return __LONG_INT__(res2,res1)
            end
        end,
        _rotl = function(a,b)
            local shift = bit_band(b[1],63)
            local short_shift = bit_band(shift,31)

            local res1, res2
            if short_shift == 0 then
                -- Need this special case because shifts of 32 aren't valid :(
                res1 = a[1]
                res2 = a[2]
            else
                res1 = bit_bor( bit_lshift(a[1],short_shift), bit_rshift(a[2], 32-short_shift) )
                res2 = bit_bor( bit_lshift(a[2],short_shift), bit_rshift(a[1], 32-short_shift) )
            end

            if shift < 32 then
                return __LONG_INT__(res1,res2)
            else
                return __LONG_INT__(res2,res1)
            end
        end,
        _or = function(a,b)
            return __LONG_INT__(bit_bor(a[1],b[1]), bit_bor(a[2],b[2]))
        end,
        _and = function(a,b)
            return __LONG_INT__(bit_band(a[1],b[1]), bit_band(a[2],b[2]))
        end,
        _xor = function(a,b)
            return __LONG_INT__(bit_bxor(a[1],b[1]), bit_bxor(a[2],b[2]))
        end,
        _clz = function(a)
            local result = (a[2] ~= 0) and __CLZ__(a[2]) or 32 + __CLZ__(a[1])
            return __LONG_INT__(result,0)
        end,
        _ctz = function(a)
            local result = (a[1] ~= 0) and __CTZ__(a[1]) or 32 + __CTZ__(a[2])
            return __LONG_INT__(result,0)
        end,
        _popcnt = function(a)
            return __LONG_INT__( __POPCNT__(a[1]) + __POPCNT__(a[2]), 0)
        end,
        sign_upper_word = function(a)
            a[2] = bit_arshift(a[1],31)
            return a
        end,
        --[[get_words = function(a)
            return a[1], a[2]
        end]]
        to_double_reinterpret = function(a)
            return UInt32sToDouble(a[1],a[2])
        end,
        to_double_signed = function(a)
            return __UNSIGNED__(a[1]) + a[2] * 4294967296
        end,
        to_double_unsigned = function(a)
            return __UNSIGNED__(a[1]) + __UNSIGNED__(a[2]) * 4294967296
        end
    }
}

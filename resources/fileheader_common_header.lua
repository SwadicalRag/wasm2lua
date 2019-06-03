-- fileheader (common:header)

if jit and jit.opt then
    -- boost jit limits
    jit.opt.start("maxsnap=1000","loopunroll=500","maxmcode=2048")
end

local __LONG_INT_CLASS__

if jit and jit.version_num < 20100 then
    function math.frexp(dbl)
        local aDbl = math_abs(dbl)
    
        if dbl ~= 0 and (aDbl ~= math_huge) then
            local exp = math_max(-1023,math_floor(math.log(aDbl,2) + 1))
            local x = aDbl * math_pow(2,-exp)
    
            if dbl < 0 then
                x = -x
            end
    
            return x,exp
        end
    
        return dbl,0
    end
end

local setmetatable = setmetatable
local assert = assert
local error = error
local bit = bit
local math = math
local bit_tobit = bit.tobit
local bit_arshift = bit.arshift
local bit_rshift = bit.rshift
local bit_lshift = bit.lshift
local bit_band = bit.band
local bit_bor = bit.bor
local bit_bxor = bit.bxor
local bit_ror = bit.ror
local bit_rol = bit.rol
local math_huge = math.huge
local math_floor = math.floor
local math_ceil = math.ceil
local math_abs = math.abs
local math_max = math.max
local math_min = math.min
local math_pow = math.pow
local math_sqrt = math.sqrt
local math_ldexp = math.ldexp
local math_frexp = math.frexp

local function __TRUNC__(n)
    if n >= 0 then return math_floor(n) end
    return math_ceil(n)
end

local function __LONG_INT__(low,high)
    -- Note: Avoid using tail-calls on builtins
    -- This aborts a JIT trace, and can be avoided by wrapping tail calls in parentheses
    return (setmetatable({low,high},__LONG_INT_CLASS__))
end

local function __LONG_INT_N__(n) -- operates on non-normalized integers
    -- convert a double value to i64 directly
    local high = bit_tobit(math_floor(n / (2^32))) -- manually rshift by 32
    local low = bit_tobit(n % (2^32)) -- wtf? normal bit conversions are not sufficent according to tests
    return (setmetatable({low,high},__LONG_INT_CLASS__))
end

_G.__LONG_INT__ = __LONG_INT__
_G.__LONG_INT_N__ = __LONG_INT_N__

__MODULES__ = __MODULES__ or {}
__GLOBALS__ = __GLOBALS__ or {}
__SETJMP_STATES__ = __SETJMP_STATES__ or setmetatable({},{__mode="k"})

local function __STACK_POP__(__STACK__)
    local v = __STACK__[#__STACK__]
    __STACK__[#__STACK__] = nil
    return v
end

local function __UNSIGNED__(value)
    if value < 0 then
        value = value + 4294967296
    end

    return value
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

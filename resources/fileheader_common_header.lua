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

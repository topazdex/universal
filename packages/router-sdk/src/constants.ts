/**
 * Topaz's deployed `MixedRouteQuoterV1` reuses the CL path layout — `token ‖ uint24 ‖ token …` —
 * and distinguishes v2 hops with bitmasks in the 3 byte pool parameter. Anything that is neither
 * mask is read as a CL tick spacing.
 */
export const MIXED_ROUTE_V2_VOLATILE_FLAG = 0x400000 // 1 << 22
export const MIXED_ROUTE_V2_STABLE_FLAG = 0x200000 // 1 << 21

export const MIXED_ROUTE_QUOTER_V1_ADDRESS = '0x47c3570b90e7234FE695Ad5F1bE69E21fe1a9ee2'

export const ADDRESS_ZERO = '0x0000000000000000000000000000000000000000'

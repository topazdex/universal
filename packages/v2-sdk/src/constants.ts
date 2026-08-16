import JSBI from 'jsbi'

/** BNB Chain mainnet */
export const TOPAZ_CHAIN_ID = 56

/** Topaz v2 PoolFactory */
export const POOL_FACTORY_ADDRESS = '0x65E6cD0eF5D3467030103cf3d433034E570b5784'

/** Pool implementation every v2 pool is an ERC-1167 clone of */
export const POOL_IMPLEMENTATION_ADDRESS = '0xdC942D8e37cC20BCf9aD1Fe0111eE6c5908f3678'

/** Topaz v2 Router, kept for callers that still target it directly */
export const ROUTER_ADDRESS = '0x1E98c8226e7d452e1888e3d3d2F929346321c6c3'

/**
 * Swap fees are expressed in basis points against this denominator:
 * `amountIn * fee / FEE_DENOMINATOR` is withheld, so `fee = 30` is 0.30%.
 */
export const FEE_DENOMINATOR = JSBI.BigInt(10_000)

/** PoolFactory defaults, individual pools may carry a custom fee */
export const DEFAULT_VOLATILE_FEE = 30
export const DEFAULT_STABLE_FEE = 5

export const ZERO = JSBI.BigInt(0)
export const ONE = JSBI.BigInt(1)
export const TWO = JSBI.BigInt(2)
export const THREE = JSBI.BigInt(3)
export const ONE_E18 = JSBI.exponentiate(JSBI.BigInt(10), JSBI.BigInt(18))

export const MINIMUM_LIQUIDITY = JSBI.BigInt(1000)

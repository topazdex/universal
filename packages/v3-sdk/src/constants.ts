/** BNB Chain mainnet */
export const TOPAZ_CHAIN_ID = 56

/** Topaz CL (Slipstream) factory */
export const CL_FACTORY_ADDRESS = '0x73DC984D9490286E735548f61dfCCec67Af82ed9'

/** CLPool implementation every CL pool is an ERC-1167 clone of */
export const CL_POOL_IMPLEMENTATION_ADDRESS = '0x18e68051d1b1fB44cb539cA4436F112D28577AF7'

export const CL_SWAP_ROUTER_ADDRESS = '0x9B63CA87919617d042A89663492dB3c8686e0CaE'
export const CL_QUOTER_V2_ADDRESS = '0x7CCB89bB9BdEF68688F39a2c22d249fD1D9759f1'
export const CL_MIXED_ROUTE_QUOTER_V1_ADDRESS = '0x47c3570b90e7234FE695Ad5F1bE69E21fe1a9ee2'
export const CL_NONFUNGIBLE_POSITION_MANAGER_ADDRESS = '0xf8c30c3C362941C23025f2eA30B066A73C982f63'

export const ADDRESS_ZERO = '0x0000000000000000000000000000000000000000'

/**
 * Slipstream pools are keyed by tick spacing rather than by fee. These are the tick spacings
 * the factory enables today; new ones can be added by governance, so treat the list as a
 * default rather than an exhaustive set.
 */
export enum TickSpacing {
  STABLE = 1,
  LOW = 50,
  MEDIUM = 100,
  HIGH = 200,
  VOLATILE = 2000
}

/** Every tick spacing the CLFactory currently enables */
export const TICK_SPACINGS: TickSpacing[] = [
  TickSpacing.STABLE,
  TickSpacing.LOW,
  TickSpacing.MEDIUM,
  TickSpacing.HIGH,
  TickSpacing.VOLATILE
]

/**
 * Default swap fee per tick spacing, in pips (1e-6). A pool's live fee can differ: the factory
 * supports custom and dynamic fee modules, so read `CLFactory.getSwapFee(pool)` when it matters.
 */
export const DEFAULT_FEE_BY_TICK_SPACING: { [tickSpacing in TickSpacing]: number } = {
  [TickSpacing.STABLE]: 100,
  [TickSpacing.LOW]: 500,
  [TickSpacing.MEDIUM]: 1_000,
  [TickSpacing.HIGH]: 3_000,
  [TickSpacing.VOLATILE]: 10_000
}

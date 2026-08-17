export const TOPAZ_CHAIN_ID = 56

/** Multicall3, deployed at the same address on BNB Chain as elsewhere */
export const MULTICALL3_ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11'

export const POOL_FACTORY_ADDRESS = '0x65E6cD0eF5D3467030103cf3d433034E570b5784'
export const CL_FACTORY_ADDRESS = '0x73DC984D9490286E735548f61dfCCec67Af82ed9'
export const QUOTER_V2_ADDRESS = '0x7CCB89bB9BdEF68688F39a2c22d249fD1D9759f1'
export const MIXED_ROUTE_QUOTER_V1_ADDRESS = '0x47c3570b90e7234FE695Ad5F1bE69E21fe1a9ee2'

export const TOPAZ_V2_SUBGRAPH_URL =
  'https://api.goldsky.com/api/public/project_cmgzljqwl006c5np2gnao4li4/subgraphs/topaz-v2/prod/gn'
export const TOPAZ_V3_SUBGRAPH_URL =
  'https://api.goldsky.com/api/public/project_cmgzljqwl006c5np2gnao4li4/subgraphs/topaz-v3/prod/gn'

/**
 * Gas the Universal Router spends outside the swaps themselves: calldata, the command loop,
 * pulling funds through Permit2 and the final sweep.
 */
export const BASE_SWAP_GAS = 115_000

/** Gas per hop, measured from the fork tests in packages/universal-router */
export const V2_HOP_GAS = 125_000
export const CL_HOP_GAS = 145_000
/** Each initialised tick a CL swap crosses costs roughly this much extra */
export const CL_TICK_CROSS_GAS = 30_000

/**
 * Quote simulations per `eth_call`, and how many of those calls run at once.
 *
 * Measured against both a paid endpoint and a public dataseed node with a 5 BNB quote. Larger
 * batches mean fewer requests but they overrun the node's `eth_call` gas ceiling, and every batch
 * that overruns is halved and retried — wasted round trips that cost far more than the requests
 * they saved. 15 was the largest size that never split on either endpoint, and it was also the
 * fastest: 1.2s vs 3.7s at 40, and 6.4s at 200.
 */
export const QUOTE_BATCH_SIZE = 15
export const MULTICALL_CONCURRENCY = 16

/**
 * Pool state reads are plain view calls costing a few thousand gas each, nowhere near the ceiling
 * that constrains quotes, so they batch far more aggressively.
 */
export const POOL_STATE_BATCH_SIZE = 60

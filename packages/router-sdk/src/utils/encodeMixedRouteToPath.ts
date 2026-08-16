import { pack } from '@ethersproject/solidity'
import { Currency, Token } from '@uniswap/sdk-core'

import { MIXED_ROUTE_V2_STABLE_FLAG, MIXED_ROUTE_V2_VOLATILE_FLAG } from '../constants'
import { MixedRoute } from '../entities/mixedRoute'
import { isCLPool, TPool } from '../entities/protocol'

/** The 3 byte pool parameter `MixedRouteQuoterV1` expects for a given pool */
export function poolPathParameter(pool: TPool): number {
  if (isCLPool(pool)) return pool.tickSpacing
  return pool.stable ? MIXED_ROUTE_V2_STABLE_FLAG : MIXED_ROUTE_V2_VOLATILE_FLAG
}

/**
 * Encodes a mixed route for `MixedRouteQuoterV1.quoteExactInput`.
 *
 * @notice exact input only — the mixed quoter cannot serve exact output, and neither can
 * Topaz stable pools.
 */
export function encodeMixedRouteToPath(route: MixedRoute<Currency, Currency>): string {
  const firstInputToken: Token = route.input.wrapped

  const { path, types } = route.pools.reduce(
    (
      { inputToken, path, types }: { inputToken: Token; path: (string | number)[]; types: string[] },
      pool: TPool,
      index: number
    ) => {
      const outputToken: Token = pool.token0.equals(inputToken) ? pool.token1 : pool.token0
      return index === 0
        ? {
            inputToken: outputToken,
            types: ['address', 'uint24', 'address'],
            path: [inputToken.address, poolPathParameter(pool), outputToken.address]
          }
        : {
            inputToken: outputToken,
            types: [...types, 'uint24', 'address'],
            path: [...path, poolPathParameter(pool), outputToken.address]
          }
    },
    { inputToken: firstInputToken, path: [], types: [] }
  )

  return pack(types, path)
}

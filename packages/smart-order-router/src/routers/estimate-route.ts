import { AnyRoute, isCLPool, TPool } from '@topazdex/router-sdk'
import { Currency, CurrencyAmount, Token } from '@topazdex/sdk-core'
import { Pool as V2Pool } from '@topazdex/v2-sdk'
import { Pool as CLPool } from '@topazdex/v3-sdk'
import JSBI from 'jsbi'

const Q96 = JSBI.exponentiate(JSBI.BigInt(2), JSBI.BigInt(96))

/**
 * A rough output for a route, computed from pool state already in memory — no RPC.
 *
 * This exists to narrow the candidate list before anything is priced on chain, which is where
 * almost all of a quote's time goes. v2 legs use the real Solidly maths. CL legs use the pool's
 * virtual reserves — `L / √P` and `L · √P` — which price impact correctly while the swap stays in
 * the current tick range, and degrade gracefully beyond it. Modelling ticks exactly would need data
 * we have not loaded.
 *
 * Spot price alone is not enough here: it ranks a thin pool identically to a deep one, which on a
 * large trade drops the route that actually wins.
 *
 * So this ranks candidates, it never answers. Everything it keeps is still quoted on chain.
 */
export function estimateOutput(
  route: AnyRoute<Currency, Currency>,
  amountIn: CurrencyAmount<Currency>
): CurrencyAmount<Token> | undefined {
  let amount = amountIn.wrapped as CurrencyAmount<Token>

  for (const pool of route.pools as TPool[]) {
    const next = step(pool, amount)
    if (!next) return undefined
    amount = next
  }
  return amount
}

function step(pool: TPool, amountIn: CurrencyAmount<Token>): CurrencyAmount<Token> | undefined {
  if (!pool.involvesToken(amountIn.currency)) return undefined

  if (!isCLPool(pool)) {
    try {
      // the v2 maths is exact and cheap, so use the real thing
      const [out] = (pool as V2Pool).getOutputAmount(amountIn)
      return out
    } catch {
      // insufficient reserves for this size: the route is not viable at this amount
      return undefined
    }
  }

  const clPool = pool as CLPool
  const zeroForOne = clPool.token0.equals(amountIn.currency)
  const output = zeroForOne ? clPool.token1 : clPool.token0

  const liquidity = clPool.liquidity
  const sqrtPrice = clPool.sqrtRatioX96
  if (JSBI.equal(liquidity, JSBI.BigInt(0)) || JSBI.equal(sqrtPrice, JSBI.BigInt(0))) return undefined

  // virtual reserves of the current range: x = L/√P, y = L·√P
  const virtualToken0 = JSBI.divide(JSBI.multiply(liquidity, Q96), sqrtPrice)
  const virtualToken1 = JSBI.divide(JSBI.multiply(liquidity, sqrtPrice), Q96)
  const [reserveIn, reserveOut] = zeroForOne
    ? [virtualToken0, virtualToken1]
    : [virtualToken1, virtualToken0]
  if (JSBI.equal(reserveIn, JSBI.BigInt(0)) || JSBI.equal(reserveOut, JSBI.BigInt(0))) return undefined

  const afterFee = JSBI.divide(
    JSBI.multiply(amountIn.quotient, JSBI.BigInt(1_000_000 - clPool.fee)),
    JSBI.BigInt(1_000_000)
  )
  const amountOut = JSBI.divide(JSBI.multiply(afterFee, reserveOut), JSBI.add(reserveIn, afterFee))
  if (JSBI.lessThanOrEqual(amountOut, JSBI.BigInt(0))) return undefined

  return CurrencyAmount.fromRawAmount(output, amountOut)
}

/**
 * Keeps the `limit` most promising routes, judged at several trade sizes.
 *
 * Size matters as much as the ranking. The answer is usually a split, so a route that looks
 * mediocre at the full amount can still win a small slice of it — a deep pool takes the bulk while
 * a thin one absorbs the remainder. Ranking on the full amount alone discarded exactly those
 * routes: it cost up to 50 bips on a large USDT to TOPAZ trade, and no limit below 60 recovered it,
 * because the winner was not merely ranked low, it was ranked wrongly.
 *
 * So routes are ranked once per size and the lists are interleaved, which is the same judgement the
 * on-chain screen makes when it prices every route at its smallest and largest slice.
 *
 * Routes we could not estimate take whatever capacity is left. In practice that only happens when a
 * pool has no liquidity or cannot cover the trade.
 */
export function prerankRoutes<T extends AnyRoute<Currency, Currency>>(
  routes: T[],
  amounts: CurrencyAmount<Currency>[],
  limit: number
): T[] {
  if (routes.length <= limit) return routes

  const rankings = amounts.map(amount => {
    const scored = routes.map(route => ({ route, estimate: estimateOutput(route, amount) }))
    return scored
      .filter((entry): entry is { route: T; estimate: CurrencyAmount<Token> } => Boolean(entry.estimate))
      .sort((a, b) => (b.estimate.greaterThan(a.estimate) ? 1 : -1))
      .map(entry => entry.route)
  })

  // take the best from each size in turn, so no single size decides the candidate set
  const kept = new Set<T>()
  for (let position = 0; kept.size < limit; position++) {
    let exhausted = true
    for (const ranking of rankings) {
      if (position >= ranking.length) continue
      exhausted = false
      kept.add(ranking[position])
      if (kept.size >= limit) break
    }
    if (exhausted) break
  }

  for (const route of routes) {
    if (kept.size >= limit) break
    kept.add(route)
  }

  return [...kept]
}

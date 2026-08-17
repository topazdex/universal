import { BigNumber } from '@ethersproject/bignumber'
import { AnyRoute } from '@topazdex/router-sdk'
import { Currency, CurrencyAmount, TradeType } from '@topazdex/sdk-core'

export interface RouteWithValidQuote {
  route: AnyRoute<Currency, Currency>
  percent: number
  amount: CurrencyAmount<Currency>
  quote: CurrencyAmount<Currency>
  /** `quote` adjusted by the gas the route costs, expressed in the quote token */
  quoteAdjustedForGas: CurrencyAmount<Currency>
  gasUsed: BigNumber
  gasCostInQuoteToken: CurrencyAmount<Currency>
  poolAddresses: string[]
}

export interface BestSwapRoute {
  routes: RouteWithValidQuote[]
  quote: CurrencyAmount<Currency>
  quoteGasAdjusted: CurrencyAmount<Currency>
  estimatedGasUsed: BigNumber
  estimatedGasUsedQuoteToken: CurrencyAmount<Currency>
}

export interface BestSwapRouteConfig {
  minSplits?: number
  maxSplits?: number
}

/**
 * Picks the combination of routes that maximises the gas adjusted quote.
 *
 * A breadth first search over splits, after Uniswap's alpha router: start from the best single
 * route, then repeatedly extend partial allocations with the best complementary percentage that
 * does not re-use a pool already spoken for. Re-using a pool across two legs of the same trade
 * would be quoted twice against the same reserves, so those combinations are excluded rather than
 * approximated.
 */
export function getBestSwapRoute(
  percents: number[],
  routesWithQuotes: RouteWithValidQuote[],
  tradeType: TradeType,
  config: BestSwapRouteConfig = {}
): BestSwapRoute | null {
  const minSplits = config.minSplits ?? 1
  const maxSplits = config.maxSplits ?? 3
  if (routesWithQuotes.length === 0) return null

  const better = (a: CurrencyAmount<Currency>, b: CurrencyAmount<Currency>): boolean =>
    tradeType === TradeType.EXACT_INPUT ? a.greaterThan(b) : a.lessThan(b)

  const percentToSortedQuotes: { [percent: number]: RouteWithValidQuote[] } = {}
  for (const routeWithQuote of routesWithQuotes) {
    ;(percentToSortedQuotes[routeWithQuote.percent] ??= []).push(routeWithQuote)
  }
  for (const percent of Object.keys(percentToSortedQuotes)) {
    percentToSortedQuotes[Number(percent)].sort((a, b) =>
      better(a.quoteAdjustedForGas, b.quoteAdjustedForGas) ? -1 : 1
    )
  }

  let best: RouteWithValidQuote[] | undefined
  let bestQuote: CurrencyAmount<Currency> | undefined

  if (percentToSortedQuotes[100]?.length && minSplits <= 1) {
    best = [percentToSortedQuotes[100][0]]
    bestQuote = percentToSortedQuotes[100][0].quoteAdjustedForGas
  }

  interface QueueEntry {
    percentIndex: number
    routes: RouteWithValidQuote[]
    remainingPercent: number
  }

  let queue: QueueEntry[] = []
  for (let i = percents.length - 1; i >= 0; i--) {
    const percent = percents[i]
    const candidates = percentToSortedQuotes[percent]
    if (!candidates?.length) continue
    // seed with the two best routes at this size, the best may share a pool with its complement
    for (const candidate of candidates.slice(0, 2)) {
      queue.push({ percentIndex: i, routes: [candidate], remainingPercent: 100 - percent })
    }
  }

  let splits = 1
  while (queue.length > 0 && splits < maxSplits) {
    splits++
    const layer = queue
    queue = []

    for (const { percentIndex, routes, remainingPercent } of layer) {
      for (let i = percentIndex; i >= 0; i--) {
        const percent = percents[i]
        if (percent > remainingPercent) continue

        const candidates = percentToSortedQuotes[percent]
        if (!candidates?.length) continue

        const used = new Set(routes.flatMap(route => route.poolAddresses))
        const candidate = candidates.find(route => route.poolAddresses.every(address => !used.has(address)))
        if (!candidate) continue

        const nextRoutes = [...routes, candidate]
        const nextRemaining = remainingPercent - percent

        if (nextRemaining === 0) {
          if (nextRoutes.length < minSplits) continue
          const quote = sum(nextRoutes.map(route => route.quoteAdjustedForGas))
          if (!bestQuote || better(quote, bestQuote)) {
            bestQuote = quote
            best = nextRoutes
          }
        } else if (splits < maxSplits) {
          queue.push({ percentIndex: i, routes: nextRoutes, remainingPercent: nextRemaining })
        }
      }
    }
  }

  if (!best) return null

  const quote = sum(best.map(route => route.quote))
  const quoteGasAdjusted = sum(best.map(route => route.quoteAdjustedForGas))
  const estimatedGasUsed = best.reduce((total, route) => total.add(route.gasUsed), BigNumber.from(0))
  const estimatedGasUsedQuoteToken = sum(best.map(route => route.gasCostInQuoteToken))

  return { routes: best, quote, quoteGasAdjusted, estimatedGasUsed, estimatedGasUsedQuoteToken }
}

function sum(amounts: CurrencyAmount<Currency>[]): CurrencyAmount<Currency> {
  return amounts.slice(1).reduce((total, amount) => total.add(amount), amounts[0])
}

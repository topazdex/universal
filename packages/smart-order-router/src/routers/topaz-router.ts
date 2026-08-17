import { BigNumber } from '@ethersproject/bignumber'
import { BaseProvider } from '@ethersproject/providers'
import { AnyRoute, Swap, TPool, Trade } from '@topazdex/router-sdk'
import { BASE_TOKENS, Currency, CurrencyAmount, Token, TradeType } from '@topazdex/sdk-core'
import { SwapOptions, SwapRouter, universalRouterAddress } from '@topazdex/universal-router-sdk'

import { TOPAZ_CHAIN_ID } from '../constants'
import { MulticallProvider } from '../providers/multicall'
import { PoolProvider } from '../providers/pool-provider'
import { AmountToQuote, QuoteProvider, routeSupportsTradeType } from '../providers/quote-provider'
import { CLSubgraphPool, SubgraphProvider, V2SubgraphPool } from '../providers/subgraph'
import { BestSwapRoute, getBestSwapRoute, RouteWithValidQuote } from './best-swap-route'
import { computeAllRoutes, routePoolAddresses } from './compute-routes'
import { GasModel } from './gas-model'

export interface RoutingConfig {
  /** Granularity of the split search: 5 means the input is explored in 5% steps */
  distributionPercent?: number
  maxSplits?: number
  minSplits?: number
  maxHops?: number
  maxRoutesPerProtocol?: number
  includeMixedRoutes?: boolean
  /** Pools pulled from each subgraph before filtering */
  subgraphPoolCount?: number
  blockNumber?: number
  /** Skip the subgraph and route over exactly these pools */
  poolsOverride?: TPool[]
}

export interface SwapRoute {
  /** Output for an exact input trade, input for an exact output trade */
  quote: CurrencyAmount<Currency>
  quoteGasAdjusted: CurrencyAmount<Currency>
  estimatedGasUsed: BigNumber
  estimatedGasUsedQuoteToken: CurrencyAmount<Currency>
  routes: RouteWithValidQuote[]
  trade: Trade<Currency, Currency, TradeType>
  blockNumber: number
  methodParameters?: { calldata: string; value: string; to: string }
}

export interface TopazRouterConstructorArgs {
  provider: BaseProvider
  chainId?: number
  subgraphProvider?: SubgraphProvider
  multicallProvider?: MulticallProvider
  poolProvider?: PoolProvider
  quoteProvider?: QuoteProvider
  /** Overrides the recorded deployment for this chain, e.g. to target a router on a fork */
  universalRouterAddress?: string
  /** How long the pool list from the subgraphs is reused before refetching. Default 5 minutes. */
  subgraphCacheTtlMs?: number
}

/**
 * Routes a swap across both Topaz stacks.
 *
 * Pipeline: discover candidate pools from the subgraphs, read their live state on chain, enumerate
 * routes (pure v2, pure CL, and mixed), quote every route at every split size with Topaz's own
 * quoters, adjust each quote for the gas that route costs, then search for the best combination.
 */
export class TopazRouter {
  private readonly provider: BaseProvider
  private readonly chainId: number
  private readonly subgraphProvider: SubgraphProvider
  private readonly poolProvider: PoolProvider
  private readonly quoteProvider: QuoteProvider
  private readonly universalRouterAddress?: string

  private subgraphCache: { v2: V2SubgraphPool[]; cl: CLSubgraphPool[]; fetchedAt: number } | undefined
  private readonly subgraphCacheTtlMs: number

  public constructor(args: TopazRouterConstructorArgs) {
    this.provider = args.provider
    this.chainId = args.chainId ?? TOPAZ_CHAIN_ID
    this.subgraphProvider = args.subgraphProvider ?? new SubgraphProvider()
    const multicall = args.multicallProvider ?? new MulticallProvider(args.provider)
    this.poolProvider = args.poolProvider ?? new PoolProvider(this.chainId, multicall)
    this.quoteProvider = args.quoteProvider ?? new QuoteProvider(multicall)
    this.universalRouterAddress = args.universalRouterAddress
    this.subgraphCacheTtlMs = args.subgraphCacheTtlMs ?? 5 * 60 * 1000
  }

  public async route(
    amount: CurrencyAmount<Currency>,
    quoteCurrency: Currency,
    tradeType: TradeType,
    swapOptions?: SwapOptions,
    config: RoutingConfig = {}
  ): Promise<SwapRoute | null> {
    const blockNumber = config.blockNumber ?? (await this.provider.getBlockNumber())
    const [currencyIn, currencyOut] =
      tradeType === TradeType.EXACT_INPUT ? [amount.currency, quoteCurrency] : [quoteCurrency, amount.currency]

    const pools = config.poolsOverride ?? (await this.loadPools(currencyIn, currencyOut, blockNumber, config))
    if (pools.length === 0) return null

    const { v2Routes, clRoutes, mixedRoutes } = computeAllRoutes(currencyIn, currencyOut, pools, {
      maxHops: config.maxHops,
      maxRoutesPerProtocol: config.maxRoutesPerProtocol,
      includeMixedRoutes: config.includeMixedRoutes
    })

    const routes: AnyRoute<Currency, Currency>[] = [...clRoutes, ...v2Routes, ...mixedRoutes].filter(route =>
      routeSupportsTradeType(route, tradeType)
    )
    if (routes.length === 0) return null

    const { percents, amounts } = splitAmount(amount, config.distributionPercent ?? 5)
    const quotes = await this.quoteProvider.getQuotes(routes, amounts, tradeType, { blockTag: blockNumber })
    if (quotes.length === 0) return null

    const gasPrice = await this.provider.getGasPrice()
    const gasModel = new GasModel(gasPrice, quoteCurrency, pools)

    const routesWithValidQuotes: RouteWithValidQuote[] = quotes.map(quote => {
      const gas = gasModel.estimate(quote.route, quote.initializedTicksCrossed)
      const quoteAdjustedForGas =
        tradeType === TradeType.EXACT_INPUT
          ? subtractFloorZero(quote.quote, gas.gasCostInQuoteToken)
          : quote.quote.add(gas.gasCostInQuoteToken)

      return {
        route: quote.route,
        percent: quote.percent,
        amount: quote.amount,
        quote: quote.quote,
        quoteAdjustedForGas,
        gasUsed: gas.gasUsed,
        gasCostInQuoteToken: gas.gasCostInQuoteToken,
        poolAddresses: routePoolAddresses(quote.route.pools)
      }
    })

    const best = getBestSwapRoute(percents, routesWithValidQuotes, tradeType, {
      minSplits: config.minSplits,
      maxSplits: config.maxSplits
    })
    if (!best) return null

    const trade = buildTrade(best, tradeType)
    const methodParameters = swapOptions ? this.buildMethodParameters(trade, swapOptions) : undefined

    return {
      quote: best.quote,
      quoteGasAdjusted: best.quoteGasAdjusted,
      estimatedGasUsed: best.estimatedGasUsed,
      estimatedGasUsedQuoteToken: best.estimatedGasUsedQuoteToken,
      routes: best.routes,
      trade,
      blockNumber,
      methodParameters
    }
  }

  private buildMethodParameters(
    trade: Trade<Currency, Currency, TradeType>,
    swapOptions: SwapOptions
  ): { calldata: string; value: string; to: string } {
    // falls back to the router recorded for this chain, so only forks need to pass one
    const to = universalRouterAddress(this.chainId, this.universalRouterAddress)
    const { calldata, value } = SwapRouter.swapCallParameters(trade, swapOptions)
    return { calldata, value, to }
  }

  private async loadPools(
    currencyIn: Currency,
    currencyOut: Currency,
    blockNumber: number,
    config: RoutingConfig
  ): Promise<TPool[]> {
    // the pool list only changes when pools are created or drained, so it is cached; pool state
    // itself is always read fresh from the chain below
    if (!this.subgraphCache || Date.now() - this.subgraphCache.fetchedAt > this.subgraphCacheTtlMs) {
      const count = config.subgraphPoolCount ?? 500
      const [v2, cl] = await Promise.all([
        this.subgraphProvider.getV2Pools(count),
        this.subgraphProvider.getCLPools(count)
      ])
      this.subgraphCache = { v2, cl, fetchedAt: Date.now() }
    }

    const allowed = allowedTokenSet(currencyIn, currencyOut, this.subgraphCache)
    const v2Candidates = this.subgraphCache.v2.filter(
      pool => allowed.has(pool.token0.id.toLowerCase()) && allowed.has(pool.token1.id.toLowerCase())
    )
    const clCandidates = this.subgraphCache.cl.filter(
      pool => allowed.has(pool.token0.id.toLowerCase()) && allowed.has(pool.token1.id.toLowerCase())
    )

    const [v2Pools, clPools] = await Promise.all([
      this.poolProvider.getV2Pools(v2Candidates, { blockTag: blockNumber }),
      this.poolProvider.getCLPools(clCandidates, { blockTag: blockNumber })
    ])

    return [...clPools, ...v2Pools]
  }
}

/**
 * The tokens a route is allowed to pass through: the traded pair, the protocol's liquidity hubs,
 * and the counterparties of the deepest pools holding either side of the pair, which is how a route
 * can hop through a token that is not a hub.
 */
function allowedTokenSet(
  currencyIn: Currency,
  currencyOut: Currency,
  subgraph: { v2: V2SubgraphPool[]; cl: CLSubgraphPool[] },
  topPoolsPerToken = 5
): Set<string> {
  const tokenIn = currencyIn.wrapped.address.toLowerCase()
  const tokenOut = currencyOut.wrapped.address.toLowerCase()

  const allowed = new Set<string>([tokenIn, tokenOut])
  for (const token of BASE_TOKENS) allowed.add(token.address.toLowerCase())

  const addCounterparties = (pools: { token0: { id: string }; token1: { id: string } }[], token: string) => {
    let added = 0
    for (const pool of pools) {
      if (added >= topPoolsPerToken) break
      const token0 = pool.token0.id.toLowerCase()
      const token1 = pool.token1.id.toLowerCase()
      if (token0 !== token && token1 !== token) continue
      allowed.add(token0 === token ? token1 : token0)
      added++
    }
  }

  // subgraph results arrive sorted by liquidity, so the first matches are the deepest pools
  for (const token of [tokenIn, tokenOut]) {
    addCounterparties(subgraph.cl, token)
    addCounterparties(subgraph.v2, token)
  }

  return allowed
}

function splitAmount(
  amount: CurrencyAmount<Currency>,
  distributionPercent: number
): { percents: number[]; amounts: AmountToQuote[] } {
  const percents: number[] = []
  const amounts: AmountToQuote[] = []

  for (let percent = distributionPercent; percent <= 100; percent += distributionPercent) {
    percents.push(percent)
    amounts.push({ percent, amount: amount.multiply(percent).divide(100) })
  }

  return { percents, amounts }
}

function subtractFloorZero(
  amount: CurrencyAmount<Currency>,
  toSubtract: CurrencyAmount<Currency>
): CurrencyAmount<Currency> {
  return amount.greaterThan(toSubtract)
    ? amount.subtract(toSubtract)
    : CurrencyAmount.fromRawAmount(amount.currency, 0)
}

function buildTrade(best: BestSwapRoute, tradeType: TradeType): Trade<Currency, Currency, TradeType> {
  const swaps: Swap<Currency, Currency>[] = best.routes.map(route =>
    tradeType === TradeType.EXACT_INPUT
      ? { route: route.route, inputAmount: route.amount, outputAmount: route.quote }
      : { route: route.route, inputAmount: route.quote, outputAmount: route.amount }
  )
  return new Trade({ swaps, tradeType })
}

export type { Token }

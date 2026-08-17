import { BigNumber } from '@ethersproject/bignumber'
import {
  AnyRoute,
  encodeMixedRouteToPath,
  isCLPool,
  MixedRoute,
  MixedRouteQuoter,
  Protocol
} from '@topazdex/router-sdk'
import { Currency, CurrencyAmount, TradeType } from '@topazdex/sdk-core'
import { Pool as V2Pool } from '@topazdex/v2-sdk'
import { Route as CLRoute, SwapQuoter } from '@topazdex/v3-sdk'

import { MIXED_ROUTE_QUOTER_V1_ADDRESS, QUOTER_V2_ADDRESS } from '../constants'
import { MulticallProvider } from './multicall'

export interface AmountToQuote {
  percent: number
  amount: CurrencyAmount<Currency>
}

export interface RouteWithQuote {
  route: AnyRoute<Currency, Currency>
  percent: number
  /** The amount that was specified: input for exact in, output for exact out */
  amount: CurrencyAmount<Currency>
  /** The amount that came back: output for exact in, input for exact out */
  quote: CurrencyAmount<Currency>
  /** Initialised ticks the CL legs crossed, the main driver of a route's gas cost */
  initializedTicksCrossed: number
}

export interface QuoteProviderOptions {
  blockTag?: number | string
  batchSize?: number
  gasLimitPerCall?: number
}

/**
 * Prices routes with Topaz's own deployed quoters, never with a local simulation.
 *
 * `MixedRouteQuoterV1` covers every exact input route — pure CL, pure v2, or mixed — because its
 * path encoding treats a v2 hop as a flagged tick spacing. Exact output has no mixed quoter and no
 * stable pool support, so it is served by `QuoterV2` for CL routes and by local Solidly math for
 * volatile v2 routes.
 */
export class QuoteProvider {
  public constructor(
    private readonly multicall: MulticallProvider,
    private readonly mixedQuoterAddress: string = MIXED_ROUTE_QUOTER_V1_ADDRESS,
    private readonly quoterV2Address: string = QUOTER_V2_ADDRESS
  ) {}

  public async getQuotes(
    routes: AnyRoute<Currency, Currency>[],
    amounts: AmountToQuote[],
    tradeType: TradeType,
    options: QuoteProviderOptions = {}
  ): Promise<RouteWithQuote[]> {
    return tradeType === TradeType.EXACT_INPUT
      ? this.getQuotesExactIn(routes, amounts, options)
      : this.getQuotesExactOut(routes, amounts, options)
  }

  private async getQuotesExactIn(
    routes: AnyRoute<Currency, Currency>[],
    amounts: AmountToQuote[],
    options: QuoteProviderOptions
  ): Promise<RouteWithQuote[]> {
    const pairs: { route: AnyRoute<Currency, Currency>; entry: AmountToQuote }[] = []
    const calls = []

    for (const route of routes) {
      const mixedRoute = new MixedRoute(route.pools, route.input, route.output)
      const path = encodeMixedRouteToPath(mixedRoute)
      for (const entry of amounts) {
        pairs.push({ route, entry })
        calls.push({
          target: this.mixedQuoterAddress,
          callData: MixedRouteQuoter.INTERFACE.encodeFunctionData('quoteExactInput', [
            path,
            entry.amount.quotient.toString()
          ])
        })
      }
    }

    const results = await this.multicall.call(calls, {
      blockTag: options.blockTag,
      batchSize: options.batchSize,
      gasLimitPerCall: options.gasLimitPerCall
    })

    const quotes: RouteWithQuote[] = []
    for (const [i, { route, entry }] of pairs.entries()) {
      const result = results[i]
      if (!result?.success) continue

      let decoded
      try {
        decoded = MixedRouteQuoter.INTERFACE.decodeFunctionResult('quoteExactInput', result.returnData)
      } catch {
        continue
      }
      const amountOut = BigNumber.from(decoded[0])
      if (amountOut.isZero()) continue

      quotes.push({
        route,
        percent: entry.percent,
        amount: entry.amount,
        quote: CurrencyAmount.fromRawAmount(route.output, amountOut.toString()),
        initializedTicksCrossed: sumTicksCrossed(decoded[2])
      })
    }
    return quotes
  }

  private async getQuotesExactOut(
    routes: AnyRoute<Currency, Currency>[],
    amounts: AmountToQuote[],
    options: QuoteProviderOptions
  ): Promise<RouteWithQuote[]> {
    const quotes: RouteWithQuote[] = []

    // volatile v2 routes invert in closed form, so they are priced locally rather than on chain
    const localRoutes = routes.filter(route => route.protocol === Protocol.V2)
    for (const route of localRoutes) {
      const pools = route.pools as V2Pool[]
      if (pools.some(pool => pool.stable)) continue
      for (const entry of amounts) {
        try {
          let amount = entry.amount
          for (let i = pools.length - 1; i >= 0; i--) {
            ;[amount] = pools[i].getInputAmount(amount.wrapped as CurrencyAmount<never>)
          }
          quotes.push({
            route,
            percent: entry.percent,
            amount: entry.amount,
            quote: CurrencyAmount.fromRawAmount(route.input, amount.quotient),
            initializedTicksCrossed: 0
          })
        } catch {
          // insufficient reserves for this size, that route simply has no quote here
        }
      }
    }

    const clRoutes = routes.filter(route => route.protocol === Protocol.CL)
    const pairs: { route: AnyRoute<Currency, Currency>; entry: AmountToQuote }[] = []
    const calls = []

    for (const route of clRoutes) {
      for (const entry of amounts) {
        pairs.push({ route, entry })
        const { calldata } = SwapQuoter.quoteCallParameters(
          route as CLRoute<Currency, Currency>,
          entry.amount,
          TradeType.EXACT_OUTPUT
        )
        calls.push({ target: this.quoterV2Address, callData: calldata })
      }
    }

    const results = await this.multicall.call(calls, {
      blockTag: options.blockTag,
      batchSize: options.batchSize,
      gasLimitPerCall: options.gasLimitPerCall
    })

    for (const [i, { route, entry }] of pairs.entries()) {
      const result = results[i]
      if (!result?.success) continue

      const single = route.pools.length === 1
      let decoded
      try {
        decoded = SwapQuoter.INTERFACE.decodeFunctionResult(
          single ? 'quoteExactOutputSingle' : 'quoteExactOutput',
          result.returnData
        )
      } catch {
        continue
      }
      const amountIn = BigNumber.from(decoded[0])
      if (amountIn.isZero()) continue

      quotes.push({
        route,
        percent: entry.percent,
        amount: entry.amount,
        quote: CurrencyAmount.fromRawAmount(route.input, amountIn.toString()),
        initializedTicksCrossed: single ? Number(decoded[2]) : sumTicksCrossed(decoded[2])
      })
    }

    return quotes
  }
}

function sumTicksCrossed(list: unknown): number {
  if (!Array.isArray(list)) return 0
  return list.reduce<number>((sum, value) => sum + Number(value), 0)
}

/** True when a route can be quoted for the given trade type at all */
export function routeSupportsTradeType(route: AnyRoute<Currency, Currency>, tradeType: TradeType): boolean {
  if (tradeType === TradeType.EXACT_INPUT) return true
  if (route.protocol === Protocol.MIXED) return false
  if (route.protocol === Protocol.CL) return true
  return !(route.pools as V2Pool[]).some(pool => !isCLPool(pool) && pool.stable)
}

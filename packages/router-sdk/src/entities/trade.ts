import { Route as V2RouteSDK } from '@topazdex/v2-sdk'
import { Route as CLRouteSDK } from '@topazdex/v3-sdk'
import { Currency, CurrencyAmount, Fraction, Percent, Price, Token, TradeType } from '@uniswap/sdk-core'
import invariant from 'tiny-invariant'

import { MixedRoute } from './mixedRoute'
import { Protocol, TPool } from './protocol'

export class RouteV2<TInput extends Currency, TOutput extends Currency> extends V2RouteSDK<TInput, TOutput> {
  public readonly protocol = Protocol.V2
}

export class RouteCL<TInput extends Currency, TOutput extends Currency> extends CLRouteSDK<TInput, TOutput> {
  public readonly protocol = Protocol.CL
}

export class RouteMixed<TInput extends Currency, TOutput extends Currency> extends MixedRoute<TInput, TOutput> {
  public readonly protocol = Protocol.MIXED
}

export type AnyRoute<TInput extends Currency, TOutput extends Currency> =
  | RouteV2<TInput, TOutput>
  | RouteCL<TInput, TOutput>
  | RouteMixed<TInput, TOutput>

/** The token sequence a route walks, normalised across the three route shapes */
export function routePath(route: AnyRoute<Currency, Currency>): Token[] {
  return route.protocol === Protocol.CL ? route.tokenPath : route.path
}

export function routePools(route: AnyRoute<Currency, Currency>): TPool[] {
  return route.pools
}

export interface Swap<TInput extends Currency, TOutput extends Currency> {
  route: AnyRoute<TInput, TOutput>
  inputAmount: CurrencyAmount<TInput>
  outputAmount: CurrencyAmount<TOutput>
}

/**
 * A trade that may be split across several routes and both Topaz stacks.
 *
 * Amounts are supplied by whoever quoted the routes — the smart order router quotes on chain
 * rather than simulating locally — so this type aggregates and applies slippage, it does not price.
 */
export class Trade<TInput extends Currency, TOutput extends Currency, TTradeType extends TradeType> {
  public readonly swaps: Swap<TInput, TOutput>[]
  public readonly tradeType: TTradeType

  private _inputAmount: CurrencyAmount<TInput> | undefined
  private _outputAmount: CurrencyAmount<TOutput> | undefined
  private _executionPrice: Price<TInput, TOutput> | undefined
  private _priceImpact: Percent | undefined

  public constructor({ swaps, tradeType }: { swaps: Swap<TInput, TOutput>[]; tradeType: TTradeType }) {
    invariant(swaps.length > 0, 'SWAPS')
    const inputCurrency = swaps[0].inputAmount.currency
    const outputCurrency = swaps[0].outputAmount.currency
    invariant(
      swaps.every(swap => inputCurrency.equals(swap.inputAmount.currency)),
      'INPUT_CURRENCY_MATCH'
    )
    invariant(
      swaps.every(swap => outputCurrency.equals(swap.outputAmount.currency)),
      'OUTPUT_CURRENCY_MATCH'
    )
    this.swaps = swaps
    this.tradeType = tradeType
  }

  public get routes(): AnyRoute<TInput, TOutput>[] {
    return this.swaps.map(swap => swap.route)
  }

  /** True when the trade touches both Topaz stacks, whether split or mixed within one route */
  public get spansBothStacks(): boolean {
    const protocols = new Set(this.routes.map(route => route.protocol))
    return protocols.has(Protocol.MIXED) || (protocols.has(Protocol.V2) && protocols.has(Protocol.CL))
  }

  public get inputAmount(): CurrencyAmount<TInput> {
    if (this._inputAmount) return this._inputAmount
    const total = this.swaps.reduce(
      (sum, swap) => sum.add(swap.inputAmount),
      CurrencyAmount.fromRawAmount(this.swaps[0].inputAmount.currency, 0)
    )
    return (this._inputAmount = total)
  }

  public get outputAmount(): CurrencyAmount<TOutput> {
    if (this._outputAmount) return this._outputAmount
    const total = this.swaps.reduce(
      (sum, swap) => sum.add(swap.outputAmount),
      CurrencyAmount.fromRawAmount(this.swaps[0].outputAmount.currency, 0)
    )
    return (this._outputAmount = total)
  }

  public get executionPrice(): Price<TInput, TOutput> {
    return (
      this._executionPrice ??
      (this._executionPrice = new Price(
        this.inputAmount.currency,
        this.outputAmount.currency,
        this.inputAmount.quotient,
        this.outputAmount.quotient
      ))
    )
  }

  /** Requires routes whose pools can price a spot mid price, i.e. every pool state is loaded */
  public get priceImpact(): Percent {
    if (this._priceImpact) return this._priceImpact

    let spotOutputAmount = CurrencyAmount.fromRawAmount(this.outputAmount.currency, 0)
    for (const swap of this.swaps) {
      spotOutputAmount = spotOutputAmount.add(swap.route.midPrice.quote(swap.inputAmount))
    }
    const priceImpact = spotOutputAmount.subtract(this.outputAmount).divide(spotOutputAmount)
    return (this._priceImpact = new Percent(priceImpact.numerator, priceImpact.denominator))
  }

  public minimumAmountOut(slippageTolerance: Percent, amountOut = this.outputAmount): CurrencyAmount<TOutput> {
    invariant(!slippageTolerance.lessThan(0), 'SLIPPAGE_TOLERANCE')
    if (this.tradeType === TradeType.EXACT_OUTPUT) return amountOut
    const slippageAdjustedAmountOut = new Fraction(1).add(slippageTolerance).invert().multiply(amountOut.quotient)
      .quotient
    return CurrencyAmount.fromRawAmount(amountOut.currency, slippageAdjustedAmountOut)
  }

  public maximumAmountIn(slippageTolerance: Percent, amountIn = this.inputAmount): CurrencyAmount<TInput> {
    invariant(!slippageTolerance.lessThan(0), 'SLIPPAGE_TOLERANCE')
    if (this.tradeType === TradeType.EXACT_INPUT) return amountIn
    const slippageAdjustedAmountIn = new Fraction(1).add(slippageTolerance).multiply(amountIn.quotient).quotient
    return CurrencyAmount.fromRawAmount(amountIn.currency, slippageAdjustedAmountIn)
  }

  public worstExecutionPrice(slippageTolerance: Percent): Price<TInput, TOutput> {
    return new Price(
      this.inputAmount.currency,
      this.outputAmount.currency,
      this.maximumAmountIn(slippageTolerance).quotient,
      this.minimumAmountOut(slippageTolerance).quotient
    )
  }
}

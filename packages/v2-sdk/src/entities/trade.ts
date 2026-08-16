import { Currency, CurrencyAmount, Fraction, Percent, Price, Token, TradeType } from '@uniswap/sdk-core'
import invariant from 'tiny-invariant'

import { Route } from './route'

/** A trade executed against one or more Topaz v2 pools */
export class Trade<TInput extends Currency, TOutput extends Currency, TTradeType extends TradeType> {
  public readonly route: Route<TInput, TOutput>
  public readonly tradeType: TTradeType
  public readonly inputAmount: CurrencyAmount<TInput>
  public readonly outputAmount: CurrencyAmount<TOutput>

  private _executionPrice: Price<TInput, TOutput> | undefined
  private _priceImpact: Percent | undefined

  public static exactIn<TInput extends Currency, TOutput extends Currency>(
    route: Route<TInput, TOutput>,
    amountIn: CurrencyAmount<TInput>
  ): Trade<TInput, TOutput, TradeType.EXACT_INPUT> {
    return new Trade(route, amountIn, TradeType.EXACT_INPUT)
  }

  public static exactOut<TInput extends Currency, TOutput extends Currency>(
    route: Route<TInput, TOutput>,
    amountOut: CurrencyAmount<TOutput>
  ): Trade<TInput, TOutput, TradeType.EXACT_OUTPUT> {
    return new Trade(route, amountOut, TradeType.EXACT_OUTPUT)
  }

  public constructor(
    route: Route<TInput, TOutput>,
    amount: TTradeType extends TradeType.EXACT_INPUT ? CurrencyAmount<TInput> : CurrencyAmount<TOutput>,
    tradeType: TTradeType
  ) {
    this.route = route
    this.tradeType = tradeType

    const tokenAmounts: CurrencyAmount<Token>[] = new Array(route.path.length)
    if (tradeType === TradeType.EXACT_INPUT) {
      invariant(amount.currency.equals(route.input), 'INPUT')
      tokenAmounts[0] = amount.wrapped
      for (let i = 0; i < route.path.length - 1; i++) {
        const [outputAmount] = route.pools[i].getOutputAmount(tokenAmounts[i])
        tokenAmounts[i + 1] = outputAmount
      }
      this.inputAmount = CurrencyAmount.fromFractionalAmount(route.input, amount.numerator, amount.denominator)
      this.outputAmount = CurrencyAmount.fromFractionalAmount(
        route.output,
        tokenAmounts[tokenAmounts.length - 1].numerator,
        tokenAmounts[tokenAmounts.length - 1].denominator
      )
    } else {
      invariant(amount.currency.equals(route.output), 'OUTPUT')
      tokenAmounts[tokenAmounts.length - 1] = amount.wrapped
      for (let i = route.path.length - 1; i > 0; i--) {
        const [inputAmount] = route.pools[i - 1].getInputAmount(tokenAmounts[i])
        tokenAmounts[i - 1] = inputAmount
      }
      this.inputAmount = CurrencyAmount.fromFractionalAmount(
        route.input,
        tokenAmounts[0].numerator,
        tokenAmounts[0].denominator
      )
      this.outputAmount = CurrencyAmount.fromFractionalAmount(route.output, amount.numerator, amount.denominator)
    }
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

  public get priceImpact(): Percent {
    if (this._priceImpact) return this._priceImpact
    const midPrice = this.route.midPrice
    const exactQuote = midPrice.quote(this.inputAmount)
    const slippage = exactQuote.subtract(this.outputAmount).divide(exactQuote)
    return (this._priceImpact = new Percent(slippage.numerator, slippage.denominator))
  }

  public minimumAmountOut(slippageTolerance: Percent): CurrencyAmount<TOutput> {
    invariant(!slippageTolerance.lessThan(0), 'SLIPPAGE_TOLERANCE')
    if (this.tradeType === TradeType.EXACT_OUTPUT) return this.outputAmount
    const slippageAdjustedAmountOut = new Fraction(1)
      .add(slippageTolerance)
      .invert()
      .multiply(this.outputAmount.quotient).quotient
    return CurrencyAmount.fromRawAmount(this.outputAmount.currency, slippageAdjustedAmountOut)
  }

  public maximumAmountIn(slippageTolerance: Percent): CurrencyAmount<TInput> {
    invariant(!slippageTolerance.lessThan(0), 'SLIPPAGE_TOLERANCE')
    if (this.tradeType === TradeType.EXACT_INPUT) return this.inputAmount
    const slippageAdjustedAmountIn = new Fraction(1).add(slippageTolerance).multiply(this.inputAmount.quotient).quotient
    return CurrencyAmount.fromRawAmount(this.inputAmount.currency, slippageAdjustedAmountIn)
  }
}

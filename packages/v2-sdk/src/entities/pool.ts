import { BigintIsh, CurrencyAmount, Price, Token } from '@uniswap/sdk-core'
import JSBI from 'jsbi'
import invariant from 'tiny-invariant'

import {
  DEFAULT_STABLE_FEE,
  DEFAULT_VOLATILE_FEE,
  FEE_DENOMINATOR,
  ONE,
  ONE_E18,
  THREE,
  ZERO
} from '../constants'
import { InsufficientInputAmountError, InsufficientReservesError, StableExactOutputError } from '../errors'
import { computePoolAddress, sortsBefore } from '../utils/computePoolAddress'

/**
 * A Topaz v2 pool: Solidly constant product (`xy = k`) when volatile, or the stable
 * invariant (`x³y + xy³ = k`) when stable.
 *
 * Every arithmetic step mirrors `Pool.sol` exactly, including the order of integer
 * divisions, so quotes agree with the chain to the wei.
 */
export class Pool {
  public readonly stable: boolean
  /** Swap fee in basis points, `amountIn * fee / 10_000` is withheld */
  public readonly fee: number
  private readonly tokenAmounts: [CurrencyAmount<Token>, CurrencyAmount<Token>]

  public static getAddress(
    tokenA: Token,
    tokenB: Token,
    stable: boolean,
    factoryAddress?: string,
    implementationAddress?: string
  ): string {
    return computePoolAddress({ factoryAddress, implementationAddress, tokenA, tokenB, stable })
  }

  public constructor(
    currencyAmountA: CurrencyAmount<Token>,
    currencyAmountB: CurrencyAmount<Token>,
    stable: boolean,
    fee: number = stable ? DEFAULT_STABLE_FEE : DEFAULT_VOLATILE_FEE
  ) {
    invariant(Number.isInteger(fee) && fee >= 0 && fee < 10_000, 'FEE')
    const tokenAmounts = sortsBefore(currencyAmountA.currency, currencyAmountB.currency)
      ? [currencyAmountA, currencyAmountB]
      : [currencyAmountB, currencyAmountA]
    this.tokenAmounts = tokenAmounts as [CurrencyAmount<Token>, CurrencyAmount<Token>]
    this.stable = stable
    this.fee = fee
  }

  public get address(): string {
    return Pool.getAddress(this.token0, this.token1, this.stable)
  }

  public get chainId(): number {
    return this.token0.chainId
  }

  public get token0(): Token {
    return this.tokenAmounts[0].currency
  }

  public get token1(): Token {
    return this.tokenAmounts[1].currency
  }

  public get reserve0(): CurrencyAmount<Token> {
    return this.tokenAmounts[0]
  }

  public get reserve1(): CurrencyAmount<Token> {
    return this.tokenAmounts[1]
  }

  public involvesToken(token: Token): boolean {
    return token.equals(this.token0) || token.equals(this.token1)
  }

  public reserveOf(token: Token): CurrencyAmount<Token> {
    invariant(this.involvesToken(token), 'TOKEN')
    return token.equals(this.token0) ? this.reserve0 : this.reserve1
  }

  /** Spot price of token1 in terms of token0, ignoring curve shape and fees */
  public get token0Price(): Price<Token, Token> {
    return new Price(this.token0, this.token1, this.tokenAmounts[0].quotient, this.tokenAmounts[1].quotient)
  }

  public get token1Price(): Price<Token, Token> {
    return new Price(this.token1, this.token0, this.tokenAmounts[1].quotient, this.tokenAmounts[0].quotient)
  }

  public priceOf(token: Token): Price<Token, Token> {
    invariant(this.involvesToken(token), 'TOKEN')
    return token.equals(this.token0) ? this.token0Price : this.token1Price
  }

  /**
   * Quotes an exact input swap and returns the pool as it would look afterwards.
   * Mirrors `Pool.getAmountOut` followed by the reserve update performed in `Pool.swap`.
   */
  public getOutputAmount(inputAmount: CurrencyAmount<Token>): [CurrencyAmount<Token>, Pool] {
    invariant(this.involvesToken(inputAmount.currency), 'TOKEN')
    if (JSBI.equal(this.reserve0.quotient, ZERO) || JSBI.equal(this.reserve1.quotient, ZERO)) {
      throw new InsufficientReservesError()
    }

    const inputReserve = this.reserveOf(inputAmount.currency)
    const outputToken = inputAmount.currency.equals(this.token0) ? this.token1 : this.token0
    const outputReserve = this.reserveOf(outputToken)

    const amountIn = inputAmount.quotient
    const feeAmount = JSBI.divide(JSBI.multiply(amountIn, JSBI.BigInt(this.fee)), FEE_DENOMINATOR)
    const amountInAfterFee = JSBI.subtract(amountIn, feeAmount)

    const amountOut = this.stable
      ? this.getStableAmountOut(amountInAfterFee, inputAmount.currency)
      : JSBI.divide(
          JSBI.multiply(amountInAfterFee, outputReserve.quotient),
          JSBI.add(inputReserve.quotient, amountInAfterFee)
        )

    if (JSBI.equal(amountOut, ZERO)) throw new InsufficientInputAmountError()
    if (JSBI.greaterThanOrEqual(amountOut, outputReserve.quotient)) throw new InsufficientReservesError()

    const outputAmount = CurrencyAmount.fromRawAmount(outputToken, amountOut)
    // fees leave the pool for PoolFees, so only the post fee input sticks to the reserve
    const nextInputReserve = inputReserve.add(CurrencyAmount.fromRawAmount(inputAmount.currency, amountInAfterFee))
    const nextOutputReserve = outputReserve.subtract(outputAmount)

    return [outputAmount, new Pool(nextInputReserve, nextOutputReserve, this.stable, this.fee)]
  }

  /**
   * Quotes an exact output swap. Volatile pools only: the stable invariant has no closed
   * form inverse, which is why the Universal Router rejects stable exact output too.
   */
  public getInputAmount(outputAmount: CurrencyAmount<Token>): [CurrencyAmount<Token>, Pool] {
    invariant(this.involvesToken(outputAmount.currency), 'TOKEN')
    if (this.stable) throw new StableExactOutputError()
    if (JSBI.equal(this.reserve0.quotient, ZERO) || JSBI.equal(this.reserve1.quotient, ZERO)) {
      throw new InsufficientReservesError()
    }

    const outputReserve = this.reserveOf(outputAmount.currency)
    if (JSBI.greaterThanOrEqual(outputAmount.quotient, outputReserve.quotient)) {
      throw new InsufficientReservesError()
    }

    const inputToken = outputAmount.currency.equals(this.token0) ? this.token1 : this.token0
    const inputReserve = this.reserveOf(inputToken)

    // matches TopazV2Library.getAmountIn
    const numerator = JSBI.multiply(outputAmount.quotient, inputReserve.quotient)
    const denominator = JSBI.subtract(outputReserve.quotient, outputAmount.quotient)
    const amountInBeforeFee = JSBI.divide(numerator, denominator)
    const amountIn = JSBI.add(
      JSBI.divide(
        JSBI.multiply(amountInBeforeFee, FEE_DENOMINATOR),
        JSBI.subtract(FEE_DENOMINATOR, JSBI.BigInt(this.fee))
      ),
      ONE
    )

    const inputAmount = CurrencyAmount.fromRawAmount(inputToken, amountIn)
    const feeAmount = JSBI.divide(JSBI.multiply(amountIn, JSBI.BigInt(this.fee)), FEE_DENOMINATOR)
    const nextInputReserve = inputReserve.add(
      CurrencyAmount.fromRawAmount(inputToken, JSBI.subtract(amountIn, feeAmount))
    )
    const nextOutputReserve = outputReserve.subtract(outputAmount)

    return [inputAmount, new Pool(nextInputReserve, nextOutputReserve, this.stable, this.fee)]
  }

  private get decimals0(): JSBI {
    return JSBI.exponentiate(JSBI.BigInt(10), JSBI.BigInt(this.token0.decimals))
  }

  private get decimals1(): JSBI {
    return JSBI.exponentiate(JSBI.BigInt(10), JSBI.BigInt(this.token1.decimals))
  }

  /** `Pool._getAmountOut` for the stable branch, on a fee adjusted input */
  private getStableAmountOut(amountIn: JSBI, tokenIn: Token): JSBI {
    const isToken0 = tokenIn.equals(this.token0)
    const xy = this.k(this.reserve0.quotient, this.reserve1.quotient)

    const normalizedReserve0 = JSBI.divide(JSBI.multiply(this.reserve0.quotient, ONE_E18), this.decimals0)
    const normalizedReserve1 = JSBI.divide(JSBI.multiply(this.reserve1.quotient, ONE_E18), this.decimals1)
    const [reserveA, reserveB] = isToken0
      ? [normalizedReserve0, normalizedReserve1]
      : [normalizedReserve1, normalizedReserve0]

    const normalizedAmountIn = JSBI.divide(
      JSBI.multiply(amountIn, ONE_E18),
      isToken0 ? this.decimals0 : this.decimals1
    )
    const y = JSBI.subtract(reserveB, Pool.getY(JSBI.add(normalizedAmountIn, reserveA), xy, reserveB))
    return JSBI.divide(JSBI.multiply(y, isToken0 ? this.decimals1 : this.decimals0), ONE_E18)
  }

  /** `Pool._k` */
  private k(x: JSBI, y: JSBI): JSBI {
    if (!this.stable) return JSBI.multiply(x, y)
    const normalizedX = JSBI.divide(JSBI.multiply(x, ONE_E18), this.decimals0)
    const normalizedY = JSBI.divide(JSBI.multiply(y, ONE_E18), this.decimals1)
    const a = JSBI.divide(JSBI.multiply(normalizedX, normalizedY), ONE_E18)
    const b = JSBI.add(
      JSBI.divide(JSBI.multiply(normalizedX, normalizedX), ONE_E18),
      JSBI.divide(JSBI.multiply(normalizedY, normalizedY), ONE_E18)
    )
    return JSBI.divide(JSBI.multiply(a, b), ONE_E18)
  }

  private static f(x0: JSBI, y: JSBI): JSBI {
    const a = JSBI.divide(JSBI.multiply(x0, y), ONE_E18)
    const b = JSBI.add(
      JSBI.divide(JSBI.multiply(x0, x0), ONE_E18),
      JSBI.divide(JSBI.multiply(y, y), ONE_E18)
    )
    return JSBI.divide(JSBI.multiply(a, b), ONE_E18)
  }

  private static d(x0: JSBI, y: JSBI): JSBI {
    return JSBI.add(
      JSBI.divide(JSBI.multiply(JSBI.multiply(THREE, x0), JSBI.divide(JSBI.multiply(y, y), ONE_E18)), ONE_E18),
      JSBI.divide(JSBI.multiply(JSBI.divide(JSBI.multiply(x0, x0), ONE_E18), x0), ONE_E18)
    )
  }

  /** `Pool._get_y`, Newton's method over the stable invariant */
  public static getY(x0: JSBI, xy: JSBI, y: JSBI): JSBI {
    for (let i = 0; i < 255; i++) {
      const k = Pool.f(x0, y)
      if (JSBI.lessThan(k, xy)) {
        let dy = JSBI.divide(JSBI.multiply(JSBI.subtract(xy, k), ONE_E18), Pool.d(x0, y))
        if (JSBI.equal(dy, ZERO)) {
          if (JSBI.equal(k, xy)) return y
          if (JSBI.greaterThan(Pool.f(x0, JSBI.add(y, ONE)), xy)) return JSBI.add(y, ONE)
          dy = ONE
        }
        y = JSBI.add(y, dy)
      } else {
        let dy = JSBI.divide(JSBI.multiply(JSBI.subtract(k, xy), ONE_E18), Pool.d(x0, y))
        if (JSBI.equal(dy, ZERO)) {
          if (JSBI.equal(k, xy) || JSBI.lessThan(Pool.f(x0, JSBI.subtract(y, ONE)), xy)) return y
          dy = ONE
        }
        y = JSBI.subtract(y, dy)
      }
    }
    throw new Error('!y')
  }

  public static fromReserves(
    tokenA: Token,
    tokenB: Token,
    reserveA: BigintIsh,
    reserveB: BigintIsh,
    stable: boolean,
    fee?: number
  ): Pool {
    return new Pool(
      CurrencyAmount.fromRawAmount(tokenA, reserveA),
      CurrencyAmount.fromRawAmount(tokenB, reserveB),
      stable,
      fee
    )
  }
}

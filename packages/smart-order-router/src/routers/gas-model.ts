import { BigNumber } from '@ethersproject/bignumber'
import { AnyRoute, isCLPool, TPool } from '@topazdex/router-sdk'
import { Currency, CurrencyAmount, Price, Token, WBNB } from '@topazdex/sdk-core'

import { BASE_SWAP_GAS, CL_HOP_GAS, CL_TICK_CROSS_GAS, V2_HOP_GAS } from '../constants'

export interface GasEstimate {
  gasUsed: BigNumber
  gasCostInNative: CurrencyAmount<Token>
  gasCostInQuoteToken: CurrencyAmount<Currency>
}

/**
 * Prices a route's gas in the quote token so the router can compare a cheap single hop against an
 * expensive split honestly. Gas numbers come from the Universal Router fork tests; the dominant
 * variable is how many initialised ticks a CL swap crosses.
 */
export class GasModel {
  private readonly nativePriceInQuoteToken: Price<Token, Currency> | undefined

  public constructor(
    private readonly gasPriceWei: BigNumber,
    private readonly quoteCurrency: Currency,
    pools: TPool[]
  ) {
    this.nativePriceInQuoteToken = buildNativePrice(quoteCurrency, pools)
  }

  /** True when no pool linked the quote token to BNB, so gas cannot be expressed in the quote token */
  public get canPriceGas(): boolean {
    return this.nativePriceInQuoteToken !== undefined || this.quoteCurrency.wrapped.equals(WBNB)
  }

  public estimate(route: AnyRoute<Currency, Currency>, initializedTicksCrossed: number): GasEstimate {
    let gas = BASE_SWAP_GAS
    for (const pool of route.pools) {
      gas += isCLPool(pool) ? CL_HOP_GAS : V2_HOP_GAS
    }
    gas += initializedTicksCrossed * CL_TICK_CROSS_GAS

    const gasUsed = BigNumber.from(gas)
    const gasCostWei = gasUsed.mul(this.gasPriceWei)
    const gasCostInNative = CurrencyAmount.fromRawAmount(WBNB, gasCostWei.toString())

    return {
      gasUsed,
      gasCostInNative,
      gasCostInQuoteToken: this.toQuoteToken(gasCostInNative)
    }
  }

  private toQuoteToken(gasCostInNative: CurrencyAmount<Token>): CurrencyAmount<Currency> {
    if (this.quoteCurrency.wrapped.equals(WBNB)) {
      return CurrencyAmount.fromRawAmount(this.quoteCurrency, gasCostInNative.quotient)
    }
    if (!this.nativePriceInQuoteToken) {
      return CurrencyAmount.fromRawAmount(this.quoteCurrency, 0)
    }
    return this.nativePriceInQuoteToken.quote(gasCostInNative)
  }
}

/**
 * Finds a price for BNB in the quote token, directly if a pool pairs them and otherwise through
 * one intermediate token. Deep pools win, since a thin pool would mis-state the gas cost.
 */
function buildNativePrice(quoteCurrency: Currency, pools: TPool[]): Price<Token, Currency> | undefined {
  const quoteToken = quoteCurrency.wrapped
  if (quoteToken.equals(WBNB)) return undefined

  const direct = bestPoolBetween(WBNB, quoteToken, pools)
  if (direct) {
    const price = direct.priceOf(WBNB)
    return new Price(WBNB, quoteCurrency, price.denominator, price.numerator)
  }

  for (const pool of pools) {
    if (!pool.involvesToken(WBNB)) continue
    const intermediate = pool.token0.equals(WBNB) ? pool.token1 : pool.token0
    const second = bestPoolBetween(intermediate, quoteToken, pools)
    if (!second) continue

    const combined = pool.priceOf(WBNB).multiply(second.priceOf(intermediate))
    return new Price(WBNB, quoteCurrency, combined.denominator, combined.numerator)
  }

  return undefined
}

function bestPoolBetween(tokenA: Token, tokenB: Token, pools: TPool[]): TPool | undefined {
  const candidates = pools.filter(pool => pool.involvesToken(tokenA) && pool.involvesToken(tokenB))
  if (candidates.length === 0) return undefined

  return candidates.reduce((best, pool) => (poolDepth(pool) > poolDepth(best) ? pool : best))
}

function poolDepth(pool: TPool): number {
  if (isCLPool(pool)) return Number(pool.liquidity.toString())
  return Number(pool.reserve0.quotient.toString()) * Number(pool.reserve1.quotient.toString())
}

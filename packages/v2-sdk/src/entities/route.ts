import { Currency, Price, Token } from '@uniswap/sdk-core'
import invariant from 'tiny-invariant'

import { Pool } from './pool'

/** An ordered list of Topaz v2 pools that swaps `input` into `output` */
export class Route<TInput extends Currency, TOutput extends Currency> {
  public readonly pools: Pool[]
  public readonly path: Token[]
  public readonly input: TInput
  public readonly output: TOutput

  private _midPrice: Price<TInput, TOutput> | null = null

  public constructor(pools: Pool[], input: TInput, output: TOutput) {
    invariant(pools.length > 0, 'POOLS')
    const chainId = pools[0].chainId
    invariant(
      pools.every(pool => pool.chainId === chainId),
      'CHAIN_IDS'
    )

    const wrappedInput = input.wrapped
    invariant(pools[0].involvesToken(wrappedInput), 'INPUT')
    invariant(pools[pools.length - 1].involvesToken(output.wrapped), 'OUTPUT')

    const path: Token[] = [wrappedInput]
    for (const [i, pool] of pools.entries()) {
      const currentInput = path[i]
      invariant(currentInput.equals(pool.token0) || currentInput.equals(pool.token1), 'PATH')
      path.push(currentInput.equals(pool.token0) ? pool.token1 : pool.token0)
    }

    this.pools = pools
    this.path = path
    this.input = input
    this.output = output
  }

  public get chainId(): number {
    return this.pools[0].chainId
  }

  /** Spot price along the route, fees excluded */
  public get midPrice(): Price<TInput, TOutput> {
    if (this._midPrice !== null) return this._midPrice
    const prices: Price<Currency, Currency>[] = []
    for (const [i, pool] of this.pools.entries()) {
      prices.push(
        this.path[i].equals(pool.token0)
          ? new Price(pool.reserve0.currency, pool.reserve1.currency, pool.reserve0.quotient, pool.reserve1.quotient)
          : new Price(pool.reserve1.currency, pool.reserve0.currency, pool.reserve1.quotient, pool.reserve0.quotient)
      )
    }
    const reduced = prices.slice(1).reduce((accumulator, currentValue) => accumulator.multiply(currentValue), prices[0])
    return (this._midPrice = new Price(this.input, this.output, reduced.denominator, reduced.numerator))
  }
}

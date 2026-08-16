import { Currency, Price, Token } from '@uniswap/sdk-core'
import invariant from 'tiny-invariant'

import { isCLPool, TPool } from './protocol'

/**
 * An ordered list of pools that may cross both Topaz stacks, for example a CL hop followed by a
 * Solidly stable hop. The Universal Router executes such a route as consecutive commands.
 */
export class MixedRoute<TInput extends Currency, TOutput extends Currency> {
  public readonly pools: TPool[]
  public readonly path: Token[]
  public readonly input: TInput
  public readonly output: TOutput

  private _midPrice: Price<TInput, TOutput> | null = null

  public constructor(pools: TPool[], input: TInput, output: TOutput) {
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

  /** True when the route touches more than one stack */
  public get isMixed(): boolean {
    const first = isCLPool(this.pools[0])
    return this.pools.some(pool => isCLPool(pool) !== first)
  }

  public get midPrice(): Price<TInput, TOutput> {
    if (this._midPrice !== null) return this._midPrice

    const price = this.pools.slice(1).reduce(
      ({ nextInput, price }, pool) => {
        return nextInput.equals(pool.token0)
          ? { nextInput: pool.token1, price: price.multiply(pool.token0Price) }
          : { nextInput: pool.token0, price: price.multiply(pool.token1Price) }
      },
      this.pools[0].token0.equals(this.input.wrapped)
        ? { nextInput: this.pools[0].token1, price: this.pools[0].token0Price }
        : { nextInput: this.pools[0].token0, price: this.pools[0].token1Price }
    ).price

    return (this._midPrice = new Price(this.input, this.output, price.denominator, price.numerator))
  }
}

/**
 * Splits a mixed route into the longest possible runs of a single protocol.
 *
 * The Universal Router has one command per stack, so a CL→CL→v2 route becomes a CL command over
 * two hops followed by a v2 command over one.
 */
export function partitionMixedRouteByProtocol(route: MixedRoute<Currency, Currency>): TPool[][] {
  const sections: TPool[][] = []
  let current: TPool[] = []
  let currentIsCL: boolean | undefined

  for (const pool of route.pools) {
    const poolIsCL = isCLPool(pool)
    if (currentIsCL === undefined || poolIsCL === currentIsCL) {
      current.push(pool)
    } else {
      sections.push(current)
      current = [pool]
    }
    currentIsCL = poolIsCL
  }
  if (current.length > 0) sections.push(current)

  return sections
}

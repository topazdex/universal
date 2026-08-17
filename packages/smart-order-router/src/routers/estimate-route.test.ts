import { RouteCL, RouteV2 } from '@topazdex/router-sdk'
import { CurrencyAmount, Token, USDT, WBNB } from '@topazdex/sdk-core'
import { Pool as V2Pool } from '@topazdex/v2-sdk'
import { Pool as CLPool, TickSpacing } from '@topazdex/v3-sdk'
import JSBI from 'jsbi'

import { estimateOutput, prerankRoutes } from './estimate-route'

const Q96 = JSBI.exponentiate(JSBI.BigInt(2), JSBI.BigInt(96))

/** A CL pool at 1:1 with the given in-range liquidity */
function clPoolAtParity(liquidity: string, fee = 500): CLPool {
  return new CLPool(WBNB, USDT, fee, TickSpacing.LOW, Q96.toString(), liquidity, 0)
}

function v2Pool(reserveWbnb: string, reserveUsdt: string): V2Pool {
  return V2Pool.fromReserves(WBNB, USDT, reserveWbnb, reserveUsdt, false, 30)
}

const oneBnb = CurrencyAmount.fromRawAmount(WBNB, '1000000000000000000')

describe('estimateOutput', () => {
  it('uses the exact Solidly maths for a v2 leg', () => {
    // #given
    const pool = v2Pool('1000000000000000000000', '600000000000000000000000')
    const route = new RouteV2([pool], WBNB, USDT)

    // #when
    const estimate = estimateOutput(route, oneBnb)
    const [exact] = pool.getOutputAmount(oneBnb)

    // #then the estimate is the real answer, not an approximation
    expect(estimate?.quotient.toString()).toEqual(exact.quotient.toString())
  })

  it('prices impact on a CL leg, so a thin pool scores below a deep one', () => {
    // #given two pools at the same price, one far deeper
    const deep = new RouteCL([clPoolAtParity('10000000000000000000000000')], WBNB, USDT)
    const thin = new RouteCL([clPoolAtParity('2000000000000000000')], WBNB, USDT)

    // #when
    const deepOut = estimateOutput(deep, oneBnb)
    const thinOut = estimateOutput(thin, oneBnb)

    // #then
    expect(deepOut).toBeDefined()
    expect(thinOut).toBeDefined()
    expect(deepOut?.greaterThan(thinOut as CurrencyAmount<Token>)).toBe(true)
  })

  it('charges the pool fee', () => {
    const cheap = new RouteCL([clPoolAtParity('10000000000000000000000000', 100)], WBNB, USDT)
    const dear = new RouteCL([clPoolAtParity('10000000000000000000000000', 10_000)], WBNB, USDT)

    const cheapOut = estimateOutput(cheap, oneBnb)
    const dearOut = estimateOutput(dear, oneBnb)

    expect(cheapOut?.greaterThan(dearOut as CurrencyAmount<Token>)).toBe(true)
  })

  it('approaches the spot price as the trade gets small relative to liquidity', () => {
    // #given a deep pool at 1:1 and a dust trade
    const route = new RouteCL([clPoolAtParity('100000000000000000000000000', 0)], WBNB, USDT)
    const dust = CurrencyAmount.fromRawAmount(WBNB, '1000')

    // #when
    const estimate = estimateOutput(route, dust)

    // #then impact is negligible, so output ≈ input at parity
    expect(Number(estimate?.quotient.toString())).toBeGreaterThan(995)
    expect(Number(estimate?.quotient.toString())).toBeLessThanOrEqual(1000)
  })

  it('gives up on a pool with no liquidity rather than inventing a number', () => {
    const route = new RouteCL([clPoolAtParity('0')], WBNB, USDT)

    expect(estimateOutput(route, oneBnb)).toBeUndefined()
  })

  it('ranks a v2 pool that cannot absorb the trade near zero', () => {
    // #given reserves far smaller than the trade: the curve asymptotes, it does not throw
    const route = new RouteV2([v2Pool('1000', '1000')], WBNB, USDT)

    // #then the estimate is dust, which sorts the route last where it belongs
    expect(Number(estimateOutput(route, oneBnb)?.quotient.toString())).toBeLessThan(1000)
  })
})

describe('prerankRoutes', () => {
  const deep = new RouteCL([clPoolAtParity('10000000000000000000000000')], WBNB, USDT)
  const middling = new RouteCL([clPoolAtParity('1000000000000000000000')], WBNB, USDT)
  const thin = new RouteCL([clPoolAtParity('2000000000000000000')], WBNB, USDT)

  it('returns everything when under the limit, untouched', () => {
    const routes = [thin, deep]

    expect(prerankRoutes(routes, oneBnb, 10)).toEqual(routes)
  })

  it('keeps the most promising routes', () => {
    const kept = prerankRoutes([thin, deep, middling], oneBnb, 2)

    expect(kept).toContain(deep)
    expect(kept).not.toContain(thin)
  })

  it('orders routes it cannot estimate last, behind every scored one', () => {
    // #given more routes than the limit, two of which cannot be estimated
    const unknownA = new RouteCL([clPoolAtParity('0')], WBNB, USDT)
    const unknownB = new RouteCL([clPoolAtParity('0', 100)], WBNB, USDT)

    // #when
    const kept = prerankRoutes([unknownA, deep, unknownB, middling], oneBnb, 3)

    // #then the scored routes lead, and only leftover capacity goes to an unknown
    expect(kept.slice(0, 2)).toEqual([deep, middling])
    expect([unknownA, unknownB]).toContain(kept[2])
  })

  it('spends the limit on scored routes before unscored ones', () => {
    const unknown = new RouteCL([clPoolAtParity('0')], WBNB, USDT)

    const kept = prerankRoutes([unknown, deep, middling], oneBnb, 2)

    expect(kept).toEqual([deep, middling])
  })
})

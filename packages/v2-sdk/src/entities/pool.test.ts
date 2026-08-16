import { CurrencyAmount, Percent, Token, TradeType } from '@uniswap/sdk-core'

import { TOPAZ_CHAIN_ID } from '../constants'
import { StableExactOutputError } from '../errors'
import { Pool } from './pool'
import { Route } from './route'
import { Trade } from './trade'

const WBNB = new Token(TOPAZ_CHAIN_ID, '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', 18, 'WBNB')
const USDT = new Token(TOPAZ_CHAIN_ID, '0x55d398326f99059fF775485246999027B3197955', 18, 'USDT')
const USDC = new Token(TOPAZ_CHAIN_ID, '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', 18, 'USDC')

describe('Pool address derivation', () => {
  it('derives the live WBNB/USDT volatile pool', () => {
    expect(Pool.getAddress(WBNB, USDT, false)).toEqual('0xe030E94879204403dB8eAA73251667551446ae01')
  })

  it('derives the live USDT/USDC stable pool', () => {
    expect(Pool.getAddress(USDT, USDC, true)).toEqual('0xfd687F1AAAFccC88bC6BD708222Ae3D71a6bdB7a')
  })

  it('is independent of token order', () => {
    expect(Pool.getAddress(USDT, WBNB, false)).toEqual(Pool.getAddress(WBNB, USDT, false))
  })

  it('separates the volatile and stable pool of a pair', () => {
    expect(Pool.getAddress(USDT, USDC, true)).not.toEqual(Pool.getAddress(USDT, USDC, false))
  })
})

describe('Pool', () => {
  it('sorts reserves by token address', () => {
    const pool = Pool.fromReserves(WBNB, USDT, '1000', '2000', false)
    expect(pool.token0).toEqual(USDT)
    expect(pool.reserve0.quotient.toString()).toEqual('2000')
  })

  it('quotes a volatile swap with the constant product formula', () => {
    // 1000 in, 30 bips fee => 997 after fee; 997 * 1e18 / (1e18 + 997)
    const pool = Pool.fromReserves(WBNB, USDT, '1000000000000000000', '1000000000000000000', false, 30)
    const [out] = pool.getOutputAmount(CurrencyAmount.fromRawAmount(WBNB, '1000'))
    expect(out.quotient.toString()).toEqual('996')
  })

  it('round trips exact output through the volatile formula', () => {
    const pool = Pool.fromReserves(WBNB, USDT, '1000000000000000000', '2000000000000000000', false, 30)
    const amountIn = CurrencyAmount.fromRawAmount(WBNB, '1000000000000000')
    const [out] = pool.getOutputAmount(amountIn)
    const [backIn] = pool.getInputAmount(out)
    // exact output rounds up, so it may cost at most a wei more than the exact input leg
    expect(Number(backIn.quotient.toString()) - Number(amountIn.quotient.toString())).toBeLessThanOrEqual(2)
  })

  it('deducts the pool fee from the input, not the output', () => {
    const withFee = Pool.fromReserves(WBNB, USDT, '1000000000000000000', '1000000000000000000', false, 30)
    const withoutFee = Pool.fromReserves(WBNB, USDT, '1000000000000000000', '1000000000000000000', false, 0)
    const amount = CurrencyAmount.fromRawAmount(WBNB, '1000000000000000')
    expect(Number(withFee.getOutputAmount(amount)[0].quotient.toString())).toBeLessThan(
      Number(withoutFee.getOutputAmount(amount)[0].quotient.toString())
    )
  })

  it('keeps a stable swap much closer to parity than a volatile one', () => {
    const reserves: [string, string] = ['100000000000000000000000', '100000000000000000000000']
    const amountIn = CurrencyAmount.fromRawAmount(USDT, '10000000000000000000000') // 10k of 100k reserves
    const stable = Pool.fromReserves(USDT, USDC, reserves[0], reserves[1], true, 5)
    const volatile = Pool.fromReserves(USDT, USDC, reserves[0], reserves[1], false, 5)

    const stableOut = Number(stable.getOutputAmount(amountIn)[0].quotient.toString())
    const volatileOut = Number(volatile.getOutputAmount(amountIn)[0].quotient.toString())
    expect(stableOut).toBeGreaterThan(volatileOut)
    expect(stableOut / 1e18).toBeGreaterThan(9900)
  })

  it('handles stable pools with mismatched decimals', () => {
    const usdcSixDecimals = new Token(TOPAZ_CHAIN_ID, USDC.address, 6, 'USDC')
    const pool = Pool.fromReserves(USDT, usdcSixDecimals, '100000000000000000000000', '100000000000', true, 5)
    const [out] = pool.getOutputAmount(CurrencyAmount.fromRawAmount(USDT, '1000000000000000000'))
    // ~1 USDT in should be ~1 USDC out, in 6 decimals
    expect(Number(out.quotient.toString()) / 1e6).toBeGreaterThan(0.99)
    expect(Number(out.quotient.toString()) / 1e6).toBeLessThan(1.0)
  })

  it('refuses exact output on stable pools', () => {
    const pool = Pool.fromReserves(USDT, USDC, '1000000000000000000000', '1000000000000000000000', true, 5)
    expect(() => pool.getInputAmount(CurrencyAmount.fromRawAmount(USDC, '1000000'))).toThrow(StableExactOutputError)
  })
})

describe('Route and Trade', () => {
  const volatile = Pool.fromReserves(WBNB, USDT, '1000000000000000000000', '600000000000000000000000', false, 30)
  const stable = Pool.fromReserves(USDT, USDC, '1000000000000000000000000', '1000000000000000000000000', true, 5)

  it('builds a multi hop path across a volatile then a stable pool', () => {
    const route = new Route([volatile, stable], WBNB, USDC)
    expect(route.path).toEqual([WBNB, USDT, USDC])
    expect(route.midPrice.toSignificant(4)).toEqual('600')
  })

  it('prices an exact input trade along the route', () => {
    const route = new Route([volatile, stable], WBNB, USDC)
    const trade = Trade.exactIn(route, CurrencyAmount.fromRawAmount(WBNB, '1000000000000000000'))
    expect(trade.tradeType).toEqual(TradeType.EXACT_INPUT)
    expect(Number(trade.outputAmount.toExact())).toBeGreaterThan(590)
    expect(Number(trade.outputAmount.toExact())).toBeLessThan(600)
    expect(Number(trade.priceImpact.toSignificant(3))).toBeGreaterThan(0)
  })

  it('applies slippage in the right direction', () => {
    const route = new Route([volatile], WBNB, USDT)
    const trade = Trade.exactIn(route, CurrencyAmount.fromRawAmount(WBNB, '1000000000000000000'))
    const slippage = new Percent(50, 10_000) // 0.5%
    expect(Number(trade.minimumAmountOut(slippage).toExact())).toBeLessThan(Number(trade.outputAmount.toExact()))
    expect(trade.maximumAmountIn(slippage).toExact()).toEqual(trade.inputAmount.toExact())
  })
})

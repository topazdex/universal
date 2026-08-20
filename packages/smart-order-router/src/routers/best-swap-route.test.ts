import { BigNumber } from '@ethersproject/bignumber'
import { RouteV2 } from '@topazdex/router-sdk'
import { CurrencyAmount, TradeType, USDT, WBNB } from '@topazdex/sdk-core'
import { Pool as V2Pool } from '@topazdex/v2-sdk'

import { getBestSwapRoute, RouteWithValidQuote } from './best-swap-route'

function candidate(
  pool: V2Pool,
  tradeType: TradeType,
  rawQuote: string,
  gasAdjustedQuote: string
): RouteWithValidQuote {
  const route = new RouteV2([pool], WBNB, USDT)
  const amountCurrency = tradeType === TradeType.EXACT_INPUT ? WBNB : USDT
  const quoteCurrency = tradeType === TradeType.EXACT_INPUT ? USDT : WBNB

  return {
    route,
    percent: 100,
    amount: CurrencyAmount.fromRawAmount(amountCurrency, '100'),
    quote: CurrencyAmount.fromRawAmount(quoteCurrency, rawQuote),
    quoteAdjustedForGas: CurrencyAmount.fromRawAmount(quoteCurrency, gasAdjustedQuote),
    gasUsed: BigNumber.from(100_000),
    gasCostInQuoteToken: CurrencyAmount.fromRawAmount(quoteCurrency, '10'),
    poolAddresses: [pool.stable ? 'stable' : 'volatile']
  }
}

const volatilePool = V2Pool.fromReserves(WBNB, USDT, '1000000', '1000000', false, 30)
const stablePool = V2Pool.fromReserves(WBNB, USDT, '1000000', '1000000', true, 5)

describe('getBestSwapRoute', () => {
  it('maximizes token output even when the lower-output route is cheaper in gas', () => {
    // #given a pure route with more output and a cheaper route with less output
    const higherOutput = candidate(volatilePool, TradeType.EXACT_INPUT, '100', '90')
    const cheaperGas = candidate(stablePool, TradeType.EXACT_INPUT, '99', '95')

    // #when
    const best = getBestSwapRoute([100], [higherOutput, cheaperGas], TradeType.EXACT_INPUT)

    // #then token output, not an estimated conversion of gas, decides execution
    expect(best?.routes[0] === higherOutput).toBe(true)
    expect(best?.quote.quotient.toString()).toEqual('100')
    expect(best?.quoteGasAdjusted.quotient.toString()).toEqual('90')
  })

  it('minimizes token input for exact output even when another route is cheaper after gas adjustment', () => {
    // #given the lower-input route has a worse gas-adjusted score
    const lowerInput = candidate(volatilePool, TradeType.EXACT_OUTPUT, '100', '110')
    const cheaperGas = candidate(stablePool, TradeType.EXACT_OUTPUT, '101', '105')

    // #when
    const best = getBestSwapRoute([100], [lowerInput, cheaperGas], TradeType.EXACT_OUTPUT)

    // #then token input decides execution
    expect(best?.routes[0] === lowerInput).toBe(true)
    expect(best?.quote.quotient.toString()).toEqual('100')
    expect(best?.quoteGasAdjusted.quotient.toString()).toEqual('110')
  })
})

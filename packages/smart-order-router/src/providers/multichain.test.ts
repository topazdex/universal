import { Interface } from '@ethersproject/abi'
import { BigNumber } from '@ethersproject/bignumber'
import { RouteV2 } from '@topazdex/router-sdk'
import {
  CurrencyAmount,
  gasTokenOnChain,
  getChainConfig,
  registerChain,
  nativeOnChain,
  Token,
  TradeType,
  USDT,
  WBNB
} from '@topazdex/sdk-core'
import { Pool } from '@topazdex/v2-sdk'
import { GasModel } from '../routers/gas-model'
import { MulticallProvider } from './multicall'
import { QuoteProvider } from './quote-provider'
import { TokenProvider } from './token-provider'
import { PoolProvider } from './pool-provider'

it('does not seed another chain token cache with BNB token metadata', async () => {
  const abi = new Interface(['function decimals() view returns(uint8)', 'function symbol() view returns(string)'])
  const call = jest.fn().mockResolvedValue([
    { success: true, returnData: abi.encodeFunctionResult('decimals', [6]) },
    { success: true, returnData: abi.encodeFunctionResult('symbol', ['OTHER']) }
  ])
  const tokens = new TokenProvider(({ call } as unknown) as MulticallProvider, 8453)
  const token = await tokens.getToken(USDT.address)
  expect(token.chainId).toBe(8453)
  expect(token.decimals).toBe(6)
  expect(token.symbol).toBe('OTHER')
  expect(call).toHaveBeenCalledTimes(1)
})

it.each([1, 4663, 8453])('prices native gas using chain %s wrapped native', (chainId) => {
  const native = nativeOnChain(chainId)
  const other = new Token(chainId, USDT.address, 18)
  const pool = Pool.fromReserves(native.wrapped, other, '100000000000000000000', '100000000000000000000', false)
  const model = new GasModel(BigNumber.from(2), native, [pool])
  const gas = model.estimate(new RouteV2([pool], other, native), 0)
  expect(gas.gasCostInNative.currency.equals(native.wrapped)).toBe(true)
  expect(gas.gasCostInQuoteToken.quotient.toString()).toBe(gas.gasUsed.mul(2).toString())
  expect(model.canPriceGas).toBe(true)
})

it('prices Arc gas in the 6-decimal USDC ERC-20 from the 18-decimal native fee', () => {
  const usdc = gasTokenOnChain(5042)
  const other = new Token(5042, USDT.address, 18)
  const pool = Pool.fromReserves(usdc, other, '100000000', '100000000000000000000', false)
  // 20 gwei on Arc is 20e9 wei of an 18-decimal USDC balance
  const model = new GasModel(BigNumber.from('20000000000'), usdc, [pool])
  const gas = model.estimate(new RouteV2([pool], other, usdc), 0)
  expect(gas.gasCostInNative.currency.equals(usdc)).toBe(true)
  expect(gas.gasCostInNative.quotient.toString()).toBe(
    gas.gasUsed.mul('20000000000').div('1000000000000').toString()
  )
  expect(gas.gasCostInQuoteToken.quotient.toString()).toBe(gas.gasCostInNative.quotient.toString())
  expect(model.canPriceGas).toBe(true)

  const otherQuoted = new GasModel(BigNumber.from('20000000000'), other, [pool])
  expect(otherQuoted.canPriceGas).toBe(true)
  // the pool prices 1 USDC (1e6) at 1e18 of the other token: a 1e-12 fee scale then 1e12 price
  expect(otherQuoted.estimate(new RouteV2([pool], usdc, other), 0).gasCostInQuoteToken.quotient.toString()).toBe(
    gas.gasUsed.mul('20000000000').toString()
  )
})

it.each([1, 4663, 8453, 5042])('derives chain %s pool addresses from its factories', (chainId) => {
  const a = new Token(chainId, WBNB.address, 18)
  const b = new Token(chainId, USDT.address, 18)
  const config = getChainConfig(chainId)
  expect(Pool.getAddress(a, b, false)).toBe(
    Pool.getAddress(a, b, false, config.v2FactoryAddress, config.v2PoolImplementationAddress)
  )
  expect(Pool.getAddress(a, b, false)).not.toBe(Pool.getAddress(WBNB, USDT, false))
  expect(() => Pool.getAddress(a, USDT, false)).toThrow('CHAIN_IDS')
})

it('does not send quotes for an incomplete deployment to a BNB quoter when deployment is missing', async () => {
  registerChain({ ...getChainConfig(8453), chainId: 987656, mixedQuoterAddress: undefined, quoterV2Address: undefined })
  const native = nativeOnChain(987656)
  const token = new Token(987656, USDT.address, 18)
  const pool = Pool.fromReserves(native.wrapped, token, '1000000', '1000000', false)
  const route = new RouteV2([pool], native, token)
  const call = jest.fn()
  const quotes = new QuoteProvider(({ call } as unknown) as MulticallProvider, undefined, undefined, 987656)
  await expect(
    quotes.getQuotes(
      [route],
      [{ percent: 100, amount: CurrencyAmount.fromRawAmount(native, 100) }],
      TradeType.EXACT_INPUT
    )
  ).rejects.toThrow('MixedRouteQuoterV1 is not configured for chain 987656')
  expect(call).not.toHaveBeenCalled()
})

it('skips pools indexed after the requested quote block', async () => {
  const call = jest.fn().mockResolvedValue([
    { success: true, returnData: '0x' },
    { success: true, returnData: '0x' }
  ])
  const provider = new PoolProvider(56, ({ call } as unknown) as MulticallProvider)
  await expect(
    provider.getV2Pools(
      [
        {
          id: Pool.getAddress(WBNB, USDT, false),
          stable: false,
          fee: 30,
          reserveUSD: 1,
          token0: { id: WBNB.address, symbol: 'WBNB', decimals: '18' },
          token1: { id: USDT.address, symbol: 'USDT', decimals: '18' }
        }
      ],
      { blockTag: 123 }
    )
  ).resolves.toEqual([])
})

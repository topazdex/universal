import { StaticJsonRpcProvider } from '@ethersproject/providers'
import { MulticallProvider } from './multicall'
import { TopazRouter } from '../routers/topaz-router'
import { CurrencyAmount, nativeOnChain, TradeType, USDT } from '@topazdex/sdk-core'

afterEach(() => jest.restoreAllMocks())

it.each(['RPC HTTP 429', 'network timeout', 'quote_timeout', 'rpc_budget_exceeded'])('does not amplify a transport outage: %s', async message => {
  const provider = new StaticJsonRpcProvider('http://unused.invalid', 56)
  const call = jest.spyOn(provider, 'call').mockRejectedValue(new Error(message))
  await expect(new MulticallProvider(provider).call(Array.from({ length: 15 }, () => ({ target: USDT.address, callData: '0x' })))).rejects.toThrow(message)
  expect(call).toHaveBeenCalledTimes(1)
})

it('rejects a zero split step before reading chain state', async () => {
  const provider = new StaticJsonRpcProvider('http://unused.invalid', 56)
  const head = jest.spyOn(provider, 'getBlockNumber')
  const router = new TopazRouter({ provider })
  await expect(router.route(CurrencyAmount.fromRawAmount(nativeOnChain(56), '1'), USDT, TradeType.EXACT_INPUT, undefined, { distributionPercent: 0 })).rejects.toThrow('Invalid routing')
  expect(head).not.toHaveBeenCalled()
})

import { StaticJsonRpcProvider } from '@ethersproject/providers'
import { MulticallProvider } from './multicall'
import { TopazRouter } from '../routers/topaz-router'
import { CurrencyAmount, nativeOnChain, TradeType, USDT } from '@topazdex/sdk-core'

afterEach(() => jest.restoreAllMocks())

const fifteenCalls = Array.from({ length: 15 }, () => ({ target: USDT.address, callData: '0x' }))

// the error is injected at `send`, not `call`: ethers wraps every eth_call failure in a
// CALL_EXCEPTION on the way up, and that wrapper is what the batch handler actually sees
it.each(['RPC HTTP 429', 'network timeout', 'quote_timeout', 'rpc_budget_exceeded', 'fetch failed'])(
  'does not amplify a transport outage: %s',
  async message => {
    const provider = new StaticJsonRpcProvider('http://unused.invalid', 56)
    const send = jest.spyOn(provider, 'send').mockRejectedValue(new Error(message))
    await expect(new MulticallProvider(provider).call(fifteenCalls)).rejects.toMatchObject({ error: { message } })
    expect(send).toHaveBeenCalledTimes(1)
  }
)

it.each(['out of gas', 'EVM error OutOfGas'])('still halves a batch the node rejected on gas, down to the failing call: %s', async message => {
  const provider = new StaticJsonRpcProvider('http://unused.invalid', 56)
  const send = jest.spyOn(provider, 'send').mockRejectedValue(new Error(message))
  const results = await new MulticallProvider(provider).call(fifteenCalls)
  expect(results).toHaveLength(15)
  expect(results.every(result => !result.success)).toBe(true)
  expect(send).toHaveBeenCalledTimes(29)
})

it('rejects a zero split step before reading chain state', async () => {
  const provider = new StaticJsonRpcProvider('http://unused.invalid', 56)
  const head = jest.spyOn(provider, 'getBlockNumber')
  const router = new TopazRouter({ provider })
  await expect(router.route(CurrencyAmount.fromRawAmount(nativeOnChain(56), '1'), USDT, TradeType.EXACT_INPUT, undefined, { distributionPercent: 0 })).rejects.toThrow('Invalid routing')
  expect(head).not.toHaveBeenCalled()
})

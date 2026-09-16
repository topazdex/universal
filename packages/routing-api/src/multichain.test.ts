import { BigNumber } from 'ethers'
import { BoundedRpcProvider } from './bounded-rpc'
import { RouteV2, Trade } from '@topazdex/router-sdk'
import { CurrencyAmount, USDT } from '@topazdex/sdk-core'
import { MulticallProvider, TopazRouter } from '@topazdex/smart-order-router'
import { Pool } from '@topazdex/v2-sdk'
import { Interface } from 'ethers/lib/utils'
import request from 'supertest'
import { resolve } from 'path'
import { createApp, serverConfigFromEnv } from './server'

const abi = new Interface(['function decimals() view returns(uint8)', 'function symbol() view returns(string)'])

beforeEach(() => {
  jest
    .spyOn(BoundedRpcProvider.prototype, 'send')
    .mockImplementation(async function (this: BoundedRpcProvider, method) {
      if (method !== 'eth_chainId') throw new Error(`Unexpected RPC ${method}`)
      return this.connection.url.includes('4663') ? '0x1237' : '0x2105'
    })
  jest.spyOn(MulticallProvider.prototype, 'call').mockResolvedValue([
    { success: true, returnData: abi.encodeFunctionResult('decimals', [6]) },
    { success: true, returnData: abi.encodeFunctionResult('symbol', ['TOKEN']) }
  ])
  jest.spyOn(TopazRouter.prototype, 'route').mockImplementation(async (amount, currency, tradeType) => {
    const pool = Pool.fromReserves(
      amount.currency.wrapped,
      currency.wrapped,
      '1000000000000000000000',
      '1000000000000',
      false
    )
    const route = new RouteV2([pool], amount.currency, currency)
    const quote = CurrencyAmount.fromRawAmount(currency, amount.currency.chainId)
    const zero = CurrencyAmount.fromRawAmount(currency, 0)
    return {
      quote,
      quoteGasAdjusted: quote,
      estimatedGasUsed: BigNumber.from(1),
      estimatedGasUsedQuoteToken: zero,
      blockNumber: 10,
      routes: [
        {
          route,
          percent: 100,
          amount,
          quote,
          quoteAdjustedForGas: quote,
          gasUsed: BigNumber.from(1),
          gasCostInQuoteToken: zero,
          poolAddresses: [pool.address]
        }
      ],
      trade: new Trade({ tradeType, swaps: [{ route, inputAmount: amount, outputAmount: quote }] })
    }
  })
})

afterEach(() => jest.restoreAllMocks())

function app() {
  return createApp({
    chainId: 4663,
    chains: [
      { chainId: 4663, rpcUrl: 'http://4663.invalid', subgraphUrl: 'http://graph.invalid/4663' },
      { chainId: 8453, rpcUrl: 'http://8453.invalid', subgraphUrl: 'http://graph.invalid/8453' }
    ]
  })
}
const query = { tokenIn: 'ETH', tokenOut: USDT.address, amount: '1000000000000000' }

it('serves concurrent chain-specific quotes and keeps response and token caches isolated', async () => {
  const server = app()
  const [robinhood, base] = await Promise.all([
    request(server)
      .get('/quote')
      .query({ ...query, chainId: 4663 }),
    request(server)
      .post('/quote')
      .send({ ...query, chainId: 8453 })
  ])
  expect(robinhood.status).toBe(200)
  expect(base.status).toBe(200)
  expect(robinhood.body).toMatchObject({ chainId: 4663, quote: '4663', quoteDecimals: '0.004663' })
  expect(base.body).toMatchObject({ chainId: 8453, quote: '8453', quoteDecimals: '0.008453' })
  expect(robinhood.body.routes[0].hops[0].address).not.toBe(base.body.routes[0].hops[0].address)
  const cached = await request(server).get('/quote').query(query)
  expect(cached.headers['x-cache']).toBe('HIT')
  expect(cached.body.chainId).toBe(4663)
  expect(TopazRouter.prototype.route).toHaveBeenCalledTimes(2)
})

it.each(['abc', '0', '-1', '8453.1', '9007199254740992', '1'])(
  'rejects invalid or disabled chainId %s',
  async (chainId) => {
    const response = await request(app())
      .get('/quote')
      .query({ ...query, chainId })
    expect(response.status).toBe(400)
    expect(TopazRouter.prototype.route).not.toHaveBeenCalled()
  }
)

it('rejects an RPC connected to a different chain before quoting', async () => {
  jest.mocked(BoundedRpcProvider.prototype.send).mockResolvedValue('0x38')
  const response = await request(app()).post('/quote').send(query)
  expect(response.status).toBe(502)
  expect(response.body.error).toBe('Quote provider unavailable')
  expect(TopazRouter.prototype.route).not.toHaveBeenCalled()
})

it('reports enabled chain IDs', async () => {
  expect((await request(app()).get('/health')).body).toEqual({ status: 'ok', chainId: 4663, chainIds: [4663, 8453] })
})

it('enables Ethereum in production while retaining the BNB default and existing chains', async () => {
  jest.mocked(BoundedRpcProvider.prototype.send).mockResolvedValue('0x1')
  const config = serverConfigFromEnv({
    CHAINS_CONFIG_FILE: resolve(__dirname, '../../../config/chains.production.json')
  })
  const server = createApp(config)
  expect((await request(server).get('/health')).body).toEqual({
    status: 'ok',
    chainId: 56,
    chainIds: [56, 4663, 8453, 1, 5042]
  })
  const response = await request(server)
    .get('/quote')
    .query({ ...query, chainId: 1 })
  expect(response.status).toBe(200)
  expect(response.body).toMatchObject({ chainId: 1, quote: '1' })
})

describe('Arc, which has no wrapped native', () => {
  const arc = () => {
    jest.mocked(BoundedRpcProvider.prototype.send).mockResolvedValue('0x13b2')
    return createApp({ chainId: 5042, rpcUrl: 'http://5042.invalid', subgraphUrl: 'http://graph.invalid/5042' })
  }
  const usdc = '0x3600000000000000000000000000000000000000'

  it.each(['native', '0x0000000000000000000000000000000000000000'])(
    'refuses the native alias %s instead of encoding a wrap against the stub',
    async (alias) => {
      const response = await request(arc())
        .get('/quote')
        .query({ tokenIn: alias, tokenOut: USDT.address, amount: '1000000' })
      expect(response.status).toBe(400)
      expect(response.body.error).toContain('no wrapped native')
      expect(response.body.error).toContain(usdc)
      expect(TopazRouter.prototype.route).not.toHaveBeenCalled()
    }
  )

  it.each(['ETH', 'USDC'])('rejects the symbol alias %s on Arc', async (alias) => {
    const response = await request(arc())
      .get('/quote')
      .query({ tokenIn: alias, tokenOut: USDT.address, amount: '1000000' })
    expect(response.status).toBe(400)
    expect(TopazRouter.prototype.route).not.toHaveBeenCalled()
  })

  it('quotes the USDC ERC-20 like any other token', async () => {
    const response = await request(arc())
      .get('/quote')
      .query({ tokenIn: usdc, tokenOut: USDT.address, amount: '1000000' })
    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({ chainId: 5042, quote: '5042' })
    const input = jest.mocked(TopazRouter.prototype.route).mock.calls[0][0].currency
    expect(input.isNative).toBe(false)
    expect(input.chainId).toBe(5042)
  })
})

it('serves Ethereum ETH quotes when its graph is explicitly configured', async () => {
  jest.mocked(BoundedRpcProvider.prototype.send).mockResolvedValue('0x1')
  const server = createApp({ chainId: 1, rpcUrl: 'http://1.invalid', subgraphUrl: 'http://graph.invalid/1' })
  const response = await request(server)
    .get('/quote')
    .query({ ...query, chainId: 1 })
  expect(response.status).toBe(200)
  expect(response.body).toMatchObject({ chainId: 1, quote: '1', quoteDecimals: '0.000001' })
  const input = jest.mocked(TopazRouter.prototype.route).mock.calls[0][0].currency
  expect(input.isNative).toBe(true)
  expect(input.chainId).toBe(1)
  expect(input.wrapped.address).toBe('0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2')
})

it('does not use a legacy BNB RPC environment setting on another chain', () => {
  expect(serverConfigFromEnv({ CHAIN_ID: '8453', BSC_MAINNET_RPC: 'https://bnb.invalid' }).rpcUrls).toBeUndefined()
  expect(serverConfigFromEnv({ CHAIN_ID: '4663', RPC_URL: 'https://robinhood.invalid' }).rpcUrls).toEqual([
    'https://robinhood.invalid'
  ])
})

it.each(['query', 'header'])('refreshes quotes while preserving discovery caching via %s', async (mode) => {
  const server = app()
  await request(server).get('/quote').query(query)
  const fresh = request(server).get('/quote')
  if (mode === 'query') fresh.query({ ...query, skipCache: 'true' })
  else fresh.query(query).set('Cache-Control', 'no-cache')
  expect((await fresh).status).toBe(200)
  expect(TopazRouter.prototype.route).toHaveBeenCalledTimes(2)
  expect(jest.mocked(TopazRouter.prototype.route).mock.calls[1][4]).not.toHaveProperty('refreshPools')
})

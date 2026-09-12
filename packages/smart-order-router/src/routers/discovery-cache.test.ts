import { BigNumber } from '@ethersproject/bignumber'
import { StaticJsonRpcProvider } from '@ethersproject/providers'
import { CurrencyAmount, nativeOnChain, Token, TradeType } from '@topazdex/sdk-core'
import { Pool } from '@topazdex/v3-sdk'
import { PoolProvider } from '../providers/pool-provider'
import { QuoteProvider } from '../providers/quote-provider'
import { SubgraphProvider } from '../providers/subgraph'
import { TopazRouter } from './topaz-router'

const native = nativeOnChain(4663)
const token = new Token(4663, '0x39dBED3a2bd333467115dE45665cC57F813C4571', 18, 'PONS')
const amount = CurrencyAmount.fromRawAmount(native, '1000000000000000')
const pool = new Pool(native.wrapped, token, 500, 50, '79228162514264337593543950336', '100000000000000000000', 0)
const discovered = {
  id: Pool.getAddress(pool.token0, pool.token1, pool.tickSpacing),
  token0: { id: native.wrapped.address, symbol: 'WETH', decimals: '18' },
  token1: { id: token.address, symbol: 'PONS', decimals: '18' },
  tickSpacing: 50,
  feeTier: 500,
  liquidity: '100000000000000000000',
  totalValueLockedUSD: 0
}

beforeEach(() => {
  jest.spyOn(StaticJsonRpcProvider.prototype, 'getBlockNumber').mockResolvedValue(100)
  jest.spyOn(StaticJsonRpcProvider.prototype, 'getGasPrice').mockResolvedValue(BigNumber.from(0))
  jest.spyOn(SubgraphProvider.prototype, 'getV2Pools').mockResolvedValue([])
  jest.spyOn(SubgraphProvider.prototype, 'getCLPools').mockResolvedValueOnce([]).mockResolvedValue([discovered])
  jest.spyOn(PoolProvider.prototype, 'getV2Pools').mockResolvedValue([])
  jest
    .spyOn(PoolProvider.prototype, 'getCLPools')
    .mockImplementation(async (candidates) => (candidates.length ? [pool] : []))
  jest.spyOn(QuoteProvider.prototype, 'getQuotes').mockImplementation(async (routes, amounts) =>
    routes.flatMap((route) =>
      amounts.map((entry) => ({
        route,
        ...entry,
        quote: CurrencyAmount.fromRawAmount(route.output, entry.amount.quotient),
        initializedTicksCrossed: 0
      }))
    )
  )
})

afterEach(() => jest.restoreAllMocks())

it('discovers a newly indexed pool when refreshing a previously empty pool cache', async () => {
  const router = new TopazRouter({ provider: new StaticJsonRpcProvider('http://rpc.invalid', 4663), chainId: 4663 })
  await expect(router.route(amount, token, TradeType.EXACT_INPUT)).resolves.toBeNull()
  await expect(router.route(amount, token, TradeType.EXACT_INPUT)).resolves.toBeNull()
  expect(SubgraphProvider.prototype.getCLPools).toHaveBeenCalledTimes(1)
  const fresh = await router.route(amount, token, TradeType.EXACT_INPUT, undefined, { refreshPools: true })
  expect(fresh?.quote.quotient.toString()).toBe(amount.quotient.toString())
  expect(SubgraphProvider.prototype.getCLPools).toHaveBeenCalledTimes(2)
})

it('picks up new pools after the configured discovery TTL expires', async () => {
  const clock = jest.spyOn(Date, 'now').mockReturnValue(100000)
  const router = new TopazRouter({
    provider: new StaticJsonRpcProvider('http://rpc.invalid', 4663),
    chainId: 4663,
    subgraphCacheTtlMs: 30000
  })
  await expect(router.route(amount, token, TradeType.EXACT_INPUT)).resolves.toBeNull()
  clock.mockReturnValue(130001)
  const fresh = await router.route(amount, token, TradeType.EXACT_INPUT)
  expect(fresh?.quote.quotient.toString()).toBe(amount.quotient.toString())
})

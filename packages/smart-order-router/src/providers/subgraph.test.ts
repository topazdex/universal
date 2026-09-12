import fetch from 'cross-fetch'
import { getChainConfig, registerChain } from '@topazdex/sdk-core'
import { SubgraphProvider } from './subgraph'

jest.mock('cross-fetch')
const mockedFetch = fetch as jest.MockedFunction<typeof fetch>
const token = { id: '0x0000000000000000000000000000000000000010', symbol: 'T', decimals: 6 }

function reply(pools: unknown[], chainId = 4663): void {
  mockedFetch.mockResolvedValue({ ok: true, json: async () => ({ data: { chainState: { chainId }, pools } }) } as never)
}

beforeEach(() => mockedFetch.mockReset())

it('queries unified unpriced v2 pools and converts pips to basis points', async () => {
  reply([{ id: 'pool', poolType: 'V2_STABLE', token0: token, token1: { ...token, decimals: null }, feePips: 500 }])
  const graph = SubgraphProvider.forChain(4663, 'https://example.com/unified')
  const pools = await graph.getV2Pools()
  expect(pools[0]).toMatchObject({
    stable: true,
    fee: 5,
    reserveUSD: 0,
    token0: { decimals: '6' },
    token1: { decimals: null }
  })
  const body = JSON.parse(mockedFetch.mock.calls[0][1]!.body as string)
  expect(body.query).toContain('chainState(id: "chain")')
  expect(body.query).toContain('poolType_in: [V2_VOLATILE, V2_STABLE]')
  expect(body.query).toContain('entityKind: USER')
  expect(body.query).not.toContain('reserveUSD')
  expect(body.variables.factory).toBe('0x1e3ac31cf96b20619c913384c9bf6010a824fb95')
})

it('queries CL pools on the same unified endpoint', async () => {
  reply([{ id: 'pool', poolType: 'CL', token0: token, token1: token, tickSpacing: 50, feePips: 700, liquidity: '123' }])
  const pools = await SubgraphProvider.forChain(4663, 'https://example.com/unified').getCLPools()
  expect(pools[0]).toMatchObject({ tickSpacing: 50, feeTier: 700, liquidity: '123' })
  expect(JSON.parse(mockedFetch.mock.calls[0][1]!.body as string).query).toContain('poolType: CL')
})

it('rejects a unified graph belonging to another chain', async () => {
  reply([], 8453)
  await expect(SubgraphProvider.forChain(4663, 'https://example.com/wrong').getCLPools()).rejects.toThrow(
    'does not match 4663'
  )
})

it('requires a subgraph for incomplete deployments instead of using BNB', () => {
  registerChain({ ...getChainConfig(8453), chainId: 987656, subgraphUrl: undefined })
  expect(() => SubgraphProvider.forChain(987656)).toThrow('not configured for chain 987656')
})

it('uses the published Ethereum graph and checks its chain identity', async () => {
  reply([], 1)
  await expect(SubgraphProvider.forChain(1).getV2Pools()).resolves.toEqual([])
  expect(mockedFetch.mock.calls[0][0]).toBe(getChainConfig(1).subgraphUrl)
  const body = JSON.parse(mockedFetch.mock.calls[0][1]!.body as string)
  expect(body.variables.factory).toBe(getChainConfig(1).v2FactoryAddress.toLowerCase())
  reply([], 56)
  await expect(SubgraphProvider.forChain(1, 'https://example.com/wrong').getCLPools()).rejects.toThrow(
    'does not match 1'
  )
})

it('preserves legacy BNB discovery', async () => {
  mockedFetch.mockResolvedValue({ ok: true, json: async () => ({ data: { pairs: [] } }) } as never)
  await expect(SubgraphProvider.forChain(56).getV2Pools()).resolves.toEqual([])
  expect(JSON.parse(mockedFetch.mock.calls[0][1]!.body as string).query).toContain('pairs(')
})

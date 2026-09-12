import request from 'supertest'
import { createApp, parseQuoteQuery, serverConfigFromEnv } from './server'
import { BoundedRpcProvider } from './bounded-rpc'
import { withQuoteBudget, WorkGate } from './work-budget'
import { ResponseCache } from './cache'
import { resolve } from 'path'

const valid = { tokenIn: 'BNB', tokenOut: '0x0000000000000000000000000000000000000001', amount: '1' }
afterEach(() => jest.restoreAllMocks())

it.each([
  { distributionPercent: 0 }, { distributionPercent: -1 }, { distributionPercent: 0.1 },
  { distributionPercent: 7 }, { maxHops: 100 }, { maxSplits: -2 }, { maxHops: ['3', '3'] },
  { type: {} }, { amount: '0' }, { amount: (2n ** 256n).toString() },
  { recipient: 'bad' }, { includeMixedRoutes: [] }, { slippageBips: 0.5 }, { deadlineSeconds: 'Infinity' }
])('rejects unsafe parameters before any provider work: %p', async fields => {
  const rpc = jest.spyOn(BoundedRpcProvider.prototype, 'send').mockRejectedValue(new Error('must not run'))
  const response = await request(createApp({ rpcUrl: 'http://unused.invalid' })).post('/quote').send({ ...valid, ...fields })
  expect(response.status).toBe(400)
  expect(rpc).not.toHaveBeenCalled()
})

it('preserves JSON false, zero slippage and raw uint256 precision', () => {
  expect(parseQuoteQuery({ ...valid, amount: (2n ** 256n - 1n).toString(), includeMixedRoutes: false, slippageBips: 0 }))
    .toMatchObject({ slippageBips: 0, routingConfig: { includeMixedRoutes: false } })
})

it('bounds bodies, ignores forged forwarding headers and leaves health responsive', async () => {
  const app = createApp({ rpcUrl: 'http://unused.invalid' })
  expect((await request(app).post('/quote').send({ padding: 'a'.repeat(17000) })).status).toBe(413)
  const statuses: number[] = []
  for (let i = 0; i < 16; i++) statuses.push((await request(app).get('/quote').set('X-Forwarded-For', `192.0.2.${i}`)).status)
  expect(statuses).toContain(429)
  expect((await request(app).get('/health')).status).toBe(200)
})

it('private RPC overrides apply to the multichain file configuration', () => {
  const config = serverConfigFromEnv({ CHAINS_CONFIG_FILE: resolve(__dirname, '../../../config/chains.production.json'), ROUTING_RPC_URLS_8453: 'https://private.invalid,https://fallback.invalid' })
  expect(config.chains?.find(c => c.chainId === 8453)?.rpcUrls).toEqual(['https://private.invalid', 'https://fallback.invalid'])
})

it('aborts an upstream request at the quote deadline and rejects calls past the budget', async () => {
  let aborted = false
  const fetcher = jest.spyOn(globalThis, 'fetch').mockImplementation(async (_url, options) => {
    const signal = options!.signal!
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => { aborted = true; reject(signal.reason) }, { once: true }))
  })
  const provider = new BoundedRpcProvider('https://private.invalid', 56)
  await expect(withQuoteBudget(() => provider.send('eth_call', []), 30)).rejects.toMatchObject({ code: 'quote_timeout' })
  expect(aborted).toBe(true)
  fetcher.mockClear()
  await expect(withQuoteBudget(() => provider.send('eth_call', []), 100, 0)).rejects.toMatchObject({ code: 'rpc_budget_exceeded' })
  expect(fetcher).not.toHaveBeenCalled()
})

it('counts shared RPC slots, removes aborted waiters and recovers capacity', async () => {
  const gate = new WorkGate(1, 1), controller = new AbortController()
  let release!: () => void
  const first = gate.run(new AbortController().signal, () => new Promise<void>(resolve => { release = resolve }))
  const queued = gate.run(controller.signal, async () => { throw new Error('must not start') })
  await expect(gate.run(new AbortController().signal, async () => 1)).rejects.toMatchObject({ code: 'service_busy' })
  controller.abort(new Error('cancelled'))
  await expect(queued).rejects.toThrow('cancelled')
  release(); await first
  await expect(gate.run(new AbortController().signal, async () => 2)).resolves.toBe(2)
})

it('an older failed computation cannot evict a successful explicit refresh', async () => {
  const cache = new ResponseCache<number>()
  let fail!: (error: Error) => void
  const old = cache.resolve('key', () => new Promise((_resolve, reject) => { fail = reject }))
  await expect(cache.resolve('key', async () => 2, true)).resolves.toBe(2)
  fail(new Error('older failure')); await expect(old).rejects.toThrow('older failure')
  await expect(cache.resolve('key', async () => 3)).resolves.toBe(2)
})

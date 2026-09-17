import request from 'supertest'
import { createApp, parseQuoteQuery, serverConfigFromEnv } from './server'
import { BoundedRpcProvider, rpcGateState } from './bounded-rpc'
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
  for (let i = 0; i < 30; i++) statuses.push((await request(app).get('/quote').set('X-Forwarded-For', `192.0.2.${i}`)).status)
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

it('reclaims the slot of a task that never settles after its signal aborts', async () => {
  // #given a one-slot gate whose only task ignores its abort signal
  const gate = new WorkGate(1, 1, 20), controller = new AbortController()
  const stuck = gate.run(controller.signal, () => new Promise<never>(() => undefined), () => 'stuck task')
  const log = jest.spyOn(console, 'error').mockImplementation(() => undefined)
  // #when the signal aborts and the grace period passes
  controller.abort(new Error('RPC request timeout'))
  await expect(stuck).rejects.toThrow('RPC request timeout')
  // #then the slot is free again and the reclaim was recorded
  await expect(gate.run(new AbortController().signal, async () => 'next')).resolves.toBe('next')
  expect(gate.state()).toMatchObject({ active: 0, queued: 0, capacity: 1, abandoned: 1 })
  expect(log).toHaveBeenCalledWith(expect.stringContaining('stuck task'))
})

it('does not count a task that settles promptly after abort as abandoned', async () => {
  const gate = new WorkGate(1, 1, 20), controller = new AbortController()
  const prompt = gate.run(controller.signal, () => new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener('abort', () => reject(controller.signal.reason))
  }))
  controller.abort(new Error('cancelled'))
  await expect(prompt).rejects.toThrow('cancelled')
  await new Promise(resolve => setTimeout(resolve, 40))
  expect(gate.state()).toMatchObject({ active: 0, abandoned: 0 })
})

it('reports a full gate on which nothing settles as stuck', async () => {
  // #given a gate whose only slot is held by a task that neither settles nor is aborted
  const gate = new WorkGate(1, 1, 10_000, 20)
  void gate.run(new AbortController().signal, () => new Promise<never>(() => undefined))
  expect(gate.state().stuck).toBe(false)
  // #when longer than any task is allowed to run passes with no progress
  await new Promise(resolve => setTimeout(resolve, 40))
  // #then the gate says so, and an idle gate never does
  expect(gate.state().stuck).toBe(true)
  expect(new WorkGate(1, 1, 10_000, 20).state().stuck).toBe(false)
})

it('a fetch that outlives its abort cannot wedge the shared RPC gate', async () => {
  // #given an endpoint whose fetch ignores the abort signal entirely, as undici rarely does
  jest.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise<never>(() => undefined))
  jest.spyOn(console, 'error').mockImplementation(() => undefined)
  const provider = new BoundedRpcProvider('https://stuck.invalid', 56, 50)
  // #when more requests than the gate holds all hang
  const started = Date.now()
  const results = await Promise.allSettled(Array.from({ length: 30 }, () => provider.send('eth_blockNumber', [])))
  // #then every one fails as a timeout within the grace window, and every slot the hung fetches
  // held was reclaimed; the rest timed out in the queue without ever holding one
  expect(results.map(result => result.status === 'rejected' ? String(result.reason.message) : 'ok')).toEqual(Array(30).fill('RPC request timeout'))
  expect(Date.now() - started).toBeLessThan(3_000)
  expect(rpcGateState()).toMatchObject({ active: 0, queued: 0, capacity: 12, abandoned: 12 })
})

it('health reports the shared RPC gate', async () => {
  const response = await request(createApp({ rpcUrl: 'http://unused.invalid' })).get('/health')
  expect(response.body.rpc).toMatchObject({ active: 0, queued: 0, capacity: 12 })
})

it('an older failed computation cannot evict a successful explicit refresh', async () => {
  const cache = new ResponseCache<number>()
  let fail!: (error: Error) => void
  const old = cache.resolve('key', () => new Promise((_resolve, reject) => { fail = reject }))
  await expect(cache.resolve('key', async () => 2, true)).resolves.toBe(2)
  fail(new Error('older failure')); await expect(old).rejects.toThrow('older failure')
  await expect(cache.resolve('key', async () => 3)).resolves.toBe(2)
})

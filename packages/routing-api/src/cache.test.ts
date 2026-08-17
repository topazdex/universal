import { ResponseCache } from './cache'

const tick = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

describe('ResponseCache', () => {
  it('serves a repeat request without recomputing', async () => {
    // #given
    const cache = new ResponseCache<number>({ ttlMs: 1_000 })
    let calls = 0
    const compute = async (): Promise<number> => ++calls

    // #when
    const first = await cache.resolve('a', compute)
    const second = await cache.resolve('a', compute)

    // #then
    expect([first, second]).toEqual([1, 1])
    expect(calls).toEqual(1)
  })

  it('recomputes once the entry expires', async () => {
    // #given
    const cache = new ResponseCache<number>({ ttlMs: 20 })
    let calls = 0
    const compute = async (): Promise<number> => ++calls

    // #when
    await cache.resolve('a', compute)
    await tick(40)
    const after = await cache.resolve('a', compute)

    // #then
    expect(after).toEqual(2)
  })

  it('coalesces concurrent identical requests into one computation', async () => {
    // #given ten users asking for the same pair at once
    const cache = new ResponseCache<number>({ ttlMs: 1_000 })
    let calls = 0
    const compute = async (): Promise<number> => {
      calls++
      await tick(20)
      return calls
    }

    // #when
    const results = await Promise.all(Array.from({ length: 10 }, () => cache.resolve('a', compute)))

    // #then the RPC saw one pipeline, not ten
    expect(calls).toEqual(1)
    expect(new Set(results).size).toEqual(1)
  })

  it('keeps different keys apart', async () => {
    const cache = new ResponseCache<string>({ ttlMs: 1_000 })

    await expect(cache.resolve('a', async () => 'first')).resolves.toEqual('first')
    await expect(cache.resolve('b', async () => 'second')).resolves.toEqual('second')
  })

  it('does not cache a failure', async () => {
    // #given one failing call followed by a good one
    const cache = new ResponseCache<string>({ ttlMs: 10_000 })
    let calls = 0
    const compute = async (): Promise<string> => {
      calls++
      if (calls === 1) throw new Error('rpc blip')
      return 'recovered'
    }

    // #when
    await expect(cache.resolve('a', compute)).rejects.toThrow('rpc blip')

    // #then the blip is not served for the rest of the TTL
    await expect(cache.resolve('a', compute)).resolves.toEqual('recovered')
  })

  it('can be disabled', async () => {
    const cache = new ResponseCache<number>({ ttlMs: 0 })
    let calls = 0
    const compute = async (): Promise<number> => ++calls

    await cache.resolve('a', compute)
    await cache.resolve('a', compute)

    expect(cache.enabled).toBe(false)
    expect(calls).toEqual(2)
  })

  it('evicts oldest entries past its ceiling', async () => {
    // #given a cache that can hold two entries
    const cache = new ResponseCache<string>({ ttlMs: 10_000, maxEntries: 2 })

    // #when three distinct keys are used
    await cache.resolve('a', async () => 'a')
    await cache.resolve('b', async () => 'b')
    await cache.resolve('c', async () => 'c')

    // #then the oldest was dropped and recomputes
    let recomputed = false
    await cache.resolve('a', async () => {
      recomputed = true
      return 'a'
    })
    expect(recomputed).toBe(true)
  })
})

describe('explicit refresh', () => {
  it('recomputes when the caller asks to bypass', async () => {
    // #given a cached value
    const cache = new ResponseCache<number>({ ttlMs: 10_000 })
    let calls = 0
    const compute = async (): Promise<number> => ++calls
    await cache.resolve('a', compute)

    // #when the caller explicitly wants fresh data
    const fresh = await cache.resolve('a', compute, true)

    // #then
    expect(fresh).toEqual(2)
  })

  it('does not join a request already in flight when bypassing', async () => {
    // #given a slow computation already running, started before the user hit refresh
    const cache = new ResponseCache<number>({ ttlMs: 10_000 })
    let calls = 0
    const compute = async (): Promise<number> => {
      const mine = ++calls
      await tick(30)
      return mine
    }
    const inFlight = cache.resolve('a', compute)

    // #when
    const refreshed = await cache.resolve('a', compute, true)
    await inFlight

    // #then the refresh got its own computation, not the older one
    expect(refreshed).toEqual(2)
  })

  it('stores the refreshed value for everyone else', async () => {
    const cache = new ResponseCache<number>({ ttlMs: 10_000 })
    let calls = 0
    const compute = async (): Promise<number> => ++calls

    await cache.resolve('a', compute)
    await cache.resolve('a', compute, true)
    const subsequent = await cache.resolve('a', compute)

    expect(subsequent).toEqual(2)
    expect(calls).toEqual(2)
  })

  it('reports whether a value was reused, and how old it is', async () => {
    const cache = new ResponseCache<string>({ ttlMs: 10_000 })

    const first = await cache.resolveWithOutcome('a', async () => 'v')
    await tick(25)
    const second = await cache.resolveWithOutcome('a', async () => 'v')
    const bypassed = await cache.resolveWithOutcome('a', async () => 'v', true)

    expect(first.hit).toBe(false)
    expect(second.hit).toBe(true)
    expect(second.ageMs).toBeGreaterThanOrEqual(20)
    expect(bypassed.hit).toBe(false)
    expect(bypassed.ageMs).toEqual(0)
  })
})

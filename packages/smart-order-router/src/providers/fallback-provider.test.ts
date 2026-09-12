import { StaticJsonRpcProvider } from '@ethersproject/providers'

import { FallbackRpcProvider, PUBLIC_BSC_RPC_URLS } from './fallback-provider'

type Behaviour = (method: string) => Promise<unknown>

/** A provider that never touches the network, so failover can be tested deterministically */
class ScriptedProvider extends StaticJsonRpcProvider {
  public sent: string[] = []

  public constructor(url: string, private readonly behaviour: Behaviour) {
    super({ url }, 56)
  }

  public async send(method: string): Promise<unknown> {
    this.sent.push(method)
    return this.behaviour(method)
  }
}

function networkError(message = 'connection refused'): Error {
  return Object.assign(new Error(message), { code: 'SERVER_ERROR' })
}

function revert(): Error {
  return Object.assign(new Error('execution reverted'), { code: 'CALL_EXCEPTION' })
}

const ok = (value: unknown): Behaviour => async () => value
const fails = (error: Error): Behaviour => async () => {
  throw error
}

describe('FallbackRpcProvider', () => {
  it('never uses a failover endpoint on the wrong chain', async () => {
    const wrong = new ScriptedProvider('http://wrong', async (method) =>
      method === 'eth_chainId' ? '0x2105' : '0x999'
    )
    const correct = new ScriptedProvider('http://correct', async (method) =>
      method === 'eth_chainId' ? '0x1237' : '0x64'
    )
    const provider = new FallbackRpcProvider([wrong, correct], { chainId: 4663, validateChainId: true })
    expect(await provider.send('eth_call', [])).toBe('0x64')
    expect(wrong.sent).toEqual(['eth_chainId'])
    expect(await provider.getBlockNumber()).toBe(100)
    expect(correct.sent.filter((method) => method === 'eth_chainId')).toHaveLength(1)
  })

  describe('failover', () => {
    it('moves to the next endpoint when one fails at the transport level', async () => {
      // #given
      const dead = new ScriptedProvider('http://dead', fails(networkError()))
      const alive = new ScriptedProvider('http://alive', ok('0x1'))
      const provider = new FallbackRpcProvider([dead, alive])

      // #when
      const result = await provider.send('eth_call', [])

      // #then
      expect(result).toEqual('0x1')
      expect(dead.sent).toHaveLength(1)
      expect(alive.sent).toHaveLength(1)
    })

    it('does not retry a revert on other endpoints', async () => {
      // #given a revert would come back identically everywhere
      const reverting = new ScriptedProvider('http://a', fails(revert()))
      const other = new ScriptedProvider('http://b', ok('0x1'))
      const provider = new FallbackRpcProvider([reverting, other])

      // #when
      await expect(provider.send('eth_call', [])).rejects.toThrow('execution reverted')

      // #then the second endpoint was never asked
      expect(other.sent).toHaveLength(0)
    })

    it('does not fail over, or cool an endpoint down, when the caller spent its own quote budget', async () => {
      // #given the deadline belongs to the quote, not to the endpoint that happened to be serving it
      let calls = 0
      const first = new ScriptedProvider('http://a', async () => {
        calls++
        if (calls === 1) throw Object.assign(new Error('quote_timeout'), { code: 'quote_timeout' })
        return '0x1'
      })
      const other = new ScriptedProvider('http://b', ok('0x2'))
      const provider = new FallbackRpcProvider([first, other], { cooldownMs: 60_000 })

      // #when
      await expect(provider.send('eth_call', [])).rejects.toThrow('quote_timeout')

      // #then the second endpoint was never asked, and the first is still preferred next time
      expect(other.sent).toHaveLength(0)
      await expect(provider.send('eth_call', [])).resolves.toEqual('0x1')
      expect(other.sent).toHaveLength(0)
    })

    it('treats a rate limit as worth retrying elsewhere', async () => {
      // #given
      const limited = new ScriptedProvider('http://a', fails(new Error('429 too many requests')))
      const alive = new ScriptedProvider('http://b', ok('0x2'))
      const provider = new FallbackRpcProvider([limited, alive])

      // #when / #then
      await expect(provider.send('eth_call', [])).resolves.toEqual('0x2')
    })

    it('throws when every endpoint is down', async () => {
      // #given
      const provider = new FallbackRpcProvider([
        new ScriptedProvider('http://a', fails(networkError('a down'))),
        new ScriptedProvider('http://b', fails(networkError('b down')))
      ])

      // #when / #then
      await expect(provider.send('eth_call', [])).rejects.toThrow('b down')
    })

    it('skips an endpoint that just failed until its cooldown expires', async () => {
      // #given
      const flaky = new ScriptedProvider('http://a', fails(networkError()))
      const alive = new ScriptedProvider('http://b', ok('0x1'))
      const provider = new FallbackRpcProvider([flaky, alive], { cooldownMs: 60_000 })

      // #when two requests are made
      await provider.send('eth_call', [])
      await provider.send('eth_call', [])

      // #then the failing endpoint was only tried once
      expect(flaky.sent).toHaveLength(1)
      expect(alive.sent).toHaveLength(2)
    })

    it('retries every endpoint rather than failing outright when all are cooling down', async () => {
      // #given an endpoint that fails once and then recovers
      let calls = 0
      const recovering = new ScriptedProvider('http://a', async () => {
        calls++
        if (calls === 1) throw networkError()
        return '0xrecovered'
      })
      const provider = new FallbackRpcProvider([recovering], { cooldownMs: 60_000 })

      // #when
      await expect(provider.send('eth_call', [])).rejects.toThrow()

      // #then the only endpoint is still tried, cooldown or not
      await expect(provider.send('eth_call', [])).resolves.toEqual('0xrecovered')
    })
  })

  describe('block height', () => {
    it('reports the lowest height the endpoints agree on, so pinned calls work everywhere', async () => {
      // #given endpoints lagging each other
      const provider = new FallbackRpcProvider([
        new ScriptedProvider('http://a', ok('0x64')), // 100
        new ScriptedProvider('http://b', ok('0x62')), // 98
        new ScriptedProvider('http://c', ok('0x63')) // 99
      ])

      // #when
      const head = await provider.getBlockNumber()

      // #then
      expect(head).toEqual(98)
    })

    it('ignores endpoints that cannot report a height', async () => {
      // #given
      const provider = new FallbackRpcProvider([
        new ScriptedProvider('http://dead', fails(networkError())),
        new ScriptedProvider('http://alive', ok('0x64'))
      ])

      // #when / #then
      await expect(provider.getBlockNumber()).resolves.toEqual(100)
    })

    it('caches the agreed height briefly, since every quote asks for it', async () => {
      // #given
      const endpoint = new ScriptedProvider('http://a', ok('0x64'))
      const provider = new FallbackRpcProvider([endpoint], { headCacheMs: 60_000 })

      // #when
      await provider.getBlockNumber()
      await provider.getBlockNumber()

      // #then
      expect(endpoint.sent.filter((method) => method === 'eth_blockNumber')).toHaveLength(1)
    })

    it('throws when no endpoint can report a height', async () => {
      // #given
      const provider = new FallbackRpcProvider([new ScriptedProvider('http://a', fails(networkError()))])

      // #when / #then
      await expect(provider.getBlockNumber()).rejects.toThrow('no healthy RPC endpoint')
    })
  })

  describe('configuration', () => {
    it('refuses to start with no endpoints', () => {
      expect(() => new FallbackRpcProvider([])).toThrow('at least one endpoint')
    })

    it('accepts plain urls', () => {
      const provider = new FallbackRpcProvider(PUBLIC_BSC_RPC_URLS)
      expect(provider.urls).toEqual(PUBLIC_BSC_RPC_URLS)
    })

    it('ships a public endpoint list that is https only and free of duplicates', () => {
      expect(PUBLIC_BSC_RPC_URLS.every((url) => url.startsWith('https://'))).toBe(true)
      expect(new Set(PUBLIC_BSC_RPC_URLS).size).toEqual(PUBLIC_BSC_RPC_URLS.length)
    })
  })
})

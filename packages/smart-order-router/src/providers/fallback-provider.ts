import { Network } from '@ethersproject/networks'
import { StaticJsonRpcProvider } from '@ethersproject/providers'

import { TOPAZ_CHAIN_ID } from '../constants'

/**
 * Public BNB Chain endpoints, ordered by measured health.
 *
 * Every entry here was probed for the three things this router needs: the right chain, a
 * `blockTag` a few blocks back (quotes are pinned to one block), and a Multicall3 batch of at
 * least 200 quote simulations. Endpoints that failed any of those — llamarpc, 1rpc, ankr,
 * nodies, subquery, meowrpc at the time of writing — are deliberately absent.
 *
 * These are a fallback, not a plan. A paid endpoint is roughly 4x faster end to end.
 */
export const PUBLIC_BSC_RPC_URLS: string[] = [
  'https://bsc-dataseed1.defibit.io',
  'https://bsc-dataseed2.bnbchain.org',
  'https://bsc-rpc.publicnode.com',
  'https://bsc-dataseed1.bnbchain.org',
  'https://bsc-dataseed1.ninicoin.io',
  'https://bsc.blockrazor.xyz',
  'https://bsc-dataseed.bnbchain.org',
  'https://bsc.drpc.org'
]

export interface FallbackRpcProviderOptions {
  chainId?: number
  /** Verify every endpoint before using its state. Enabled by the routing API. */
  validateChainId?: boolean
  /** Per request, per endpoint */
  timeoutMs?: number
  /** How long a failing endpoint is skipped */
  cooldownMs?: number
  /** Endpoints to try before giving up on a request */
  maxAttempts?: number
  /** How long the agreed block height is reused */
  headCacheMs?: number
  /** How long to wait for endpoints to report their height before proceeding without the stragglers */
  headDeadlineMs?: number
}

interface Endpoint {
  url: string
  provider: StaticJsonRpcProvider
  skipUntil: number
  networkCheck?: Promise<void>
}

/**
 * Sends each request to the first healthy endpoint and moves on when one misbehaves.
 *
 * Unlike ethers' `FallbackProvider` this does not seek quorum: quotes are already expensive, and
 * asking several endpoints the same question multiplies RPC cost for no benefit on read-only data.
 *
 * Two behaviours matter for correctness:
 *
 * - **Deterministic failures are not retried elsewhere.** A batch that exhausts the node's gas
 *   ceiling would fail identically on every endpoint; retrying it eight times before the caller
 *   gets to halve it just wastes time. Only transport-level failures fail over.
 * - **The reported block height is the lowest the healthy endpoints agree on.** Quotes pin every
 *   call to one block, and endpoints lag each other by a block or two, so pinning to the fastest
 *   endpoint's head would make every call fail on the ones still catching up.
 */
export class FallbackRpcProvider extends StaticJsonRpcProvider {
  private readonly endpoints: Endpoint[]
  private readonly cooldownMs: number
  private readonly maxAttempts: number
  private readonly headCacheMs: number
  private readonly headDeadlineMs: number
  private readonly validateChainId: boolean
  private headPending: Promise<number> | undefined
  private head: { value: number; at: number } | undefined

  /**
   * @param endpoints urls, or ready-made providers when an endpoint needs its own auth or timeouts
   */
  public constructor(endpoints: (string | StaticJsonRpcProvider)[], options: FallbackRpcProviderOptions = {}) {
    const chainId = options.chainId ?? TOPAZ_CHAIN_ID
    const timeout = options.timeoutMs ?? 20_000
    if (endpoints.length === 0) throw new Error('FallbackRpcProvider needs at least one endpoint')

    const first = endpoints[0]
    super({ url: typeof first === 'string' ? first : first.connection.url, timeout }, chainId)

    this.endpoints = endpoints.map((endpoint) => ({
      url: typeof endpoint === 'string' ? endpoint : endpoint.connection.url,
      provider:
        typeof endpoint === 'string' ? new StaticJsonRpcProvider({ url: endpoint, timeout }, chainId) : endpoint,
      skipUntil: 0
    }))
    this.cooldownMs = options.cooldownMs ?? 30_000
    this.maxAttempts = options.maxAttempts ?? Math.min(4, endpoints.length)
    this.headCacheMs = options.headCacheMs ?? 2_000
    this.headDeadlineMs = options.headDeadlineMs ?? 1_500
    this.validateChainId = options.validateChainId ?? false
  }

  public get urls(): string[] {
    return this.endpoints.map((endpoint) => endpoint.url)
  }

  public async send(method: string, params: Array<unknown>): Promise<unknown> {
    const now = Date.now()
    const healthy = this.endpoints.filter((endpoint) => endpoint.skipUntil <= now)
    // every endpoint is cooling down: better to retry them than to fail outright
    const order = healthy.length > 0 ? healthy : this.endpoints

    let lastError: unknown
    for (const endpoint of order.slice(0, this.maxAttempts)) {
      try {
        await this.verifyEndpoint(endpoint)
        return await endpoint.provider.send(method, params)
      } catch (error) {
        if (isDeterministic(error)) throw error
        endpoint.skipUntil = Date.now() + this.cooldownMs
        lastError = error
      }
    }
    throw lastError
  }

  /** The highest block every endpoint that answered promptly can serve */
  public async getBlockNumber(): Promise<number> {
    return this.headPending ??= this.fetchHead().finally(() => { this.headPending = undefined })
  }

  private async fetchHead(): Promise<number> {
    const now = Date.now()
    if (this.head && now - this.head.at < this.headCacheMs) return this.head.value

    const asked = this.endpoints.filter((endpoint) => endpoint.skipUntil <= now)
    const pending = (asked.length > 0 ? asked : this.endpoints).map((endpoint) => this.headOf(endpoint))

    // an endpoint that cannot answer this within the deadline is no use for quoting either, so
    // proceed with whoever replied rather than letting the slowest one gate the request
    const known = (await Promise.all(pending.map((head) => withDeadline(head, this.headDeadlineMs)))).filter(
      (value): value is number => typeof value === 'number'
    )

    // nothing replied in time: fall back to the first endpoint that replies at all
    const value = known.length > 0 ? Math.min(...known) : await firstResolved(pending)
    this.head = { value, at: Date.now() }
    return value
  }

  private async headOf(endpoint: Endpoint): Promise<number | undefined> {
    try {
      await this.verifyEndpoint(endpoint)
      const result = await endpoint.provider.send('eth_blockNumber', [])
      const head = Number.parseInt(result as string, 16)
      return Number.isFinite(head) ? head : undefined
    } catch {
      endpoint.skipUntil = Date.now() + this.cooldownMs
      return undefined
    }
  }

  private async verifyEndpoint(endpoint: Endpoint): Promise<void> {
    if (!this.validateChainId) return
    await (endpoint.networkCheck ??= endpoint.provider
      .send('eth_chainId', [])
      .then((actual) => {
        if (Number(actual) !== this.network.chainId)
          throw new Error(`RPC chain does not match configured chain ${this.network.chainId}`)
      })
      .catch((error) => {
        endpoint.networkCheck = undefined
        throw error
      }))
  }

  public async detectNetwork(): Promise<Network> {
    return this.network
  }
}

/** Resolves to undefined if the promise has not settled within the deadline */
async function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), ms)
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function firstResolved(pending: Promise<number | undefined>[]): Promise<number> {
  return new Promise((resolve, reject) => {
    let remaining = pending.length
    for (const promise of pending) promise.then(value => {
      if (typeof value === 'number') resolve(value)
      if (--remaining === 0) reject(new Error('no healthy RPC endpoint could report a block number'))
    }, () => {
      if (--remaining === 0) reject(new Error('no healthy RPC endpoint could report a block number'))
    })
  })
}

/**
 * True when the node answered and the answer would be the same everywhere: a revert, a gas
 * ceiling, an invalid argument. Anything else — timeout, socket error, 429, 5xx — is worth
 * asking a different endpoint.
 */
function isDeterministic(error: unknown): boolean {
  const code = (error as { code?: string })?.code
  if (code === 'CALL_EXCEPTION' || code === 'UNPREDICTABLE_GAS_LIMIT' || code === 'INVALID_ARGUMENT') {
    return true
  }
  const message = String((error as { message?: string })?.message ?? '').toLowerCase()
  if (message.includes('rate limit') || message.includes('too many requests') || message.includes('429')) {
    return false
  }
  return (
    message.includes('execution reverted') || message.includes('out of gas') || message.includes('gas required exceeds')
  )
}

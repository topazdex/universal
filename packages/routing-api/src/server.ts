import { readFileSync } from 'fs'
import { StaticJsonRpcProvider } from '@ethersproject/providers'
import { ChainDeployment, getChainConfig, registerChain, TradeType } from '@topazdex/sdk-core'
import {
  FallbackRpcProvider,
  MulticallProvider,
  PUBLIC_BSC_RPC_URLS,
  TokenProvider,
  TopazRouter
} from '@topazdex/smart-order-router'
import express, { Express, NextFunction, Request, Response } from 'express'

import { ResponseCache } from './cache'
import { BoundedRpcProvider, rpcGateState } from './bounded-rpc'
import { quoteProtection } from './protection'
import { WorkLimitError } from './work-budget'
import { BadRequestError, QuotePermit, QuoteResponse, QuoteService } from './quote'

/**
 * Browser origins allowed to call the API when nothing is configured.
 *
 * `localhost` covers any port and either loopback spelling, because dev servers vary — Vite is
 * 5173, Next is 3000, and a browser treats `127.0.0.1` as a different origin from `localhost`.
 * That is safe here: quotes are public read-only data and no credentials are ever accepted, so
 * CORS is gating who may *read* a response their own machine could fetch with curl regardless.
 *
 * The wildcard covers every topazdex host — `app`, `www`, `a2`, whatever ships next — without a
 * deploy per subdomain. The apex is listed separately because `*.` requires a label.
 */
export const DEFAULT_CORS_ORIGINS = ['localhost', 'https://topazdex.com', 'https://*.topazdex.com']

/** `localhost` in an allowlist means any port, over http, on either loopback spelling */
function isLoopback(origin: string): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin)
}

/**
 * `https://*.topazdex.com` matches any subdomain, at any depth. The `*` stands for hostname labels
 * and nothing else, and the pattern is anchored, so `https://app.topazdex.com.evil.example` and
 * `https://topazdex.com.evil.example` both still fail.
 */
function compileWildcard(pattern: string): RegExp {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`^${escaped.replace(/\\\*/g, '[a-z0-9-]+(?:\\.[a-z0-9-]+)*')}$`)
}

export interface ChainServerConfig {
  /** One endpoint, or several to fail over between. Defaults to the public list. */
  rpcUrl?: string
  rpcUrls?: string[]
  chainId?: number
  universalRouterAddress?: string
  subgraphUrl?: string
  /** How long discovered pool lists are reused; live pool state is always fetched again. */
  subgraphCacheTtlMs?: number
  /** Public deployment metadata. Required in full for a new chain; overrides known deployments. */
  deployment?: Partial<ChainDeployment>
  /** Quote calls per eth_call. Lower it if the RPC rejects batches on gas. */
  multicallBatchSize?: number
  /** eth_calls in flight at once. Lower it if the RPC rate limits you. */
  multicallConcurrency?: number
  /** Token addresses the router may hop through, overriding the defaults */
  baseTokens?: string[]
  /** How long an identical quote is reused; 0 disables caching. */
  quoteCacheTtlMs?: number
  /**
   * Per RPC attempt, including time spent queued behind other quotes. Default 3s: a public
   * endpoint that takes longer than that on one call is not going to produce a usable quote.
   * A cold anvil fork fetches state lazily and needs far more.
   */
  rpcTimeoutMs?: number
  /** Deadline for one computed quote, after which its in-flight RPCs are aborted. Default 12s. */
  quoteTimeoutMs?: number
}

export interface ServerConfig extends ChainServerConfig {
  /** Enabled chains. Omit for the legacy single-chain server. */
  chains?: ChainServerConfig[]
  corsOrigins?: string[]
}

export function createApp(config: ServerConfig): Express {
  const chainId = config.chainId ?? config.chains?.[0]?.chainId ?? 56
  const services = new Map<number, { quote: QuoteService; verifyNetwork: () => Promise<void> }>()
  for (const entry of config.chains ?? [config]) {
    const id = entry.chainId ?? chainId
    if (!Number.isSafeInteger(id) || id <= 0 || services.has(id)) throw new Error(`Invalid or duplicate chainId ${id}`)
    if (entry.deployment) {
      let existing: Partial<ChainDeployment> = {}
      try {
        existing = getChainConfig(id)
      } catch {
        /* new deployment must supply every required field */
      }
      registerChain({ ...existing, ...entry.deployment, chainId: id } as ChainDeployment)
    }
    const chain = getChainConfig(id)
    const provider = buildProvider(entry, id)
    const multicall = new MulticallProvider(
      provider,
      {
        batchSize: entry.multicallBatchSize,
        concurrency: entry.multicallConcurrency
      },
      chain.multicallAddress
    )
    const tokenProvider = new TokenProvider(multicall, id)
    const router = new TopazRouter({
      provider,
      chainId: id,
      multicallProvider: multicall,
      universalRouterAddress: entry.universalRouterAddress,
      subgraphUrl: entry.subgraphUrl,
      subgraphCacheTtlMs: entry.subgraphCacheTtlMs
    })
    const cache = new ResponseCache<QuoteResponse | null>({ ttlMs: entry.quoteCacheTtlMs ?? config.quoteCacheTtlMs })
    let verified: Promise<void> | undefined
    services.set(id, {
      quote: new QuoteService(
        router,
        tokenProvider,
        id,
        entry.baseTokens,
        cache,
        async () => services.get(id)!.verifyNetwork(),
        entry.quoteTimeoutMs ?? config.quoteTimeoutMs
      ),
      verifyNetwork: () =>
        verified ??
        (verified = provider
          .send('eth_chainId', [])
          .then((actual) => {
            if (Number(actual) !== id) throw new Error(`RPC chain does not match configured chain ${id}`)
          })
          .catch((error) => {
            verified = undefined
            throw error
          }))
    })
  }
  if (!services.has(chainId)) throw new Error(`Default chain ${chainId} is not enabled`)

  const app = express()
  app.disable('x-powered-by')
  app.set('query parser', 'simple')
  app.use(cors(config.corsOrigins ?? DEFAULT_CORS_ORIGINS))
  app.use('/quote', quoteProtection())
  app.use(express.json({ limit: '16kb', strict: true }))

  // a process whose RPC gate is stuck answers every quote with a timeout; failing the check
  // takes it out of the load balancer instead of letting it serve half the traffic as 502s
  app.get('/health', (_request: Request, response: Response) => {
    const rpc = rpcGateState()
    response.status(rpc.stuck ? 503 : 200).json({ status: rpc.stuck ? 'degraded' : 'ok', chainId, ...(config.chains ? { chainIds: [...services.keys()] } : {}), rpc })
  })

  // POST carries a Permit2 signature comfortably; GET stays for simple quotes and links
  app.post('/quote', async (request: Request, response: Response) => {
    await handleQuote(request.body as QueryLike, response, wantsFresh(request))
  })

  app.get('/quote', async (request: Request, response: Response) => {
    await handleQuote(request.query as QueryLike, response, wantsFresh(request))
  })

  async function handleQuote(source: QueryLike, response: Response, skipCache = false): Promise<void> {
    response.locals.quoteStarted = true
    try {
      const params = { ...parseQuoteQuery(source), skipCache }
      const requestedChain = parseChainId(source.chainId, chainId)
      const service = services.get(requestedChain)
      if (!service) throw new BadRequestError(`Unsupported chainId ${requestedChain}`)
      const nativeSymbol = getChainConfig(requestedChain).nativeCurrency.symbol.toLowerCase()
      for (const token of [params.tokenIn, params.tokenOut]) if (['eth', 'bnb'].includes(token.toLowerCase()) && token.toLowerCase() !== nativeSymbol) throw new BadRequestError('Native alias does not match chain')
      const { value, hit, ageMs } = await service.quote.quoteWithCacheOutcome(params)
      if (!value) {
        response.status(404).json({ error: 'No route found' })
        return
      }
      // so a caller can tell a reused answer from a fresh one without guessing
      response.setHeader('X-Cache', hit ? 'HIT' : 'MISS')
      response.setHeader('Age', String(Math.floor(ageMs / 1000)))
      response.json(value)
    } catch (error) {
      if (error instanceof BadRequestError) response.status(400).json({ error: error.message })
      else if (error instanceof WorkLimitError) {
        response.setHeader('Retry-After', '1')
        response.status(error.code === 'quote_timeout' ? 504 : 503).json({ error: error.code })
      } else {
        // the caller gets a generic answer; the operator gets the cause, minus anything that
        // could be an endpoint credential
        // eslint-disable-next-line no-console
        console.error(`quote failed on chain ${source.chainId ?? chainId}: ${describeFailure(error)}`)
        response.status(502).json({ error: 'Quote provider unavailable' })
      }
    } finally { response.locals.releaseQuote?.() }
  }

  app.use((error: { type?: string }, _request: Request, response: Response, _next: NextFunction) => {
    response.locals.releaseQuote?.()
    response.status(error.type === 'entity.too.large' ? 413 : 400).json({ error: 'Invalid request body' })
  })
  return app
}

/**
 * Quotes are public read-only data, so this is an allowlist rather than a credentialed policy: the
 * matching origin is echoed back, never a wildcard alongside credentials.
 *
 * A `POST` carrying `content-type: application/json` is not a simple request, so browsers send a
 * preflight first — it has to be answered even though the endpoint itself is harmless.
 */
function cors(origins: string[]) {
  const allowAll = origins.includes('*')
  const allowLoopback = origins.includes('localhost')
  const allowed = new Set(origins.map((origin) => origin.toLowerCase()))
  const patterns = origins
    .filter((origin) => origin !== '*' && origin.includes('*'))
    .map((origin) => compileWildcard(origin.toLowerCase()))

  function isAllowed(origin: string): boolean {
    if (allowAll || allowed.has(origin)) return true
    if (allowLoopback && isLoopback(origin)) return true
    return patterns.some((pattern) => pattern.test(origin))
  }

  return (request: Request, response: Response, next: NextFunction): void => {
    const origin = request.headers.origin
    const permitted = Boolean(origin) && isAllowed((origin as string).toLowerCase())

    // set unconditionally: a shared cache must not serve a header-less response to an allowed
    // origin, or vice versa
    response.setHeader('Vary', 'Origin, Access-Control-Request-Headers')

    if (origin && permitted) {
      response.setHeader('Access-Control-Allow-Origin', origin)
      response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
      // Reflect whatever the caller asked for. Only `content-type` was allowed before, which broke
      // the documented `Cache-Control: no-cache` refresh: that header is not CORS-safelisted, so it
      // preflights, and the browser blocked the response. Reflecting is safe because this API never
      // accepts credentials — the origin allowlist above is what decides who may read a response.
      response.setHeader(
        'Access-Control-Allow-Headers',
        request.headers['access-control-request-headers'] ?? 'content-type'
      )
      response.setHeader('Access-Control-Max-Age', '86400')
    }

    if (request.method === 'OPTIONS') {
      response.sendStatus(204)
      return
    }
    next()
  }
}

/**
 * A single endpoint stays a plain provider; several become a failover pool. Either way it is
 * Static, not JsonRpcProvider: the latter issues an eth_chainId before every single request,
 * which doubles the request count for a quote that is otherwise all multicalls.
 */
function buildProvider(config: ChainServerConfig, chainId: number): StaticJsonRpcProvider {
  const urls = config.rpcUrls?.length
    ? config.rpcUrls
    : config.rpcUrl
    ? [config.rpcUrl]
    : chainId === 56
    ? PUBLIC_BSC_RPC_URLS
    : getChainConfig(chainId).rpcUrls
  if (urls.length === 0) throw new Error(`RPC URL is not configured for chain ${chainId}`)
  return new FallbackRpcProvider(
    urls.slice(0, 2).map((url) => new BoundedRpcProvider(url, chainId, config.rpcTimeoutMs)),
    { chainId, validateChainId: true, maxAttempts: 2 }
  )
}

interface QueryLike {
  [key: string]: unknown
}

/**
 * The chain of messages from an error down to its root cause, for a log line. ethers wraps a
 * failed eth_call in a CALL_EXCEPTION whose message says nothing about why the send failed, so
 * the nested `error` is usually the interesting part. URLs are dropped: an RPC endpoint may
 * carry its key in the path.
 */
function describeFailure(error: unknown): string {
  const parts: string[] = []
  for (let cause = error as { message?: string; error?: unknown } | undefined; cause; cause = cause.error as typeof cause) {
    const message = String(cause.message ?? cause).replace(/https?:\/\/\S+/g, '<url>').slice(0, 300)
    if (!parts.includes(message)) parts.push(message)
    if (parts.length === 4) break
  }
  return parts.join(' <- ') || 'unknown error'
}

/**
 * A user pressing refresh is asking for new data, not for whatever we answered a second ago.
 * Standard `Cache-Control: no-cache` says so; `?skipCache=true` is the same thing for clients
 * that find setting a header awkward.
 */
function wantsFresh(request: Request): boolean {
  const cacheControl = String(request.headers['cache-control'] ?? '').toLowerCase()
  if (cacheControl.includes('no-cache') || cacheControl.includes('no-store')) return true

  const source = (request.method === 'POST' ? request.body : request.query) as QueryLike | undefined
  return source?.skipCache === true || source?.skipCache === 'true'
}

export function parseQuoteQuery(query: QueryLike) {
  if (!query || typeof query !== 'object' || Array.isArray(query)) throw new BadRequestError('Expected a request object')
  const tokenIn = requireString(query, 'tokenIn')
  const tokenOut = requireString(query, 'tokenOut')
  for (const token of [tokenIn, tokenOut]) {
    if (!/^(0x[0-9a-fA-F]{40}|native|BNB|ETH)$/i.test(token)) throw new BadRequestError('Invalid token address or native alias')
  }
  const amount = rawUint(requireString(query, 'amount'), 256, 'amount')
  if (BigInt(amount) === 0n) throw new BadRequestError('amount must be positive')
  const type = query.type === undefined ? 'exactin' : requireString(query, 'type').toLowerCase()
  if (type !== 'exactin' && type !== 'exactout') throw new BadRequestError('type must be exactIn or exactOut')
  const recipient = query.recipient === undefined ? undefined : address(query.recipient, 'recipient')
  const slippageBips = integer(query.slippageBips, 0, 5000, 'slippageBips')
  const maxHops = integer(query.maxHops, 1, 3, 'maxHops')
  const maxSplits = integer(query.maxSplits, 1, 4, 'maxSplits')
  const distributionPercent = integer(query.distributionPercent, 5, 100, 'distributionPercent')
  if (distributionPercent !== undefined && 100 % distributionPercent !== 0) throw new BadRequestError('distributionPercent must divide 100')
  const includeMixedRoutes = boolean(query.includeMixedRoutes, 'includeMixedRoutes')
  const permitGrantedInBatch = boolean(query.permitGrantedInBatch, 'permitGrantedInBatch')
  boolean(query.skipCache, 'skipCache')
  return {
    tokenIn, tokenOut, amount, recipient, slippageBips,
    tradeType: type === 'exactin' ? TradeType.EXACT_INPUT : TradeType.EXACT_OUTPUT,
    deadlineSeconds: integer(query.deadlineSeconds, 30, 3600, 'deadlineSeconds'),
    permit: permitGrantedInBatch ? undefined : parsePermit(query.permit),
    permitGrantedInBatch,
    routingConfig: {
      ...(maxHops === undefined ? {} : { maxHops }),
      ...(maxSplits === undefined ? {} : { maxSplits }),
      ...(distributionPercent === undefined ? {} : { distributionPercent }),
      ...(includeMixedRoutes === undefined ? {} : { includeMixedRoutes })
    }
  }
}

function integer(value: unknown, min: number, max: number, name: string): number | undefined {
  if (value === undefined) return undefined
  if ((typeof value !== 'number' && typeof value !== 'string') || !/^[0-9]+$/.test(String(value))) throw new BadRequestError(`${name} must be an integer`)
  const n = Number(value)
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new BadRequestError(`${name} must be between ${min} and ${max}`)
  return n
}
function boolean(value: unknown, name: string): boolean | undefined {
  if (value === undefined) return undefined
  if (value === true || value === 'true') return true
  if (value === false || value === 'false') return false
  throw new BadRequestError(`${name} must be true or false`)
}
function address(value: unknown, name: string): string {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value)) throw new BadRequestError(`${name} must be an address`)
  return value
}
function rawUint(value: unknown, bits: number, name: string): string {
  if ((typeof value !== 'string' && typeof value !== 'number') || (typeof value === 'number' && !Number.isSafeInteger(value)) || !/^[0-9]{1,78}$/.test(String(value)) || BigInt(value) >= 2n ** BigInt(bits)) throw new BadRequestError(`${name} must be uint${bits}`)
  return String(value)
}

function parsePermit(value: unknown): QuotePermit | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'object') throw new BadRequestError('permit must be an object')

  const permit = value as Partial<QuotePermit>
  const details = permit.details
  if (!details || typeof details !== 'object') throw new BadRequestError('permit.details is required')
  for (const field of ['token', 'amount', 'expiration', 'nonce'] as const) {
    if (details[field] === undefined) throw new BadRequestError(`permit.details.${field} is required`)
  }
  if (!permit.spender) throw new BadRequestError('permit.spender is required')
  if (permit.sigDeadline === undefined) throw new BadRequestError('permit.sigDeadline is required')
  address(details.token, 'permit.details.token')
  address(permit.spender, 'permit.spender')
  rawUint(details.amount, 160, 'permit.details.amount')
  rawUint(details.expiration, 48, 'permit.details.expiration')
  rawUint(details.nonce, 48, 'permit.details.nonce')
  rawUint(permit.sigDeadline, 256, 'permit.sigDeadline')
  if (typeof permit.signature !== 'string' || !/^0x(?:[0-9a-fA-F]{2}){1,4096}$/.test(permit.signature)) {
    throw new BadRequestError('permit.signature must be a hex string')
  }

  return permit as QuotePermit
}

function requireString(query: QueryLike, key: string): string {
  const value = query[key]
  if (typeof value !== 'string' || value.length === 0) throw new BadRequestError(`${key} is required`)
  return value
}

function parseChainId(value: unknown, fallback: number): number {
  if (value === undefined) return fallback
  if ((typeof value !== 'string' && typeof value !== 'number') || !/^[0-9]+$/.test(String(value))) {
    throw new BadRequestError('chainId must be a positive integer')
  }
  const chainId = Number(value)
  if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new BadRequestError('chainId must be a positive integer')
  return chainId
}

/** Load one chain from environment variables, or several from a JSON server configuration. */
export function serverConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  if (env.CHAINS_CONFIG_FILE) {
    const config = JSON.parse(readFileSync(env.CHAINS_CONFIG_FILE, 'utf8')) as ServerConfig
    for (const chain of config.chains ?? [config]) {
      const override = env[`ROUTING_RPC_URLS_${chain.chainId ?? config.chainId ?? 56}`]
      if (override) chain.rpcUrls = override.split(',').map(url => url.trim()).filter(Boolean)
    }
    return config
  }
  const chainId = env.CHAIN_ID ? Number(env.CHAIN_ID) : 56
  const rpc = env.RPC_URLS ?? env.RPC_URL ?? (chainId === 56 ? env.BSC_RPC_URLS ?? env.BSC_MAINNET_RPC : undefined)
  return {
    chainId,
    rpcUrls: rpc
      ?.split(',')
      .map((url) => url.trim())
      .filter(Boolean),
    subgraphUrl: env.SUBGRAPH_URL,
    subgraphCacheTtlMs: env.SUBGRAPH_CACHE_TTL_MS ? Number(env.SUBGRAPH_CACHE_TTL_MS) : undefined,
    universalRouterAddress: env.UNIVERSAL_ROUTER_ADDRESS,
    multicallBatchSize: env.MULTICALL_BATCH_SIZE ? Number(env.MULTICALL_BATCH_SIZE) : undefined,
    multicallConcurrency: env.MULTICALL_CONCURRENCY ? Number(env.MULTICALL_CONCURRENCY) : undefined,
    baseTokens: env.ROUTING_BASE_TOKENS?.split(',')
      .map((address) => address.trim())
      .filter(Boolean),
    quoteCacheTtlMs: env.QUOTE_CACHE_TTL_MS ? Number(env.QUOTE_CACHE_TTL_MS) : undefined,
    corsOrigins: env.CORS_ORIGINS?.split(',')
      .map((origin) => origin.trim())
      .filter(Boolean)
  }
}

if (require.main === module) {
  const port = Number(process.env.PORT ?? 3000)
  const server = createApp(serverConfigFromEnv()).listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`topaz routing-api listening on :${port}`)
  })
  server.requestTimeout = 10_000
  server.headersTimeout = 10_000
  server.keepAliveTimeout = 5_000
  server.maxHeadersCount = 64
  process.on('SIGTERM', () => {
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(1), 15_000).unref()
  })
}

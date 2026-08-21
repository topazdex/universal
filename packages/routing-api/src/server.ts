import { BaseProvider, StaticJsonRpcProvider } from '@ethersproject/providers'
import { TradeType } from '@topazdex/sdk-core'
import {
  FallbackRpcProvider,
  MulticallProvider,
  PUBLIC_BSC_RPC_URLS,
  TokenProvider,
  TopazRouter
} from '@topazdex/smart-order-router'
import express, { Express, NextFunction, Request, Response } from 'express'

import { ResponseCache } from './cache'
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

export interface ServerConfig {
  /** One endpoint, or several to fail over between. Defaults to the public list. */
  rpcUrl?: string
  rpcUrls?: string[]
  chainId?: number
  universalRouterAddress?: string
  /** Quote calls per eth_call. Lower it if the RPC rejects batches on gas. */
  multicallBatchSize?: number
  /** eth_calls in flight at once. Lower it if the RPC rate limits you. */
  multicallConcurrency?: number
  /** Token addresses the router may hop through, overriding the defaults */
  baseTokens?: string[]
  /** Browser origins allowed to call this API. `['*']` allows any. */
  corsOrigins?: string[]
  /** How long an identical quote is reused. 0 disables it. Default 2000ms, about two blocks. */
  quoteCacheTtlMs?: number
}

export function createApp(config: ServerConfig): Express {
  const chainId = config.chainId ?? 56
  const provider = buildProvider(config, chainId)
  const multicall = new MulticallProvider(provider, {
    batchSize: config.multicallBatchSize,
    concurrency: config.multicallConcurrency
  })
  const tokenProvider = new TokenProvider(multicall, chainId)
  const router = new TopazRouter({
    provider,
    chainId,
    multicallProvider: multicall,
    universalRouterAddress: config.universalRouterAddress
  })
  const cache = new ResponseCache<QuoteResponse | null>({ ttlMs: config.quoteCacheTtlMs })
  const quoteService = new QuoteService(router, tokenProvider, chainId, config.baseTokens, cache)

  const app = express()
  app.use(express.json())
  app.use(cors(config.corsOrigins ?? DEFAULT_CORS_ORIGINS))

  app.get('/health', (_request: Request, response: Response) => {
    response.json({ status: 'ok', chainId })
  })

  // POST carries a Permit2 signature comfortably; GET stays for simple quotes and links
  app.post('/quote', async (request: Request, response: Response) => {
    await handleQuote(request.body as QueryLike, response, wantsFresh(request))
  })

  app.get('/quote', async (request: Request, response: Response) => {
    await handleQuote(request.query as QueryLike, response, wantsFresh(request))
  })

  async function handleQuote(source: QueryLike, response: Response, skipCache = false): Promise<void> {
    try {
      const params = { ...parseQuoteQuery(source), skipCache }
      const { value, hit, ageMs } = await quoteService.quoteWithCacheOutcome(params)
      if (!value) {
        response.status(404).json({ error: 'No route found' })
        return
      }
      // so a caller can tell a reused answer from a fresh one without guessing
      response.setHeader('X-Cache', hit ? 'HIT' : 'MISS')
      response.setHeader('Age', String(Math.floor(ageMs / 1000)))
      response.json(value)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      response.status(error instanceof BadRequestError ? 400 : 500).json({ error: message })
    }
  }

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
  const allowed = new Set(origins.map(origin => origin.toLowerCase()))
  const patterns = origins
    .filter(origin => origin !== '*' && origin.includes('*'))
    .map(origin => compileWildcard(origin.toLowerCase()))

  function isAllowed(origin: string): boolean {
    if (allowAll || allowed.has(origin)) return true
    if (allowLoopback && isLoopback(origin)) return true
    return patterns.some(pattern => pattern.test(origin))
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
function buildProvider(config: ServerConfig, chainId: number): BaseProvider {
  const urls = config.rpcUrls?.length ? config.rpcUrls : config.rpcUrl ? [config.rpcUrl] : PUBLIC_BSC_RPC_URLS
  if (urls.length === 1) return new StaticJsonRpcProvider({ url: urls[0], timeout: 20_000 }, chainId)
  return new FallbackRpcProvider(urls, { chainId })
}

interface QueryLike {
  [key: string]: unknown
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

function parseQuoteQuery(query: QueryLike) {
  const tokenIn = requireString(query, 'tokenIn')
  const tokenOut = requireString(query, 'tokenOut')
  const amount = requireString(query, 'amount')
  if (!/^\d+$/.test(amount)) throw new BadRequestError('amount must be an integer in the token’s smallest unit')

  const type = (query.type as string | undefined)?.toLowerCase() ?? 'exactin'
  if (type !== 'exactin' && type !== 'exactout') throw new BadRequestError('type must be exactIn or exactOut')

  const recipient = query.recipient as string | undefined
  const slippageBips = query.slippageBips ? Number(query.slippageBips) : undefined
  if (slippageBips !== undefined && (!Number.isFinite(slippageBips) || slippageBips < 0 || slippageBips > 5_000)) {
    throw new BadRequestError('slippageBips must be between 0 and 5000')
  }

  const permitGrantedInBatch = query.permitGrantedInBatch === true || query.permitGrantedInBatch === 'true'

  const routingConfig = {
    ...(query.maxHops ? { maxHops: Number(query.maxHops) } : {}),
    ...(query.maxSplits ? { maxSplits: Number(query.maxSplits) } : {}),
    ...(query.distributionPercent ? { distributionPercent: Number(query.distributionPercent) } : {}),
    ...(query.includeMixedRoutes !== undefined
      ? { includeMixedRoutes: query.includeMixedRoutes !== 'false' }
      : {})
  }

  return {
    tokenIn,
    tokenOut,
    amount,
    tradeType: type === 'exactin' ? TradeType.EXACT_INPUT : TradeType.EXACT_OUTPUT,
    recipient,
    slippageBips,
    deadlineSeconds: query.deadlineSeconds ? Number(query.deadlineSeconds) : undefined,
    // a permit alongside the in-batch grant is ignored outright, not validated: the batch
    // supersedes it, so a client that sent both by mistake still gets its quote
    permit: permitGrantedInBatch ? undefined : parsePermit(query.permit),
    permitGrantedInBatch,
    routingConfig
  }
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
  if (typeof permit.signature !== 'string' || !/^0x[0-9a-fA-F]+$/.test(permit.signature)) {
    throw new BadRequestError('permit.signature must be a hex string')
  }

  return permit as QuotePermit
}

function requireString(query: QueryLike, key: string): string {
  const value = query[key]
  if (typeof value !== 'string' || value.length === 0) throw new BadRequestError(`${key} is required`)
  return value
}

if (require.main === module) {
  // BSC_MAINNET_RPC for one endpoint, BSC_RPC_URLS for a comma separated failover list
  const rpcUrls = (process.env.BSC_RPC_URLS ?? process.env.BSC_MAINNET_RPC ?? '')
    .split(',')
    .map(url => url.trim())
    .filter(Boolean)

  if (rpcUrls.length === 0) {
    // eslint-disable-next-line no-console
    console.warn(
      `No BSC_MAINNET_RPC or BSC_RPC_URLS set, falling back to ${PUBLIC_BSC_RPC_URLS.length} public endpoints. ` +
        'Expect quotes several times slower than on a paid endpoint.'
    )
  }

  const port = Number(process.env.PORT ?? 3000)
  const app = createApp({
    rpcUrls,
    chainId: process.env.CHAIN_ID ? Number(process.env.CHAIN_ID) : undefined,
    universalRouterAddress: process.env.UNIVERSAL_ROUTER_ADDRESS,
    multicallBatchSize: process.env.MULTICALL_BATCH_SIZE ? Number(process.env.MULTICALL_BATCH_SIZE) : undefined,
    multicallConcurrency: process.env.MULTICALL_CONCURRENCY ? Number(process.env.MULTICALL_CONCURRENCY) : undefined,
    baseTokens: (process.env.ROUTING_BASE_TOKENS ?? '')
      .split(',')
      .map(address => address.trim())
      .filter(Boolean),
    quoteCacheTtlMs: process.env.QUOTE_CACHE_TTL_MS ? Number(process.env.QUOTE_CACHE_TTL_MS) : undefined,
    corsOrigins: process.env.CORS_ORIGINS
      ? process.env.CORS_ORIGINS.split(',')
          .map(origin => origin.trim())
          .filter(Boolean)
      : undefined
  })

  app.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`topaz routing-api listening on :${port}`)
  })
}

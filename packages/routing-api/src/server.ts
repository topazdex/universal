import { StaticJsonRpcProvider } from '@ethersproject/providers'
import { TradeType } from '@topazdex/sdk-core'
import { MulticallProvider, TokenProvider, TopazRouter } from '@topazdex/smart-order-router'
import express, { Express, Request, Response } from 'express'

import { BadRequestError, QuoteService } from './quote'

export interface ServerConfig {
  rpcUrl: string
  chainId?: number
  universalRouterAddress?: string
  /** Quote calls per eth_call. Lower it if the RPC rejects batches on gas. */
  multicallBatchSize?: number
  /** eth_calls in flight at once. Lower it if the RPC rate limits you. */
  multicallConcurrency?: number
}

export function createApp(config: ServerConfig): Express {
  const chainId = config.chainId ?? 56
  // StaticJsonRpcProvider, not JsonRpcProvider: the latter issues an eth_chainId before every
  // single request, which doubles the request count for a quote that is otherwise all multicalls
  const provider = new StaticJsonRpcProvider(config.rpcUrl, chainId)
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
  const quoteService = new QuoteService(router, tokenProvider, chainId)

  const app = express()
  app.use(express.json())

  app.get('/health', (_request: Request, response: Response) => {
    response.json({ status: 'ok', chainId })
  })

  app.get('/quote', async (request: Request, response: Response) => {
    try {
      const params = parseQuoteQuery(request.query)
      const quote = await quoteService.quote(params)
      if (!quote) {
        response.status(404).json({ error: 'No route found' })
        return
      }
      response.json(quote)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      response.status(error instanceof BadRequestError ? 400 : 500).json({ error: message })
    }
  })

  return app
}

interface QueryLike {
  [key: string]: unknown
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
    routingConfig
  }
}

function requireString(query: QueryLike, key: string): string {
  const value = query[key]
  if (typeof value !== 'string' || value.length === 0) throw new BadRequestError(`${key} is required`)
  return value
}

if (require.main === module) {
  const rpcUrl = process.env.BSC_MAINNET_RPC
  if (!rpcUrl) throw new Error('BSC_MAINNET_RPC is required')

  const port = Number(process.env.PORT ?? 3000)
  const app = createApp({
    rpcUrl,
    chainId: process.env.CHAIN_ID ? Number(process.env.CHAIN_ID) : undefined,
    universalRouterAddress: process.env.UNIVERSAL_ROUTER_ADDRESS,
    multicallBatchSize: process.env.MULTICALL_BATCH_SIZE ? Number(process.env.MULTICALL_BATCH_SIZE) : undefined,
    multicallConcurrency: process.env.MULTICALL_CONCURRENCY ? Number(process.env.MULTICALL_CONCURRENCY) : undefined
  })

  app.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`topaz routing-api listening on :${port}`)
  })
}

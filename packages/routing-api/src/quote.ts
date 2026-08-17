import { isCLPool, Protocol } from '@topazdex/router-sdk'
import { BNB, Currency, CurrencyAmount, Percent, Token, TradeType } from '@topazdex/sdk-core'
import { RoutingConfig, SwapRoute, TokenProvider, TopazRouter } from '@topazdex/smart-order-router'
import { Pool as V2Pool } from '@topazdex/v2-sdk'
import { Pool as CLPool } from '@topazdex/v3-sdk'

import { ResponseCache } from './cache'

export const NATIVE_ALIASES = new Set(['bnb', 'native', '0x0000000000000000000000000000000000000000'])

/** Anything the caller can fix by changing the request, as opposed to a fault on our side */
export class BadRequestError extends Error {
  public constructor(message: string) {
    super(message)
    this.name = 'BadRequestError'
  }
}

/** A Permit2 `PermitSingle` plus its EIP-712 signature, as the router consumes it */
export interface QuotePermit {
  details: { token: string; amount: string; expiration: string | number; nonce: string | number }
  spender: string
  sigDeadline: string | number
  signature: string
}

export interface QuoteRequest {
  tokenIn: string
  tokenOut: string
  /** Raw amount, in the smallest unit of the specified token */
  amount: string
  tradeType: TradeType
  recipient?: string
  /** Basis points, e.g. 50 is 0.5% */
  slippageBips?: number
  deadlineSeconds?: number
  /**
   * A signed Permit2 allowance, so the swap pulls funds without a separate approval transaction.
   * Only meaningful alongside `recipient`, since it only affects the calldata.
   */
  permit?: QuotePermit
  /** Recompute rather than reuse a recent identical quote. For an explicit user refresh. */
  skipCache?: boolean
  routingConfig?: RoutingConfig
}

export interface QuoteResponseHop {
  protocol: 'v2-volatile' | 'v2-stable' | 'cl'
  address: string
  tokenIn: string
  tokenOut: string
  /** Basis points for v2 pools, pips for CL pools */
  fee: number
  tickSpacing?: number
}

export interface QuoteResponseRoute {
  protocol: Protocol
  percent: number
  amountIn: string
  amountOut: string
  hops: QuoteResponseHop[]
}

export interface QuoteResponse {
  blockNumber: number
  tradeType: 'exactIn' | 'exactOut'
  amount: string
  quote: string
  quoteDecimals: string
  quoteGasAdjusted: string
  /** Slippage applied to the calldata, in basis points */
  slippageBips: number
  /**
   * The limit enforced on chain: the least output an exact input trade will accept, or the most
   * input an exact output trade will spend. Taken from the same trade the calldata was built from,
   * so it always agrees with it.
   */
  minimumAmountOut?: string
  maximumAmountIn?: string
  gasUseEstimate: string
  gasUseEstimateQuote: string
  routes: QuoteResponseRoute[]
  methodParameters?: { calldata: string; value: string; to: string }
}

export class QuoteService {
  private baseTokens: Promise<Token[]> | undefined

  public constructor(
    private readonly router: TopazRouter,
    private readonly tokenProvider: TokenProvider,
    private readonly chainId: number,
    /** Overrides the default routing hubs; resolved on first use */
    private readonly baseTokenAddresses?: string[],
    private readonly cache: ResponseCache<QuoteResponse | null> = new ResponseCache()
  ) {}

  public async quote(request: QuoteRequest): Promise<QuoteResponse | null> {
    return (await this.quoteWithCacheOutcome(request)).value
  }

  /** As `quote`, but says whether the answer was reused, so the caller can report it */
  public async quoteWithCacheOutcome(
    request: QuoteRequest
  ): Promise<{ value: QuoteResponse | null; hit: boolean; ageMs: number }> {
    // a permit is single use, so a request carrying one must never be served from cache
    if (request.permit || !this.cache.enabled) {
      return { value: await this.computeQuote(request), hit: false, ageMs: 0 }
    }
    return this.cache.resolveWithOutcome(
      cacheKey(request),
      () => this.computeQuote(request),
      request.skipCache === true
    )
  }

  private async computeQuote(request: QuoteRequest): Promise<QuoteResponse | null> {
    const [currencyIn, currencyOut] = await Promise.all([
      this.resolveCurrency(request.tokenIn),
      this.resolveCurrency(request.tokenOut)
    ])
    if (currencyIn.equals(currencyOut)) throw new BadRequestError('tokenIn and tokenOut must differ')

    const exactIn = request.tradeType === TradeType.EXACT_INPUT
    const slippageBips = request.slippageBips ?? 50
    const amountCurrency = exactIn ? currencyIn : currencyOut
    const quoteCurrency = exactIn ? currencyOut : currencyIn
    const amount = CurrencyAmount.fromRawAmount(amountCurrency, request.amount)

    if (request.permit && !currencyIn.isNative) {
      const permitted = request.permit.details.token.toLowerCase()
      if (permitted !== currencyIn.wrapped.address.toLowerCase()) {
        throw new BadRequestError('permit.details.token must be the input token')
      }
    }

    const swapOptions = request.recipient
      ? {
          slippageTolerance: new Percent(slippageBips, 10_000),
          recipient: request.recipient,
          deadline: Math.floor(Date.now() / 1000) + (request.deadlineSeconds ?? 1800),
          // a permit on a native input would be meaningless: there is no ERC20 to pull
          ...(request.permit && !currencyIn.isNative ? { inputTokenPermit: request.permit } : {})
        }
      : undefined

    const baseTokens = await this.resolveBaseTokens()
    const route = await this.router.route(amount, quoteCurrency, request.tradeType, swapOptions, {
      ...request.routingConfig,
      ...(baseTokens ? { baseTokens } : {})
    })
    return route ? serialize(route, request.tradeType, amount, slippageBips) : null
  }

  private async resolveBaseTokens(): Promise<Token[] | undefined> {
    if (!this.baseTokenAddresses?.length) return undefined
    // resolved once and reused: decimals require a chain read
    this.baseTokens ??= this.tokenProvider
      .getTokens(this.baseTokenAddresses as string[])
      .then(resolved => [...resolved.values()])
    return this.baseTokens
  }

  private async resolveCurrency(identifier: string): Promise<Currency> {
    if (NATIVE_ALIASES.has(identifier.toLowerCase())) return BNB.onChain(this.chainId)
    try {
      return await this.tokenProvider.getToken(identifier)
    } catch (error) {
      throw new BadRequestError(`could not resolve token ${identifier} as an ERC20 on this chain`)
    }
  }
}

/** Everything that changes the response, including what ends up inside the calldata */
function cacheKey(request: QuoteRequest): string {
  return JSON.stringify([
    request.tokenIn.toLowerCase(),
    request.tokenOut.toLowerCase(),
    request.amount,
    request.tradeType,
    request.recipient?.toLowerCase() ?? null,
    request.slippageBips ?? null,
    request.deadlineSeconds ?? null,
    request.routingConfig ?? null
  ])
}

function serialize(
  route: SwapRoute,
  tradeType: TradeType,
  amount: CurrencyAmount<Currency>,
  slippageBips: number
): QuoteResponse {
  const exactIn = tradeType === TradeType.EXACT_INPUT
  const slippage = new Percent(slippageBips, 10_000)

  return {
    blockNumber: route.blockNumber,
    tradeType: exactIn ? 'exactIn' : 'exactOut',
    amount: amount.quotient.toString(),
    quote: route.quote.quotient.toString(),
    quoteDecimals: route.quote.toExact(),
    quoteGasAdjusted: route.quoteGasAdjusted.quotient.toString(),
    slippageBips,
    ...(exactIn
      ? { minimumAmountOut: route.trade.minimumAmountOut(slippage).quotient.toString() }
      : { maximumAmountIn: route.trade.maximumAmountIn(slippage).quotient.toString() }),
    gasUseEstimate: route.estimatedGasUsed.toString(),
    gasUseEstimateQuote: route.estimatedGasUsedQuoteToken.quotient.toString(),
    routes: route.routes.map(entry => ({
      protocol: entry.route.protocol,
      percent: entry.percent,
      amountIn: (exactIn ? entry.amount : entry.quote).quotient.toString(),
      amountOut: (exactIn ? entry.quote : entry.amount).quotient.toString(),
      hops: describeHops(entry.route.pools, entry.route.input)
    })),
    methodParameters: route.methodParameters
  }
}

function describeHops(pools: (V2Pool | CLPool)[], input: Currency): QuoteResponseHop[] {
  const hops: QuoteResponseHop[] = []
  let current: Token = input.wrapped

  for (const pool of pools) {
    const next = pool.token0.equals(current) ? pool.token1 : pool.token0
    hops.push(
      isCLPool(pool)
        ? {
            protocol: 'cl',
            address: CLPool.getAddress(pool.token0, pool.token1, pool.tickSpacing),
            tokenIn: current.address,
            tokenOut: next.address,
            fee: pool.fee,
            tickSpacing: pool.tickSpacing
          }
        : {
            protocol: pool.stable ? 'v2-stable' : 'v2-volatile',
            address: V2Pool.getAddress(pool.token0, pool.token1, pool.stable),
            tokenIn: current.address,
            tokenOut: next.address,
            fee: pool.fee
          }
    )
    current = next
  }

  return hops
}

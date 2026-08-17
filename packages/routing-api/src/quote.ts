import { isCLPool, Protocol } from '@topazdex/router-sdk'
import { BNB, Currency, CurrencyAmount, Percent, Token, TradeType } from '@topazdex/sdk-core'
import { RoutingConfig, SwapRoute, TokenProvider, TopazRouter } from '@topazdex/smart-order-router'
import { Pool as V2Pool } from '@topazdex/v2-sdk'
import { Pool as CLPool } from '@topazdex/v3-sdk'

export const NATIVE_ALIASES = new Set(['bnb', 'native', '0x0000000000000000000000000000000000000000'])

/** Anything the caller can fix by changing the request, as opposed to a fault on our side */
export class BadRequestError extends Error {
  public constructor(message: string) {
    super(message)
    this.name = 'BadRequestError'
  }
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
  gasUseEstimate: string
  gasUseEstimateQuote: string
  routes: QuoteResponseRoute[]
  methodParameters?: { calldata: string; value: string; to: string }
}

export class QuoteService {
  public constructor(
    private readonly router: TopazRouter,
    private readonly tokenProvider: TokenProvider,
    private readonly chainId: number
  ) {}

  public async quote(request: QuoteRequest): Promise<QuoteResponse | null> {
    const [currencyIn, currencyOut] = await Promise.all([
      this.resolveCurrency(request.tokenIn),
      this.resolveCurrency(request.tokenOut)
    ])
    if (currencyIn.equals(currencyOut)) throw new BadRequestError('tokenIn and tokenOut must differ')

    const exactIn = request.tradeType === TradeType.EXACT_INPUT
    const amountCurrency = exactIn ? currencyIn : currencyOut
    const quoteCurrency = exactIn ? currencyOut : currencyIn
    const amount = CurrencyAmount.fromRawAmount(amountCurrency, request.amount)

    const swapOptions = request.recipient
      ? {
          slippageTolerance: new Percent(request.slippageBips ?? 50, 10_000),
          recipient: request.recipient,
          deadline: Math.floor(Date.now() / 1000) + (request.deadlineSeconds ?? 1800)
        }
      : undefined

    const route = await this.router.route(
      amount,
      quoteCurrency,
      request.tradeType,
      swapOptions,
      request.routingConfig
    )
    return route ? serialize(route, request.tradeType, amount) : null
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

function serialize(route: SwapRoute, tradeType: TradeType, amount: CurrencyAmount<Currency>): QuoteResponse {
  const exactIn = tradeType === TradeType.EXACT_INPUT

  return {
    blockNumber: route.blockNumber,
    tradeType: exactIn ? 'exactIn' : 'exactOut',
    amount: amount.quotient.toString(),
    quote: route.quote.quotient.toString(),
    quoteDecimals: route.quote.toExact(),
    quoteGasAdjusted: route.quoteGasAdjusted.quotient.toString(),
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

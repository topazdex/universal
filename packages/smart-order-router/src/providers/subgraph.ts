import fetch from 'cross-fetch'
import { getChainConfig } from '@topazdex/sdk-core'

import { TOPAZ_V2_SUBGRAPH_URL, TOPAZ_V3_SUBGRAPH_URL } from '../constants'

export interface SubgraphToken {
  id: string
  symbol: string | null
  decimals: string | null
}

export interface V2SubgraphPool {
  id: string
  token0: SubgraphToken
  token1: SubgraphToken
  stable: boolean
  /** Basis points against 10_000, i.e. 30 is 0.30% */
  fee: number
  reserveUSD: number
}

export interface CLSubgraphPool {
  id: string
  token0: SubgraphToken
  token1: SubgraphToken
  tickSpacing: number
  /** Pips, i.e. 1e-6 */
  feeTier: number
  liquidity: string
  totalValueLockedUSD: number
}

async function query<T>(url: string, gql: string, variables: Record<string, unknown> = {}): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 5000)
  try {
  const init = {
    signal: controller.signal,
    size: 4 * 1024 * 1024,
    redirect: 'error' as const,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: gql, variables })
  }
  const response = await fetch(url, init)
  if (!response.ok) throw new Error(`Subgraph HTTP ${response.status}`)
  const body = (await response.json()) as { data?: T; errors?: { message: string }[] }
  if (body.errors?.length) throw new Error('Subgraph query failed')
  if (!body.data) throw new Error('Subgraph returned no data')
  return body.data
  } finally { clearTimeout(timer); controller.abort() }
}

/**
 * Topaz liquidity discovery.
 *
 * The subgraphs are the index: they tell us which pools exist and how much they hold, which is how
 * the router narrows thousands of pools down to a candidate set. Pool state used for quoting is
 * always read from the chain afterwards, never from the subgraph, so a lagging index can cost us a
 * better route but can never produce a wrong quote.
 */
export class SubgraphProvider {
  public constructor(
    private readonly v2Url: string = TOPAZ_V2_SUBGRAPH_URL,
    private readonly v3Url: string = TOPAZ_V3_SUBGRAPH_URL,
    private readonly unifiedUrl?: string,
    private readonly chainId?: number
  ) {}

  public static forChain(chainId: number, subgraphUrl?: string): SubgraphProvider {
    const chain = getChainConfig(chainId)
    const unified = subgraphUrl ?? chain.subgraphUrl
    if (unified) return new SubgraphProvider('', '', unified, chainId)
    if (chain.v2SubgraphUrl && chain.v3SubgraphUrl) {
      return new SubgraphProvider(chain.v2SubgraphUrl, chain.v3SubgraphUrl)
    }
    throw new Error(`Unified subgraph URL is not configured for chain ${chainId}`)
  }

  public async getV2Pools(first = 500): Promise<V2SubgraphPool[]> {
    if (this.unifiedUrl) {
      const pools = await this.getUnifiedPools(false, first)
      return pools.map((pool) => ({
        id: pool.id,
        token0: unifiedToken(pool.token0),
        token1: unifiedToken(pool.token1),
        stable: pool.poolType === 'V2_STABLE',
        fee: (pool.feePips ?? 0) / 100,
        reserveUSD: 0
      }))
    }
    const data = await query<{
      pairs: {
        id: string
        token0: SubgraphToken
        token1: SubgraphToken
        stable: boolean
        fee: string
        reserveUSD: string
      }[]
    }>(
      this.v2Url,
      `query TopPairs($first: Int!) {
        pairs(first: $first, orderBy: reserveUSD, orderDirection: desc, where: { reserveUSD_gt: "0" }) {
          id
          token0 { id symbol decimals }
          token1 { id symbol decimals }
          stable
          fee
          reserveUSD
        }
      }`,
      { first }
    )

    return data.pairs.map((pair) => ({
      id: pair.id,
      token0: pair.token0,
      token1: pair.token1,
      stable: pair.stable,
      fee: Number(pair.fee),
      reserveUSD: Number(pair.reserveUSD)
    }))
  }

  public async getCLPools(first = 500): Promise<CLSubgraphPool[]> {
    if (this.unifiedUrl) {
      const pools = await this.getUnifiedPools(true, first)
      return pools.map((pool) => {
        if (!pool.tickSpacing || pool.tickSpacing <= 0) throw new Error(`Invalid tick spacing for ${pool.id}`)
        return {
          id: pool.id,
          token0: unifiedToken(pool.token0),
          token1: unifiedToken(pool.token1),
          tickSpacing: pool.tickSpacing,
          feeTier: pool.feePips ?? pool.feeTierPips ?? 0,
          liquidity: pool.liquidity,
          totalValueLockedUSD: 0
        }
      })
    }
    const data = await query<{
      pools: {
        id: string
        token0: SubgraphToken
        token1: SubgraphToken
        tickSpacing: string
        feeTier: string
        liquidity: string
        totalValueLockedUSD: string
      }[]
    }>(
      this.v3Url,
      `query TopPools($first: Int!) {
        pools(first: $first, orderBy: totalValueLockedUSD, orderDirection: desc, where: { liquidity_gt: "0" }) {
          id
          token0 { id symbol decimals }
          token1 { id symbol decimals }
          tickSpacing
          feeTier
          liquidity
          totalValueLockedUSD
        }
      }`,
      { first }
    )

    return data.pools.map((pool) => ({
      id: pool.id,
      token0: pool.token0,
      token1: pool.token1,
      tickSpacing: Number(pool.tickSpacing),
      feeTier: Number(pool.feeTier),
      liquidity: pool.liquidity,
      totalValueLockedUSD: Number(pool.totalValueLockedUSD)
    }))
  }

  private async getUnifiedPools(cl: boolean, first: number): Promise<UnifiedPool[]> {
    const chain = getChainConfig(this.chainId!)
    // The unified graph stores raw balances, not USD valuations. Include unpriced liquidity and
    // exclude protocol-only system pools. Live factory fees and pool state drive actual quotes.
    const filter = cl
      ? 'poolType: CL, liquidity_gt: "0"'
      : 'poolType_in: [V2_VOLATILE, V2_STABLE], reserve0Raw_gt: "0", reserve1Raw_gt: "0"'
    const data = await query<{ chainState: { chainId: number } | null; pools: UnifiedPool[] }>(
      this.unifiedUrl!,
      `
      query RoutingPools($first: Int!, $factory: String!) {
        chainState(id: "chain") { chainId }
        pools(first: $first, orderBy: ${cl ? 'liquidity' : 'reserve0Raw'}, orderDirection: desc,
          where: { entityKind: USER, factory: $factory, ${filter} }) {
          id poolType tickSpacing feePips feeTierPips liquidity
          token0 { id symbol decimals }
          token1 { id symbol decimals }
        }
      }`,
      { first, factory: (cl ? chain.clFactoryAddress : chain.v2FactoryAddress).toLowerCase() }
    )
    if (data.chainState?.chainId !== this.chainId) throw new Error(`Subgraph chain does not match ${this.chainId}`)
    return data.pools
  }
}

interface UnifiedToken {
  id: string
  symbol: string | null
  decimals: number | null
}
interface UnifiedPool {
  id: string
  poolType: 'V2_VOLATILE' | 'V2_STABLE' | 'CL'
  token0: UnifiedToken
  token1: UnifiedToken
  tickSpacing: number | null
  feePips: number | null
  feeTierPips: number | null
  liquidity: string
}
function unifiedToken(token: UnifiedToken): SubgraphToken {
  return { ...token, decimals: token.decimals === null ? null : String(token.decimals) }
}

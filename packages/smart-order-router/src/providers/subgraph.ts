import fetch from 'cross-fetch'

import { TOPAZ_V2_SUBGRAPH_URL, TOPAZ_V3_SUBGRAPH_URL } from '../constants'

export interface SubgraphToken {
  id: string
  symbol: string
  decimals: string
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
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: gql, variables })
  })
  if (!response.ok) throw new Error(`subgraph ${url} responded ${response.status}`)
  const body = (await response.json()) as { data?: T; errors?: { message: string }[] }
  if (body.errors?.length) throw new Error(`subgraph ${url} error: ${body.errors.map(e => e.message).join(', ')}`)
  if (!body.data) throw new Error(`subgraph ${url} returned no data`)
  return body.data
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
    private readonly v3Url: string = TOPAZ_V3_SUBGRAPH_URL
  ) {}

  public async getV2Pools(first = 500): Promise<V2SubgraphPool[]> {
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

    return data.pairs.map(pair => ({
      id: pair.id,
      token0: pair.token0,
      token1: pair.token1,
      stable: pair.stable,
      fee: Number(pair.fee),
      reserveUSD: Number(pair.reserveUSD)
    }))
  }

  public async getCLPools(first = 500): Promise<CLSubgraphPool[]> {
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

    return data.pools.map(pool => ({
      id: pool.id,
      token0: pool.token0,
      token1: pool.token1,
      tickSpacing: Number(pool.tickSpacing),
      feeTier: Number(pool.feeTier),
      liquidity: pool.liquidity,
      totalValueLockedUSD: Number(pool.totalValueLockedUSD)
    }))
  }
}

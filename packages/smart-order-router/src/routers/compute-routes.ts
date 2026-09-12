import { isCLPool, MixedRoute, RouteCL, RouteMixed, RouteV2, TPool } from '@topazdex/router-sdk'
import { Currency, Token } from '@topazdex/sdk-core'
import { Pool as V2Pool } from '@topazdex/v2-sdk'
import { Pool as CLPool, Route as CLRoute } from '@topazdex/v3-sdk'

export interface ComputedRoutes {
  v2Routes: RouteV2<Currency, Currency>[]
  clRoutes: RouteCL<Currency, Currency>[]
  mixedRoutes: RouteMixed<Currency, Currency>[]
}

export interface ComputeRoutesOptions {
  maxHops?: number
  /** Cap on routes per category, applied after generation to bound quoting cost */
  maxRoutesPerProtocol?: number
  /** Set false to skip routes that cross both stacks */
  includeMixedRoutes?: boolean
}

/**
 * Enumerates every path from `tokenIn` to `tokenOut` of at most `maxHops` pools, then sorts the
 * paths into pure v2, pure CL and mixed routes.
 *
 * A path may only use a pool once: quoting assumes each pool is priced from its current state, and
 * a route that re-entered a pool would be quoted against stale reserves.
 */
export function computeAllRoutes(
  tokenIn: Currency,
  tokenOut: Currency,
  pools: TPool[],
  options: ComputeRoutesOptions = {}
): ComputedRoutes {
  const maxHops = options.maxHops ?? 3
  const maxRoutes = options.maxRoutesPerProtocol ?? 60
  const includeMixed = options.includeMixedRoutes ?? true
  if (!Number.isSafeInteger(maxHops) || maxHops < 1 || maxHops > 3 || !Number.isSafeInteger(maxRoutes) || maxRoutes < 1 || maxRoutes > 60) throw new Error('Invalid route search limits')
  if (pools.length > 2000) throw new Error('Too many candidate pools')
  let examined = 0

  const tokenInWrapped = tokenIn.wrapped
  const tokenOutWrapped = tokenOut.wrapped

  const paths: TPool[][] = []
  const currentPath: TPool[] = []
  const visited = new Set<TPool>()

  const walk = (previousToken: Token) => {
    if (currentPath.length > 0 && previousToken.equals(tokenOutWrapped)) {
      paths.push([...currentPath])
      return
    }
    if (currentPath.length === maxHops) return

    for (const pool of pools) {
      if (++examined > 100_000) throw new Error('Route search budget exceeded')
      if (visited.has(pool)) continue
      if (!pool.involvesToken(previousToken)) continue

      const nextToken = pool.token0.equals(previousToken) ? pool.token1 : pool.token0

      currentPath.push(pool)
      visited.add(pool)
      walk(nextToken)
      visited.delete(pool)
      currentPath.pop()
    }
  }

  walk(tokenInWrapped)

  // the cap below truncates, and DFS order is arbitrary, so rank first: short routes cost less gas
  // and, at equal length, the deepest pools are the ones that can absorb size
  paths.sort((a, b) => a.length - b.length || pathDepth(b) - pathDepth(a))

  const v2Routes: RouteV2<Currency, Currency>[] = []
  const clRoutes: RouteCL<Currency, Currency>[] = []
  const mixedRoutes: RouteMixed<Currency, Currency>[] = []

  for (const path of paths) {
    const allCL = path.every(isCLPool)
    const allV2 = path.every(pool => !isCLPool(pool))

    try {
      if (allCL) {
        clRoutes.push(new RouteCL(path as CLPool[], tokenIn, tokenOut))
      } else if (allV2) {
        v2Routes.push(new RouteV2(path as V2Pool[], tokenIn, tokenOut))
      } else if (includeMixed) {
        mixedRoutes.push(new RouteMixed(path, tokenIn, tokenOut))
      }
    } catch {
      // a path that cannot form a valid route, e.g. a token appearing twice, is simply dropped
    }
  }

  return {
    v2Routes: v2Routes.slice(0, maxRoutes),
    clRoutes: clRoutes.slice(0, maxRoutes),
    mixedRoutes: mixedRoutes.slice(0, maxRoutes)
  }
}

/**
 * How much size a path can absorb, taken as its thinnest pool: a route is only as deep as its
 * narrowest hop. Units differ between the two stacks, so this ranks within a stack rather than
 * across it, which is all the tie-break needs.
 */
function pathDepth(path: TPool[]): number {
  return Math.min(...path.map(poolDepth))
}

function poolDepth(pool: TPool): number {
  if (isCLPool(pool)) return Number(pool.liquidity.toString())
  return Number(pool.reserve0.quotient.toString()) * Number(pool.reserve1.quotient.toString())
}

/** Pool addresses a route touches, used to keep split routes from re-using the same pool */
export function routePoolAddresses(pools: TPool[]): string[] {
  return pools.map(pool =>
    isCLPool(pool)
      ? CLPool.getAddress(pool.token0, pool.token1, pool.tickSpacing)
      : V2Pool.getAddress(pool.token0, pool.token1, pool.stable)
  )
}

export function toCLRoute(pools: CLPool[], input: Currency, output: Currency): CLRoute<Currency, Currency> {
  return new CLRoute(pools, input, output)
}

export function toMixedRoute(pools: TPool[], input: Currency, output: Currency): MixedRoute<Currency, Currency> {
  return new MixedRoute(pools, input, output)
}

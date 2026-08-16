import { Pool as V2Pool } from '@topaz/v2-sdk'
import { Pool as CLPool, TickSpacing } from '@topaz/v3-sdk'
import { CurrencyAmount, Token } from '@uniswap/sdk-core'
import { Contract, providers } from 'ethers'

import { MIXED_ROUTE_QUOTER_V1_ADDRESS, MIXED_ROUTE_V2_STABLE_FLAG, MIXED_ROUTE_V2_VOLATILE_FLAG } from './constants'
import { MixedRoute, partitionMixedRouteByProtocol } from './entities/mixedRoute'
import { encodeMixedRouteToPath, poolPathParameter } from './utils/encodeMixedRouteToPath'
import { MixedRouteQuoter } from './utils/mixedRouteQuoter'

const RPC = process.env.BSC_MAINNET_RPC
const BLOCK_TAG = process.env.FORK_BLOCK ? Number(process.env.FORK_BLOCK) : 'latest'
const CHAIN_ID = 56

const WBNB = new Token(CHAIN_ID, '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', 18, 'WBNB')
const USDT = new Token(CHAIN_ID, '0x55d398326f99059fF775485246999027B3197955', 18, 'USDT')
const USDC = new Token(CHAIN_ID, '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', 18, 'USDC')

const V2_FACTORY = '0x65E6cD0eF5D3467030103cf3d433034E570b5784'
const CL_FACTORY = '0x73DC984D9490286E735548f61dfCCec67Af82ed9'

const V2_FACTORY_ABI = [
  'function getPool(address tokenA, address tokenB, bool stable) view returns (address)',
  'function getFee(address pool, bool stable) view returns (uint256)'
]
const V2_POOL_ABI = [
  'function metadata() view returns (uint256 dec0, uint256 dec1, uint256 r0, uint256 r1, bool st, address t0, address t1)'
]
const CL_FACTORY_ABI = [
  'function getPool(address tokenA, address tokenB, int24 tickSpacing) view returns (address)',
  'function getSwapFee(address pool) view returns (uint24)'
]
const CL_POOL_ABI = [
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, bool unlocked)',
  'function liquidity() view returns (uint128)'
]

const describeIfRpc = RPC ? describe : describe.skip

describeIfRpc('router-sdk mixed routes against the live Topaz quoters', () => {
  const provider = new providers.JsonRpcProvider(RPC, CHAIN_ID)
  const v2Factory = new Contract(V2_FACTORY, V2_FACTORY_ABI, provider)
  const clFactory = new Contract(CL_FACTORY, CL_FACTORY_ABI, provider)

  async function loadV2Pool(tokenA: Token, tokenB: Token, stable: boolean): Promise<V2Pool> {
    const address: string = await v2Factory.getPool(tokenA.address, tokenB.address, stable, { blockTag: BLOCK_TAG })
    const pool = new Contract(address, V2_POOL_ABI, provider)
    const [metadata, fee] = await Promise.all([
      pool.metadata({ blockTag: BLOCK_TAG }),
      v2Factory.getFee(address, stable, { blockTag: BLOCK_TAG })
    ])
    const token0 = metadata.t0 === tokenA.address ? tokenA : tokenB
    const token1 = metadata.t1 === tokenB.address ? tokenB : tokenA
    return new V2Pool(
      CurrencyAmount.fromRawAmount(token0, metadata.r0.toString()),
      CurrencyAmount.fromRawAmount(token1, metadata.r1.toString()),
      metadata.st,
      Number(fee.toString())
    )
  }

  async function loadCLPool(tokenA: Token, tokenB: Token, tickSpacing: number): Promise<CLPool> {
    const address: string = await clFactory.getPool(tokenA.address, tokenB.address, tickSpacing, {
      blockTag: BLOCK_TAG
    })
    const pool = new Contract(address, CL_POOL_ABI, provider)
    const [slot0, liquidity, fee] = await Promise.all([
      pool.slot0({ blockTag: BLOCK_TAG }),
      pool.liquidity({ blockTag: BLOCK_TAG }),
      clFactory.getSwapFee(address, { blockTag: BLOCK_TAG })
    ])
    return new CLPool(
      tokenA,
      tokenB,
      Number(fee.toString()),
      tickSpacing,
      slot0.sqrtPriceX96.toString(),
      liquidity.toString(),
      slot0.tick
    )
  }

  async function quoteMixed(route: MixedRoute<Token, Token>, amountIn: CurrencyAmount<Token>): Promise<string> {
    const { calldata } = MixedRouteQuoter.quoteExactInputCallParameters(route, amountIn)
    const result = await provider.call({ to: MIXED_ROUTE_QUOTER_V1_ADDRESS, data: calldata }, BLOCK_TAG)
    const [amountOut] = MixedRouteQuoter.INTERFACE.decodeFunctionResult('quoteExactInput', result)
    return amountOut.toString()
  }

  it('flags v2 hops with the bitmasks the quoter expects', async () => {
    const volatile = await loadV2Pool(WBNB, USDT, false)
    const stable = await loadV2Pool(USDT, USDC, true)
    const cl = await loadCLPool(WBNB, USDT, TickSpacing.LOW)

    expect(poolPathParameter(volatile)).toEqual(MIXED_ROUTE_V2_VOLATILE_FLAG)
    expect(poolPathParameter(stable)).toEqual(MIXED_ROUTE_V2_STABLE_FLAG)
    expect(poolPathParameter(cl)).toEqual(TickSpacing.LOW)
  })

  it('prices a CL hop followed by a stable v2 hop, and matches the two legs quoted separately', async () => {
    const clPool = await loadCLPool(WBNB, USDT, TickSpacing.LOW)
    const stablePool = await loadV2Pool(USDT, USDC, true)
    const route = new MixedRoute([clPool, stablePool], WBNB, USDC)
    expect(route.isMixed).toBe(true)

    const amountIn = CurrencyAmount.fromRawAmount(WBNB, '10000000000000000') // 0.01 WBNB
    const mixedQuote = await quoteMixed(route, amountIn)

    // leg 1 priced by the CL quoter through a single hop mixed path, leg 2 by the v2 pool math
    const clOnly = new MixedRoute([clPool], WBNB, USDT)
    const clQuote = await quoteMixed(clOnly, amountIn)
    const [expectedOut] = stablePool.getOutputAmount(CurrencyAmount.fromRawAmount(USDT, clQuote))

    expect(mixedQuote).toEqual(expectedOut.quotient.toString())
  })

  it('prices a volatile v2 hop followed by a CL hop', async () => {
    const volatilePool = await loadV2Pool(WBNB, USDT, false)
    const clPool = await loadCLPool(USDT, USDC, TickSpacing.STABLE)
    const route = new MixedRoute([volatilePool, clPool], WBNB, USDC)

    const amountIn = CurrencyAmount.fromRawAmount(WBNB, '1000000000000000') // 0.001 WBNB
    const mixedQuote = await quoteMixed(route, amountIn)

    const [intermediate] = volatilePool.getOutputAmount(amountIn)
    const clOnly = new MixedRoute([clPool], USDT, USDC)
    const clQuote = await quoteMixed(clOnly, intermediate)

    expect(mixedQuote).toEqual(clQuote)
  })

  it('encodes a mixed path with one 3 byte parameter per hop', async () => {
    const clPool = await loadCLPool(WBNB, USDT, TickSpacing.LOW)
    const stablePool = await loadV2Pool(USDT, USDC, true)
    const path = encodeMixedRouteToPath(new MixedRoute([clPool, stablePool], WBNB, USDC))
    // 20 + 3 + 20 + 3 + 20 bytes
    expect(path.length).toEqual(2 + 66 * 2)
    expect(path.toLowerCase()).toContain('200000') // the stable flag
  })

  it('partitions a route into one section per stack, preserving order', async () => {
    const clWbnbUsdt = await loadCLPool(WBNB, USDT, TickSpacing.LOW)
    const clUsdtUsdc = await loadCLPool(USDT, USDC, TickSpacing.STABLE)
    const v2UsdcUsdt = await loadV2Pool(USDC, USDT, true)

    const route = new MixedRoute([clWbnbUsdt, clUsdtUsdc, v2UsdcUsdt], WBNB, USDT)
    const sections = partitionMixedRouteByProtocol(route)

    expect(sections).toHaveLength(2)
    expect(sections[0]).toHaveLength(2)
    expect(sections[1]).toHaveLength(1)
  })
})

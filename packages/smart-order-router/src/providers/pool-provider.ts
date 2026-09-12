import { Interface } from '@ethersproject/abi'
import { CurrencyAmount, getChainConfig, Token } from '@topazdex/sdk-core'
import { Pool as V2Pool } from '@topazdex/v2-sdk'
import { Pool as CLPool } from '@topazdex/v3-sdk'

import { POOL_STATE_BATCH_SIZE } from '../constants'
import { MulticallProvider } from './multicall'
import { CLSubgraphPool, SubgraphToken, V2SubgraphPool } from './subgraph'
import { TokenProvider } from './token-provider'

const V2_POOL_INTERFACE = new Interface([
  'function metadata() view returns (uint256 dec0, uint256 dec1, uint256 r0, uint256 r1, bool st, address t0, address t1)'
])
const V2_FACTORY_INTERFACE = new Interface(['function getFee(address pool, bool stable) view returns (uint256)'])
const CL_POOL_INTERFACE = new Interface([
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, bool unlocked)',
  'function liquidity() view returns (uint128)'
])
const CL_FACTORY_INTERFACE = new Interface(['function getSwapFee(address pool) view returns (uint24)'])

export interface PoolProviderOptions {
  blockTag?: number | string
}

/**
 * Turns subgraph pool descriptors into SDK pools backed by live chain state.
 *
 * Fees are read from the factories rather than assumed: v2 pools can carry a custom fee and CL
 * pools can be driven by a dynamic fee module, so the tick spacing or the stable flag only tells
 * you the default.
 */
export class PoolProvider {
  private readonly tokens: TokenProvider
  public constructor(
    private readonly chainId: number,
    private readonly multicall: MulticallProvider,
    private readonly v2FactoryAddress: string = getChainConfig(chainId).v2FactoryAddress,
    private readonly clFactoryAddress: string = getChainConfig(chainId).clFactoryAddress
  ) {
    this.tokens = new TokenProvider(multicall, chainId)
  }

  private async toToken(token: SubgraphToken): Promise<Token> {
    if (token.decimals === null) return this.tokens.getToken(token.id)
    return new Token(this.chainId, token.id, Number(token.decimals), token.symbol ?? undefined)
  }

  public async getV2Pools(pools: V2SubgraphPool[], options: PoolProviderOptions = {}): Promise<V2Pool[]> {
    if (pools.length === 0) return []

    for (const pool of pools) {
      const [token0, token1] = await Promise.all([this.toToken(pool.token0), this.toToken(pool.token1)])
      const address = V2Pool.getAddress(token0, token1, pool.stable)
      if (address.toLowerCase() !== pool.id.toLowerCase())
        throw new Error(`Unexpected v2 pool ${pool.id} on chain ${this.chainId}`)
    }
    const calls = pools.flatMap((pool) => [
      { target: pool.id, callData: V2_POOL_INTERFACE.encodeFunctionData('metadata') },
      {
        target: this.v2FactoryAddress,
        callData: V2_FACTORY_INTERFACE.encodeFunctionData('getFee', [pool.id, pool.stable])
      }
    ])

    const results = await this.multicall.call(calls, {
      blockTag: options.blockTag,
      batchSize: POOL_STATE_BATCH_SIZE
    })

    const built: V2Pool[] = []
    for (const [i, pool] of pools.entries()) {
      const metadataResult = results[i * 2]
      const feeResult = results[i * 2 + 1]
      if (!metadataResult?.success || !feeResult?.success) continue
      // A graph can contain pools created after the requested block. Calls to an address with
      // no code succeed with empty data in Multicall3, so success alone is not sufficient.
      if (metadataResult.returnData === '0x' || feeResult.returnData === '0x') continue

      const metadata = V2_POOL_INTERFACE.decodeFunctionResult('metadata', metadataResult.returnData)
      const [fee] = V2_FACTORY_INTERFACE.decodeFunctionResult('getFee', feeResult.returnData)
      if (metadata.r0.isZero() || metadata.r1.isZero()) continue

      const token0 = await this.toToken(pool.token0)
      const token1 = await this.toToken(pool.token1)
      const [sorted0, sorted1] =
        token0.address.toLowerCase() === metadata.t0.toLowerCase() ? [token0, token1] : [token1, token0]

      built.push(
        new V2Pool(
          CurrencyAmount.fromRawAmount(sorted0, metadata.r0.toString()),
          CurrencyAmount.fromRawAmount(sorted1, metadata.r1.toString()),
          metadata.st,
          Number(fee.toString())
        )
      )
    }
    return built
  }

  public async getCLPools(pools: CLSubgraphPool[], options: PoolProviderOptions = {}): Promise<CLPool[]> {
    if (pools.length === 0) return []

    for (const pool of pools) {
      const [token0, token1] = await Promise.all([this.toToken(pool.token0), this.toToken(pool.token1)])
      const address = CLPool.getAddress(token0, token1, pool.tickSpacing)
      if (address.toLowerCase() !== pool.id.toLowerCase())
        throw new Error(`Unexpected CL pool ${pool.id} on chain ${this.chainId}`)
    }
    const calls = pools.flatMap((pool) => [
      { target: pool.id, callData: CL_POOL_INTERFACE.encodeFunctionData('slot0') },
      { target: pool.id, callData: CL_POOL_INTERFACE.encodeFunctionData('liquidity') },
      {
        target: this.clFactoryAddress,
        callData: CL_FACTORY_INTERFACE.encodeFunctionData('getSwapFee', [pool.id])
      }
    ])

    const results = await this.multicall.call(calls, {
      blockTag: options.blockTag,
      batchSize: POOL_STATE_BATCH_SIZE
    })

    const built: CLPool[] = []
    for (const [i, pool] of pools.entries()) {
      const slot0Result = results[i * 3]
      const liquidityResult = results[i * 3 + 1]
      const feeResult = results[i * 3 + 2]
      if (!slot0Result?.success || !liquidityResult?.success || !feeResult?.success) continue
      if ([slot0Result, liquidityResult, feeResult].some((result) => result.returnData === '0x')) continue

      const slot0 = CL_POOL_INTERFACE.decodeFunctionResult('slot0', slot0Result.returnData)
      const [liquidity] = CL_POOL_INTERFACE.decodeFunctionResult('liquidity', liquidityResult.returnData)
      const [fee] = CL_FACTORY_INTERFACE.decodeFunctionResult('getSwapFee', feeResult.returnData)
      if (liquidity.isZero()) continue

      built.push(
        new CLPool(
          await this.toToken(pool.token0),
          await this.toToken(pool.token1),
          Number(fee.toString()),
          pool.tickSpacing,
          slot0.sqrtPriceX96.toString(),
          liquidity.toString(),
          slot0.tick
        )
      )
    }
    return built
  }
}

import { CurrencyAmount, Token } from '@uniswap/sdk-core'
import { Contract, providers } from 'ethers'

import { POOL_FACTORY_ADDRESS, TOPAZ_CHAIN_ID } from './constants'
import { Pool } from './entities/pool'

const RPC = process.env.BSC_MAINNET_RPC
const BLOCK_TAG = process.env.FORK_BLOCK ? Number(process.env.FORK_BLOCK) : 'latest'

const POOL_ABI = [
  'function metadata() view returns (uint256 dec0, uint256 dec1, uint256 r0, uint256 r1, bool st, address t0, address t1)',
  'function getAmountOut(uint256 amountIn, address tokenIn) view returns (uint256)'
]
const FACTORY_ABI = [
  'function getPool(address tokenA, address tokenB, bool stable) view returns (address)',
  'function getFee(address pool, bool stable) view returns (uint256)'
]

const WBNB = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c'
const USDT = '0x55d398326f99059fF775485246999027B3197955'
const USDC = '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d'

const describeIfRpc = RPC ? describe : describe.skip

/**
 * The SDK reimplements `Pool.sol`'s integer math. These tests pull live reserves and fees off
 * BNB Chain and require the SDK quote to equal `Pool.getAmountOut` exactly, wei for wei.
 */
describeIfRpc('v2-sdk against live Topaz pools', () => {
  const provider = new providers.JsonRpcProvider(RPC, TOPAZ_CHAIN_ID)
  const factory = new Contract(POOL_FACTORY_ADDRESS, FACTORY_ABI, provider)

  async function loadPool(tokenA: string, tokenB: string, stable: boolean): Promise<{ pool: Pool; contract: Contract }> {
    const address: string = await factory.getPool(tokenA, tokenB, stable, { blockTag: BLOCK_TAG })
    expect(address).not.toEqual('0x0000000000000000000000000000000000000000')
    // the router derives the same address without an RPC call
    expect(address).toEqual(
      Pool.getAddress(
        new Token(TOPAZ_CHAIN_ID, tokenA, 18),
        new Token(TOPAZ_CHAIN_ID, tokenB, 18),
        stable
      )
    )

    const contract = new Contract(address, POOL_ABI, provider)
    const [metadata, fee] = await Promise.all([
      contract.metadata({ blockTag: BLOCK_TAG }),
      factory.getFee(address, stable, { blockTag: BLOCK_TAG })
    ])

    const token0 = new Token(TOPAZ_CHAIN_ID, metadata.t0, Math.log10(Number(metadata.dec0.toString())))
    const token1 = new Token(TOPAZ_CHAIN_ID, metadata.t1, Math.log10(Number(metadata.dec1.toString())))
    const pool = new Pool(
      CurrencyAmount.fromRawAmount(token0, metadata.r0.toString()),
      CurrencyAmount.fromRawAmount(token1, metadata.r1.toString()),
      metadata.st,
      Number(fee.toString())
    )
    return { pool, contract }
  }

  async function expectQuotesMatch(pool: Pool, contract: Contract, tokenIn: Token, amounts: string[]) {
    for (const amount of amounts) {
      const [sdkOut] = pool.getOutputAmount(CurrencyAmount.fromRawAmount(tokenIn, amount))
      const chainOut = await contract.getAmountOut(amount, tokenIn.address, { blockTag: BLOCK_TAG })
      expect(sdkOut.quotient.toString()).toEqual(chainOut.toString())
    }
  }

  it('matches the chain on the WBNB/USDT volatile pool, both directions', async () => {
    const { pool, contract } = await loadPool(WBNB, USDT, false)
    expect(pool.stable).toBe(false)
    const wbnb = pool.token0.address === WBNB ? pool.token0 : pool.token1
    const usdt = pool.token0.address === USDT ? pool.token0 : pool.token1

    await expectQuotesMatch(pool, contract, wbnb, ['1', '1000000000000000', '10000000000000000', '100000000000000000'])
    await expectQuotesMatch(pool, contract, usdt, ['1000000000000000000', '10000000000000000000'])
  })

  it('matches the chain on the USDT/USDC stable pool, both directions', async () => {
    const { pool, contract } = await loadPool(USDT, USDC, true)
    expect(pool.stable).toBe(true)
    const usdt = pool.token0.address === USDT ? pool.token0 : pool.token1
    const usdc = pool.token0.address === USDC ? pool.token0 : pool.token1

    await expectQuotesMatch(pool, contract, usdt, ['1000000000000000', '100000000000000000', '1000000000000000000'])
    await expectQuotesMatch(pool, contract, usdc, ['1000000000000000', '1000000000000000000'])
  })

  it('reads the live fee rather than assuming the factory default', async () => {
    const { pool } = await loadPool(WBNB, USDT, false)
    expect(pool.fee).toBeGreaterThan(0)
    expect(pool.fee).toBeLessThan(10_000)
  })
})

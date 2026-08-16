import { CurrencyAmount, Token, TradeType } from '@uniswap/sdk-core'
import { Contract, providers } from 'ethers'

import { CL_FACTORY_ADDRESS, CL_QUOTER_V2_ADDRESS, TickSpacing, TOPAZ_CHAIN_ID } from './constants'
import { Pool } from './entities/pool'
import { Route } from './entities/route'
import { SwapQuoter } from './quoter'
import { encodeRouteToPath } from './utils/encodeRouteToPath'

const RPC = process.env.BSC_MAINNET_RPC
const BLOCK_TAG = process.env.FORK_BLOCK ? Number(process.env.FORK_BLOCK) : 'latest'

const FACTORY_ABI = [
  'function getPool(address tokenA, address tokenB, int24 tickSpacing) view returns (address)',
  'function poolImplementation() view returns (address)',
  'function getSwapFee(address pool) view returns (uint24)'
]
const POOL_ABI = [
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, bool unlocked)',
  'function liquidity() view returns (uint128)',
  'function tickSpacing() view returns (int24)',
  'function fee() view returns (uint24)'
]

const WBNB = new Token(TOPAZ_CHAIN_ID, '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', 18, 'WBNB')
const USDT = new Token(TOPAZ_CHAIN_ID, '0x55d398326f99059fF775485246999027B3197955', 18, 'USDT')
const USDC = new Token(TOPAZ_CHAIN_ID, '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', 18, 'USDC')

const describeIfRpc = RPC ? describe : describe.skip

describeIfRpc('v3-sdk against the live Topaz CL deployment', () => {
  const provider = new providers.JsonRpcProvider(RPC, TOPAZ_CHAIN_ID)
  const factory = new Contract(CL_FACTORY_ADDRESS, FACTORY_ABI, provider)
  const quoter = new Contract(CL_QUOTER_V2_ADDRESS, [], provider)

  async function loadPool(tokenA: Token, tokenB: Token, tickSpacing: number): Promise<Pool> {
    const address: string = await factory.getPool(tokenA.address, tokenB.address, tickSpacing, { blockTag: BLOCK_TAG })
    expect(address).toEqual(Pool.getAddress(tokenA, tokenB, tickSpacing))

    const pool = new Contract(address, POOL_ABI, provider)
    const [slot0, liquidity, fee] = await Promise.all([
      pool.slot0({ blockTag: BLOCK_TAG }),
      pool.liquidity({ blockTag: BLOCK_TAG }),
      factory.getSwapFee(address, { blockTag: BLOCK_TAG })
    ])
    return new Pool(
      tokenA,
      tokenB,
      Number(fee.toString()),
      tickSpacing,
      slot0.sqrtPriceX96.toString(),
      liquidity.toString(),
      slot0.tick
    )
  }

  async function callQuoter(calldata: string): Promise<string> {
    return provider.call({ to: quoter.address, data: calldata }, BLOCK_TAG)
  }

  it('derives live CL pool addresses from the clone implementation', async () => {
    const implementation: string = await factory.poolImplementation({ blockTag: BLOCK_TAG })
    expect(implementation).toEqual('0x18e68051d1b1fB44cb539cA4436F112D28577AF7')

    const wbnbUsdt: string = await factory.getPool(WBNB.address, USDT.address, TickSpacing.LOW, {
      blockTag: BLOCK_TAG
    })
    expect(wbnbUsdt).toEqual(Pool.getAddress(WBNB, USDT, TickSpacing.LOW))
    expect(wbnbUsdt).toEqual('0x767F1F4bF9E5E40F3D865c172c9bD0AE216e65B4')
  })

  it('reads the live swap fee, which the tick spacing only defaults', async () => {
    const pool = await loadPool(WBNB, USDT, TickSpacing.LOW)
    expect(pool.tickSpacing).toEqual(TickSpacing.LOW)
    expect(pool.fee).toBeGreaterThan(0)
    expect(pool.fee).toBeLessThan(1_000_000)
    expect(pool.token0Price.toSignificant(6)).toBeTruthy()
  })

  it('quotes an exact input single hop through the deployed QuoterV2', async () => {
    const pool = await loadPool(WBNB, USDT, TickSpacing.LOW)
    const route = new Route([pool], WBNB, USDT)
    const amountIn = CurrencyAmount.fromRawAmount(WBNB, '100000000000000000') // 0.1 WBNB

    const { calldata } = SwapQuoter.quoteCallParameters(route, amountIn, TradeType.EXACT_INPUT)
    const result = await callQuoter(calldata)
    const [amountOut] = SwapQuoter.INTERFACE.decodeFunctionResult('quoteExactInputSingle', result)

    // 0.1 BNB is worth hundreds of USDT, sanity bound rather than a hardcoded amount
    expect(Number(amountOut.toString()) / 1e18).toBeGreaterThan(10)
  })

  it('quotes an exact output single hop through the deployed QuoterV2', async () => {
    const pool = await loadPool(WBNB, USDT, TickSpacing.LOW)
    const route = new Route([pool], WBNB, USDT)
    const amountOut = CurrencyAmount.fromRawAmount(USDT, '50000000000000000000') // 50 USDT

    const { calldata } = SwapQuoter.quoteCallParameters(route, amountOut, TradeType.EXACT_OUTPUT)
    const result = await callQuoter(calldata)
    const [amountIn] = SwapQuoter.INTERFACE.decodeFunctionResult('quoteExactOutputSingle', result)

    expect(Number(amountIn.toString())).toBeGreaterThan(0)
  })

  it('quotes a multi hop route, tick spacings travelling inside the path', async () => {
    const wbnbUsdt = await loadPool(WBNB, USDT, TickSpacing.LOW)
    const usdtUsdc = await loadPool(USDT, USDC, TickSpacing.STABLE)
    const route = new Route([wbnbUsdt, usdtUsdc], WBNB, USDC)

    const path = encodeRouteToPath(route, false)
    // 20 + 3 + 20 + 3 + 20 bytes
    expect(path.length).toEqual(2 + 66 * 2)

    const amountIn = CurrencyAmount.fromRawAmount(WBNB, '100000000000000000')
    const { calldata } = SwapQuoter.quoteCallParameters(route, amountIn, TradeType.EXACT_INPUT)
    const result = await callQuoter(calldata)
    const [amountOut] = SwapQuoter.INTERFACE.decodeFunctionResult('quoteExactInput', result)

    expect(Number(amountOut.toString()) / 1e18).toBeGreaterThan(10)
  })

  it('agrees with the single hop quote when routed directly', async () => {
    const pool = await loadPool(WBNB, USDT, TickSpacing.LOW)
    const route = new Route([pool], WBNB, USDT)
    const amountIn = CurrencyAmount.fromRawAmount(WBNB, '10000000000000000')

    const single = SwapQuoter.quoteCallParameters(route, amountIn, TradeType.EXACT_INPUT)
    const [singleOut] = SwapQuoter.INTERFACE.decodeFunctionResult(
      'quoteExactInputSingle',
      await callQuoter(single.calldata)
    )

    // the same swap expressed as a path quote must price identically
    const pathCalldata = SwapQuoter.INTERFACE.encodeFunctionData('quoteExactInput', [
      encodeRouteToPath(route, false),
      amountIn.quotient.toString()
    ])
    const [pathOut] = SwapQuoter.INTERFACE.decodeFunctionResult('quoteExactInput', await callQuoter(pathCalldata))

    expect(singleOut.toString()).toEqual(pathOut.toString())
  })
})

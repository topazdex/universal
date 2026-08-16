import {
  MixedRoute,
  MIXED_ROUTE_QUOTER_V1_ADDRESS,
  MixedRouteQuoter,
  RouteCL,
  RouteMixed,
  RouteV2,
  Swap,
  Trade
} from '@topaz/router-sdk'
import { BNB, CurrencyAmount, Percent, Token, TradeType, USDC, USDT, WBNB } from '@topaz/sdk-core'
import { Pool as V2Pool } from '@topaz/v2-sdk'
import { CL_QUOTER_V2_ADDRESS, Pool as CLPool, SwapQuoter, TickSpacing } from '@topaz/v3-sdk'
import { BigNumber, Contract, providers, Wallet } from 'ethers'

import { PERMIT2_ADDRESS } from './constants'
import { SwapRouter } from './swapRouter'
import { AnvilInstance, createFundedWallet, pickPort, startAnvilFork } from './test-utils/anvil'
import { deployUniversalRouter } from './test-utils/deployRouter'

const RPC = process.env.BSC_MAINNET_RPC
const FORK_BLOCK = process.env.FORK_BLOCK ? Number(process.env.FORK_BLOCK) : undefined
const CHAIN_ID = 56
const BNB_NATIVE = BNB.onChain(CHAIN_ID)

const V2_FACTORY = '0x65E6cD0eF5D3467030103cf3d433034E570b5784'
const CL_FACTORY = '0x73DC984D9490286E735548f61dfCCec67Af82ed9'

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)'
]
const PERMIT2_ABI = ['function approve(address token, address spender, uint160 amount, uint48 expiration)']
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

const SLIPPAGE = new Percent(50, 10_000) // 0.5%
const describeIfRpc = RPC ? describe : describe.skip

/**
 * The full chain under test: live pool state → SDK trade → Universal Router calldata → execution
 * against the real Topaz contracts on a forked BNB Chain.
 */
describeIfRpc('Universal Router SDK end to end against Topaz mainnet', () => {
  let anvil: AnvilInstance
  let provider: providers.JsonRpcProvider
  let signer: Wallet
  let account: string
  let routerAddress: string

  let usdt: Contract
  let usdc: Contract

  beforeAll(async () => {
    anvil = await startAnvilFork({ rpcUrl: RPC as string, blockNumber: FORK_BLOCK, port: pickPort() })
    provider = anvil.provider
    signer = await createFundedWallet(provider)
    account = signer.address

    const router = await deployUniversalRouter(signer)
    routerAddress = router.address

    usdt = new Contract(USDT.address, ERC20_ABI, provider)
    usdc = new Contract(USDC.address, ERC20_ABI, provider)
  }, 300_000)

  afterAll(() => anvil?.stop())

  async function loadV2Pool(tokenA: Token, tokenB: Token, stable: boolean): Promise<V2Pool> {
    const factory = new Contract(V2_FACTORY, V2_FACTORY_ABI, provider)
    const address: string = await factory.getPool(tokenA.address, tokenB.address, stable)
    const pool = new Contract(address, V2_POOL_ABI, provider)
    const [metadata, fee] = await Promise.all([pool.metadata(), factory.getFee(address, stable)])
    const token0 = metadata.t0 === tokenA.address ? tokenA : tokenB
    const token1 = token0.equals(tokenA) ? tokenB : tokenA
    return new V2Pool(
      CurrencyAmount.fromRawAmount(token0, metadata.r0.toString()),
      CurrencyAmount.fromRawAmount(token1, metadata.r1.toString()),
      metadata.st,
      Number(fee.toString())
    )
  }

  async function loadCLPool(tokenA: Token, tokenB: Token, tickSpacing: number): Promise<CLPool> {
    const factory = new Contract(CL_FACTORY, CL_FACTORY_ABI, provider)
    const address: string = await factory.getPool(tokenA.address, tokenB.address, tickSpacing)
    const pool = new Contract(address, CL_POOL_ABI, provider)
    const [slot0, liquidity, fee] = await Promise.all([pool.slot0(), pool.liquidity(), factory.getSwapFee(address)])
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

  async function quoteCL(route: RouteCL<Token, Token>, amount: CurrencyAmount<Token>, tradeType: TradeType) {
    const { calldata } = SwapQuoter.quoteCallParameters(route, amount, tradeType)
    const result = await provider.call({ to: CL_QUOTER_V2_ADDRESS, data: calldata })
    const fn =
      route.pools.length === 1
        ? tradeType === TradeType.EXACT_INPUT
          ? 'quoteExactInputSingle'
          : 'quoteExactOutputSingle'
        : tradeType === TradeType.EXACT_INPUT
          ? 'quoteExactInput'
          : 'quoteExactOutput'
    const [quoted] = SwapQuoter.INTERFACE.decodeFunctionResult(fn, result)
    return BigNumber.from(quoted)
  }

  async function quoteMixed(route: MixedRoute<Token, Token>, amountIn: CurrencyAmount<Token>) {
    const { calldata } = MixedRouteQuoter.quoteExactInputCallParameters(route, amountIn)
    const result = await provider.call({ to: MIXED_ROUTE_QUOTER_V1_ADDRESS, data: calldata })
    const [amountOut] = MixedRouteQuoter.INTERFACE.decodeFunctionResult('quoteExactInput', result)
    return BigNumber.from(amountOut)
  }

  async function send(calldata: string, value: string) {
    const tx = await signer.sendTransaction({ to: routerAddress, data: calldata, value, gasLimit: 3_000_000 })
    const receipt = await tx.wait()
    expect(receipt.status).toEqual(1)
    return receipt
  }

  function tradeOf(
    swaps: Swap<never, never>[] | Swap<any, any>[],
    tradeType: TradeType
  ): Trade<any, any, TradeType> {
    return new Trade({ swaps: swaps as never, tradeType })
  }

  function deadline(): number {
    return Math.floor(Date.now() / 1000) + 1800
  }

  it('swaps native BNB into USDT through a CL pool', async () => {
    const pool = await loadCLPool(WBNB, USDT, TickSpacing.LOW)
    const route = new RouteCL([pool], BNB_NATIVE, USDT)
    const amountIn = CurrencyAmount.fromRawAmount(BNB_NATIVE, '100000000000000000') // 0.1 BNB
    const quoted = await quoteCL(route as never, amountIn.wrapped as never, TradeType.EXACT_INPUT)

    const trade = tradeOf(
      [{ route, inputAmount: amountIn, outputAmount: CurrencyAmount.fromRawAmount(USDT, quoted.toString()) }],
      TradeType.EXACT_INPUT
    )
    const { calldata, value } = SwapRouter.swapCallParameters(trade, {
      slippageTolerance: SLIPPAGE,
      recipient: account,
      deadline: deadline()
    })

    const before = await usdt.balanceOf(account)
    await send(calldata, value)
    const received = (await usdt.balanceOf(account)).sub(before)

    expect(received.toString()).toEqual(quoted.toString())
  }, 120_000)

  it('swaps native BNB into USDT through a v2 volatile pool, matching the SDK quote exactly', async () => {
    const pool = await loadV2Pool(WBNB, USDT, false)
    const route = new RouteV2([pool], BNB_NATIVE, USDT)
    const amountIn = CurrencyAmount.fromRawAmount(BNB_NATIVE, '5000000000000000') // 0.005 BNB
    const [expectedOut] = pool.getOutputAmount(amountIn.wrapped as CurrencyAmount<Token>)

    const trade = tradeOf([{ route, inputAmount: amountIn, outputAmount: expectedOut }], TradeType.EXACT_INPUT)
    const { calldata, value } = SwapRouter.swapCallParameters(trade, {
      slippageTolerance: SLIPPAGE,
      recipient: account,
      deadline: deadline()
    })

    const before = await usdt.balanceOf(account)
    await send(calldata, value)
    const received = (await usdt.balanceOf(account)).sub(before)

    expect(received.toString()).toEqual(expectedOut.quotient.toString())
  }, 120_000)

  it('swaps native BNB into USDC across a CL hop and a stable v2 hop in one transaction', async () => {
    const clPool = await loadCLPool(WBNB, USDT, TickSpacing.LOW)
    const stablePool = await loadV2Pool(USDT, USDC, true)
    const route = new RouteMixed([clPool, stablePool], BNB_NATIVE, USDC)
    expect(route.isMixed).toBe(true)

    const amountIn = CurrencyAmount.fromRawAmount(BNB_NATIVE, '10000000000000000') // 0.01 BNB
    const quoted = await quoteMixed(
      new MixedRoute([clPool, stablePool], WBNB, USDC),
      amountIn.wrapped as CurrencyAmount<Token>
    )

    const trade = tradeOf(
      [{ route, inputAmount: amountIn, outputAmount: CurrencyAmount.fromRawAmount(USDC, quoted.toString()) }],
      TradeType.EXACT_INPUT
    )
    const { calldata, value } = SwapRouter.swapCallParameters(trade, {
      slippageTolerance: SLIPPAGE,
      recipient: account,
      deadline: deadline()
    })

    const before = await usdc.balanceOf(account)
    await send(calldata, value)
    const received = (await usdc.balanceOf(account)).sub(before)

    expect(received.toString()).toEqual(quoted.toString())
  }, 120_000)

  it('splits one trade across a CL pool and a v2 pool', async () => {
    const clPool = await loadCLPool(WBNB, USDT, TickSpacing.LOW)
    const v2Pool = await loadV2Pool(WBNB, USDT, false)

    const clAmount = CurrencyAmount.fromRawAmount(BNB_NATIVE, '50000000000000000') // 0.05 BNB
    const v2Amount = CurrencyAmount.fromRawAmount(BNB_NATIVE, '2000000000000000') // 0.002 BNB

    const clRoute = new RouteCL([clPool], BNB_NATIVE, USDT)
    const v2Route = new RouteV2([v2Pool], BNB_NATIVE, USDT)

    const clQuote = await quoteCL(clRoute as never, clAmount.wrapped as never, TradeType.EXACT_INPUT)
    const [v2Quote] = v2Pool.getOutputAmount(v2Amount.wrapped as CurrencyAmount<Token>)

    const trade = tradeOf(
      [
        {
          route: clRoute,
          inputAmount: clAmount,
          outputAmount: CurrencyAmount.fromRawAmount(USDT, clQuote.toString())
        },
        { route: v2Route, inputAmount: v2Amount, outputAmount: v2Quote }
      ],
      TradeType.EXACT_INPUT
    )
    const { calldata, value } = SwapRouter.swapCallParameters(trade, {
      slippageTolerance: SLIPPAGE,
      recipient: account,
      deadline: deadline()
    })

    const before = await usdt.balanceOf(account)
    await send(calldata, value)
    const received = (await usdt.balanceOf(account)).sub(before)

    expect(received.toString()).toEqual(clQuote.add(v2Quote.quotient.toString()).toString())
    // the router keeps no dust when it custodies a split trade
    expect((await usdt.balanceOf(routerAddress)).toString()).toEqual('0')
  }, 120_000)

  it('takes an interface fee out of the output', async () => {
    const pool = await loadCLPool(WBNB, USDT, TickSpacing.LOW)
    const route = new RouteCL([pool], BNB_NATIVE, USDT)
    const amountIn = CurrencyAmount.fromRawAmount(BNB_NATIVE, '10000000000000000')
    const quoted = await quoteCL(route as never, amountIn.wrapped as never, TradeType.EXACT_INPUT)

    const feeRecipient = '0x000000000000000000000000000000000000dEaD'
    const trade = tradeOf(
      [{ route, inputAmount: amountIn, outputAmount: CurrencyAmount.fromRawAmount(USDT, quoted.toString()) }],
      TradeType.EXACT_INPUT
    )
    const { calldata, value } = SwapRouter.swapCallParameters(trade, {
      slippageTolerance: SLIPPAGE,
      recipient: account,
      deadline: deadline(),
      fee: { fee: new Percent(25, 10_000), recipient: feeRecipient } // 0.25%
    })

    const userBefore = await usdt.balanceOf(account)
    const feeBefore = await usdt.balanceOf(feeRecipient)
    await send(calldata, value)

    const feeTaken = (await usdt.balanceOf(feeRecipient)).sub(feeBefore)
    const userReceived = (await usdt.balanceOf(account)).sub(userBefore)

    expect(feeTaken.toString()).toEqual(quoted.mul(25).div(10_000).toString())
    expect(userReceived.add(feeTaken).toString()).toEqual(quoted.toString())
  }, 120_000)

  it('swaps USDT back into native BNB using a Permit2 allowance', async () => {
    // fund the account with USDT through the router itself, then trade it back
    const clPool = await loadCLPool(WBNB, USDT, TickSpacing.LOW)
    const fundRoute = new RouteCL([clPool], BNB_NATIVE, USDT)
    const fundIn = CurrencyAmount.fromRawAmount(BNB_NATIVE, '100000000000000000')
    const fundQuote = await quoteCL(fundRoute as never, fundIn.wrapped as never, TradeType.EXACT_INPUT)
    const fundTrade = tradeOf(
      [
        {
          route: fundRoute,
          inputAmount: fundIn,
          outputAmount: CurrencyAmount.fromRawAmount(USDT, fundQuote.toString())
        }
      ],
      TradeType.EXACT_INPUT
    )
    const funding = SwapRouter.swapCallParameters(fundTrade, {
      slippageTolerance: SLIPPAGE,
      recipient: account,
      deadline: deadline()
    })
    await send(funding.calldata, funding.value)

    await (await usdt.connect(signer).approve(PERMIT2_ADDRESS, BigNumber.from(2).pow(256).sub(1))).wait()
    const permit2 = new Contract(PERMIT2_ADDRESS, PERMIT2_ABI, signer)
    await (
      await permit2.approve(USDT.address, routerAddress, BigNumber.from(2).pow(160).sub(1), 2 ** 48 - 1)
    ).wait()

    const sellPool = await loadCLPool(WBNB, USDT, TickSpacing.LOW)
    const sellRoute = new RouteCL([sellPool], USDT, BNB_NATIVE)
    const amountIn = CurrencyAmount.fromRawAmount(USDT, '10000000000000000000') // 10 USDT
    const quoted = await quoteCL(sellRoute as never, amountIn as never, TradeType.EXACT_INPUT)

    const trade = tradeOf(
      [
        {
          route: sellRoute,
          inputAmount: amountIn,
          outputAmount: CurrencyAmount.fromRawAmount(BNB_NATIVE, quoted.toString())
        }
      ],
      TradeType.EXACT_INPUT
    )
    const { calldata, value } = SwapRouter.swapCallParameters(trade, {
      slippageTolerance: SLIPPAGE,
      recipient: account,
      deadline: deadline()
    })

    const before = await provider.getBalance(account)
    const receipt = await send(calldata, value)
    const gasCost = receipt.gasUsed.mul(receipt.effectiveGasPrice)
    const received = (await provider.getBalance(account)).sub(before).add(gasCost)

    expect(received.toString()).toEqual(quoted.toString())
  }, 180_000)

  it('honours an exact output trade and refunds the unspent native input', async () => {
    const pool = await loadCLPool(WBNB, USDT, TickSpacing.LOW)
    const route = new RouteCL([pool], BNB_NATIVE, USDT)
    const amountOut = CurrencyAmount.fromRawAmount(USDT, '25000000000000000000') // 25 USDT
    const quotedIn = await quoteCL(route as never, amountOut as never, TradeType.EXACT_OUTPUT)

    const trade = tradeOf(
      [
        {
          route,
          inputAmount: CurrencyAmount.fromRawAmount(BNB_NATIVE, quotedIn.toString()),
          outputAmount: amountOut
        }
      ],
      TradeType.EXACT_OUTPUT
    )
    const { calldata, value } = SwapRouter.swapCallParameters(trade, {
      slippageTolerance: SLIPPAGE,
      recipient: account,
      deadline: deadline()
    })

    const usdtBefore = await usdt.balanceOf(account)
    const bnbBefore = await provider.getBalance(account)
    const receipt = await send(calldata, value)
    const gasCost = receipt.gasUsed.mul(receipt.effectiveGasPrice)

    const usdtReceived = (await usdt.balanceOf(account)).sub(usdtBefore)
    const bnbSpent = bnbBefore.sub(await provider.getBalance(account)).sub(gasCost)

    expect(usdtReceived.toString()).toEqual(amountOut.quotient.toString())
    // only the amount the swap actually consumed leaves the wallet, the slippage buffer comes back
    expect(bnbSpent.toString()).toEqual(quotedIn.toString())
    expect((await provider.getBalance(routerAddress)).toString()).toEqual('0')
  }, 120_000)

  it('rejects an execution past its deadline', async () => {
    const pool = await loadCLPool(WBNB, USDT, TickSpacing.LOW)
    const route = new RouteCL([pool], BNB_NATIVE, USDT)
    const amountIn = CurrencyAmount.fromRawAmount(BNB_NATIVE, '1000000000000000')
    const quoted = await quoteCL(route as never, amountIn.wrapped as never, TradeType.EXACT_INPUT)

    const trade = tradeOf(
      [{ route, inputAmount: amountIn, outputAmount: CurrencyAmount.fromRawAmount(USDT, quoted.toString()) }],
      TradeType.EXACT_INPUT
    )
    const { calldata, value } = SwapRouter.swapCallParameters(trade, {
      slippageTolerance: SLIPPAGE,
      recipient: account,
      deadline: 1
    })

    const tx = await signer.sendTransaction({ to: routerAddress, data: calldata, value, gasLimit: 3_000_000 })
    await expect(tx.wait()).rejects.toThrow()
  }, 120_000)
})

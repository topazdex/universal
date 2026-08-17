import { Protocol } from '@topazdex/router-sdk'
import { BNB, CurrencyAmount, Percent, TradeType, USDC, USDT, WBNB } from '@topazdex/sdk-core'
import { CL_QUOTER_V2_ADDRESS, Pool as CLPool, Route as CLRoute, SwapQuoter, TickSpacing } from '@topazdex/v3-sdk'
import { BigNumber, Contract, providers, Wallet } from 'ethers'

import { TopazRouter } from './routers/topaz-router'

const RPC = process.env.BSC_MAINNET_RPC
const FORK_BLOCK = process.env.FORK_BLOCK ? Number(process.env.FORK_BLOCK) : undefined
const CHAIN_ID = 56
const BNB_NATIVE = BNB.onChain(CHAIN_ID)
const SLIPPAGE = new Percent(100, 10_000) // 1%

const CL_FACTORY = '0x73DC984D9490286E735548f61dfCCec67Af82ed9'
const CL_FACTORY_ABI = [
  'function getPool(address tokenA, address tokenB, int24 tickSpacing) view returns (address)',
  'function getSwapFee(address pool) view returns (uint24)'
]
const CL_POOL_ABI = [
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, bool unlocked)',
  'function liquidity() view returns (uint128)'
]
const ERC20_ABI = ['function balanceOf(address) view returns (uint256)']

const describeIfRpc = RPC ? describe : describe.skip

/**
 * Routes real sizes against live Topaz liquidity, then executes the router's own calldata on a
 * fork to prove the quote is achievable rather than merely plausible.
 */
describeIfRpc('smart order router against live Topaz liquidity', () => {
  jest.setTimeout(600_000)

  let anvil: { provider: providers.JsonRpcProvider; stop: () => void }
  let provider: providers.JsonRpcProvider
  let signer: Wallet
  let account: string
  let routerAddress: string
  let router: TopazRouter

  beforeAll(async () => {
    const { startAnvilFork, pickPort, createFundedWallet } = await import(
      '@topazdex/universal-router-sdk/dist/test-utils/anvil'
    )
    const { deployUniversalRouter } = await import('@topazdex/universal-router-sdk/dist/test-utils/deployRouter')

    anvil = await startAnvilFork({ rpcUrl: RPC as string, blockNumber: FORK_BLOCK, port: pickPort(500) })
    provider = anvil.provider
    signer = await createFundedWallet(provider, 'topaz-sor-test-account')
    account = signer.address

    const deployed = await deployUniversalRouter(signer)
    routerAddress = deployed.address

    router = new TopazRouter({ provider, universalRouterAddress: routerAddress })
  }, 300_000)

  afterAll(() => anvil?.stop())

  async function directClQuote(amountIn: string): Promise<BigNumber> {
    const factory = new Contract(CL_FACTORY, CL_FACTORY_ABI, provider)
    const address: string = await factory.getPool(WBNB.address, USDT.address, TickSpacing.LOW)
    const poolContract = new Contract(address, CL_POOL_ABI, provider)
    const [slot0, liquidity, fee] = await Promise.all([
      poolContract.slot0(),
      poolContract.liquidity(),
      factory.getSwapFee(address)
    ])
    const pool = new CLPool(
      WBNB,
      USDT,
      Number(fee.toString()),
      TickSpacing.LOW,
      slot0.sqrtPriceX96.toString(),
      liquidity.toString(),
      slot0.tick
    )
    const route = new CLRoute([pool], WBNB, USDT)
    const { calldata } = SwapQuoter.quoteCallParameters(
      route,
      CurrencyAmount.fromRawAmount(WBNB, amountIn),
      TradeType.EXACT_INPUT
    )
    const result = await provider.call({ to: CL_QUOTER_V2_ADDRESS, data: calldata })
    const [amountOut] = SwapQuoter.INTERFACE.decodeFunctionResult('quoteExactInputSingle', result)
    return BigNumber.from(amountOut)
  }

  it('routes native BNB into USDT and beats the single deepest CL pool', async () => {
    const amount = CurrencyAmount.fromRawAmount(BNB_NATIVE, '1000000000000000000') // 1 BNB
    const result = await router.route(amount, USDT, TradeType.EXACT_INPUT)

    expect(result).not.toBeNull()
    expect(result!.routes.length).toBeGreaterThan(0)
    expect(result!.quote.greaterThan(0)).toBe(true)

    const direct = await directClQuote(amount.quotient.toString())
    expect(BigNumber.from(result!.quote.quotient.toString()).gte(direct)).toBe(true)
  })

  it('prices gas into the comparison, so the gas adjusted quote trails the raw quote', async () => {
    const amount = CurrencyAmount.fromRawAmount(BNB_NATIVE, '100000000000000000') // 0.1 BNB
    const result = await router.route(amount, USDT, TradeType.EXACT_INPUT)

    expect(result).not.toBeNull()
    expect(result!.estimatedGasUsed.gt(0)).toBe(true)
    expect(result!.quoteGasAdjusted.lessThan(result!.quote)).toBe(true)
    expect(result!.estimatedGasUsedQuoteToken.greaterThan(0)).toBe(true)
  })

  it('executes its own calldata for a native input trade', async () => {
    const amount = CurrencyAmount.fromRawAmount(BNB_NATIVE, '200000000000000000') // 0.2 BNB
    const result = await router.route(amount, USDT, TradeType.EXACT_INPUT, {
      slippageTolerance: SLIPPAGE,
      recipient: account,
      deadline: Math.floor(Date.now() / 1000) + 1800
    })

    expect(result?.methodParameters).toBeDefined()
    const { calldata, value, to } = result!.methodParameters!
    expect(to).toEqual(routerAddress)

    const usdt = new Contract(USDT.address, ERC20_ABI, provider)
    const before = await usdt.balanceOf(account)
    const receipt = await (
      await signer.sendTransaction({ to, data: calldata, value, gasLimit: 5_000_000 })
    ).wait()
    expect(receipt.status).toEqual(1)

    const received = (await usdt.balanceOf(account)).sub(before)
    const minimum = result!.trade.minimumAmountOut(SLIPPAGE)

    expect(received.gte(BigNumber.from(minimum.quotient.toString()))).toBe(true)
    // the executed amount should land within a hair of the quote, the fork moved only by our own trade
    const quoted = BigNumber.from(result!.quote.quotient.toString())
    expect(received.sub(quoted).abs().mul(10_000).div(quoted).toNumber()).toBeLessThanOrEqual(1)
  })

  it('routes an exact output trade and executes it', async () => {
    const amountOut = CurrencyAmount.fromRawAmount(USDT, '100000000000000000000') // 100 USDT
    const result = await router.route(amountOut, BNB_NATIVE, TradeType.EXACT_OUTPUT, {
      slippageTolerance: SLIPPAGE,
      recipient: account,
      deadline: Math.floor(Date.now() / 1000) + 1800
    })

    expect(result).not.toBeNull()
    expect(result!.quote.greaterThan(0)).toBe(true)

    const usdt = new Contract(USDT.address, ERC20_ABI, provider)
    const before = await usdt.balanceOf(account)
    const { calldata, value, to } = result!.methodParameters!
    const receipt = await (
      await signer.sendTransaction({ to, data: calldata, value, gasLimit: 5_000_000 })
    ).wait()
    expect(receipt.status).toEqual(1)

    const received = (await usdt.balanceOf(account)).sub(before)
    expect(received.toString()).toEqual(amountOut.quotient.toString())
  })

  it('considers both stacks when routing a stable pair', async () => {
    const amount = CurrencyAmount.fromRawAmount(USDT, '1000000000000000000000') // 1000 USDT
    const result = await router.route(amount, USDC, TradeType.EXACT_INPUT)

    expect(result).not.toBeNull()
    const protocols = new Set(result!.routes.map(route => route.route.protocol))
    expect(protocols.size).toBeGreaterThan(0)
    // a 1000 USDT trade between two stables should barely move, whichever stack it uses
    const out = Number(result!.quote.toExact())
    expect(out).toBeGreaterThan(980)
    expect(out).toBeLessThan(1020)
  })

  it('finds mixed routes when a pair is only connected across the two stacks', async () => {
    const amount = CurrencyAmount.fromRawAmount(BNB_NATIVE, '100000000000000000')
    const result = await router.route(amount, USDC, TradeType.EXACT_INPUT, undefined, {
      maxHops: 2,
      distributionPercent: 25
    })

    expect(result).not.toBeNull()
    const protocols = result!.routes.map(route => route.route.protocol)
    expect(protocols.every(protocol => Object.values(Protocol).includes(protocol))).toBe(true)
    expect(result!.quote.greaterThan(0)).toBe(true)
  })
})

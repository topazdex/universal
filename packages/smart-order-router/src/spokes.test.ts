import { readFileSync } from 'fs'
import { resolve } from 'path'
import { BigNumber, Contract, ContractFactory, providers, Wallet } from 'ethers'
import { CurrencyAmount, getChainConfig, hasWrappedNative, nativeOnChain, Percent, Token, TradeType } from '@topazdex/sdk-core'
import { Pool } from '@topazdex/v2-sdk'
import { createFundedWallet, pickPort, startAnvilFork } from '@topazdex/universal-router-sdk/dist/test-utils/anvil'
import { SubgraphProvider } from './providers/subgraph'
import { TopazRouter } from './routers/topaz-router'

const networks: { chainId: number; name: string; rpc?: string; routerAddress?: string }[] = [
  {
    chainId: 1,
    name: 'Ethereum',
    rpc: process.env.ETHEREUM_RPC_URL,
    routerAddress: process.env.ETHEREUM_UNIVERSAL_ROUTER
  },
  { chainId: 4663, name: 'Robinhood', rpc: process.env.ROBINHOOD_RPC_URL },
  { chainId: 8453, name: 'Base', rpc: process.env.BASE_RPC_URL },
  // Arc has no wrapped native: the hub side of the pool is a six-decimal token standing in for USDC,
  // whose own transfers reach a system precompile Anvil cannot run
  { chainId: 5042, name: 'Arc', rpc: process.env.ARC_RPC_URL, routerAddress: process.env.ARC_UNIVERSAL_ROUTER }
]

for (const network of networks) {
  const chain = getChainConfig(network.chainId)
  const nativeLeg = hasWrappedNative(network.chainId)
  const native = nativeLeg ? nativeOnChain(network.chainId) : undefined
  ;(network.rpc ? describe : describe.skip)(`${network.name} routing and execution`, () => {
    jest.setTimeout(300_000)
    let fork: { provider: providers.JsonRpcProvider; stop: () => void }
    let wallet: Wallet
    let token: Token
    let erc20: Contract
    /** The wrapped native, or on Arc the six-decimal stand-in the trade starts from */
    let hub: Token
    let hubErc20: Contract | undefined
    let router: TopazRouter
    let executionRouterAddress: string

    beforeAll(async () => {
      fork = await startAnvilFork({ rpcUrl: network.rpc!, chainId: network.chainId, port: pickPort(1200) })
      wallet = await createFundedWallet(fork.provider, `topaz-spoke-routing-test-${network.chainId}`)
      const recordedRouter = network.routerAddress ?? chain.universalRouterAddress
      if (recordedRouter) {
        executionRouterAddress = recordedRouter
      } else {
        // Rehearse a new chain before its execution router is broadcast. This deployment exists
        // only inside Anvil; live-chain tests keep using the recorded router above.
        const routerArtifact = JSON.parse(
          readFileSync(
            resolve(__dirname, '../../universal-router/out/UniversalRouter.sol/UniversalRouter.json'),
            'utf8'
          )
        )
        const executionRouter = await new ContractFactory(
          routerArtifact.abi,
          routerArtifact.bytecode.object,
          wallet
        ).deploy({
          permit2: chain.permit2Address,
          // Arc's slot holds the reverting stub every Topaz contract there was deployed with
          weth9: chain.wrappedNativeAddress ?? '0x8bcEaA40B9AcdfAedF85AdF4FF01F5Ad6517937f',
          v2Factory: chain.v2FactoryAddress,
          v2Implementation: chain.v2PoolImplementationAddress,
          clFactory: chain.clFactoryAddress,
          clImplementation: chain.clPoolImplementationAddress
        })
        await executionRouter.deployed()
        executionRouterAddress = executionRouter.address
      }
      const artifact = JSON.parse(
        readFileSync(resolve(__dirname, '../../universal-router/out/Arc.t.sol/ArcTestToken.json'), 'utf8')
      )
      const tokens = new ContractFactory(artifact.abi, artifact.bytecode.object, wallet)
      erc20 = await tokens.deploy('FORK', 18, '1000000000000000000000000')
      await erc20.deployed()
      token = new Token(network.chainId, erc20.address, 18, 'FORK')
      const hubLiquidity = nativeLeg ? '10000000000000000000' : '10000000'
      if (native) {
        hub = native.wrapped
        const weth = new Contract(
          hub.address,
          ['function deposit() payable', 'function transfer(address,uint256) returns(bool)'],
          wallet
        )
        await (await weth.deposit({ value: hubLiquidity })).wait()
        hubErc20 = weth
      } else {
        hubErc20 = await tokens.deploy('USDC', 6, '1000000000000')
        await hubErc20.deployed()
        hub = new Token(network.chainId, hubErc20.address, 6, 'USDC')
      }
      const factory = new Contract(
        chain.v2FactoryAddress,
        ['function createPool(address,address,bool) returns(address)'],
        wallet
      )
      await (await factory.createPool(hub.address, token.address, false)).wait()
      const poolAddress = Pool.getAddress(hub, token, false)
      await (await hubErc20.transfer(poolAddress, hubLiquidity)).wait()
      await (await erc20.transfer(poolAddress, '10000000000000000000')).wait()
      await (
        await new Contract(poolAddress, ['function mint(address) returns(uint256)'], wallet).mint(wallet.address)
      ).wait()
      // The public graph cannot index pools created on a local fork. Only discovery is supplied;
      // metadata, reserves, fees, quote simulation and execution all use deployed contracts.
      const subgraph = ({
        getV2Pools: async () => [
          {
            id: poolAddress,
            stable: false,
            fee: 0,
            reserveUSD: 0,
            token0: { id: hub.address, symbol: hub.symbol, decimals: String(hub.decimals) },
            token1: { id: token.address, symbol: 'FORK', decimals: '18' }
          }
        ],
        getCLPools: async () => []
      } as unknown) as SubgraphProvider
      router = new TopazRouter({
        provider: fork.provider,
        chainId: network.chainId,
        subgraphProvider: subgraph,
        universalRouterAddress: executionRouterAddress
      })
    })

    afterAll(() => fork?.stop())

    it.each([TradeType.EXACT_INPUT, TradeType.EXACT_OUTPUT])(
      `executes a ${nativeLeg ? 'native' : 'token'} quote of trade type %s`,
      async (tradeType) => {
        const from = native ?? hub
        const amount = CurrencyAmount.fromRawAmount(
          tradeType === TradeType.EXACT_INPUT ? from : token,
          nativeLeg ? '1000000000000000' : '1000'
        )
        const result = await router.route(amount, tradeType === TradeType.EXACT_INPUT ? token : from, tradeType, {
          recipient: wallet.address,
          slippageTolerance: new Percent(50, 10000)
        })
        expect(result).not.toBeNull()
        expect(result!.methodParameters!.to).toBe(executionRouterAddress)
        const params = result!.methodParameters!
        if (!nativeLeg) {
          // a token leg pays through Permit2; the native path needs neither approval
          expect(params.value).toBe('0x00')
          const permit2 = new Contract(
            chain.permit2Address!,
            ['function approve(address,address,uint160,uint48)'],
            wallet
          )
          for (const spender of [hubErc20!, erc20]) {
            await (await spender.approve(chain.permit2Address, '0x' + 'f'.repeat(64))).wait()
            await (
              await permit2.approve(spender.address, executionRouterAddress, '0x' + 'f'.repeat(40), '0x' + 'f'.repeat(12))
            ).wait()
          }
        }
        const before = await erc20.balanceOf(wallet.address)
        await (
          await wallet.sendTransaction({ to: params.to, data: params.calldata, value: params.value, gasLimit: 2000000 })
        ).wait()
        const received = (await erc20.balanceOf(wallet.address)).sub(before)
        const expected =
          tradeType === TradeType.EXACT_INPUT ? result!.quote.quotient.toString() : amount.quotient.toString()
        expect(received.gte(BigNumber.from(expected))).toBe(true)
      }
    )
  })
}

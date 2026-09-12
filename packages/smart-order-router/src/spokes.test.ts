import { readFileSync } from 'fs'
import { resolve } from 'path'
import { BigNumber, Contract, ContractFactory, providers, Wallet } from 'ethers'
import { CurrencyAmount, getChainConfig, nativeOnChain, Percent, Token, TradeType } from '@topazdex/sdk-core'
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
  { chainId: 8453, name: 'Base', rpc: process.env.BASE_RPC_URL }
]

for (const network of networks) {
  const chain = getChainConfig(network.chainId)
  const native = nativeOnChain(network.chainId)
  ;(network.rpc ? describe : describe.skip)(`${network.name} routing and execution`, () => {
    jest.setTimeout(300_000)
    let fork: { provider: providers.JsonRpcProvider; stop: () => void }
    let wallet: Wallet
    let token: Token
    let erc20: Contract
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
          weth9: chain.wrappedNativeAddress,
          v2Factory: chain.v2FactoryAddress,
          v2Implementation: chain.v2PoolImplementationAddress,
          clFactory: chain.clFactoryAddress,
          clImplementation: chain.clPoolImplementationAddress
        })
        await executionRouter.deployed()
        executionRouterAddress = executionRouter.address
      }
      const artifact = JSON.parse(
        readFileSync(resolve(__dirname, '../../universal-router/out/Robinhood.t.sol/RobinhoodTestToken.json'), 'utf8')
      )
      erc20 = await new ContractFactory(artifact.abi, artifact.bytecode.object, wallet).deploy()
      await erc20.deployed()
      token = new Token(network.chainId, erc20.address, 18, 'FORK')
      const weth = new Contract(
        native.wrapped.address,
        ['function deposit() payable', 'function transfer(address,uint256) returns(bool)'],
        wallet
      )
      const factory = new Contract(
        chain.v2FactoryAddress,
        ['function createPool(address,address,bool) returns(address)'],
        wallet
      )
      await (await factory.createPool(native.wrapped.address, token.address, false)).wait()
      const poolAddress = Pool.getAddress(native.wrapped, token, false)
      await (await weth.deposit({ value: '10000000000000000000' })).wait()
      await (await weth.transfer(poolAddress, '10000000000000000000')).wait()
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
            token0: { id: native.wrapped.address, symbol: 'WETH', decimals: '18' },
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
      'executes a native quote of trade type %s',
      async (tradeType) => {
        const amount = CurrencyAmount.fromRawAmount(
          tradeType === TradeType.EXACT_INPUT ? native : token,
          '1000000000000000'
        )
        const result = await router.route(amount, tradeType === TradeType.EXACT_INPUT ? token : native, tradeType, {
          recipient: wallet.address,
          slippageTolerance: new Percent(50, 10000)
        })
        expect(result).not.toBeNull()
        expect(result!.methodParameters!.to).toBe(executionRouterAddress)
        const before = await erc20.balanceOf(wallet.address)
        const params = result!.methodParameters!
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

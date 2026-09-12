import { Token } from '@uniswap/sdk-core'

export interface ChainDeployment {
  chainId: number
  name: string
  nativeCurrency: { name: string; symbol: string; decimals: number }
  wrappedNativeAddress: string
  rpcUrls: string[]
  v2FactoryAddress: string
  v2PoolImplementationAddress: string
  clFactoryAddress: string
  clPoolImplementationAddress: string
  mixedQuoterAddress?: string
  quoterV2Address?: string
  universalRouterAddress?: string
  multicallAddress: string
  permit2Address?: string
  /** Unified schema from topaz-api/topaz-spoke-subgraph/schema.graphql. */
  subgraphUrl?: string
  /** Legacy BNB graphs, used only until its unified graph is configured. */
  v2SubgraphUrl?: string
  v3SubgraphUrl?: string
  /** Routing intermediaries in addition to wrapped native; see docs/INTERMEDIARY_TOKENS.md. */
  baseTokens?: { address: string; decimals: number; symbol?: string }[]
}

const chains = new Map<number, ChainDeployment>()

/** Register deployments at startup, before constructing currencies or routers. */
export function registerChain(config: ChainDeployment): void {
  if (!Number.isSafeInteger(config.chainId) || config.chainId <= 0) throw new Error('Invalid chainId')
  if (!config.name || !config.nativeCurrency?.symbol || !Array.isArray(config.rpcUrls)) {
    throw new Error(`Incomplete chain configuration for ${config.chainId}`)
  }
  const addresses = [
    config.wrappedNativeAddress,
    config.v2FactoryAddress,
    config.v2PoolImplementationAddress,
    config.clFactoryAddress,
    config.clPoolImplementationAddress,
    config.multicallAddress
  ]
  for (const address of addresses) validateAddress(config.chainId, address)
  for (const address of [
    config.mixedQuoterAddress,
    config.quoterV2Address,
    config.universalRouterAddress,
    config.permit2Address
  ]) {
    if (address !== undefined) validateAddress(config.chainId, address)
  }
  const decimals = config.nativeCurrency.decimals
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 254) throw new Error('Invalid native decimals')
  for (const token of config.baseTokens ?? []) new Token(config.chainId, token.address, token.decimals, token.symbol)
  chains.set(config.chainId, JSON.parse(JSON.stringify(config)) as ChainDeployment)
}

function validateAddress(chainId: number, address: string): void {
  if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address) || /^0x0{40}$/.test(address)) {
    throw new Error(`Invalid contract address for chain ${chainId}`)
  }
  new Token(chainId, address, 18)
}

export function getChainConfig(chainId: number): ChainDeployment {
  const config = chains.get(chainId)
  if (!config) throw new Error(`No Topaz deployment configured for chain ${chainId}; registerChain first`)
  return JSON.parse(JSON.stringify(config)) as ChainDeployment
}

export function wrappedNativeOnChain(chainId: number): Token {
  const config = getChainConfig(chainId)
  return new Token(
    chainId,
    config.wrappedNativeAddress,
    config.nativeCurrency.decimals,
    `W${config.nativeCurrency.symbol}`,
    `Wrapped ${config.nativeCurrency.name}`
  )
}

export function baseTokensOnChain(chainId: number): Token[] {
  const config = getChainConfig(chainId)
  return [
    wrappedNativeOnChain(chainId),
    ...(config.baseTokens ?? []).map((token) => new Token(chainId, token.address, token.decimals, token.symbol))
  ]
}

// Spoke addresses imported from xTopaz deployment records on 2026-09-11/12.
// Unrecorded quoters, execution routers and unpublished subgraphs stay unset.
registerChain({
  chainId: 1,
  name: 'Ethereum',
  universalRouterAddress: '0x606794d37991A426a189fD9FA8664D339A77f8ae',
  subgraphUrl:
    'https://api.goldsky.com/api/public/project_cmgzljqwl006c5np2gnao4li4/subgraphs/topaz-chain-ethereum/r-8b4f23a5d335-51fb901bfc78d0a8/gn',
  mixedQuoterAddress: '0x39A344d192D1D34a6Bee24DCF11093e93Fbb3993',
  quoterV2Address: '0xA9Cd3aC90513663197E7Fd6c932f63f0C40701be',
  nativeCurrency: {
    name: 'Ether',
    symbol: 'ETH',
    decimals: 18
  },
  wrappedNativeAddress: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
  rpcUrls: ['https://ethereum-rpc.publicnode.com', 'https://eth.drpc.org'],
  permit2Address: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
  multicallAddress: '0xcA11bde05977b3631167028862bE2a173976CA11',
  v2FactoryAddress: '0x1E3aC31cF96b20619c913384C9bf6010A824fB95',
  v2PoolImplementationAddress: '0x8776BE6cd50BB78414c655bc8bF9e86A0989722F',
  clFactoryAddress: '0xaa5865dC3A60b25D305226d66fd573021f0D8fFB',
  clPoolImplementationAddress: '0x2DaA7cF731334b4Cd1c2E4E01E97Ca67F4B9C6AE',
  // Starter intermediaries verified on-chain on 2026-09-12; sources in docs/INTERMEDIARY_TOKENS.md.
  baseTokens: [
    {
      address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
      decimals: 6,
      symbol: 'USDC'
    },
    {
      address: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
      decimals: 6,
      symbol: 'USDT'
    },
    {
      address: '0x6B175474E89094C44Da98b954EedeAC495271d0F',
      decimals: 18,
      symbol: 'DAI'
    },
    {
      address: '0xdC035D45d973E3EC169d2276DDab16f1e407384F',
      decimals: 18,
      symbol: 'USDS'
    },
    {
      address: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599',
      decimals: 8,
      symbol: 'WBTC'
    },
    {
      address: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf',
      decimals: 8,
      symbol: 'cbBTC'
    },
    {
      address: '0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0',
      decimals: 18,
      symbol: 'wstETH'
    },
    {
      address: '0x1aA89C4Ab9884Cb65B759A3Cc3A1690744d687a6',
      decimals: 18,
      symbol: 'xTOPAZ'
    }
  ]
})

registerChain({
  chainId: 56,
  name: 'BNB Chain',
  nativeCurrency: {
    name: 'BNB',
    symbol: 'BNB',
    decimals: 18
  },
  wrappedNativeAddress: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
  rpcUrls: ['https://bsc-dataseed.bnbchain.org'],
  v2FactoryAddress: '0x65E6cD0eF5D3467030103cf3d433034E570b5784',
  v2PoolImplementationAddress: '0xdC942D8e37cC20BCf9aD1Fe0111eE6c5908f3678',
  clFactoryAddress: '0x73DC984D9490286E735548f61dfCCec67Af82ed9',
  clPoolImplementationAddress: '0x18e68051d1b1fB44cb539cA4436F112D28577AF7',
  mixedQuoterAddress: '0x47c3570b90e7234FE695Ad5F1bE69E21fe1a9ee2',
  quoterV2Address: '0x7CCB89bB9BdEF68688F39a2c22d249fD1D9759f1',
  universalRouterAddress: '0x691e6171e0a434FfE5C9f1759621D05b9efcF6A6',
  multicallAddress: '0xcA11bde05977b3631167028862bE2a173976CA11',
  permit2Address: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
  v2SubgraphUrl: 'https://api.goldsky.com/api/public/project_cmgzljqwl006c5np2gnao4li4/subgraphs/topaz-v2/prod/gn',
  v3SubgraphUrl: 'https://api.goldsky.com/api/public/project_cmgzljqwl006c5np2gnao4li4/subgraphs/topaz-v3/prod/gn',
  baseTokens: [
    {
      address: '0x55d398326f99059fF775485246999027B3197955',
      decimals: 18,
      symbol: 'USDT'
    },
    {
      address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
      decimals: 18,
      symbol: 'USDC'
    },
    {
      address: '0x2170Ed0880ac9A755fd29B2688956BD959F933F8',
      decimals: 18,
      symbol: 'ETH'
    },
    {
      address: '0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c',
      decimals: 18,
      symbol: 'BTCB'
    },
    {
      address: '0xdf002282C1474C9592780618Adda7EaA99998Abd',
      decimals: 18,
      symbol: 'TOPAZ'
    }
  ]
})

registerChain({
  chainId: 4663,
  universalRouterAddress: '0x268d1C8a538Ecf6628838C11d581e1EABD13D6A4',
  subgraphUrl:
    'https://api.goldsky.com/api/public/project_cmgzljqwl006c5np2gnao4li4/subgraphs/topaz-chain-robinhood/r-8b4f23a5d335-4f8e4a2e72c2beff/gn',
  permit2Address: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
  name: 'Robinhood',
  nativeCurrency: {
    name: 'Ether',
    symbol: 'ETH',
    decimals: 18
  },
  wrappedNativeAddress: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73',
  rpcUrls: ['https://rpc.mainnet.chain.robinhood.com'],
  multicallAddress: '0xcA11bde05977b3631167028862bE2a173976CA11',
  v2FactoryAddress: '0x1E3aC31cF96b20619c913384C9bf6010A824fB95',
  v2PoolImplementationAddress: '0x8776BE6cd50BB78414c655bc8bF9e86A0989722F',
  clFactoryAddress: '0xaa5865dC3A60b25D305226d66fd573021f0D8fFB',
  clPoolImplementationAddress: '0x2DaA7cF731334b4Cd1c2E4E01E97Ca67F4B9C6AE',
  mixedQuoterAddress: '0x39A344d192D1D34a6Bee24DCF11093e93Fbb3993',
  quoterV2Address: '0xA9Cd3aC90513663197E7Fd6c932f63f0C40701be',
  // Starter intermediaries verified on-chain on 2026-09-12; sources in docs/INTERMEDIARY_TOKENS.md.
  baseTokens: [
    {
      address: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',
      decimals: 6,
      symbol: 'USDG'
    },
    {
      address: '0x1aA89C4Ab9884Cb65B759A3Cc3A1690744d687a6',
      decimals: 18,
      symbol: 'xTOPAZ'
    }
  ]
})

registerChain({
  chainId: 8453,
  universalRouterAddress: '0xe4b23F13b24232C1E68AD0575191216152AA9480',
  subgraphUrl:
    'https://api.goldsky.com/api/public/project_cmgzljqwl006c5np2gnao4li4/subgraphs/topaz-chain-base/r-8b4f23a5d335-b4f259122be58576/gn',
  mixedQuoterAddress: '0xA9Cd3aC90513663197E7Fd6c932f63f0C40701be',
  quoterV2Address: '0x2e7395A6E0De6eE1f390bEcE891069Cd18Ff8572',
  permit2Address: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
  name: 'Base',
  nativeCurrency: {
    name: 'Ether',
    symbol: 'ETH',
    decimals: 18
  },
  wrappedNativeAddress: '0x4200000000000000000000000000000000000006',
  // mainnet.base.org answers 429 under modest load; publicnode takes over while it cools down
  rpcUrls: ['https://mainnet.base.org', 'https://base-rpc.publicnode.com'],
  multicallAddress: '0xcA11bde05977b3631167028862bE2a173976CA11',
  v2FactoryAddress: '0x1E3aC31cF96b20619c913384C9bf6010A824fB95',
  v2PoolImplementationAddress: '0x8776BE6cd50BB78414c655bc8bF9e86A0989722F',
  clFactoryAddress: '0xaa5865dC3A60b25D305226d66fd573021f0D8fFB',
  clPoolImplementationAddress: '0x2DaA7cF731334b4Cd1c2E4E01E97Ca67F4B9C6AE',
  // Starter intermediaries verified on-chain on 2026-09-12; sources in docs/INTERMEDIARY_TOKENS.md.
  baseTokens: [
    {
      address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      decimals: 6,
      symbol: 'USDC'
    },
    {
      address: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf',
      decimals: 8,
      symbol: 'cbBTC'
    },
    {
      address: '0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452',
      decimals: 18,
      symbol: 'wstETH'
    },
    {
      address: '0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22',
      decimals: 18,
      symbol: 'cbETH'
    },
    {
      address: '0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42',
      decimals: 6,
      symbol: 'EURC'
    },
    {
      address: '0x940181a94A35A4569E4529A3CDfB74e38FD98631',
      decimals: 18,
      symbol: 'AERO'
    },
    {
      address: '0x1aA89C4Ab9884Cb65B759A3Cc3A1690744d687a6',
      decimals: 18,
      symbol: 'xTOPAZ'
    }
  ]
})

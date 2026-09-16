import {
  baseTokensOnChain,
  BNB,
  gasTokenOnChain,
  getChainConfig,
  hasWrappedNative,
  nativeOnChain,
  registerChain,
  WBNB,
  wrappedNativeOnChain
} from './index'

describe('chain deployments', () => {
  it.each([1, 4663, 8453])('resolves native ETH and routing tokens on %s', (chainId) => {
    const native = nativeOnChain(chainId)
    expect(native.symbol).toBe('ETH')
    expect(native.wrapped.address).toBe(getChainConfig(chainId).wrappedNativeAddress)
    expect(native.wrapped.equals(WBNB)).toBe(false)
    expect(baseTokensOnChain(chainId).every((token) => token.chainId === chainId)).toBe(true)
  })

  it('does not treat ETH on different chains as the same currency', () => {
    expect(nativeOnChain(1).equals(nativeOnChain(8453))).toBe(false)
    expect(nativeOnChain(4663).equals(nativeOnChain(8453))).toBe(false)
    expect(() => BNB.onChain(8453)).toThrow('BNB_CHAIN')
    expect(() => nativeOnChain(987654)).toThrow('No Topaz deployment')
  })

  it('uses the deployed Ethereum router and unified graph', () => {
    const ethereum = getChainConfig(1)
    expect(ethereum.wrappedNativeAddress).toBe('0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2')
    expect(ethereum.subgraphUrl).toBe(
      'https://api.goldsky.com/api/public/project_cmgzljqwl006c5np2gnao4li4/subgraphs/topaz-chain-ethereum/r-8b4f23a5d335-51fb901bfc78d0a8/gn'
    )
    expect(ethereum.v2SubgraphUrl).toBeUndefined()
    expect(ethereum.v3SubgraphUrl).toBeUndefined()
    expect(ethereum.universalRouterAddress).toBe('0x606794d37991A426a189fD9FA8664D339A77f8ae')
  })

  it('accepts a future EVM chain with a different native denomination', () => {
    registerChain({
      ...getChainConfig(8453),
      chainId: 987655,
      nativeCurrency: { name: 'Gas token', symbol: 'GAS', decimals: 6 }
    })
    expect(nativeOnChain(987655).decimals).toBe(6)
    expect(nativeOnChain(987655).wrapped.decimals).toBe(6)
    expect(nativeOnChain(987655).symbol).toBe('GAS')
  })

  it('registers Arc without a wrapped native and refuses native legs there', () => {
    const arc = getChainConfig(5042)
    expect(arc.wrappedNativeAddress).toBeUndefined()
    expect(arc.universalRouterAddress).toBe('0x7B1d8745079C85af80Ff7A7eA7C2C4769Eab5348')
    expect(arc.nativeCurrency).toEqual({ name: 'USD Coin', symbol: 'USDC', decimals: 18 })
    expect(arc.gasToken).toEqual({ address: '0x3600000000000000000000000000000000000000', decimals: 6, symbol: 'USDC' })
    expect(hasWrappedNative(5042)).toBe(false)
    expect(hasWrappedNative(8453)).toBe(true)
    expect(() => nativeOnChain(5042)).toThrow('no wrapped native')
    expect(() => wrappedNativeOnChain(5042)).toThrow('no wrapped native')
    expect(gasTokenOnChain(5042).decimals).toBe(6)
    expect(gasTokenOnChain(8453).address).toBe(getChainConfig(8453).wrappedNativeAddress)
    // the stub is not a token; only real ERC-20 hubs belong in the routing set
    expect(baseTokensOnChain(5042).map((token) => token.symbol)).toEqual(['USDC', 'xTOPAZ'])
    expect(baseTokensOnChain(5042).every((token) => token.chainId === 5042)).toBe(true)
  })

  it('requires a gas token when no wrapped native exists', () => {
    expect(() =>
      registerChain({ ...getChainConfig(8453), chainId: 987657, wrappedNativeAddress: undefined, gasToken: undefined })
    ).toThrow('gas token')
  })

  it('does not expose mutable deployment records', () => {
    const chain = getChainConfig(4663)
    chain.rpcUrls.length = 0
    expect(getChainConfig(4663).rpcUrls.length).toBeGreaterThan(0)
  })

  it('keeps incomplete deployments explicit', () => {
    registerChain({
      ...getChainConfig(8453),
      chainId: 987656,
      mixedQuoterAddress: undefined,
      universalRouterAddress: undefined
    })
    expect(getChainConfig(987656).mixedQuoterAddress).toBeUndefined()
    expect(getChainConfig(987656).universalRouterAddress).toBeUndefined()
  })
})

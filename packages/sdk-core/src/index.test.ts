import { BASE_TOKENS, BNB, nativeOnChain, TOPAZ_CHAIN_ID, USDT, WBNB } from './index'

describe('BNB', () => {
  it('wraps to WBNB', () => {
    expect(nativeOnChain().wrapped.equals(WBNB)).toBe(true)
    expect(WBNB.address).toEqual('0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c')
  })

  it('is native and equals any other BNB instance on the same chain', () => {
    expect(BNB.onChain(TOPAZ_CHAIN_ID).isNative).toBe(true)
    expect(BNB.onChain(TOPAZ_CHAIN_ID).equals(nativeOnChain())).toBe(true)
  })

  it('is cached per chain, so currency identity survives across packages', () => {
    expect(BNB.onChain(TOPAZ_CHAIN_ID)).toBe(nativeOnChain(TOPAZ_CHAIN_ID))
  })

  it('does not equal a token', () => {
    expect(nativeOnChain().equals(USDT)).toBe(false)
  })
})

describe('tokens', () => {
  it('are all on BNB Chain', () => {
    expect(BASE_TOKENS.every(token => token.chainId === TOPAZ_CHAIN_ID)).toBe(true)
  })

  it('lead with the wrapped native token, the deepest routing hub', () => {
    expect(BASE_TOKENS[0].equals(WBNB)).toBe(true)
  })

  it('are checksummed and unique', () => {
    const addresses = BASE_TOKENS.map(token => token.address)
    expect(new Set(addresses).size).toEqual(addresses.length)
    expect(addresses.every(address => address !== address.toLowerCase())).toBe(true)
  })
})

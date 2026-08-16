import { Currency, NativeCurrency, Token } from '@uniswap/sdk-core'
import invariant from 'tiny-invariant'

export * from '@uniswap/sdk-core'

/** BNB Chain mainnet */
export const TOPAZ_CHAIN_ID = 56

export const WBNB = new Token(
  TOPAZ_CHAIN_ID,
  '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
  18,
  'WBNB',
  'Wrapped BNB'
)

/**
 * Native BNB. `@uniswap/sdk-core` ships `Ether` and a wrapped-native table but no BNB currency,
 * so the Topaz stack defines one here and everything else imports it from this package, keeping a
 * single currency identity across the SDKs.
 */
export class BNB extends NativeCurrency {
  protected constructor(chainId: number) {
    super(chainId, 18, 'BNB', 'BNB')
  }

  public get wrapped(): Token {
    invariant(this.chainId === TOPAZ_CHAIN_ID, 'WRAPPED')
    return WBNB
  }

  private static _cache: { [chainId: number]: BNB } = {}

  public static onChain(chainId: number): BNB {
    return this._cache[chainId] ?? (this._cache[chainId] = new BNB(chainId))
  }

  public equals(other: Currency): boolean {
    return other.isNative && other.chainId === this.chainId
  }
}

export function nativeOnChain(chainId: number = TOPAZ_CHAIN_ID): BNB {
  return BNB.onChain(chainId)
}

/** Tokens the Topaz deployment treats as routing hubs, plus the governance token */
export const TOPAZ = new Token(TOPAZ_CHAIN_ID, '0xdf002282C1474C9592780618Adda7EaA99998Abd', 18, 'TOPAZ', 'Topaz')
export const USDT = new Token(TOPAZ_CHAIN_ID, '0x55d398326f99059fF775485246999027B3197955', 18, 'USDT', 'Tether USD')
export const USDC = new Token(TOPAZ_CHAIN_ID, '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', 18, 'USDC', 'USD Coin')
export const BTCB = new Token(TOPAZ_CHAIN_ID, '0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c', 18, 'BTCB', 'Bitcoin BEP20')
export const WETH = new Token(TOPAZ_CHAIN_ID, '0x2170Ed0880ac9A755fd29B2688956BD959F933F8', 18, 'ETH', 'Ethereum Token')

/**
 * Default intermediate tokens the router hops through when no direct pool exists.
 * Ordered by how much Topaz liquidity they anchor.
 */
export const BASE_TOKENS: Token[] = [WBNB, USDT, USDC, BTCB, WETH, TOPAZ]

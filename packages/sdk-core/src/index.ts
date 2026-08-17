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
export const SOL = new Token(TOPAZ_CHAIN_ID, '0x570A5D26f7765Ecb712C0924E4De545B89fD43dF', 18, 'SOL', 'Solana')
export const USD1 = new Token(TOPAZ_CHAIN_ID, '0x8d0D000Ee44948FC98c9B98A4FA4921476f08B0d', 18, 'USD1', 'World Liberty USD1')
export const XRP = new Token(TOPAZ_CHAIN_ID, '0x1D2F0da169ceB9fC7B3144628dB156f3F6c60dBE', 18, 'XRP', 'XRP Token')
export const BOOK = new Token(TOPAZ_CHAIN_ID, '0xC9Ad421f96579AcE066eC188a7Bba472fB83017F', 18, 'BOOK', 'Book of Meme')

/**
 * Tokens the router always considers hopping through, ordered by the Topaz liquidity they anchor.
 *
 * A token earns a place here by connecting pairs, not by being popular: it needs live pools with
 * more than one counterparty, otherwise it can only ever be an endpoint. Tokens outside this list
 * are still reachable — the router adds the counterparties of the deepest pools holding either side
 * of the trade, so a long-tail token is picked up dynamically when it is actually relevant.
 *
 * Adding a token with no Topaz pools is harmless but pointless: it contributes no routes. Widening
 * it beyond these six was measured and returned identical quotes on ten pairs for more RPC calls,
 * because the dynamic discovery above already reached the same pools. SOL, USD1, XRP and BOOK are
 * exported above so a deployment can add them via ROUTING_BASE_TOKENS if that changes.
 */
export const BASE_TOKENS: Token[] = [WBNB, USDT, USDC, WETH, BTCB, TOPAZ]

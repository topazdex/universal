import { Interface } from '@ethersproject/abi'
import { BASE_TOKENS, Token } from '@topaz/sdk-core'

import { TOPAZ_CHAIN_ID } from '../constants'
import { MulticallProvider } from './multicall'

const ERC20_INTERFACE = new Interface([
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function name() view returns (string)'
])

/**
 * Resolves token addresses into SDK tokens.
 *
 * The canonical Topaz tokens are known up front; anything else is read from the chain once and
 * cached, so an unlisted token can still be routed.
 */
export class TokenProvider {
  private readonly cache = new Map<string, Token>()

  public constructor(
    private readonly multicall: MulticallProvider,
    private readonly chainId: number = TOPAZ_CHAIN_ID
  ) {
    for (const token of BASE_TOKENS) {
      this.cache.set(token.address.toLowerCase(), token)
    }
  }

  public async getTokens(addresses: string[]): Promise<Map<string, Token>> {
    const wanted = addresses.map(address => address.toLowerCase())
    const missing = [...new Set(wanted.filter(address => !this.cache.has(address)))]

    if (missing.length > 0) {
      const calls = missing.flatMap(address => [
        { target: address, callData: ERC20_INTERFACE.encodeFunctionData('decimals') },
        { target: address, callData: ERC20_INTERFACE.encodeFunctionData('symbol') }
      ])
      const results = await this.multicall.call(calls)

      for (const [i, address] of missing.entries()) {
        const decimalsResult = results[i * 2]
        const symbolResult = results[i * 2 + 1]
        if (!decimalsResult?.success) continue

        const [decimals] = ERC20_INTERFACE.decodeFunctionResult('decimals', decimalsResult.returnData)
        let symbol: string | undefined
        if (symbolResult?.success) {
          try {
            ;[symbol] = ERC20_INTERFACE.decodeFunctionResult('symbol', symbolResult.returnData)
          } catch {
            // tokens with a bytes32 symbol cannot be decoded as a string; the symbol is cosmetic
          }
        }

        this.cache.set(address, new Token(this.chainId, address, Number(decimals), symbol))
      }
    }

    const resolved = new Map<string, Token>()
    for (const address of wanted) {
      const token = this.cache.get(address)
      if (token) resolved.set(address, token)
    }
    return resolved
  }

  public async getToken(address: string): Promise<Token> {
    const tokens = await this.getTokens([address])
    const token = tokens.get(address.toLowerCase())
    if (!token) throw new Error(`could not resolve token ${address}`)
    return token
  }
}

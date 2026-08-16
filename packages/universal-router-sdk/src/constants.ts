import { BigNumber } from '@ethersproject/bignumber'

export const TOPAZ_CHAIN_ID = 56

/** Canonical Permit2, same address on BNB Chain as everywhere else */
export const PERMIT2_ADDRESS = '0x000000000022D473030F116dDEE9F6B43aC78BA3'

export const WBNB_ADDRESS = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c'

export const ADDRESS_ZERO = '0x0000000000000000000000000000000000000000'

/** Sentinel recipients understood by the router */
export const SENDER_AS_RECIPIENT = '0x0000000000000000000000000000000000000001'
export const ROUTER_AS_RECIPIENT = '0x0000000000000000000000000000000000000002'

/** Tells a command to spend the router's whole balance of the token */
export const CONTRACT_BALANCE = BigNumber.from(2).pow(255)

/** A v2 command reads amountIn == 0 as "the pool was already paid" */
export const ALREADY_PAID = BigNumber.from(0)

export const MAX_UINT256 = BigNumber.from(2).pow(256).sub(1)
export const MAX_UINT160 = BigNumber.from(2).pow(160).sub(1)

/**
 * Deployed Universal Router addresses by chain id. Populated once the router is deployed;
 * until then callers pass the address explicitly, which the fork tests do.
 */
export const UNIVERSAL_ROUTER_ADDRESSES: { [chainId: number]: string } = {}

export function universalRouterAddress(chainId: number, override?: string): string {
  const address = override ?? UNIVERSAL_ROUTER_ADDRESSES[chainId]
  if (!address) {
    throw new Error(`No Universal Router deployment recorded for chain ${chainId}, pass one explicitly`)
  }
  return address
}

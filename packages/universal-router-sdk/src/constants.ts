import { getChainConfig } from '@topazdex/sdk-core'
import { BigNumber } from '@ethersproject/bignumber'

export const TOPAZ_CHAIN_ID = 56

/** Canonical Permit2, same address on BNB Chain as everywhere else */
export const PERMIT2_ADDRESS = '0x000000000022D473030F116dDEE9F6B43aC78BA3'

export const WBNB_ADDRESS = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c'

export const ADDRESS_ZERO = '0x0000000000000000000000000000000000000000'

/** The router reads address(0) as "this is native BNB, not a token" */
export const ETH_ADDRESS = ADDRESS_ZERO

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
 * Deployed Universal Router addresses by chain id.
 *
 * The BNB Chain deployment is checked byte for byte against this repo's source by
 * `DeployedRouterForkTest` in the universal-router package.
 */
export const UNIVERSAL_ROUTER_ADDRESSES: { [chainId: number]: string } = {
  [1]: '0x606794d37991A426a189fD9FA8664D339A77f8ae',
  [TOPAZ_CHAIN_ID]: '0x691e6171e0a434FfE5C9f1759621D05b9efcF6A6',
  [4663]: '0x268d1C8a538Ecf6628838C11d581e1EABD13D6A4',
  [8453]: '0xe4b23F13b24232C1E68AD0575191216152AA9480',
  [5042]: '0x7B1d8745079C85af80Ff7A7eA7C2C4769Eab5348'
}

export function universalRouterAddress(chainId: number, override?: string): string {
  const address = override ?? getChainConfig(chainId).universalRouterAddress
  if (!address) {
    throw new Error(`No Universal Router deployment recorded for chain ${chainId}, pass one explicitly`)
  }
  return address
}

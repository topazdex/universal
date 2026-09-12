import { getCreate2Address } from '@ethersproject/address'
import { keccak256 } from '@ethersproject/keccak256'
import { pack } from '@ethersproject/solidity'
import { getChainConfig, Token } from '@topazdex/sdk-core'


/**
 * ERC-1167 minimal proxy creation code, the form OpenZeppelin's `Clones` deploys.
 * The implementation address is spliced into the middle.
 */
export function cloneInitCodeHash(implementation: string): string {
  return keccak256(
    `0x3d602d80600a3d3981f3363d3d373d3d3d363d73${implementation.slice(2).toLowerCase()}5af43d82803e903d91602b57fd5bf3`
  )
}

export function sortsBefore(tokenA: Token, tokenB: Token): boolean {
  if (tokenA.chainId !== tokenB.chainId) throw new Error('CHAIN_IDS')
  return tokenA.address.toLowerCase() < tokenB.address.toLowerCase()
}

/**
 * Derives a Topaz v2 pool address without touching the chain.
 *
 * `PoolFactory.createPool` clones its `implementation()` with
 * `salt = keccak256(abi.encodePacked(token0, token1, stable))`.
 */
export function computePoolAddress({
  factoryAddress,
  implementationAddress,
  tokenA,
  tokenB,
  stable
}: {
  factoryAddress?: string
  implementationAddress?: string
  tokenA: Token
  tokenB: Token
  stable: boolean
}): string {
  factoryAddress ??= getChainConfig(tokenA.chainId).v2FactoryAddress
  implementationAddress ??= getChainConfig(tokenA.chainId).v2PoolImplementationAddress
  const [token0, token1] = sortsBefore(tokenA, tokenB) ? [tokenA, tokenB] : [tokenB, tokenA]
  const salt = keccak256(pack(['address', 'address', 'bool'], [token0.address, token1.address, stable]))
  return getCreate2Address(factoryAddress, salt, cloneInitCodeHash(implementationAddress))
}

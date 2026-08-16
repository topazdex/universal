import { getCreate2Address } from '@ethersproject/address'
import { keccak256 } from '@ethersproject/keccak256'
import { pack } from '@ethersproject/solidity'
import { Token } from '@uniswap/sdk-core'

import { POOL_FACTORY_ADDRESS, POOL_IMPLEMENTATION_ADDRESS } from '../constants'

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
  return tokenA.address.toLowerCase() < tokenB.address.toLowerCase()
}

/**
 * Derives a Topaz v2 pool address without touching the chain.
 *
 * `PoolFactory.createPool` clones its `implementation()` with
 * `salt = keccak256(abi.encodePacked(token0, token1, stable))`.
 */
export function computePoolAddress({
  factoryAddress = POOL_FACTORY_ADDRESS,
  implementationAddress = POOL_IMPLEMENTATION_ADDRESS,
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
  const [token0, token1] = sortsBefore(tokenA, tokenB) ? [tokenA, tokenB] : [tokenB, tokenA]
  const salt = keccak256(pack(['address', 'address', 'bool'], [token0.address, token1.address, stable]))
  return getCreate2Address(factoryAddress, salt, cloneInitCodeHash(implementationAddress))
}

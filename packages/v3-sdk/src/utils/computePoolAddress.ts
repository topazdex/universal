import { defaultAbiCoder } from '@ethersproject/abi'
import { getCreate2Address } from '@ethersproject/address'
import { keccak256 } from '@ethersproject/keccak256'
import { Token } from '@uniswap/sdk-core'

import { CL_FACTORY_ADDRESS, CL_POOL_IMPLEMENTATION_ADDRESS } from '../constants'

/**
 * ERC-1167 minimal proxy creation code, the form OpenZeppelin's `Clones` deploys.
 */
export function cloneInitCodeHash(implementation: string): string {
  return keccak256(
    `0x3d602d80600a3d3981f3363d3d373d3d3d363d73${implementation.slice(2).toLowerCase()}5af43d82803e903d91602b57fd5bf3`
  )
}

/**
 * Derives a Topaz CL pool address without touching the chain.
 *
 * Unlike Uniswap V3, which CREATE2s full pool bytecode keyed by fee, `CLFactory.createPool`
 * clones its `poolImplementation()` with `salt = keccak256(abi.encode(token0, token1, tickSpacing))`.
 */
export function computePoolAddress({
  factoryAddress = CL_FACTORY_ADDRESS,
  implementationAddress = CL_POOL_IMPLEMENTATION_ADDRESS,
  tokenA,
  tokenB,
  tickSpacing
}: {
  factoryAddress?: string
  implementationAddress?: string
  tokenA: Token
  tokenB: Token
  tickSpacing: number
}): string {
  const [token0, token1] = tokenA.sortsBefore(tokenB) ? [tokenA, tokenB] : [tokenB, tokenA]
  const salt = keccak256(
    defaultAbiCoder.encode(['address', 'address', 'int24'], [token0.address, token1.address, tickSpacing])
  )
  return getCreate2Address(factoryAddress, salt, cloneInitCodeHash(implementationAddress))
}

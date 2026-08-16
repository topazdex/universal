// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/// @notice Minimal interface of the Topaz v2 (Solidly) PoolFactory
/// @dev Only the methods consumed by the Universal Router and its tests are declared here
interface IPoolFactory {
    /// @notice Is a valid pool created by this factory
    function isPool(address pool) external view returns (bool);

    /// @notice Return address of pool created by this factory, or address(0) if it does not exist
    /// @param tokenA .
    /// @param tokenB .
    /// @param stable True if stable, false if volatile
    function getPool(address tokenA, address tokenB, bool stable) external view returns (address);

    /// @notice Returns fee for a pool in basis points scaled by 1e4 (i.e. 30 == 0.30%), custom fees included
    function getFee(address _pool, bool _stable) external view returns (uint256);

    /// @notice True if swaps are globally paused
    function isPaused() external view returns (bool);

    /// @notice The Pool implementation that every pool is an ERC-1167 clone of
    function implementation() external view returns (address);
}

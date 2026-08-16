// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/// @notice Minimal interface of a Topaz v2 (Solidly) Pool
/// @dev Only the methods consumed by the Universal Router and its tests are declared here
interface IPool {
    /// @notice Address of token in the pool with the lower address value
    function token0() external view returns (address);

    /// @notice Address of token in the pool with the higher address value
    function token1() external view returns (address);

    /// @notice True if pool is stable, false if volatile
    function stable() external view returns (bool);

    /// @notice Reserves of token0 and token1, and the timestamp of the last update
    function getReserves() external view returns (uint256 _reserve0, uint256 _reserve1, uint256 _blockTimestampLast);

    /// @notice Get the amount of tokenOut given the amount of tokenIn, fees included
    function getAmountOut(uint256 amountIn, address tokenIn) external view returns (uint256);

    /// @notice This low-level function should be called from a contract which performs important safety checks
    /// @param amount0Out   Amount of token0 to send to `to`
    /// @param amount1Out   Amount of token1 to send to `to`
    /// @param to           Address to receive the swapped output
    /// @param data         Additional calldata for flashloans
    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data) external;
}

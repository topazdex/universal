// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity >=0.5.0;

/// @notice Minimal interface of the Topaz CL (Slipstream) CLFactory
/// @dev Only the methods consumed by the Universal Router and its tests are declared here
interface ICLFactory {
    /// @notice The CLPool implementation that every pool is an ERC-1167 clone of
    function poolImplementation() external view returns (address);

    /// @notice Returns the pool address for a given pair of tokens and a tick spacing, or address(0) if it does not exist
    function getPool(address tokenA, address tokenB, int24 tickSpacing) external view returns (address pool);

    /// @notice Returns the default fee in pips (1e-6) for a tick spacing, 0 if the tick spacing is not enabled
    function tickSpacingToFee(int24 tickSpacing) external view returns (uint24 fee);

    /// @notice Get the current swap fee in pips (1e-6) for a pool, dynamic fee modules included
    function getSwapFee(address pool) external view returns (uint24);
}

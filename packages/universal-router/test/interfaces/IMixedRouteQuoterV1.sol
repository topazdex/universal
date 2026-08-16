// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.17;

/// @notice Minimal interface of the live Topaz MixedRouteQuoterV1
/// @dev In a mixed path the 3 byte pool parameter is either a CL tick spacing, or one of the two
/// v2 bitmasks below. This is the encoding the smart order router must emit for mixed routes.
interface IMixedRouteQuoterV1 {
    /// @dev 1 << 22, marks the hop as a Topaz v2 volatile pool
    function quoteExactInput(bytes memory path, uint256 amountIn)
        external
        returns (
            uint256 amountOut,
            uint160[] memory v3SqrtPriceX96AfterList,
            uint32[] memory v3InitializedTicksCrossedList,
            uint256 v3SwapGasEstimate
        );
}

library MixedRoute {
    /// @dev 1 << 22, marks a hop as a Topaz v2 volatile pool
    uint24 internal constant V2_VOLATILE = 0x400000;
    /// @dev 1 << 21, marks a hop as a Topaz v2 stable pool
    uint24 internal constant V2_STABLE = 0x200000;
}

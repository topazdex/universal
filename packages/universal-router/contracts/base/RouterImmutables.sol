// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.17;

import {IAllowanceTransfer} from 'permit2/src/interfaces/IAllowanceTransfer.sol';
import {IWETH9} from '../interfaces/external/IWETH9.sol';

struct RouterParameters {
    address permit2;
    address weth9;
    address v2Factory;
    address v2Implementation;
    address clFactory;
    address clImplementation;
}

/// @notice A single hop of a Topaz v2 (Solidly) trade
struct Route {
    address from;
    address to;
    bool stable;
}

/// @title Router Immutable Storage contract
/// @notice Used along with the `RouterParameters` struct for ease of cross-chain deployment
contract RouterImmutables {
    /// @dev WETH9 address (WBNB on BNB Chain)
    IWETH9 internal immutable WETH9;

    /// @dev Permit2 address
    IAllowanceTransfer internal immutable PERMIT2;

    /// @dev The address of the Topaz v2 PoolFactory
    address internal immutable TOPAZ_V2_FACTORY;

    /// @dev The address of the Topaz v2 Pool implementation, pools are ERC-1167 clones of it
    address internal immutable TOPAZ_V2_IMPLEMENTATION;

    /// @dev The address of the Topaz CL (v3 / Slipstream) CLFactory
    address internal immutable TOPAZ_CL_FACTORY;

    /// @dev The address of the Topaz CLPool implementation, pools are ERC-1167 clones of it
    address internal immutable TOPAZ_CL_IMPLEMENTATION;

    constructor(RouterParameters memory params) {
        PERMIT2 = IAllowanceTransfer(params.permit2);
        WETH9 = IWETH9(params.weth9);
        TOPAZ_V2_FACTORY = params.v2Factory;
        TOPAZ_V2_IMPLEMENTATION = params.v2Implementation;
        TOPAZ_CL_FACTORY = params.clFactory;
        TOPAZ_CL_IMPLEMENTATION = params.clImplementation;
    }
}

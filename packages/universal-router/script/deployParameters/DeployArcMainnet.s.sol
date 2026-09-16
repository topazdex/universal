// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.17;

import {DeployUniversalRouter} from '../DeployUniversalRouter.s.sol';
import {ArcMainnet} from '../constants/ArcMainnet.sol';

contract DeployArcMainnet is DeployUniversalRouter {
    function setUp() public override {
        require(block.chainid == ArcMainnet.CHAIN_ID, 'Wrong deployment chain');
        params = ArcMainnet.parameters();
        require(params.permit2.code.length > 0 && params.weth9.code.length > 0, 'Missing payment contracts');
        require(
            params.v2Implementation.code.length > 0 && params.clImplementation.code.length > 0,
            'Missing pool implementations'
        );
        // Native USDC in the slot would make every payment of USDC into the router look like a wrap (D48).
        // The stub must answer nothing: a token that reports a balance is not the stub.
        require(params.weth9 != ArcMainnet.USDC, 'WETH9 must not be native USDC');
        (bool answered,) = params.weth9.staticcall(abi.encodeWithSignature('balanceOf(address)', params.permit2));
        require(!answered, 'WETH9 must be the reverting stub');
        outputFilename = 'arc.json';
    }
}

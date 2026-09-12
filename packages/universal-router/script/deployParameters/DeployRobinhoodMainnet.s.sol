// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.17;

import {DeployUniversalRouter} from '../DeployUniversalRouter.s.sol';
import {RobinhoodMainnet} from '../constants/RobinhoodMainnet.sol';

contract DeployRobinhoodMainnet is DeployUniversalRouter {
    function setUp() public override {
        require(block.chainid == RobinhoodMainnet.CHAIN_ID, 'Wrong deployment chain');
        params = RobinhoodMainnet.parameters();
        require(params.permit2.code.length > 0 && params.weth9.code.length > 0, 'Missing payment contracts');
        require(
            params.v2Implementation.code.length > 0 && params.clImplementation.code.length > 0,
            'Missing pool implementations'
        );
        outputFilename = 'robinhood.json';
    }
}

// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.17;

import {DeployUniversalRouter} from '../DeployUniversalRouter.s.sol';
import {RouterParameters} from 'contracts/base/RouterImmutables.sol';
import {BscMainnet} from '../constants/BscMainnet.sol';

contract DeployBscMainnet is DeployUniversalRouter {
    function setUp() public override {
        params = RouterParameters({
            permit2: BscMainnet.PERMIT2,
            weth9: BscMainnet.WBNB,
            v2Factory: BscMainnet.POOL_FACTORY,
            v2Implementation: BscMainnet.POOL_IMPLEMENTATION,
            clFactory: BscMainnet.CL_FACTORY,
            clImplementation: BscMainnet.CL_POOL_IMPLEMENTATION
        });

        outputFilename = 'bsc.json';
    }
}

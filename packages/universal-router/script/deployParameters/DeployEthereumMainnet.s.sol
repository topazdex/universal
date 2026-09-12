// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.17;

import {DeployUniversalRouter} from '../DeployUniversalRouter.s.sol';
import {EthereumMainnet} from '../constants/EthereumMainnet.sol';

contract DeployEthereumMainnet is DeployUniversalRouter {
    function setUp() public override {
        require(block.chainid == EthereumMainnet.CHAIN_ID, 'Wrong deployment chain');
        params = EthereumMainnet.parameters();
        require(params.permit2.code.length > 0 && params.weth9.code.length > 0, 'Missing payment contracts');
        require(
            params.v2Implementation.code.length > 0 && params.clImplementation.code.length > 0,
            'Missing pool implementations'
        );
        outputFilename = 'ethereum.json';
    }
}

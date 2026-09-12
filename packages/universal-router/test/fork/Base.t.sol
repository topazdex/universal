// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.17;

import {RobinhoodForkTest} from './Robinhood.t.sol';
import {RouterParameters} from 'contracts/base/RouterImmutables.sol';
import {BaseMainnet} from 'script/constants/BaseMainnet.sol';

/// @notice Runs the same native, Permit2, v2 and CL swap checks against Base's actual contracts.
contract BaseForkTest is RobinhoodForkTest {
    function parameters() internal pure override returns (RouterParameters memory) {
        return BaseMainnet.parameters();
    }

    function expectedChainId() internal pure override returns (uint256) {
        return 8453;
    }

    function rpcEnvironment() internal pure override returns (string memory) {
        return 'BASE_RPC_URL';
    }

    function routerEnvironment() internal pure override returns (string memory) {
        return 'BASE_UNIVERSAL_ROUTER';
    }

    function artifactFile() internal pure override returns (string memory) {
        return 'deployment-addresses/base-router-artifact.json';
    }
}

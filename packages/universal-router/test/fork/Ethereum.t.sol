// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.17;

import {RobinhoodForkTest} from './Robinhood.t.sol';
import {RouterParameters} from 'contracts/base/RouterImmutables.sol';
import {EthereumMainnet} from 'script/constants/EthereumMainnet.sol';

/// @notice Rehearses swaps on a local Ethereum fork before the execution router is deployed.
contract EthereumForkTest is RobinhoodForkTest {
    function parameters() internal pure override returns (RouterParameters memory) {
        return EthereumMainnet.parameters();
    }

    function expectedChainId() internal pure override returns (uint256) {
        return EthereumMainnet.CHAIN_ID;
    }

    function rpcEnvironment() internal pure override returns (string memory) {
        return 'ETHEREUM_RPC_URL';
    }

    function routerEnvironment() internal pure override returns (string memory) {
        return 'ETHEREUM_UNIVERSAL_ROUTER';
    }

    function artifactFile() internal pure override returns (string memory) {
        return 'deployment-addresses/ethereum-router-artifact.json';
    }

    function routerCreationCode() internal override returns (bytes memory) {
        if (vm.exists(artifactFile())) return super.routerCreationCode();
        return vm.getCode('UniversalRouter.sol:UniversalRouter');
    }
}

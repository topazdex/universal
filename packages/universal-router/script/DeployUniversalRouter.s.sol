// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.17;

import 'forge-std/Script.sol';
import 'forge-std/console2.sol';

import {UniversalRouter} from 'contracts/UniversalRouter.sol';
import {RouterParameters} from 'contracts/base/RouterImmutables.sol';
import {ICLFactory} from 'contracts/interfaces/external/ICLFactory.sol';
import {IPoolFactory} from 'contracts/interfaces/external/IPoolFactory.sol';

abstract contract DeployUniversalRouter is Script {
    error PoolImplementationMismatch(address expected, address actual);
    error CLPoolImplementationMismatch(address expected, address actual);
    error InvalidOutputFilename();

    RouterParameters internal params;
    UniversalRouter public router;
    string public outputFilename;

    /// @dev Sets `params` and `outputFilename`
    function setUp() public virtual;

    function run() external {
        verifyParams();

        uint256 pk = vm.envUint('PRIVATE_KEY');
        vm.startBroadcast(pk);

        router = new UniversalRouter(params);
        console2.log('UniversalRouter deployed:', address(router));

        vm.stopBroadcast();

        writeOutput();
    }

    /// @dev Cross-checks the clone implementations against the live factories, a wrong implementation
    /// silently derives non-existent pool addresses instead of reverting at deploy time
    function verifyParams() public view {
        address v2Implementation = IPoolFactory(params.v2Factory).implementation();
        if (v2Implementation != params.v2Implementation) {
            revert PoolImplementationMismatch(v2Implementation, params.v2Implementation);
        }
        address clImplementation = ICLFactory(params.clFactory).poolImplementation();
        if (clImplementation != params.clImplementation) {
            revert CLPoolImplementationMismatch(clImplementation, params.clImplementation);
        }
    }

    function writeOutput() internal {
        if (bytes(outputFilename).length == 0) revert InvalidOutputFilename();
        string memory path = string.concat(vm.projectRoot(), '/deployment-addresses/', outputFilename);
        vm.writeJson(vm.serializeAddress('router', 'UniversalRouter', address(router)), path);
    }
}

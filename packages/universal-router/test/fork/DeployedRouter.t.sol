// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.17;

import 'forge-std/Test.sol';

import {UniversalRouter} from 'contracts/UniversalRouter.sol';
import {RouterParameters} from 'contracts/base/RouterImmutables.sol';
import {ICLFactory} from 'contracts/interfaces/external/ICLFactory.sol';
import {IPoolFactory} from 'contracts/interfaces/external/IPoolFactory.sol';
import {BscMainnet} from 'script/constants/BscMainnet.sol';

/// @notice Checks a live Universal Router deployment against the source in this repo.
///
/// The router's parameters are immutable and baked into its runtime code, so deploying the current
/// source with the same parameters and comparing code byte for byte proves both that the deployment
/// is this source and that it was given the right factories. Set `DEPLOYED_UNIVERSAL_ROUTER` to
/// point it at a deployment.
contract DeployedRouterForkTest is Test {
    /// @dev A block after the router was deployed to BNB Chain mainnet
    uint256 internal constant DEFAULT_FORK_BLOCK = 116_365_000;

    address internal deployed;

    function setUp() public {
        deployed = vm.envOr('DEPLOYED_UNIVERSAL_ROUTER', address(0));
        if (deployed == address(0)) return;

        uint256 forkBlock = vm.envOr('DEPLOYED_FORK_BLOCK', DEFAULT_FORK_BLOCK);
        vm.createSelectFork(vm.envString('BSC_MAINNET_RPC'), forkBlock);
        assertEq(block.chainid, BscMainnet.CHAIN_ID, 'fork is not BNB Chain mainnet');
    }

    function test_deployedCodeMatchesThisSource() public {
        if (deployed == address(0)) {
            vm.skip(true);
            return;
        }
        assertGt(deployed.code.length, 0, 'nothing deployed at DEPLOYED_UNIVERSAL_ROUTER');

        UniversalRouter fresh = new UniversalRouter(
            RouterParameters({
                permit2: BscMainnet.PERMIT2,
                weth9: BscMainnet.WBNB,
                v2Factory: BscMainnet.POOL_FACTORY,
                v2Implementation: BscMainnet.POOL_IMPLEMENTATION,
                clFactory: BscMainnet.CL_FACTORY,
                clImplementation: BscMainnet.CL_POOL_IMPLEMENTATION
            })
        );

        assertEq(
            keccak256(deployed.code),
            keccak256(address(fresh).code),
            'live router differs from this source, or was deployed with different parameters'
        );
    }

    function test_liveFactoriesStillMatchTheDeployedImmutables() public view {
        if (deployed == address(0)) return;

        assertEq(IPoolFactory(BscMainnet.POOL_FACTORY).implementation(), BscMainnet.POOL_IMPLEMENTATION);
        assertEq(ICLFactory(BscMainnet.CL_FACTORY).poolImplementation(), BscMainnet.CL_POOL_IMPLEMENTATION);
    }
}

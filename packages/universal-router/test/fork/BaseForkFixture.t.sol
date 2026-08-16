// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.17;

import 'forge-std/Test.sol';

import {UniversalRouter} from 'contracts/UniversalRouter.sol';
import {RouterParameters, Route} from 'contracts/base/RouterImmutables.sol';
import {Commands} from 'contracts/libraries/Commands.sol';
import {Constants} from 'contracts/libraries/Constants.sol';
import {ICLFactory} from 'contracts/interfaces/external/ICLFactory.sol';
import {ICLPool} from 'contracts/interfaces/external/ICLPool.sol';
import {IPool} from 'contracts/interfaces/external/IPool.sol';
import {IPoolFactory} from 'contracts/interfaces/external/IPoolFactory.sol';
import {IWETH9} from 'contracts/interfaces/external/IWETH9.sol';
import {IAllowanceTransfer} from 'permit2/src/interfaces/IAllowanceTransfer.sol';
import {ERC20} from 'solmate/src/tokens/ERC20.sol';
import {BscMainnet} from 'script/constants/BscMainnet.sol';

/// @notice Forks BNB Chain mainnet and deploys the Universal Router against the live Topaz Dex contracts
abstract contract BaseForkFixture is Test {
    UniversalRouter public router;

    IPoolFactory public constant poolFactory = IPoolFactory(BscMainnet.POOL_FACTORY);
    ICLFactory public constant clFactory = ICLFactory(BscMainnet.CL_FACTORY);
    IAllowanceTransfer public constant permit2 = IAllowanceTransfer(BscMainnet.PERMIT2);
    IWETH9 public constant weth = IWETH9(BscMainnet.WBNB);

    address public constant WBNB = BscMainnet.WBNB;
    address public constant USDT = BscMainnet.USDT;
    address public constant USDC = BscMainnet.USDC;
    address public constant TOPAZ = BscMainnet.TOPAZ;

    /// @dev Tick spacings of the live CL pools exercised by the tests
    int24 public constant TICK_SPACING_VOLATILE = 50;
    int24 public constant TICK_SPACING_STABLE = 1;

    address public user = makeAddr('user');
    address public recipient = makeAddr('recipient');

    function setUp() public virtual {
        uint256 forkBlock = vm.envOr('FORK_BLOCK', uint256(0));
        if (forkBlock == 0) {
            vm.createSelectFork(vm.envString('BSC_MAINNET_RPC'));
        } else {
            vm.createSelectFork(vm.envString('BSC_MAINNET_RPC'), forkBlock);
        }
        assertEq(block.chainid, BscMainnet.CHAIN_ID, 'fork is not BNB Chain mainnet');

        router = new UniversalRouter(
            RouterParameters({
                permit2: BscMainnet.PERMIT2,
                weth9: BscMainnet.WBNB,
                v2Factory: BscMainnet.POOL_FACTORY,
                v2Implementation: BscMainnet.POOL_IMPLEMENTATION,
                clFactory: BscMainnet.CL_FACTORY,
                clImplementation: BscMainnet.CL_POOL_IMPLEMENTATION
            })
        );
        vm.label(address(router), 'UniversalRouter');
        vm.label(WBNB, 'WBNB');
        vm.label(USDT, 'USDT');
        vm.label(USDC, 'USDC');
        vm.label(TOPAZ, 'TOPAZ');

        vm.deal(user, 1_000 ether);
    }

    /// @dev Routes the user's funds through Permit2, the production flow
    function approveViaPermit2(address token) internal {
        vm.startPrank(user);
        ERC20(token).approve(address(permit2), type(uint256).max);
        permit2.approve(token, address(router), type(uint160).max, type(uint48).max);
        vm.stopPrank();
    }

    /// @dev Approves the router directly, exercising the plain `transferFrom` path
    function approveRouterDirectly(address token) internal {
        vm.prank(user);
        ERC20(token).approve(address(router), type(uint256).max);
    }

    function fundWbnb(address to, uint256 amount) internal {
        vm.deal(to, to.balance + amount);
        vm.prank(to);
        weth.deposit{value: amount}();
    }

    function fund(address token, address to, uint256 amount) internal {
        if (token == WBNB) {
            fundWbnb(to, amount);
        } else {
            deal(token, to, amount, true);
        }
    }

    function execute(bytes memory commands, bytes[] memory inputs) internal {
        vm.prank(user);
        router.execute(commands, inputs, block.timestamp + 1);
    }

    function executeWithValue(bytes memory commands, bytes[] memory inputs, uint256 value) internal {
        vm.prank(user);
        router.execute{value: value}(commands, inputs, block.timestamp + 1);
    }

    function balanceOf(address token, address account) internal view returns (uint256) {
        return ERC20(token).balanceOf(account);
    }

    /// @dev Encodes a Topaz CL path: token, tickSpacing (3 bytes), token, ...
    function clPath(address tokenA, int24 tickSpacing, address tokenB) internal pure returns (bytes memory) {
        return abi.encodePacked(tokenA, uint24(tickSpacing), tokenB);
    }

    function clPath(address tokenA, int24 tickSpacingA, address tokenB, int24 tickSpacingB, address tokenC)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodePacked(tokenA, uint24(tickSpacingA), tokenB, uint24(tickSpacingB), tokenC);
    }

    function singleRoute(address from, address to, bool stable) internal pure returns (Route[] memory routes) {
        routes = new Route[](1);
        routes[0] = Route({from: from, to: to, stable: stable});
    }

    function v2Pool(address tokenA, address tokenB, bool stable) internal view returns (IPool) {
        address pool = poolFactory.getPool(tokenA, tokenB, stable);
        require(pool != address(0), 'v2 pool does not exist at fork block');
        return IPool(pool);
    }

    function clPool(address tokenA, address tokenB, int24 tickSpacing) internal view returns (ICLPool) {
        address pool = clFactory.getPool(tokenA, tokenB, tickSpacing);
        require(pool != address(0), 'CL pool does not exist at fork block');
        return ICLPool(pool);
    }
}

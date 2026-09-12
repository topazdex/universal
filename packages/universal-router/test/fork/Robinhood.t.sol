// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.17;

import 'forge-std/Test.sol';
import {ERC20} from 'solmate/src/tokens/ERC20.sol';
import {IAllowanceTransfer} from 'permit2/src/interfaces/IAllowanceTransfer.sol';
import {UniversalRouter} from 'contracts/UniversalRouter.sol';
import {RouterParameters, Route} from 'contracts/base/RouterImmutables.sol';
import {IPool} from 'contracts/interfaces/external/IPool.sol';
import {IWETH9} from 'contracts/interfaces/external/IWETH9.sol';
import {ICLPool} from 'contracts/interfaces/external/ICLPool.sol';
import {RobinhoodMainnet} from 'script/constants/RobinhoodMainnet.sol';

interface ICreateV2Pool {
    function createPool(address, address, bool) external returns (address);
}

interface ICreateCLPool {
    function createPool(address, address, int24, uint160) external returns (address);
}

interface IMintV2 {
    function mint(address) external returns (uint256);
}

interface IMintCL {
    function mint(address, int24, int24, uint128, bytes calldata) external returns (uint256, uint256);
}

contract RobinhoodTestToken is ERC20 {
    constructor() ERC20('Fork token', 'FORK', 18) {
        _mint(msg.sender, 1_000_000 ether);
    }
}

/// @notice Uses actual Robinhood factories, implementations, wrapped ETH and Permit2.
/// Pools and liquidity are created only inside the fork; nothing is broadcast by these tests.
contract RobinhoodForkTest is Test {
    UniversalRouter private router;
    IWETH9 private weth;
    RobinhoodTestToken private token;
    address private clPool;
    address private v2Pool;
    address private recipient = makeAddr('Robinhood recipient');

    function parameters() internal pure virtual returns (RouterParameters memory) {
        return RobinhoodMainnet.parameters();
    }

    function expectedChainId() internal pure virtual returns (uint256) {
        return 4663;
    }

    function rpcEnvironment() internal pure virtual returns (string memory) {
        return 'ROBINHOOD_RPC_URL';
    }

    function routerEnvironment() internal pure virtual returns (string memory) {
        return 'ROBINHOOD_UNIVERSAL_ROUTER';
    }

    function artifactFile() internal pure virtual returns (string memory) {
        return 'deployment-addresses/robinhood-router-artifact.json';
    }

    function setUp() public {
        string memory rpc = vm.envOr(rpcEnvironment(), string(''));
        if (bytes(rpc).length == 0) vm.skip(true);
        vm.createSelectFork(rpc);
        assertEq(block.chainid, expectedChainId());
        RouterParameters memory params = parameters();
        address deployed = vm.envOr(routerEnvironment(), address(0));
        router = deployed == address(0) ? deployCanonicalRouter() : UniversalRouter(payable(deployed));
        assertGt(address(router).code.length, 0);
        weth = IWETH9(params.weth9);
        token = new RobinhoodTestToken();
        vm.deal(address(this), 1_000 ether);
        weth.deposit{value: 500 ether}();

        v2Pool = ICreateV2Pool(params.v2Factory).createPool(address(weth), address(token), false);
        weth.transfer(v2Pool, 100 ether);
        token.transfer(v2Pool, 100 ether);
        IMintV2(v2Pool).mint(address(this));
        clPool = ICreateCLPool(params.clFactory).createPool(address(weth), address(token), 50, uint160(1 << 96));
        IMintCL(clPool).mint(address(this), -10000, 10000, 100 ether, '');

        token.approve(params.permit2, type(uint256).max);
        weth.approve(params.permit2, type(uint256).max);
        IAllowanceTransfer(params.permit2).approve(address(token), address(router), type(uint160).max, type(uint48).max);
        IAllowanceTransfer(params.permit2).approve(address(weth), address(router), type(uint160).max, type(uint48).max);
    }

    function uniswapV3MintCallback(uint256 amount0, uint256 amount1, bytes calldata) external {
        require(msg.sender == clPool, 'Unexpected callback');
        ERC20(ICLPool(clPool).token0()).transfer(clPool, amount0);
        ERC20(ICLPool(clPool).token1()).transfer(clPool, amount1);
    }

    function test_runtimeMatchesConfiguredDeployment() public {
        UniversalRouter expected = deployCanonicalRouter();
        assertEq(keccak256(address(router).code), keccak256(address(expected).code), 'Runtime or immutables differ');
    }

    function routerCreationCode() internal virtual returns (bytes memory) {
        // Use the archived deployment artifact: via-IR output can vary with the compilation
        // unit. Rebuilding an expanded test suite need not reproduce deployment bytecode.
        return vm.parseJsonBytes(vm.readFile(artifactFile()), '.bytecode.object');
    }

    function deployCanonicalRouter() private returns (UniversalRouter) {
        bytes memory creation = abi.encodePacked(routerCreationCode(), abi.encode(parameters()));
        address fresh;
        assembly {
            fresh := create(0, add(creation, 32), mload(creation))
        }
        require(fresh != address(0), 'Deployment failed');
        return UniversalRouter(payable(fresh));
    }

    function test_nativeV2ExactInput() public {
        uint256 expected = IPool(v2Pool).getAmountOut(1 ether, address(weth));
        Route[] memory path = new Route[](1);
        path[0] = Route(address(weth), address(token), false);
        bytes[] memory inputs = new bytes[](2);
        inputs[0] = abi.encode(address(2), 1 ether);
        inputs[1] = abi.encode(recipient, 1 ether, expected, path, false);
        router.execute{value: 1 ether}(hex'0b08', inputs, block.timestamp);
        assertEq(token.balanceOf(recipient), expected);
        assertEq(weth.balanceOf(address(router)), 0);
    }

    function test_permit2V2ExactOutput() public {
        Route[] memory path = new Route[](1);
        path[0] = Route(address(token), address(weth), false);
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(recipient, 1 ether, 2 ether, path, true);
        uint256 beforeBalance = token.balanceOf(address(this));
        router.execute(hex'09', inputs, block.timestamp);
        // V2 exact output rounds input up and sends the resulting output, which can exceed the target.
        assertGe(weth.balanceOf(recipient), 1 ether);
        assertLe(beforeBalance - token.balanceOf(address(this)), 2 ether);
        assertEq(token.balanceOf(address(router)), 0);
    }

    function test_clExactInputToNative() public {
        bytes[] memory inputs = new bytes[](2);
        inputs[0] =
            abi.encode(address(2), 1 ether, 0, abi.encodePacked(address(token), uint24(50), address(weth)), true);
        inputs[1] = abi.encode(recipient, 0.9 ether);
        router.execute(hex'000c', inputs, block.timestamp);
        assertGt(recipient.balance, 0.9 ether);
        assertEq(weth.balanceOf(address(router)), 0);
    }

    function test_nativeCLExactOutput() public {
        bytes[] memory inputs = new bytes[](3);
        inputs[0] = abi.encode(address(2), 2 ether);
        inputs[1] =
            abi.encode(recipient, 1 ether, 2 ether, abi.encodePacked(address(token), uint24(50), address(weth)), false);
        inputs[2] = abi.encode(address(1), 0);
        router.execute{value: 2 ether}(hex'0b010c', inputs, block.timestamp);
        assertEq(token.balanceOf(recipient), 1 ether);
        assertEq(weth.balanceOf(address(router)), 0);
    }

    receive() external payable {}
}

// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.17;

import 'forge-std/Test.sol';
import {ERC20} from 'solmate/src/tokens/ERC20.sol';
import {IAllowanceTransfer} from 'permit2/src/interfaces/IAllowanceTransfer.sol';
import {UniversalRouter} from 'contracts/UniversalRouter.sol';
import {RouterParameters, Route} from 'contracts/base/RouterImmutables.sol';
import {IPool} from 'contracts/interfaces/external/IPool.sol';
import {ICLPool} from 'contracts/interfaces/external/ICLPool.sol';
import {IUniversalRouter} from 'contracts/interfaces/IUniversalRouter.sol';
import {ArcMainnet} from 'script/constants/ArcMainnet.sol';

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

contract ArcTestToken is ERC20 {
    constructor(string memory symbol, uint8 decimals, uint256 supply) ERC20('Fork token', symbol, decimals) {
        _mint(msg.sender, supply);
    }
}

/// @notice Uses Arc's actual factories, implementations and Permit2. Arc has no wrapped native: the
/// router's WETH9 slot is a reverting stub, so these tests prove the token-only paths work with a
/// six-decimal token and that every native leg reverts instead of losing funds.
/// Native USDC's ERC-20 interface cannot stand in for itself here: its transfer reaches a system
/// precompile (0x1800…0000) the local EVM does not implement, so a plain six-decimal token takes its
/// place. Pools and liquidity are created only inside the fork; nothing is broadcast by these tests.
contract ArcForkTest is Test {
    error UnsupportedProtocolError();
    error ETHNotAccepted();

    uint256 private constant USDC_UNIT = 1e6;

    UniversalRouter private router;
    ArcTestToken private usdc;
    ArcTestToken private token;
    address private clPool;
    address private v2Pool;
    address private recipient = makeAddr('Arc recipient');

    function setUp() public {
        string memory rpc = vm.envOr('ARC_RPC_URL', string(''));
        if (bytes(rpc).length == 0) vm.skip(true);
        vm.createSelectFork(rpc);
        assertEq(block.chainid, ArcMainnet.CHAIN_ID);
        RouterParameters memory params = ArcMainnet.parameters();
        address deployed = vm.envOr('ARC_UNIVERSAL_ROUTER', address(0));
        router = deployed == address(0) ? deployCanonicalRouter() : UniversalRouter(payable(deployed));
        assertGt(address(router).code.length, 0);
        token = new ArcTestToken('FORK', 18, 1_000_000 ether);
        usdc = new ArcTestToken('USDC', 6, 1_000_000 * USDC_UNIT);
        // Native USDC and its ERC-20 interface are one balance on Arc; the router never needs to hold either
        vm.deal(address(this), 1_000 ether);
        assertEq(ERC20(ArcMainnet.USDC).decimals(), 6);
        assertEq(ERC20(ArcMainnet.USDC).balanceOf(address(this)), 1_000 * USDC_UNIT);

        v2Pool = ICreateV2Pool(params.v2Factory).createPool(address(usdc), address(token), false);
        usdc.transfer(v2Pool, 100 * USDC_UNIT);
        token.transfer(v2Pool, 100 ether);
        IMintV2(v2Pool).mint(address(this));
        // 1 USDC (1e6 raw) per 1 FORK (1e18 raw); which side is token0 depends on the fork-time addresses
        uint160 sqrtPrice = address(usdc) < address(token)
            ? uint160(uint256(1e6) << 96)  // token1/token0 = 1e12
            : uint160((uint256(1) << 96) / 1e6); // token1/token0 = 1e-12
        clPool = ICreateCLPool(params.clFactory).createPool(address(usdc), address(token), 50, sqrtPrice);
        (, int24 tick,,,,) = ICLPool(clPool).slot0();
        int24 centre = (tick / 50) * 50;
        IMintCL(clPool).mint(address(this), centre - 10_000, centre + 10_000, 1e14, '');

        token.approve(params.permit2, type(uint256).max);
        usdc.approve(params.permit2, type(uint256).max);
        IAllowanceTransfer(params.permit2).approve(address(token), address(router), type(uint160).max, type(uint48).max);
        IAllowanceTransfer(params.permit2).approve(address(usdc), address(router), type(uint160).max, type(uint48).max);
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

    function test_usdcV2ExactInput() public {
        uint256 amountIn = 10 * USDC_UNIT;
        uint256 expected = IPool(v2Pool).getAmountOut(amountIn, address(usdc));
        Route[] memory path = new Route[](1);
        path[0] = Route(address(usdc), address(token), false);
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(recipient, amountIn, expected, path, true);
        uint256 before = usdc.balanceOf(address(this));
        router.execute(hex'08', inputs, block.timestamp);
        assertEq(token.balanceOf(recipient), expected);
        assertEq(before - usdc.balanceOf(address(this)), amountIn);
        assertEq(usdc.balanceOf(address(router)), 0);
    }

    function test_permit2V2ExactOutputToUsdc() public {
        Route[] memory path = new Route[](1);
        path[0] = Route(address(token), address(usdc), false);
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(recipient, 1 * USDC_UNIT, 2 ether, path, true);
        uint256 beforeBalance = token.balanceOf(address(this));
        router.execute(hex'09', inputs, block.timestamp);
        // V2 exact output rounds input up and sends the resulting output, which can exceed the target.
        assertGe(usdc.balanceOf(recipient), 1 * USDC_UNIT);
        assertLe(beforeBalance - token.balanceOf(address(this)), 2 ether);
        assertEq(token.balanceOf(address(router)), 0);
    }

    function test_clExactInputUsdcToToken() public {
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(
            recipient, 1 * USDC_UNIT, 0.9 ether, abi.encodePacked(address(usdc), uint24(50), address(token)), true
        );
        router.execute(hex'00', inputs, block.timestamp);
        assertGt(token.balanceOf(recipient), 0.9 ether);
        assertEq(usdc.balanceOf(address(router)), 0);
    }

    function test_clExactOutputUsdc() public {
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(
            recipient, 1 * USDC_UNIT, 2 ether, abi.encodePacked(address(usdc), uint24(50), address(token)), true
        );
        router.execute(hex'01', inputs, block.timestamp);
        assertEq(usdc.balanceOf(recipient), 1 * USDC_UNIT);
        assertEq(token.balanceOf(address(router)), 0);
    }

    function test_wrapRevertsAtTheStub() public {
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(address(2), 1 ether);
        // the stub's first opcodes refuse any value with an empty revert, before its typed error
        vm.expectRevert(bytes(''));
        router.execute{value: 1 ether}(hex'0b', inputs, block.timestamp);
    }

    function test_unwrapRevertsAtTheStub() public {
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(recipient, 0);
        vm.expectRevert(UnsupportedProtocolError.selector);
        router.execute(hex'0c', inputs, block.timestamp);
    }

    function test_routerRefusesNativeUsdc() public {
        vm.expectRevert(ETHNotAccepted.selector);
        (bool success,) = payable(address(router)).call{value: 1 ether}('');
        success;
    }

    function routerCreationCode() internal view returns (bytes memory) {
        // Use the archived deployment artifact: via-IR output can vary with the compilation
        // unit. Rebuilding an expanded test suite need not reproduce deployment bytecode.
        return vm.parseJsonBytes(vm.readFile('deployment-addresses/arc-router-artifact.json'), '.bytecode.object');
    }

    function deployCanonicalRouter() private returns (UniversalRouter) {
        bytes memory creation = abi.encodePacked(routerCreationCode(), abi.encode(ArcMainnet.parameters()));
        address fresh;
        assembly {
            fresh := create(0, add(creation, 32), mload(creation))
        }
        require(fresh != address(0), 'Deployment failed');
        return UniversalRouter(payable(fresh));
    }

    receive() external payable {}
}

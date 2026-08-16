// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.17;

import {BaseForkFixture} from './BaseForkFixture.t.sol';
import {Commands} from 'contracts/libraries/Commands.sol';
import {Constants} from 'contracts/libraries/Constants.sol';
import {Route} from 'contracts/base/RouterImmutables.sol';
import {IPool} from 'contracts/interfaces/external/IPool.sol';
import {TopazV2Library} from 'contracts/modules/topaz/v2/TopazV2Library.sol';

/// @notice Swaps routed through the live Topaz v2 (Solidly) pools on BNB Chain mainnet
contract TopazV2ForkTest is BaseForkFixture {
    uint256 constant WBNB_IN = 0.01 ether;
    uint256 constant USDT_IN = 1e18;

    function test_volatileExactInput() public {
        IPool pool = v2Pool(WBNB, USDT, false);
        uint256 expected = pool.getAmountOut(WBNB_IN, WBNB);

        fund(WBNB, user, WBNB_IN);
        approveViaPermit2(WBNB);

        bytes memory commands = abi.encodePacked(bytes1(uint8(Commands.V2_SWAP_EXACT_IN)));
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(recipient, WBNB_IN, expected, singleRoute(WBNB, USDT, false), true);

        execute(commands, inputs);

        assertEq(balanceOf(USDT, recipient), expected, 'router output differs from the pool quote');
        assertEq(balanceOf(WBNB, user), 0);
        assertEq(balanceOf(WBNB, address(router)), 0, 'router retained input');
        assertEq(balanceOf(USDT, address(router)), 0, 'router retained output');
    }

    function test_volatileExactInputRevertsOnSlippage() public {
        IPool pool = v2Pool(WBNB, USDT, false);
        uint256 expected = pool.getAmountOut(WBNB_IN, WBNB);

        fund(WBNB, user, WBNB_IN);
        approveViaPermit2(WBNB);

        bytes memory commands = abi.encodePacked(bytes1(uint8(Commands.V2_SWAP_EXACT_IN)));
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(recipient, WBNB_IN, expected + 1, singleRoute(WBNB, USDT, false), true);

        vm.expectRevert();
        execute(commands, inputs);
    }

    function test_volatileExactOutput() public {
        IPool pool = v2Pool(WBNB, USDT, false);
        uint256 amountOut = pool.getAmountOut(WBNB_IN, WBNB);
        uint256 amountInMax = WBNB_IN * 2;

        fund(WBNB, user, amountInMax);
        approveViaPermit2(WBNB);

        bytes memory commands = abi.encodePacked(bytes1(uint8(Commands.V2_SWAP_EXACT_OUT)));
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(recipient, amountOut, amountInMax, singleRoute(WBNB, USDT, false), true);

        execute(commands, inputs);

        assertGe(balanceOf(USDT, recipient), amountOut, 'received less than requested');
        uint256 spent = amountInMax - balanceOf(WBNB, user);
        assertLe(spent, amountInMax);
        assertApproxEqRel(spent, WBNB_IN, 0.01e18, 'input drifted from the exact-in equivalent');
    }

    function test_volatileExactOutputRevertsOnSlippage() public {
        IPool pool = v2Pool(WBNB, USDT, false);
        uint256 amountOut = pool.getAmountOut(WBNB_IN, WBNB);

        fund(WBNB, user, WBNB_IN * 2);
        approveViaPermit2(WBNB);

        bytes memory commands = abi.encodePacked(bytes1(uint8(Commands.V2_SWAP_EXACT_OUT)));
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(recipient, amountOut, WBNB_IN / 2, singleRoute(WBNB, USDT, false), true);

        vm.expectRevert();
        execute(commands, inputs);
    }

    function test_stableExactInput() public {
        IPool pool = v2Pool(USDT, USDC, true);
        assertTrue(pool.stable());
        uint256 expected = pool.getAmountOut(USDT_IN, USDT);

        fund(USDT, user, USDT_IN);
        approveViaPermit2(USDT);

        bytes memory commands = abi.encodePacked(bytes1(uint8(Commands.V2_SWAP_EXACT_IN)));
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(recipient, USDT_IN, expected, singleRoute(USDT, USDC, true), true);

        execute(commands, inputs);

        assertEq(balanceOf(USDC, recipient), expected, 'stable curve output differs from the pool quote');
    }

    /// @dev The Solidly stable invariant has no closed form inverse, so exact output is not supported,
    /// matching the upstream Velodrome router. The smart order router must never emit this shape.
    function test_stableExactOutputReverts() public {
        fund(USDT, user, USDT_IN * 2);
        approveViaPermit2(USDT);

        bytes memory commands = abi.encodePacked(bytes1(uint8(Commands.V2_SWAP_EXACT_OUT)));
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(recipient, USDT_IN / 2, USDT_IN * 2, singleRoute(USDT, USDC, true), true);

        vm.expectRevert(TopazV2Library.StableExactOutputUnsupported.selector);
        execute(commands, inputs);
    }

    function test_multiHopExactInputStableThenVolatile() public {
        IPool stablePool = v2Pool(USDT, USDC, true);
        IPool volatilePool = v2Pool(WBNB, USDT, false);

        uint256 usdcIn = 1e18;
        uint256 intermediate = stablePool.getAmountOut(usdcIn, USDC);
        uint256 expected = volatilePool.getAmountOut(intermediate, USDT);

        fund(USDC, user, usdcIn);
        approveViaPermit2(USDC);

        Route[] memory routes = new Route[](2);
        routes[0] = Route({from: USDC, to: USDT, stable: true});
        routes[1] = Route({from: USDT, to: WBNB, stable: false});

        bytes memory commands = abi.encodePacked(bytes1(uint8(Commands.V2_SWAP_EXACT_IN)));
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(recipient, usdcIn, expected, routes, true);

        execute(commands, inputs);

        assertEq(balanceOf(WBNB, recipient), expected, 'multi hop output differs from the chained pool quotes');
        assertEq(balanceOf(USDT, address(router)), 0, 'intermediate token stuck in the router');
    }

    function test_exactInputFromNativeBnb() public {
        IPool pool = v2Pool(WBNB, USDT, false);
        uint256 expected = pool.getAmountOut(WBNB_IN, WBNB);

        bytes memory commands =
            abi.encodePacked(bytes1(uint8(Commands.WRAP_ETH)), bytes1(uint8(Commands.V2_SWAP_EXACT_IN)));
        bytes[] memory inputs = new bytes[](2);
        inputs[0] = abi.encode(Constants.ADDRESS_THIS, WBNB_IN);
        inputs[1] = abi.encode(recipient, Constants.CONTRACT_BALANCE, expected, singleRoute(WBNB, USDT, false), false);

        uint256 balanceBefore = user.balance;
        executeWithValue(commands, inputs, WBNB_IN);

        assertEq(balanceOf(USDT, recipient), expected);
        assertEq(user.balance, balanceBefore - WBNB_IN);
    }

    function test_exactInputToNativeBnb() public {
        IPool pool = v2Pool(WBNB, USDT, false);
        uint256 expected = pool.getAmountOut(USDT_IN, USDT);

        fund(USDT, user, USDT_IN);
        approveViaPermit2(USDT);

        bytes memory commands =
            abi.encodePacked(bytes1(uint8(Commands.V2_SWAP_EXACT_IN)), bytes1(uint8(Commands.UNWRAP_WETH)));
        bytes[] memory inputs = new bytes[](2);
        inputs[0] = abi.encode(Constants.ADDRESS_THIS, USDT_IN, expected, singleRoute(USDT, WBNB, false), true);
        inputs[1] = abi.encode(recipient, expected);

        execute(commands, inputs);

        assertEq(recipient.balance, expected, 'native output differs from the pool quote');
        assertEq(balanceOf(WBNB, address(router)), 0);
    }

    function test_exactInputWithoutPermit2() public {
        IPool pool = v2Pool(WBNB, USDT, false);
        uint256 expected = pool.getAmountOut(WBNB_IN, WBNB);

        fund(WBNB, user, WBNB_IN);
        approveRouterDirectly(WBNB);

        bytes memory commands = abi.encodePacked(bytes1(uint8(Commands.V2_SWAP_EXACT_IN)));
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(recipient, WBNB_IN, expected, singleRoute(WBNB, USDT, false), true);

        execute(commands, inputs);

        assertEq(balanceOf(USDT, recipient), expected);
    }
}

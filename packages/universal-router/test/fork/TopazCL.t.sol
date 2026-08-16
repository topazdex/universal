// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.17;

import {BaseForkFixture} from './BaseForkFixture.t.sol';
import {Commands} from 'contracts/libraries/Commands.sol';
import {Constants} from 'contracts/libraries/Constants.sol';
import {ICLPool} from 'contracts/interfaces/external/ICLPool.sol';
import {IQuoterV2} from '../interfaces/IQuoterV2.sol';
import {BscMainnet} from 'script/constants/BscMainnet.sol';

/// @notice Swaps routed through the live Topaz CL (Slipstream) pools on BNB Chain mainnet.
/// Every expected amount comes from Topaz's own deployed QuoterV2, so a passing test means the
/// forked router agrees with the quoting infrastructure the smart order router will use.
contract TopazCLForkTest is BaseForkFixture {
    IQuoterV2 public constant quoter = IQuoterV2(BscMainnet.CL_QUOTER_V2);

    uint256 constant WBNB_IN = 0.1 ether;
    uint256 constant USDT_IN = 100e18;

    function test_exactInputSingle() public {
        (uint256 expected,,,) = quoter.quoteExactInputSingle(
            IQuoterV2.QuoteExactInputSingleParams({
                tokenIn: WBNB,
                tokenOut: USDT,
                amountIn: WBNB_IN,
                tickSpacing: TICK_SPACING_VOLATILE,
                sqrtPriceLimitX96: 0
            })
        );
        assertGt(expected, 0);

        fund(WBNB, user, WBNB_IN);
        approveViaPermit2(WBNB);

        bytes memory commands = abi.encodePacked(bytes1(uint8(Commands.V3_SWAP_EXACT_IN)));
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(recipient, WBNB_IN, expected, clPath(WBNB, TICK_SPACING_VOLATILE, USDT), true);

        execute(commands, inputs);

        assertEq(balanceOf(USDT, recipient), expected, 'router output differs from the QuoterV2 quote');
        assertEq(balanceOf(WBNB, address(router)), 0);
        assertEq(balanceOf(USDT, address(router)), 0);
    }

    function test_exactInputSingleReverseDirection() public {
        (uint256 expected,,,) = quoter.quoteExactInputSingle(
            IQuoterV2.QuoteExactInputSingleParams({
                tokenIn: USDT,
                tokenOut: WBNB,
                amountIn: USDT_IN,
                tickSpacing: TICK_SPACING_VOLATILE,
                sqrtPriceLimitX96: 0
            })
        );

        fund(USDT, user, USDT_IN);
        approveViaPermit2(USDT);

        bytes memory commands = abi.encodePacked(bytes1(uint8(Commands.V3_SWAP_EXACT_IN)));
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(recipient, USDT_IN, expected, clPath(USDT, TICK_SPACING_VOLATILE, WBNB), true);

        execute(commands, inputs);

        assertEq(balanceOf(WBNB, recipient), expected);
    }

    function test_exactInputRevertsOnSlippage() public {
        (uint256 expected,,,) = quoter.quoteExactInputSingle(
            IQuoterV2.QuoteExactInputSingleParams({
                tokenIn: WBNB,
                tokenOut: USDT,
                amountIn: WBNB_IN,
                tickSpacing: TICK_SPACING_VOLATILE,
                sqrtPriceLimitX96: 0
            })
        );

        fund(WBNB, user, WBNB_IN);
        approveViaPermit2(WBNB);

        bytes memory commands = abi.encodePacked(bytes1(uint8(Commands.V3_SWAP_EXACT_IN)));
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(recipient, WBNB_IN, expected + 1, clPath(WBNB, TICK_SPACING_VOLATILE, USDT), true);

        vm.expectRevert();
        execute(commands, inputs);
    }

    function test_exactOutputSingle() public {
        uint256 amountOut = 50e18; // USDT
        (uint256 expectedIn,,,) = quoter.quoteExactOutputSingle(
            IQuoterV2.QuoteExactOutputSingleParams({
                tokenIn: WBNB,
                tokenOut: USDT,
                amount: amountOut,
                tickSpacing: TICK_SPACING_VOLATILE,
                sqrtPriceLimitX96: 0
            })
        );
        assertGt(expectedIn, 0);

        uint256 amountInMax = expectedIn * 2;
        fund(WBNB, user, amountInMax);
        approveViaPermit2(WBNB);

        // exact output paths are encoded in reverse: tokenOut ... tokenIn
        bytes memory commands = abi.encodePacked(bytes1(uint8(Commands.V3_SWAP_EXACT_OUT)));
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(recipient, amountOut, amountInMax, clPath(USDT, TICK_SPACING_VOLATILE, WBNB), true);

        execute(commands, inputs);

        assertEq(balanceOf(USDT, recipient), amountOut, 'exact output amount not honoured');
        assertEq(amountInMax - balanceOf(WBNB, user), expectedIn, 'input differs from the QuoterV2 quote');
    }

    function test_exactOutputRevertsOnSlippage() public {
        uint256 amountOut = 50e18;
        (uint256 expectedIn,,,) = quoter.quoteExactOutputSingle(
            IQuoterV2.QuoteExactOutputSingleParams({
                tokenIn: WBNB,
                tokenOut: USDT,
                amount: amountOut,
                tickSpacing: TICK_SPACING_VOLATILE,
                sqrtPriceLimitX96: 0
            })
        );

        fund(WBNB, user, expectedIn * 2);
        approveViaPermit2(WBNB);

        bytes memory commands = abi.encodePacked(bytes1(uint8(Commands.V3_SWAP_EXACT_OUT)));
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(recipient, amountOut, expectedIn - 1, clPath(USDT, TICK_SPACING_VOLATILE, WBNB), true);

        vm.expectRevert();
        execute(commands, inputs);
    }

    function test_multiHopExactInput() public {
        bytes memory path = clPath(WBNB, TICK_SPACING_VOLATILE, USDT, TICK_SPACING_STABLE, USDC);
        (uint256 expected,,,) = quoter.quoteExactInput(path, WBNB_IN);
        assertGt(expected, 0);

        fund(WBNB, user, WBNB_IN);
        approveViaPermit2(WBNB);

        bytes memory commands = abi.encodePacked(bytes1(uint8(Commands.V3_SWAP_EXACT_IN)));
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(recipient, WBNB_IN, expected, path, true);

        execute(commands, inputs);

        assertEq(balanceOf(USDC, recipient), expected, 'multi hop output differs from the QuoterV2 quote');
        assertEq(balanceOf(USDT, address(router)), 0, 'intermediate token stuck in the router');
    }

    function test_multiHopExactOutput() public {
        uint256 amountOut = 50e18; // USDC
        bytes memory reversePath = clPath(USDC, TICK_SPACING_STABLE, USDT, TICK_SPACING_VOLATILE, WBNB);
        (uint256 expectedIn,,,) = quoter.quoteExactOutput(reversePath, amountOut);
        assertGt(expectedIn, 0);

        uint256 amountInMax = expectedIn * 2;
        fund(WBNB, user, amountInMax);
        approveViaPermit2(WBNB);

        bytes memory commands = abi.encodePacked(bytes1(uint8(Commands.V3_SWAP_EXACT_OUT)));
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(recipient, amountOut, amountInMax, reversePath, true);

        execute(commands, inputs);

        assertEq(balanceOf(USDC, recipient), amountOut);
        assertEq(amountInMax - balanceOf(WBNB, user), expectedIn, 'input differs from the QuoterV2 quote');
        assertEq(balanceOf(USDT, address(router)), 0);
    }

    function test_exactInputFromNativeBnb() public {
        (uint256 expected,,,) = quoter.quoteExactInputSingle(
            IQuoterV2.QuoteExactInputSingleParams({
                tokenIn: WBNB,
                tokenOut: USDT,
                amountIn: WBNB_IN,
                tickSpacing: TICK_SPACING_VOLATILE,
                sqrtPriceLimitX96: 0
            })
        );

        bytes memory commands =
            abi.encodePacked(bytes1(uint8(Commands.WRAP_ETH)), bytes1(uint8(Commands.V3_SWAP_EXACT_IN)));
        bytes[] memory inputs = new bytes[](2);
        inputs[0] = abi.encode(Constants.ADDRESS_THIS, WBNB_IN);
        inputs[1] =
            abi.encode(recipient, Constants.CONTRACT_BALANCE, expected, clPath(WBNB, TICK_SPACING_VOLATILE, USDT), false);

        executeWithValue(commands, inputs, WBNB_IN);

        assertEq(balanceOf(USDT, recipient), expected);
    }

    function test_exactInputToNativeBnb() public {
        (uint256 expected,,,) = quoter.quoteExactInputSingle(
            IQuoterV2.QuoteExactInputSingleParams({
                tokenIn: USDT,
                tokenOut: WBNB,
                amountIn: USDT_IN,
                tickSpacing: TICK_SPACING_VOLATILE,
                sqrtPriceLimitX96: 0
            })
        );

        fund(USDT, user, USDT_IN);
        approveViaPermit2(USDT);

        bytes memory commands =
            abi.encodePacked(bytes1(uint8(Commands.V3_SWAP_EXACT_IN)), bytes1(uint8(Commands.UNWRAP_WETH)));
        bytes[] memory inputs = new bytes[](2);
        inputs[0] =
            abi.encode(Constants.ADDRESS_THIS, USDT_IN, expected, clPath(USDT, TICK_SPACING_VOLATILE, WBNB), true);
        inputs[1] = abi.encode(recipient, expected);

        execute(commands, inputs);

        assertEq(recipient.balance, expected, 'native output differs from the QuoterV2 quote');
    }

    function test_exactInputWithoutPermit2() public {
        (uint256 expected,,,) = quoter.quoteExactInputSingle(
            IQuoterV2.QuoteExactInputSingleParams({
                tokenIn: WBNB,
                tokenOut: USDT,
                amountIn: WBNB_IN,
                tickSpacing: TICK_SPACING_VOLATILE,
                sqrtPriceLimitX96: 0
            })
        );

        fund(WBNB, user, WBNB_IN);
        approveRouterDirectly(WBNB);

        bytes memory commands = abi.encodePacked(bytes1(uint8(Commands.V3_SWAP_EXACT_IN)));
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(recipient, WBNB_IN, expected, clPath(WBNB, TICK_SPACING_VOLATILE, USDT), true);

        execute(commands, inputs);

        assertEq(balanceOf(USDT, recipient), expected);
    }

    /// @dev A swap callback may only be delivered by a pool the router itself derived
    function test_callbackRejectsUnknownCaller() public {
        bytes memory data = abi.encode(clPath(WBNB, TICK_SPACING_VOLATILE, USDT), user);
        vm.expectRevert();
        vm.prank(makeAddr('notAPool'));
        router.uniswapV3SwapCallback(1, -1, data);
    }
}

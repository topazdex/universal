// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.17;

import {BaseForkFixture} from './BaseForkFixture.t.sol';
import {Commands} from 'contracts/libraries/Commands.sol';
import {Constants} from 'contracts/libraries/Constants.sol';
import {IPool} from 'contracts/interfaces/external/IPool.sol';
import {IQuoterV2} from '../interfaces/IQuoterV2.sol';
import {IMixedRouteQuoterV1, MixedRoute} from '../interfaces/IMixedRouteQuoterV1.sol';
import {BscMainnet} from 'script/constants/BscMainnet.sol';

/// @notice Routes that cross Topaz CL and Topaz v2 pools inside a single transaction, cross checked
/// against Topaz's deployed MixedRouteQuoterV1 — the quoter the smart order router will price with.
contract TopazMixedForkTest is BaseForkFixture {
    IQuoterV2 public constant quoter = IQuoterV2(BscMainnet.CL_QUOTER_V2);
    IMixedRouteQuoterV1 public constant mixedQuoter = IMixedRouteQuoterV1(BscMainnet.CL_MIXED_ROUTE_QUOTER_V1);

    uint256 constant WBNB_IN = 0.05 ether;

    function test_clThenV2StableExactInput() public {
        bytes memory mixedPath =
            abi.encodePacked(WBNB, uint24(TICK_SPACING_VOLATILE), USDT, MixedRoute.V2_STABLE, USDC);
        (uint256 expected,,,) = mixedQuoter.quoteExactInput(mixedPath, WBNB_IN);
        assertGt(expected, 0);

        fund(WBNB, user, WBNB_IN);
        approveViaPermit2(WBNB);

        bytes memory commands =
            abi.encodePacked(bytes1(uint8(Commands.V3_SWAP_EXACT_IN)), bytes1(uint8(Commands.V2_SWAP_EXACT_IN)));
        bytes[] memory inputs = new bytes[](2);
        inputs[0] = abi.encode(Constants.ADDRESS_THIS, WBNB_IN, 0, clPath(WBNB, TICK_SPACING_VOLATILE, USDT), true);
        inputs[1] =
            abi.encode(recipient, Constants.CONTRACT_BALANCE, expected, singleRoute(USDT, USDC, true), false);

        execute(commands, inputs);

        assertEq(balanceOf(USDC, recipient), expected, 'mixed CL->v2 output differs from MixedRouteQuoterV1');
        assertEq(balanceOf(USDT, address(router)), 0, 'intermediate token stuck in the router');
    }

    function test_v2StableThenClExactInput() public {
        uint256 usdcIn = 10e18;
        bytes memory mixedPath =
            abi.encodePacked(USDC, MixedRoute.V2_STABLE, USDT, uint24(TICK_SPACING_VOLATILE), WBNB);
        (uint256 expected,,,) = mixedQuoter.quoteExactInput(mixedPath, usdcIn);
        assertGt(expected, 0);

        fund(USDC, user, usdcIn);
        approveViaPermit2(USDC);

        bytes memory commands =
            abi.encodePacked(bytes1(uint8(Commands.V2_SWAP_EXACT_IN)), bytes1(uint8(Commands.V3_SWAP_EXACT_IN)));
        bytes[] memory inputs = new bytes[](2);
        inputs[0] = abi.encode(Constants.ADDRESS_THIS, usdcIn, 0, singleRoute(USDC, USDT, true), true);
        inputs[1] = abi.encode(
            recipient, Constants.CONTRACT_BALANCE, expected, clPath(USDT, TICK_SPACING_VOLATILE, WBNB), false
        );

        execute(commands, inputs);

        assertEq(balanceOf(WBNB, recipient), expected, 'mixed v2->CL output differs from MixedRouteQuoterV1');
        assertEq(balanceOf(USDT, address(router)), 0);
    }

    function test_v2VolatileThenClMixedQuoterAgreement() public {
        uint256 amountIn = 0.005 ether;
        bytes memory mixedPath = abi.encodePacked(WBNB, MixedRoute.V2_VOLATILE, USDT, uint24(TICK_SPACING_STABLE), USDC);
        (uint256 expected,,,) = mixedQuoter.quoteExactInput(mixedPath, amountIn);
        assertGt(expected, 0);

        fund(WBNB, user, amountIn);
        approveViaPermit2(WBNB);

        bytes memory commands =
            abi.encodePacked(bytes1(uint8(Commands.V2_SWAP_EXACT_IN)), bytes1(uint8(Commands.V3_SWAP_EXACT_IN)));
        bytes[] memory inputs = new bytes[](2);
        inputs[0] = abi.encode(Constants.ADDRESS_THIS, amountIn, 0, singleRoute(WBNB, USDT, false), true);
        inputs[1] =
            abi.encode(recipient, Constants.CONTRACT_BALANCE, expected, clPath(USDT, TICK_SPACING_STABLE, USDC), false);

        execute(commands, inputs);

        assertEq(balanceOf(USDC, recipient), expected, 'mixed v2->CL output differs from MixedRouteQuoterV1');
    }

    /// @notice The shape the smart order router emits when it splits a trade across both stacks
    function test_splitRouteAcrossClAndV2() public {
        uint256 clAmount = 0.05 ether;
        uint256 v2Amount = 0.005 ether;

        (uint256 clExpected,,,) = quoter.quoteExactInputSingle(
            IQuoterV2.QuoteExactInputSingleParams({
                tokenIn: WBNB,
                tokenOut: USDT,
                amountIn: clAmount,
                tickSpacing: TICK_SPACING_VOLATILE,
                sqrtPriceLimitX96: 0
            })
        );
        uint256 v2Expected = v2Pool(WBNB, USDT, false).getAmountOut(v2Amount, WBNB);

        fund(WBNB, user, clAmount + v2Amount);
        approveViaPermit2(WBNB);

        bytes memory commands =
            abi.encodePacked(bytes1(uint8(Commands.V3_SWAP_EXACT_IN)), bytes1(uint8(Commands.V2_SWAP_EXACT_IN)));
        bytes[] memory inputs = new bytes[](2);
        inputs[0] = abi.encode(recipient, clAmount, clExpected, clPath(WBNB, TICK_SPACING_VOLATILE, USDT), true);
        inputs[1] = abi.encode(recipient, v2Amount, v2Expected, singleRoute(WBNB, USDT, false), true);

        execute(commands, inputs);

        assertEq(balanceOf(USDT, recipient), clExpected + v2Expected, 'split route output mismatch');
        assertEq(balanceOf(WBNB, user), 0);
    }

    /// @notice Interface fee flow: swap into the router, pay a portion to the fee collector, sweep the rest
    function test_payPortionThenSweep() public {
        address feeCollector = makeAddr('feeCollector');
        uint256 feeBips = 25; // 0.25%

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

        bytes memory commands = abi.encodePacked(
            bytes1(uint8(Commands.V3_SWAP_EXACT_IN)),
            bytes1(uint8(Commands.PAY_PORTION)),
            bytes1(uint8(Commands.SWEEP))
        );
        bytes[] memory inputs = new bytes[](3);
        inputs[0] = abi.encode(Constants.ADDRESS_THIS, WBNB_IN, expected, clPath(WBNB, TICK_SPACING_VOLATILE, USDT), true);
        inputs[1] = abi.encode(USDT, feeCollector, feeBips);
        inputs[2] = abi.encode(USDT, recipient, 0);

        execute(commands, inputs);

        uint256 fee = (expected * feeBips) / 10_000;
        assertEq(balanceOf(USDT, feeCollector), fee, 'fee portion mismatch');
        assertEq(balanceOf(USDT, recipient), expected - fee, 'swept remainder mismatch');
        assertEq(balanceOf(USDT, address(router)), 0);
    }
}

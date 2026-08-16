// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.17;

import {BaseForkFixture} from './BaseForkFixture.t.sol';
import {Commands} from 'contracts/libraries/Commands.sol';
import {Constants} from 'contracts/libraries/Constants.sol';
import {Dispatcher} from 'contracts/base/Dispatcher.sol';
import {IUniversalRouter} from 'contracts/interfaces/IUniversalRouter.sol';

/// @notice Router level behaviour that is independent of which Topaz stack a swap touches
contract UniversalRouterForkTest is BaseForkFixture {
    function test_revertsAfterDeadline() public {
        bytes memory commands = abi.encodePacked(bytes1(uint8(Commands.WRAP_ETH)));
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(Constants.ADDRESS_THIS, 0);

        vm.expectRevert(IUniversalRouter.TransactionDeadlinePassed.selector);
        vm.prank(user);
        router.execute(commands, inputs, block.timestamp - 1);
    }

    function test_revertsOnLengthMismatch() public {
        bytes memory commands = abi.encodePacked(bytes1(uint8(Commands.WRAP_ETH)));
        bytes[] memory inputs = new bytes[](0);

        vm.expectRevert(IUniversalRouter.LengthMismatch.selector);
        execute(commands, inputs);
    }

    function test_revertsOnUnsupportedCommand() public {
        // 0x10 is a Seaport command upstream, unsupported on Topaz
        bytes memory commands = abi.encodePacked(bytes1(uint8(0x10)));
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = bytes('');

        vm.expectRevert(abi.encodeWithSelector(Dispatcher.InvalidCommandType.selector, 0x10));
        execute(commands, inputs);
    }

    function test_allowRevertFlagSwallowsFailure() public {
        // BALANCE_CHECK_ERC20 against an impossible balance fails, the flag lets execution continue
        bytes memory commands =
            abi.encodePacked(bytes1(uint8(Commands.BALANCE_CHECK_ERC20)) | Commands.FLAG_ALLOW_REVERT);
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(user, USDT, type(uint256).max);

        execute(commands, inputs);
    }

    function test_balanceCheckRevertsWithoutFlag() public {
        bytes memory commands = abi.encodePacked(bytes1(uint8(Commands.BALANCE_CHECK_ERC20)));
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(user, USDT, type(uint256).max);

        vm.expectRevert();
        execute(commands, inputs);
    }

    function test_rejectsDirectEthTransfers() public {
        vm.prank(user);
        (bool success,) = address(router).call{value: 1 ether}('');
        assertFalse(success, 'router accepted a bare ETH transfer');
    }

    function test_wrapAndUnwrapReturnsNativeBnb() public {
        uint256 amount = 1 ether;
        bytes memory commands =
            abi.encodePacked(bytes1(uint8(Commands.WRAP_ETH)), bytes1(uint8(Commands.UNWRAP_WETH)));
        bytes[] memory inputs = new bytes[](2);
        inputs[0] = abi.encode(Constants.ADDRESS_THIS, amount);
        inputs[1] = abi.encode(recipient, amount);

        executeWithValue(commands, inputs, amount);

        assertEq(recipient.balance, amount);
        assertEq(balanceOf(WBNB, address(router)), 0);
    }

    function test_subPlanExecutesNestedCommands() public {
        uint256 amount = 1 ether;

        bytes memory subCommands =
            abi.encodePacked(bytes1(uint8(Commands.WRAP_ETH)), bytes1(uint8(Commands.UNWRAP_WETH)));
        bytes[] memory subInputs = new bytes[](2);
        subInputs[0] = abi.encode(Constants.ADDRESS_THIS, amount);
        subInputs[1] = abi.encode(recipient, amount);

        bytes memory commands = abi.encodePacked(bytes1(uint8(Commands.EXECUTE_SUB_PLAN)));
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(subCommands, subInputs);

        executeWithValue(commands, inputs, amount);

        assertEq(recipient.balance, amount);
    }

    function test_transferFromPullsWithPermit2() public {
        uint256 amount = 5e18;
        fund(USDT, user, amount);
        approveViaPermit2(USDT);

        bytes memory commands = abi.encodePacked(bytes1(uint8(Commands.TRANSFER_FROM)));
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(USDT, recipient, amount);

        execute(commands, inputs);

        assertEq(balanceOf(USDT, recipient), amount);
        assertEq(balanceOf(USDT, user), 0);
    }
}

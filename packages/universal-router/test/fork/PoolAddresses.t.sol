// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.17;

import {BaseForkFixture} from './BaseForkFixture.t.sol';
import {Clones} from '@openzeppelin/contracts/proxy/Clones.sol';
import {BscMainnet} from 'script/constants/BscMainnet.sol';

/// @notice The router derives pool addresses off-chain style, from the factory + clone implementation.
/// If either immutable is wrong every swap reverts with a nonsensical error, so pin them down directly.
contract PoolAddressesForkTest is BaseForkFixture {
    function test_v2ImplementationMatchesLiveFactory() public view {
        assertEq(poolFactory.implementation(), BscMainnet.POOL_IMPLEMENTATION);
    }

    function test_clImplementationMatchesLiveFactory() public view {
        assertEq(clFactory.poolImplementation(), BscMainnet.CL_POOL_IMPLEMENTATION);
    }

    function test_derivedV2VolatilePoolMatchesFactory() public view {
        assertEq(derivedV2Pool(WBNB, USDT, false), address(v2Pool(WBNB, USDT, false)));
    }

    function test_derivedV2StablePoolMatchesFactory() public view {
        assertEq(derivedV2Pool(USDT, USDC, true), address(v2Pool(USDT, USDC, true)));
    }

    function test_derivedClVolatilePoolMatchesFactory() public view {
        assertEq(
            derivedClPool(WBNB, USDT, TICK_SPACING_VOLATILE), address(clPool(WBNB, USDT, TICK_SPACING_VOLATILE))
        );
    }

    function test_derivedClStablePoolMatchesFactory() public view {
        assertEq(derivedClPool(USDT, USDC, TICK_SPACING_STABLE), address(clPool(USDT, USDC, TICK_SPACING_STABLE)));
    }

    function derivedV2Pool(address tokenA, address tokenB, bool stable) internal pure returns (address) {
        (address token0, address token1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        return Clones.predictDeterministicAddress({
            implementation: BscMainnet.POOL_IMPLEMENTATION,
            salt: keccak256(abi.encodePacked(token0, token1, stable)),
            deployer: BscMainnet.POOL_FACTORY
        });
    }

    function derivedClPool(address tokenA, address tokenB, int24 tickSpacing) internal pure returns (address) {
        (address token0, address token1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        return Clones.predictDeterministicAddress({
            implementation: BscMainnet.CL_POOL_IMPLEMENTATION,
            salt: keccak256(abi.encode(token0, token1, tickSpacing)),
            deployer: BscMainnet.CL_FACTORY
        });
    }
}

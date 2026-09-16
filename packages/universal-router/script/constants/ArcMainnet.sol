// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.17;

import {RouterParameters} from 'contracts/base/RouterImmutables.sol';

/// @dev Imported from topaz-multichain deployments/arc; factory links checked on chain before deployment.
/// Arc has no wrapped USDC (D48). The WETH9 slot holds the reverting stub Uniswap's Arc periphery uses,
/// the same address the Topaz quoters and routers there were deployed with, so every native leg reverts
/// with UnsupportedProtocolError() instead of wrapping. Pools trade native USDC's 6-decimal ERC-20 interface.
library ArcMainnet {
    uint256 internal constant CHAIN_ID = 5042;
    address internal constant WETH_STUB = 0x8bcEaA40B9AcdfAedF85AdF4FF01F5Ad6517937f;
    address internal constant USDC = 0x3600000000000000000000000000000000000000;
    address internal constant XTOPAZ = 0x1aA89C4Ab9884Cb65B759A3Cc3A1690744d687a6;

    function parameters() internal pure returns (RouterParameters memory) {
        return RouterParameters({
            permit2: 0x000000000022D473030F116dDEE9F6B43aC78BA3,
            weth9: WETH_STUB,
            v2Factory: 0x1E3aC31cF96b20619c913384C9bf6010A824fB95,
            v2Implementation: 0x8776BE6cd50BB78414c655bc8bF9e86A0989722F,
            clFactory: 0xaa5865dC3A60b25D305226d66fd573021f0D8fFB,
            clImplementation: 0x2DaA7cF731334b4Cd1c2E4E01E97Ca67F4B9C6AE
        });
    }
}

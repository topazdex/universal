// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.17;

import {RouterParameters} from 'contracts/base/RouterImmutables.sol';

/// @dev Imported from xTopaz Ethereum deployment records; verify factory links before deployment.
library EthereumMainnet {
    uint256 internal constant CHAIN_ID = 1;
    address internal constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;

    function parameters() internal pure returns (RouterParameters memory) {
        return RouterParameters({
            permit2: 0x000000000022D473030F116dDEE9F6B43aC78BA3,
            weth9: WETH,
            v2Factory: 0x1E3aC31cF96b20619c913384C9bf6010A824fB95,
            v2Implementation: 0x8776BE6cd50BB78414c655bc8bF9e86A0989722F,
            clFactory: 0xaa5865dC3A60b25D305226d66fd573021f0D8fFB,
            clImplementation: 0x2DaA7cF731334b4Cd1c2E4E01E97Ca67F4B9C6AE
        });
    }
}

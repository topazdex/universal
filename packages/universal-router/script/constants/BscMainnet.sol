// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.17;

/// @notice Canonical BNB Chain mainnet (chain id 56) addresses of the Topaz Dex deployment
/// @dev Single source of truth shared by the deploy scripts and the fork tests
library BscMainnet {
    uint256 internal constant CHAIN_ID = 56;

    // Infrastructure
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address internal constant WBNB = 0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c;

    // Topaz v2 (Solidly volatile & stable pools)
    address internal constant POOL_FACTORY = 0x65E6cD0eF5D3467030103cf3d433034E570b5784;
    address internal constant POOL_IMPLEMENTATION = 0xdC942D8e37cC20BCf9aD1Fe0111eE6c5908f3678;
    address internal constant ROUTER_V2 = 0x1E98c8226e7d452e1888e3d3d2F929346321c6c3;

    // Topaz CL (v3 / Slipstream concentrated liquidity)
    address internal constant CL_FACTORY = 0x73DC984D9490286E735548f61dfCCec67Af82ed9;
    address internal constant CL_POOL_IMPLEMENTATION = 0x18e68051d1b1fB44cb539cA4436F112D28577AF7;
    address internal constant CL_SWAP_ROUTER = 0x9B63CA87919617d042A89663492dB3c8686e0CaE;
    address internal constant CL_QUOTER_V2 = 0x7CCB89bB9BdEF68688F39a2c22d249fD1D9759f1;
    address internal constant CL_MIXED_ROUTE_QUOTER_V1 = 0x47c3570b90e7234FE695Ad5F1bE69E21fe1a9ee2;
    address internal constant CL_POSITION_MANAGER = 0xf8c30c3C362941C23025f2eA30B066A73C982f63;

    // Tokens
    address internal constant TOPAZ = 0xdf002282C1474C9592780618Adda7EaA99998Abd;
    address internal constant USDT = 0x55d398326f99059fF775485246999027B3197955;
    address internal constant USDC = 0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d;
    address internal constant BTCB = 0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c;
    address internal constant ETH = 0x2170Ed0880ac9A755fd29B2688956BD959F933F8;
}

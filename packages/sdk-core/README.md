# @topaz/sdk-core

Shared currency primitives for the Topaz stack.

This package re-exports `@uniswap/sdk-core` rather than forking it: `Token`, `CurrencyAmount`,
`Fraction`, `Percent` and `TradeType` are chain agnostic, and keeping one copy means a `Token`
built in one package compares equal to the same token built in another.

What it adds is what upstream lacks for this chain:

```ts
import { BNB, nativeOnChain, WBNB, USDT, USDC, BASE_TOKENS, TOPAZ_CHAIN_ID } from '@topaz/sdk-core'

nativeOnChain()        // BNB, whose .wrapped is WBNB
BASE_TOKENS            // routing hubs, ordered by the Topaz liquidity they anchor
```

`@uniswap/sdk-core` ships `Ether` and a wrapped-native table but no BNB native currency, so `BNB`
is defined here and every downstream package imports it from this one.

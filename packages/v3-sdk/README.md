# @topaz/v3-sdk

Topaz CL pools — Slipstream concentrated liquidity. Forked from `@uniswap/v3-sdk`; the tick, swap
and price math is upstream's, the pool identity is Topaz's.

## What changed from `@uniswap/v3-sdk`

| | Uniswap V3 | Topaz CL |
| --- | --- | --- |
| pool key | `(token0, token1, fee)` | `(token0, token1, tickSpacing)` |
| tick spacing | derived from the fee tier | the key itself |
| swap fee | fixed by the fee tier | a mutable pool property, set by the factory's fee module |
| address | CREATE2 over pool init code | ERC-1167 clone of `CLFactory.poolImplementation()` |
| path encoding | `token ‖ fee(3) ‖ token` | `token ‖ tickSpacing(3) ‖ token` |

So a `Pool` takes both a fee and a tick spacing, and `Pool.getAddress` needs no init code hash:

```ts
import { Pool, TickSpacing } from '@topaz/v3-sdk'

const pool = new Pool(WBNB, USDT, /* fee, pips */ 500, TickSpacing.LOW, sqrtPriceX96, liquidity, tick)
Pool.getAddress(WBNB, USDT, TickSpacing.LOW)
```

Default fee per tick spacing is `1→100`, `50→500`, `100→1000`, `200→3000`, `2000→10000`, but a pool's
live fee comes from `CLFactory.getSwapFee(pool)` and can differ — read it rather than assume it.

`SwapQuoter` builds calldata for Topaz's deployed `QuoterV2`, whose single-hop entrypoints take a
tick spacing where Uniswap's take a fee.

Position management (`NonfungiblePositionManager`, `Position`, staker) is deliberately not ported:
this package exists to serve routing.

## Tests

`src/mainnet.test.ts` checks derived addresses against `CLFactory.getPool` and runs the SDK's quoter
calldata against the live `QuoterV2`, including the multi-hop path encoding.

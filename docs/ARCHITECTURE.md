# Architecture

## Goal

Index Topaz CL and Topaz v2 liquidity, search for the best route across both, and execute it through
a single Universal Router transaction — the Uniswap routing stack, retargeted at Topaz on BNB Chain.

```
routing-api  ──►  smart-order-router  ──►  router-sdk ─┬─ v2-sdk  (Solidly pools)
     │                    │                            ├─ v3-sdk  (Slipstream CL pools)
     │                    │                            └─ sdk-core
     │                    └─ subgraphs (discovery) + QuoterV2 / MixedRouteQuoterV1 (pricing)
     ▼
universal-router-sdk  ──►  UniversalRouter  ──►  PoolFactory / CLFactory pools
```

## Why the Velodrome fork is the right base for the router

Aerodrome and Velodrome run the same two stacks as Topaz — Solidly v2 pools plus Slipstream CL pools
— and their Universal Router fork already encodes both differences from Uniswap:

1. **Pool addressing.** Uniswap derives pool addresses with `CREATE2` over full init code. Solidly
   and Slipstream deploy ERC-1167 clones, so addresses derive from the clone implementation.
2. **Pool keys.** Uniswap V2 pairs are `(token0, token1)`; Solidly adds a `stable` flag. Uniswap V3
   pools are keyed by `fee`; Slipstream is keyed by `tickSpacing`, which is what travels in the path.

Everything else (Permit2, command dispatch, payments, callbacks) is upstream Uniswap and needed no
change.

## What was removed from the router fork

The upstream router carries Ethereum NFT marketplace integrations with no counterpart on BNB Chain:
Seaport 1.4/1.5, LooksRare V2 and its rewards collector, NFTX, X2Y2, Foundation, Sudoswap, Element,
CryptoPunks and NFT20, the ERC721/ERC1155 payment paths those need, and Velodrome's Mode chain
fee-sharing extension. Dropping them removes a large amount of dead delegate-call surface.

## Where the TypeScript packages came from

| package | origin |
| --- | --- |
| `sdk-core` | thin layer over `@uniswap/sdk-core` from npm — its primitives are chain agnostic, and a single copy keeps `Token` identity consistent across packages. Adds the BNB native currency it lacks. |
| `v2-sdk` | written against `Pool.sol`. Uniswap's v2-sdk models constant-product pairs with a fixed 0.30% fee and no stable curve, so the pool entity is Topaz's while the route/trade shapes follow upstream. |
| `v3-sdk` | forked from `@uniswap/v3-sdk`. Tick, swap and price math is upstream's, unchanged; pool identity, path encoding and the quoter are Slipstream's. |
| `router-sdk` | written against Topaz's `MixedRouteQuoterV1` encoding, following Uniswap's router-sdk concepts (mixed routes, protocol partitioning, multi-route trades). |
| `universal-router-sdk` | written against this repo's router. The command planner mirrors Uniswap's, the swap encoders are Topaz's. |
| `smart-order-router` | architecture and the split-search algorithm follow Uniswap's alpha router; the providers are Topaz's. Uniswap's SOR is ~114 files of chain configs, v4, UniswapX, Tenderly simulation and AWS caching, nearly all of which would be deleted for a single-chain two-protocol deployment, so the parts that carry the value — candidate pools, route enumeration, percentage split search with gas adjustment — were ported directly instead. |
| `routing-api` | an Express service over the router, serving the same shape of quote response as Uniswap's routing-api. |

## Design decisions worth knowing

**Quotes always come from the chain.** The subgraphs decide which pools are worth considering;
`QuoterV2` and `MixedRouteQuoterV1` decide what a route is worth. A stale index can cost a better
route, but it can never produce a wrong quote.

**Fees are read, never assumed.** A v2 pool can carry a custom fee and a CL pool can be driven by a
dynamic fee module, so `PoolFactory.getFee` and `CLFactory.getSwapFee` are part of every pool load.

**Exact output is restricted by what the contracts can do.** The Solidly stable invariant
`x³y + xy³ = k` has no closed form inverse, so stable pools cannot serve exact output — the router
reverts with `StableExactOutputUnsupported`, the v2 SDK throws `StableExactOutputError`, and the
smart order router excludes stable and mixed routes from exact-output searches rather than quoting
something it cannot execute.

**Mixed routes are one command per stack.** The Universal Router has a v2 command and a CL command,
so a mixed route is partitioned into protocol runs; each run but the last hands its output to the
router, and each run but the first spends the router's balance.

## Verification

| layer | how it is proven |
| --- | --- |
| `universal-router` | 43 Solidity fork tests. Amounts come from `Pool.getAmountOut`, `QuoterV2` and `MixedRouteQuoterV1` on live state, never hardcoded. One test compares the live deployment's bytecode with this source. |
| `v2-sdk` | SDK quote must equal `Pool.getAmountOut` to the wei, both curves, both directions. |
| `v3-sdk` | derived addresses equal `CLFactory.getPool`; quoter calldata runs against the live `QuoterV2`. |
| `router-sdk` | mixed-route quotes from the live `MixedRouteQuoterV1` must equal the same route priced leg by leg. |
| `universal-router-sdk` | the router is deployed onto an anvil fork and SDK calldata is executed against live pools: CL, v2, mixed, split, fees, Permit2, native in/out, exact output. |
| `smart-order-router` | routes real sizes against live liquidity, then executes its own calldata and checks the received amount lands within a basis point of the quote. Local route estimates are unit tested against the maths they approximate. |
| `routing-api` | the service runs against a fork and the calldata it returns is executed, including a swap pulled entirely by a signed Permit2 allowance. |

Beyond the suites, changes to the routing path are validated by quoting a spread of pairs and sizes
against a router configured to price *every* route on chain, expecting zero difference. That check
caught a 50 bips regression that six spot checks had missed; see `CLAUDE.md`.

## How a quote spends its time

Measured stage by stage on a warm process: **86% is on-chain quoting**, 11% is reading pool state,
and everything else — route enumeration, the split search, encoding — is noise. Every optimisation
that has mattered came from quoting fewer routes, never from moving bytes faster:

| change | effect on a 1 BNB → TOPAZ quote |
| --- | --- |
| `StaticJsonRpcProvider` instead of `JsonRpcProvider` | dropped 140 redundant `eth_chainId` calls, half the traffic |
| multicall batch 15, 16 in flight | measured optimum; bigger batches overrun the node's gas ceiling, get halved, and cost more |
| screen routes at two sizes before the full sweep | 3-4x fewer calls, identical quotes |
| rank candidates locally before quoting | 34 calls → 16, 1782ms → 490ms, identical quotes |
| 1s response cache with in-flight coalescing | repeat quotes ~0.2s; ten concurrent become one computation |

## Not built yet

- **Local CL simulation.** The largest remaining win. `v3-sdk` already ships the swap maths; the
  missing input is each pool's initialised ticks. Cached per block, quoting becomes CPU-bound and
  sub-100ms is plausible. Prove wei-exactness against `QuoterV2` before letting it decide anything.
- **Pool-state cache.** Identical quotes hit the response cache, but a quote differing only in
  amount re-reads every pool.
- **Rate limiting.** The public endpoint has none; see `docs/ROUTING_API_DEPLOYMENT.md`.
- **Position management in `v3-sdk`.** `NonfungiblePositionManager`, `Position` and staker helpers
  were left out; this stack exists to route.

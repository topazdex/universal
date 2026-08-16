# Architecture and roadmap

## Goal

Index Topaz CL and Topaz v2 liquidity, search for the best route across both, and execute it through a
single Universal Router transaction — the Uniswap routing stack, retargeted at Topaz on BNB Chain.

```
routing-api  ──►  smart-order-router  ──►  v2-sdk / v3-sdk / router-sdk / sdk-core
     │                    │
     │                    └─ on-chain quoting: QuoterV2, MixedRouteQuoterV1, subgraphs
     ▼
universal-router-sdk  ──►  UniversalRouter (contracts)  ──►  Topaz PoolFactory / CLFactory pools
```

## Why the Velodrome fork is the right base

Aerodrome and Velodrome run the same two stacks as Topaz — Solidly v2 pools plus Slipstream CL pools —
and their Universal Router fork already encodes both differences from Uniswap:

1. **Pool addressing.** Uniswap derives pool addresses with `CREATE2` over full init code. Solidly and
   Slipstream deploy ERC-1167 clones, so addresses derive from the clone implementation instead.
2. **Pool keys.** Uniswap V2 pairs are `(token0, token1)`; Solidly adds a `stable` flag. Uniswap V3 pools
   are keyed by `fee`; Slipstream is keyed by `tickSpacing`, which is what travels in the encoded path.

Everything else (Permit2, command dispatch, payments, callbacks) is upstream Uniswap and needed no change.

## What was removed from the fork

The upstream router carries Ethereum NFT marketplace integrations that have no counterpart on BNB Chain:
Seaport 1.4/1.5, LooksRare V2 and its rewards collector, NFTX, X2Y2, Foundation, Sudoswap, Element,
CryptoPunks and NFT20, plus the ERC721/ERC1155 payment paths those need, and Velodrome's Mode chain
fee-sharing extension. Dropping them removes a large amount of dead delegate-call surface.

## Status

### Phase 1 — Universal Router ✅

Forked, retargeted at Topaz, and verified against live BNB Chain mainnet state. 41 fork tests, with every
expected amount sourced from Topaz's own deployed quoters rather than hardcoded:

- clone-derived pool addresses equal what `PoolFactory` and `CLFactory` report
- v2 volatile and stable exact-input match `Pool.getAmountOut` exactly
- CL exact-input and exact-output match `QuoterV2` exactly, single hop and multi hop
- mixed CL↔v2 routes match `MixedRouteQuoterV1` exactly
- split routes, BNB wrap/unwrap, Permit2 and plain-approval funding, interface fees, sub-plans

Known limitation, inherited from upstream and enforced by a test: **stable pools cannot serve exact
output**, because the `x³y+xy³=k` invariant has no closed form inverse. Route builders must send
exact-output trades over volatile or CL pools.

### Phase 2 — SDKs (next)

Fork `@uniswap/sdk-core`, `v2-sdk`, `v3-sdk`, `router-sdk` and `universal-router-sdk`, replacing:

- V2 `Pair` with a Solidly `Pool` carrying `stable`, per-pool fees from `PoolFactory.getFee`, and the
  stable curve's `getAmountOut` (Newton iteration on `_get_y`)
- V3 `Pool`'s `fee` key with `tickSpacing`, and the clone-based address derivation
- Uniswap's mixed route path encoding with Topaz's `0x400000` / `0x200000` bitmask convention
- the calldata encoder's `Route[]` shape for `V2_SWAP_EXACT_IN/OUT`

### Phase 3 — Smart order router

Fork `@uniswap/smart-order-router`: pool providers reading the Topaz v2 and v3 subgraphs, on-chain
quote providers over `QuoterV2` and `MixedRouteQuoterV1`, gas models for BNB Chain, and the route search
across v2 + CL + mixed candidates.

### Phase 4 — Routing API

Fork `@uniswap/routing-api` into a service that serves quotes and Universal Router calldata over HTTP.

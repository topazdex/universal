# topaz-universal

Routing monorepo for [Topaz Dex](https://topazdex.com) on BNB Chain (chain id 56): the Universal Router
contracts plus the TypeScript stack needed to index Topaz liquidity and route intelligently between
**Topaz CL** (Slipstream concentrated liquidity) and **Topaz v2** (Solidly volatile and stable) pools.

## Packages

| package | status | description |
| --- | --- | --- |
| [`@topaz/universal-router`](packages/universal-router) | ✅ working, fork tested against mainnet | Solidity Universal Router fork |
| `@topaz/sdk-core` | planned | chain/token/currency primitives |
| `@topaz/v2-sdk` | planned | Solidly pool math, volatile and stable |
| `@topaz/v3-sdk` | planned | Slipstream CL pool math, tick spacing keyed |
| `@topaz/router-sdk` | planned | mixed v2/CL route & trade types |
| `@topaz/universal-router-sdk` | planned | trade → Universal Router calldata |
| `@topaz/smart-order-router` | planned | pool indexing, route search, quoting |
| `@topaz/routing-api` | planned | HTTP quote service over the SOR |

## Topaz on BNB Chain

Two liquidity stacks share one ve(3,3) layer:

- **v2** — Solidly pools created by `PoolFactory`, keyed `(token0, token1, stable)`. Volatile pools use
  `xy=k`, stable pools use `x³y+xy³=k`. Fees are basis points scaled by 1e4 (`30` = 0.30%) and can be
  overridden per pool.
- **CL** — Slipstream pools created by `CLFactory`, keyed `(token0, token1, tickSpacing)`. Fees are in
  pips (1e-6) and can be dynamic. Default map: `1→100`, `50→500`, `100→1000`, `200→3000`, `2000→10000`.

Both factories deploy pools as ERC-1167 clones, so pool addresses are derivable off-chain from the
factory, the clone implementation and the pool key.

Canonical addresses live in [`packages/universal-router/script/constants/BscMainnet.sol`](packages/universal-router/script/constants/BscMainnet.sol).

### Mixed route path encoding

Topaz's deployed `MixedRouteQuoterV1` reuses the CL path layout (`token ‖ uint24 ‖ token ‖ …`) and encodes
v2 hops in the 3 byte pool parameter:

| value | meaning |
| --- | --- |
| `0x400000` (`1 << 22`) | Topaz v2 volatile pool |
| `0x200000` (`1 << 21`) | Topaz v2 stable pool |
| anything else | Topaz CL pool with that tick spacing |

The smart order router must emit this encoding when quoting mixed routes.

## Getting started

```bash
cp .env.example .env        # set BSC_MAINNET_RPC to an archive endpoint
yarn install
yarn test:router            # 41 fork tests against live Topaz mainnet contracts
```

## Docs

- [Architecture and roadmap](docs/ARCHITECTURE.md)

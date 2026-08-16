# topaz-universal

Routing monorepo for [Topaz Dex](https://topazdex.com) on BNB Chain (chain id 56): the Universal Router
contracts plus the TypeScript stack needed to index Topaz liquidity and route intelligently between
**Topaz CL** (Slipstream concentrated liquidity) and **Topaz v2** (Solidly volatile and stable) pools.

## Packages

| package | description |
| --- | --- |
| [`@topaz/universal-router`](packages/universal-router) | Solidity Universal Router fork, one entrypoint for swaps across both stacks |
| [`@topaz/sdk-core`](packages/sdk-core) | BNB native currency, canonical tokens, chain constants |
| [`@topaz/v2-sdk`](packages/v2-sdk) | Solidly pool math, volatile and stable |
| [`@topaz/v3-sdk`](packages/v3-sdk) | Slipstream CL pool math, keyed by tick spacing |
| [`@topaz/router-sdk`](packages/router-sdk) | mixed v2/CL routes and multi-route trades |
| [`@topaz/universal-router-sdk`](packages/universal-router-sdk) | trade → Universal Router calldata |
| [`@topaz/smart-order-router`](packages/smart-order-router) | pool indexing, route search, on-chain quoting, split selection |
| [`@topaz/routing-api`](packages/routing-api) | HTTP quote service over the router |

Every package is tested against live BNB Chain mainnet state — no mocked pools, and no hardcoded
expected amounts: quotes are checked against Topaz's own deployed `Pool.getAmountOut`, `QuoterV2`
and `MixedRouteQuoterV1`, and calldata is executed on a fork.

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
yarn build

yarn test:router            # 41 Solidity fork tests against live Topaz contracts
yarn test                   # every package, including anvil-fork end to end tests
```

Foundry and `anvil` must be on `PATH`: the TypeScript end-to-end tests boot a fork and deploy the
router onto it.

Quote something:

```bash
UNIVERSAL_ROUTER_ADDRESS=0x… yarn workspace @topaz/routing-api start
curl 'localhost:3000/quote?tokenIn=BNB&tokenOut=0x55d398326f99059fF775485246999027B3197955&amount=1000000000000000000'
```

## Docs

- [Architecture and roadmap](docs/ARCHITECTURE.md)

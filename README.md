# topazdex-universal

Quotes support per-chain EVM deployments, including BNB Chain, Robinhood, Base, Ethereum and Arc. See [multichain setup and deployment status](docs/MULTICHAIN.md).

Routing stack for [Topaz Dex](https://topazdex.com) on BNB Chain (chain id 56). It prices a swap
across **Topaz CL** (Slipstream concentrated liquidity) and **Topaz v2** (Solidly volatile and
stable) in one request, and executes it in one transaction through a forked Universal Router.

```
  quote.topazdex.com/quote  ──►  smart-order-router  ──►  router-sdk ─┬─ v2-sdk   Solidly pools
            │                            │                            ├─ v3-sdk   Slipstream CL
            │                            │                            └─ sdk-core
            │                            └─ subgraphs (which pools exist)
            │                               QuoterV2 / MixedRouteQuoterV1 (what they are worth)
            ▼
  universal-router-sdk  ──►  UniversalRouter  ──►  PoolFactory / CLFactory pools
```

## Live

| | |
| --- | --- |
| Universal Router | [`0x691e6171e0a434FfE5C9f1759621D05b9efcF6A6`](https://bscscan.com/address/0x691e6171e0a434FfE5C9f1759621D05b9efcF6A6) — verified on BscScan |
| Quote API | `https://quote.topazdex.com` |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` |

```bash
curl 'https://quote.topazdex.com/quote?tokenIn=BNB&tokenOut=0x55d398326f99059fF775485246999027B3197955&amount=1000000000000000000'
```

Roughly 0.6s uncached and 0.2s cached, on free public RPCs. Add `&recipient=0x…` and the response
carries executable calldata.

## Packages

All published under `@topazdex` at `0.1.0`.

| package | what it does |
| --- | --- |
| [`universal-router`](packages/universal-router) | Solidity. One entrypoint for swaps across both stacks |
| [`sdk-core`](packages/sdk-core) | BNB native currency, canonical tokens, chain constants |
| [`v2-sdk`](packages/v2-sdk) | Solidly pool maths, volatile and stable |
| [`v3-sdk`](packages/v3-sdk) | Slipstream CL, keyed by tick spacing |
| [`router-sdk`](packages/router-sdk) | mixed v2/CL routes, multi-route trades |
| [`universal-router-sdk`](packages/universal-router-sdk) | trade → Universal Router calldata |
| [`smart-order-router`](packages/smart-order-router) | pool discovery, route search, quoting, split selection |
| [`routing-api`](packages/routing-api) | HTTP quote service (not published; it is a service) |

## Using it in your own project

Three levels, cheapest first. All of them price against the same on-chain quoters, so they agree.

**1. Call the hosted API.** Nothing to install, nothing to run. Add `&recipient=0x…` and the response
carries calldata you can send straight from a wallet — see
[frontend integration](docs/FRONTEND_INTEGRATION.md) for approvals, Permit2 and execution.

```ts
const quote = await fetch(
  `https://quote.topazdex.com/quote?tokenIn=BNB&tokenOut=${USDT}&amount=${amountIn}&recipient=${account}`
).then(r => r.json())

await sendTransaction(quote.methodParameters)   // { to, calldata, value }
```

**2. Route in-process.** Your own RPC, your own tuning, no dependency on our service.

```bash
npm install @topazdex/smart-order-router @topazdex/sdk-core
```

```ts
import { TopazRouter, FallbackRpcProvider, PUBLIC_BSC_RPC_URLS } from '@topazdex/smart-order-router'
import { CurrencyAmount, Percent, TradeType, BNB, USDT } from '@topazdex/sdk-core'

const router = new TopazRouter({ provider: new FallbackRpcProvider(PUBLIC_BSC_RPC_URLS) })

const route = await router.route(
  CurrencyAmount.fromRawAmount(BNB.onChain(56), '1000000000000000000'),
  USDT,
  TradeType.EXACT_INPUT,
  { slippageTolerance: new Percent(50, 10_000), recipient, deadline }
)

route.quote.toExact()      // output amount
route.methodParameters     // { calldata, value, to }
```

It works with no RPC configured — `PUBLIC_BSC_RPC_URLS` is a probed list of public endpoints, and a
paid endpoint is roughly 4x faster.

**3. Take just the pieces.** The pool maths (`@topazdex/v2-sdk`, `@topazdex/v3-sdk`), the mixed-route
encoding (`@topazdex/router-sdk`) and the calldata encoder (`@topazdex/universal-router-sdk`) are
independently useful — for a bot, an analytics job, or a router of your own.

```bash
npm install @topazdex/universal-router-sdk    # just build calldata from a trade you priced
npm install @topazdex/v2-sdk                  # just the Solidly maths, wei-exact vs the pool
```

Each package's README covers what it does and how it differs from its Uniswap counterpart.

## Running it yourself

The quote service is stateless and needs one thing: a BNB Chain RPC. It falls back to a built-in
public list, so it runs with no configuration at all — several times slower.

```bash
docker build -f packages/routing-api/Dockerfile -t topazdex/routing-api .    # from the repo root
docker run -p 3000:3000 -e BSC_MAINNET_RPC="https://…" topazdex/routing-api
curl 'localhost:3000/quote?tokenIn=BNB&tokenOut=0x55d398326f99059fF775485246999027B3197955&amount=1000000000000000000'
```

[Deployment guide](docs/ROUTING_API_DEPLOYMENT.md) covers Fly.io, systemd, RPC failover, the measured
batch-size and hop-depth tradeoffs, and what to watch in production. The router contract is immutable
and already deployed; you only need [its deployment guide](docs/DEPLOYMENT.md) if you are forking the
stack onto your own pools.

## Topaz on BNB Chain

Two liquidity stacks share one ve(3,3) layer:

- **v2** — Solidly pools from `PoolFactory`, keyed `(token0, token1, stable)`. Volatile is `xy=k`,
  stable is `x³y+xy³=k`. Fees are basis points against 10 000 (`30` = 0.30%) and can be overridden
  per pool.
- **CL** — Slipstream pools from `CLFactory`, keyed `(token0, token1, tickSpacing)`. Fees are pips
  (1e-6) and can be dynamic. Default map: `1→100`, `50→500`, `100→1000`, `200→3000`, `2000→10000`.

Both factories deploy pools as **ERC-1167 clones**, so addresses derive off-chain from the factory,
the clone implementation and the pool key — not from init code as in Uniswap.

Mixed routes reuse the CL path layout, flagging v2 hops in the 3-byte pool slot: `0x400000` for
volatile, `0x200000` for stable, anything else is a CL tick spacing. That is what Topaz's deployed
`MixedRouteQuoterV1` expects.

Canonical addresses live in
[`packages/universal-router/script/constants/BscMainnet.sol`](packages/universal-router/script/constants/BscMainnet.sol).

## Working on it

The Solidity package vendors its dependencies as git submodules, so clone recursively or `forge
build` will fail on unresolved imports.

```bash
git clone --recursive https://github.com/topazdex/universal.git
cd universal

cp .env.example .env      # set BSC_MAINNET_RPC
yarn install
yarn build
yarn test                 # ~4 min; needs foundry and anvil on PATH
yarn lint
```

Every suite runs against **live BNB Chain state** — no mocked pools, and no hardcoded expected
amounts. Values come from Topaz's own `Pool.getAmountOut`, `QuoterV2` and `MixedRouteQuoterV1`, and
SDK-built calldata is executed on an anvil fork. Without `BSC_MAINNET_RPC` the network suites skip
silently, so check the counts.

| suite | tests |
| --- | --- |
| universal-router (forge) | 43 |
| smart-order-router | 30 |
| routing-api | 39 |
| v2-sdk | 17 |
| universal-router-sdk | 9 |
| sdk-core | 7 |
| v3-sdk | 6 |
| router-sdk | 5 |

## Docs

| | |
| --- | --- |
| [Frontend integration](docs/FRONTEND_INTEGRATION.md) | quoting, approvals, Permit2, execution — start here for a dapp |
| [Architecture](docs/ARCHITECTURE.md) | what was forked from where, and why each decision |
| [Router deployment](docs/DEPLOYMENT.md) | deploying and verifying the contract |
| [Routing API deployment](docs/ROUTING_API_DEPLOYMENT.md) | running the service, tuning, what to watch |
| [Contributing](CONTRIBUTING.md) | setup, the invariants, and the bar for a routing-path change |
| [Security](SECURITY.md) | reporting a vulnerability, and what the design already rules out |
| [CLAUDE.md](CLAUDE.md) | invariants, traps and open items for anyone picking this up |

## Contributing

Issues and pull requests are welcome. [CONTRIBUTING.md](CONTRIBUTING.md) has the setup, but two
things are worth knowing before you start:

- **The tests need an RPC and skip silently without one.** Every suite runs against live BNB Chain
  state with no mocks and no hardcoded amounts, so a run that tested nothing looks exactly like a run
  that tested everything. Check the counts above.
- **Changes to the routing path need numbers, not spot checks.** Quote quality degrades quietly — a
  past change lost 50 bips on large split trades and six manual checks missed it. Compare against a
  router that prices every route on chain, at a pinned block, and expect 0 bips.

Found a security vulnerability? Don't open an issue — see [SECURITY.md](SECURITY.md).

## Licensing

**GPL-3.0-or-later**, inherited from the Velodrome router, except **`@topazdex/v3-sdk`**, which is
substantially `@uniswap/v3-sdk` and stays **MIT** with Uniswap's notice alongside ours. Each package
ships its own `LICENSE`; vendored interfaces under
`packages/universal-router/contracts/interfaces/external/` keep the SPDX headers they arrived with.

This stack is a fork, and the lineage is deliberate — [ARCHITECTURE.md](docs/ARCHITECTURE.md) records
what came from [Velodrome](https://github.com/velodrome-finance/universal-router),
[Uniswap](https://github.com/Uniswap/universal-router) and Slipstream, and why each decision went the
way it did.

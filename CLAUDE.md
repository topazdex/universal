# CLAUDE.md

Working notes for an agent picking this repo up. Read this before changing anything.

## What this is

A routing stack for [Topaz Dex](https://topazdex.com) on BNB Chain (56): a forked Universal Router,
the SDKs it needs, a smart order router, and an HTTP quote service. It exists so a swap can be
priced across **Topaz CL** (Slipstream concentrated liquidity) and **Topaz v2** (Solidly volatile and
stable) in one request, and executed in one transaction.

Everything below is live. This is not a prototype.

| | |
| --- | --- |
| Universal Router | [`0x691e6171e0a434FfE5C9f1759621D05b9efcF6A6`](https://bscscan.com/address/0x691e6171e0a434FfE5C9f1759621D05b9efcF6A6), verified |
| Quote API | `https://quote.topazdex.com` (Fly app `topaz-routing-api`, region `ord`) |
| npm | seven packages under `@topazdex`, all at `0.1.0` |

## Layout

```
packages/
  universal-router/       Solidity. Forked from velodrome-finance/universal-router (v1 branch).
  sdk-core/               BNB currency + canonical tokens, over @uniswap/sdk-core
  v2-sdk/                 Solidly pool maths, volatile and stable
  v3-sdk/                 Slipstream CL, forked from @uniswap/v3-sdk (MIT, unlike the rest)
  router-sdk/             mixed routes, multi-route trades
  universal-router-sdk/   trade -> calldata
  smart-order-router/     pool discovery, route search, on-chain quoting, split selection
  routing-api/            Express service (private, not published)
docs/                     architecture, both deployment guides, frontend integration
script/publish.sh         npm release, in dependency order
```

## Invariants — do not break these

**Quotes come from the chain, never from the index.** The subgraphs decide which pools are worth
considering. `QuoterV2` and `MixedRouteQuoterV1` decide what a route is worth. A stale index can
cost a better route; it can never produce a wrong number.

**Local estimates rank, they never answer.** `estimate-route.ts` prunes candidates before on-chain
quoting. Everything it keeps is still priced on chain. If you make it authoritative you will ship
wrong quotes.

**Fees are read, never assumed.** A v2 pool can carry a custom fee; a CL pool can be driven by a
dynamic fee module. `PoolFactory.getFee` and `CLFactory.getSwapFee` are part of every pool load.

**Stable pools cannot serve exact output.** `x³y + xy³ = k` has no closed-form inverse. The router
reverts (`StableExactOutputUnsupported`), the v2 SDK throws (`StableExactOutputError`), and the SOR
excludes stable and mixed routes from exact-output searches. Do not "fix" this.

**Pool addresses are ERC-1167 clones.** Both factories clone an implementation, so addresses derive
from `PoolFactory.implementation()` / `CLFactory.poolImplementation()` — not from init code as in
Uniswap. `DeployedRouterForkTest` guards this.

## How to work here

```bash
cp .env.example .env      # BSC_MAINNET_RPC is the only one that matters
yarn install && yarn build
yarn test                 # everything, ~4 min, needs foundry + anvil on PATH
yarn test:router          # just the Solidity fork tests
yarn lint                 # tsc --noEmit everywhere + forge fmt --check

# one package while iterating
yarn workspace @topazdex/smart-order-router test --testPathPattern estimate
```

Tests hit **live mainnet state** — no mocks, no hardcoded amounts. Expected values come from Topaz's
own deployed quoters, so a passing suite means agreement with the chain. Without `BSC_MAINNET_RPC`
the network suites self-skip, which is silent: check the counts below.

| package | tests |
| --- | --- |
| universal-router | 43 forge (1 skips without `DEPLOYED_UNIVERSAL_ROUTER`) |
| smart-order-router | 30 |
| routing-api | 39 |
| v2-sdk | 17 |
| universal-router-sdk | 9 |
| sdk-core | 7 |
| v3-sdk | 6 |
| router-sdk | 5 |

Run the whole suite against the **live** router with
`DEPLOYED_UNIVERSAL_ROUTER=0x691e… forge test` inside `packages/universal-router`.

## Traps that already cost time

**`forge verify-contract` cannot verify this project.** Under `via_ir`, a contract's bytecode depends
on the whole compilation unit; foundry compiles all 60 project sources together while
`--show-standard-json-input` emits only the 27 reachable ones, which compile 392 bytes shorter. Use
`script/verify-bscscan.py`, which captures what foundry actually feeds solc. Do not pass `--verify`
to the deploy script either.

**Anvil's default accounts cannot hold BNB on a BSC fork.** Those public-key addresses carry an
EIP-7702 delegation on mainnet that sweeps incoming BNB, and forks inherit it. Native output silently
arrives as zero *with a successful transaction*. Use `createFundedWallet` from
`@topazdex/universal-router-sdk/dist/test-utils/anvil`.

**Yarn and npm disagree about the registry.** Yarn's default is `registry.yarnpkg.com`, a read
mirror; `npm login` writes a token scoped to `registry.npmjs.org`. `yarn npm whoami --publish` is the
check that matters. `script/publish.sh` packs with yarn (it rewrites `workspace:*` into real
versions) and publishes with npm.

**A new npm package 404s on read for a few minutes after a successful publish.** Check
`npm access list packages @topazdex` before concluding a publish failed.

**The Permit2 EIP-712 domain has no `version` field.** Adding one yields a valid-looking signature
that the router rejects.

**Tuning parameters interact.** `maxRoutesToQuote` derives from the route count; when local
pre-ranking narrowed that count, the screen silently shrank from 13 survivors to 5 and quotes lost up
to 50 bips. Screen width now follows routes *found*. Any change near `topaz-router.ts`'s limits needs
the quality check below.

## Before changing anything in the routing path

Quote quality is the product. Six spot checks are not evidence — that is exactly how the 50 bips
regression shipped. Compare against a router that prices every route:

```ts
router.route(amount, tokenOut, tradeType, undefined, {
  blockNumber,                    // pin it, or the comparison is noise
  maxRoutesToScreen: 100_000,
  maxRoutesToQuote: 100_000,
})
```

Span pair shapes (hub, spoke-to-spoke, long tail) and sizes (dust to whale). The failure mode was
specific to large trades that split three ways. Expect **0 bips**; anything negative is quote quality
you are giving away.

## Performance, and where the remaining time goes

A quote is ~0.6s uncached and ~0.2s cached on free public RPCs, from 16 `eth_call`s. Measured stage
timings put **86% of the wall clock in on-chain quoting**, 11% in reading pool state. So the lever is
always *quoting fewer routes*, never moving bytes faster.

The next real unlock is **local CL simulation**. `@topazdex/v3-sdk` already ships the swap maths
(`v3Swap`, `TickMath`, `TickListDataProvider`); the missing input is each pool's initialised ticks.
With those cached per block, quoting becomes CPU-bound and sub-100ms is plausible. Build it behind a
flag and prove wei-exactness against `QuoterV2` before letting it decide anything.

## Deploying

Router: `docs/DEPLOYMENT.md`. Immutable, no owner, no upgrade path — redeploying is the only way to
change a parameter, which is why the script cross-checks the factories first.

API: `fly deploy` from the repo root. Fly sometimes warns the app is not listening during a rollout;
that is a timing artifact, confirm with `/health` before chasing it.

Packages: `./script/publish.sh --dry-run`, then `./script/publish.sh`. Needs an npm automation token
in `~/.npmrc` (a normal login session forces an OTP per publish).

## Conventions

- Commits: one concern each, imperative subject, body explains *why* including what was measured.
- No `any`, no `@ts-ignore`. `yarn lint` must pass.
- Comments explain why, never what. Delete commented-out code.
- Tests use `#given / #when / #then` and assert against live chain state, not fixtures.
- Never commit `.env`. `.gitignore` covers every variant; the repo has been audited for leaked keys.

## Open items

- **No rate limiting.** `quote.topazdex.com` is DNS-only through Cloudflare with no auth. Each quote
  is ~16 `eth_call`s against *public* RPCs, so one script can degrade it for everyone. Proxying it
  (orange cloud) with a ~5 req/s rule on `/quote` is the fix. Do not cache `/quote` at the edge:
  responses are block-specific and carry executable calldata.
- **No pool-state cache.** Identical quotes hit the response cache, but a quote differing only in
  amount re-reads every pool.
- **Published packages lag the repo.** All seven `@topazdex` packages are on npm at `0.1.0`, but
  `repository`/`homepage` metadata was added after that publish, so the npm pages will not link back
  to GitHub until the next version goes out. `./script/publish.sh` skips a version already on the
  registry, so shipping the metadata needs a version bump.
- **Position management** (`NonfungiblePositionManager`, `Position`, staker) was deliberately left
  out of `v3-sdk`. This stack routes; it does not manage liquidity.

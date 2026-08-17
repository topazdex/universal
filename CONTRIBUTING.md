# Contributing

Thanks for looking. This repo is the routing stack behind [Topaz Dex](https://topazdex.com) — a
forked Universal Router, the SDKs around it, a smart order router and an HTTP quote service. It is
live on BNB Chain, so the bar for a change in the routing path is higher than usual. This page is
how to clear it.

## Getting set up

**Clone with submodules.** The Solidity package vendors `forge-std`, `solmate`, `permit2` and
`openzeppelin-contracts` as git submodules. A plain `git clone` gives you empty `lib/` directories
and `forge build` fails with unresolved imports.

```bash
git clone --recursive https://github.com/topazdex/universal.git
cd universal

# already cloned without --recursive?
git submodule update --init --recursive
```

You need:

| | |
| --- | --- |
| Node | 18+ (CI runs 22) |
| Yarn | 4.x, via `corepack enable` — the repo pins `yarn@4.17.1` |
| [Foundry](https://book.getfoundry.sh/getting-started/installation) | `forge` and `anvil` on `PATH` |
| A BNB Chain RPC | see below — without one most of the suite silently skips |

```bash
cp .env.example .env      # BSC_MAINNET_RPC is the only one that matters
yarn install
yarn build
yarn test                 # ~4 min
yarn lint                 # tsc --noEmit everywhere + forge fmt --check
```

Iterating on one package:

```bash
yarn workspace @topazdex/smart-order-router test
yarn workspace @topazdex/smart-order-router test --testPathPattern estimate
yarn workspace @topazdex/universal-router test          # forge test
```

### About that RPC

Every suite runs against **live BNB Chain state**. There are no mocked pools and no hardcoded
expected amounts — expected values come from Topaz's own deployed quoters, so a passing suite means
the code agrees with the chain.

The consequence is that **without `BSC_MAINNET_RPC` the network suites skip, and they skip
silently.** A green run that tested nothing looks exactly like a green run that tested everything,
so check the counts:

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

Any public BNB Chain endpoint works for the test suite; archive access is not required. `FORK_BLOCK`
in `.env.example` pins the fork so runs are reproducible — unset it to test against the chain tip.

## Invariants

These are not style preferences. Each one is load-bearing, and each has cost someone time.

**Quotes come from the chain, never from the index.** The subgraphs decide which pools are worth
considering; `QuoterV2` and `MixedRouteQuoterV1` decide what a route is worth. A stale index can cost
you a better route. It can never produce a wrong number. Do not let discovery data price anything.

**Local estimates rank, they never answer.** `estimate-route.ts` prunes candidates before on-chain
quoting. Everything it keeps is still priced on chain. Making it authoritative ships wrong quotes.

**Fees are read, never assumed.** A v2 pool can carry a custom fee; a CL pool can be driven by a
dynamic fee module. `PoolFactory.getFee` and `CLFactory.getSwapFee` are part of every pool load.

**Stable pools cannot serve exact output.** `x³y + xy³ = k` has no closed-form inverse. The router
reverts with `StableExactOutputUnsupported`, the v2 SDK throws `StableExactOutputError`, and the
smart order router excludes stable and mixed routes from exact-output searches. This is agreement
with the contracts, not a gap — please do not "fix" it.

**Pool addresses are ERC-1167 clones.** Both factories clone an implementation, so addresses derive
from `PoolFactory.implementation()` / `CLFactory.poolImplementation()`, not from init code as in
Uniswap. `PoolAddressesForkTest` guards this against the live factories.

## Changing anything in the routing path

Quote quality is the product, and it degrades quietly. A previous change lost up to 50 bips on large
trades that split three ways, and six spot checks did not catch it — because the loss only appeared
on a pair shape and trade size none of them covered.

So if you touch route enumeration, screening, local ranking, the split search, or any limit near
`topaz-router.ts`, compare against a router that prices *every* route on chain:

```ts
router.route(amount, tokenOut, tradeType, undefined, {
  blockNumber,                    // pin it, or the comparison is noise
  maxRoutesToScreen: 100_000,
  maxRoutesToQuote: 100_000,
})
```

Span pair shapes (hub pairs, spoke-to-spoke, long tail) and sizes (dust to whale). **Expect 0 bips.**
Anything negative is quote quality you are giving away. Put the numbers in the PR description.

Performance changes get the same treatment from the other side: ~86% of a quote's wall clock is
on-chain quoting and 11% is reading pool state, so the only lever that has ever mattered is *quoting
fewer routes*. A change that moves bytes faster is unlikely to show up at all — measure before and
after, and say what you measured.

## Code

- **No `any`, no `@ts-ignore`, no `@ts-expect-error`.** `yarn lint` must pass.
- Comments explain *why*. If a comment explains *what*, rename something instead. Delete
  commented-out code rather than shipping it.
- Tests use `#given / #when / #then` and assert against live chain state, not fixtures.
- Match the surrounding code. Every package here has a consistent style; follow the file you are in.
- Fixing a bug? Fix it minimally. Refactoring while fixing makes the fix unreviewable.
- Never commit `.env`. `.gitignore` covers every variant.

## Commits and pull requests

One concern per commit, imperative subject, and a body that explains **why** — including what you
measured, if anything. For large multi-part work, one pull request with several well-scoped commits
beats a stack of dependent PRs.

```
perf(sor): rank routes locally before quoting them on chain

On-chain quoting is 86% of a quote's wall clock, so the lever is quoting
fewer routes. Candidates are now scored from pool state already in memory
and only the best 20 reach the chain.

Validated across 39 quotes, 16 pairs, dust to 20 BNB, against a router
pricing every route: all 39 identical. 34 calls -> 16, 1782ms -> 490ms.
```

Before opening a PR:

```bash
yarn lint
yarn test
```

CI runs the Solidity build, `forge fmt --check` and the fork tests, then installs the workspace,
builds, typechecks and runs every TypeScript suite. It needs `BSC_MAINNET_RPC` as a repository
secret; forks without it will see the network suites skip, which is expected — a maintainer will run
them.

In the PR description, say what you changed, why, and how you know it works. For anything touching
routing, that means numbers.

## Reporting things

- **Bugs and feature requests** — [open an issue](https://github.com/topazdex/universal/issues).
  Include the pair, amount, trade type and block number for anything quote-related; a quote is only
  reproducible if it is pinned to a block.
- **Security vulnerabilities** — do not open an issue. See [SECURITY.md](SECURITY.md).

## Licensing your contribution

Contributions are accepted under the licence of the package you are changing: **GPL-3.0-or-later**
for everything except `@topazdex/v3-sdk`, which is substantially `@uniswap/v3-sdk` and stays **MIT**.
Opening a pull request means you agree to that, and that you have the right to submit the code.

If you are porting code from another project, say so in the PR and keep its copyright notice and
SPDX header intact — that is how the vendored files in `packages/universal-router/contracts/interfaces/external/`
are handled.

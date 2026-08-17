<!--
Thanks for the PR. Keep the sections that apply and delete the rest.
Contributor guide: CONTRIBUTING.md
-->

## What and why

<!-- What changed, and what problem it solves. The "why" is the part reviewers cannot reconstruct. -->

## How it was verified

<!--
Which suites you ran, and their counts — the network suites skip silently without BSC_MAINNET_RPC,
so "tests pass" on its own does not distinguish a full run from a skipped one.
-->

- [ ] `yarn lint` passes
- [ ] `yarn test` passes, with `BSC_MAINNET_RPC` set

## Routing path changes only

<!--
Delete this section if you did not touch route enumeration, screening, local ranking, the split
search, or any limit near topaz-router.ts.

Otherwise: quote quality degrades quietly, and spot checks miss it. Compare against a router that
prices every route on chain, at a pinned block, across pair shapes and sizes. Expect 0 bips.
-->

- [ ] Compared against `maxRoutesToScreen: 100_000, maxRoutesToQuote: 100_000` at a pinned block
- [ ] Spanned hub pairs, spoke-to-spoke pairs and long-tail pairs
- [ ] Spanned sizes from dust to whale

| pair | size | baseline | this branch | delta |
| --- | --- | --- | --- | --- |
|  |  |  |  |  |

## Anything reviewers should know

<!-- Tradeoffs, follow-ups, things you are unsure about. Better raised here than found in review. -->

# Intermediary token starter lists

Researched and checked on-chain on September 12, 2026 UTC (September 11 in Vancouver).
These starter lists are implemented in [the chain registry](../packages/sdk-core/src/chains.ts)
and deployed to [the quoting API](https://quote.topazdex.com/health) in Fly release **v16**
on September 12, 2026 at 05:23 UTC. The running instance's defaults were checked against
all 20 verified chain/token entries. [Deployment evidence](evidence/intermediary-tokens-deployment-2026-09-12.json)
records the image, runtime configuration and production quote checks.

| Chain            | Proposed routing intermediaries, including wrapped native |
| ---------------- | --------------------------------------------------------- |
| Robinhood (4663) | WETH, USDG, xTOPAZ                                        |
| Base (8453)      | WETH, USDC, cbBTC, wstETH, cbETH, EURC, AERO, xTOPAZ      |
| Ethereum (1)     | WETH, USDC, USDT, DAI, USDS, WBTC, cbBTC, wstETH, xTOPAZ  |

## What the lists do

The router already includes the input/output tokens and discovers counterparties from up to
five pools touching each endpoint, separately for v2 and CL. Presets keep additional potential
intermediaries eligible even when those limited neighbor selections do not reach them.
They can improve coverage; they do not guarantee a route. Discovery still considers at most
500 pools per protocol by default, and the unified graph's raw reserve/liquidity rankings
are not comparable USD liquidity rankings.

ETH swaps use WETH inside pools. `baseTokensOnChain()` automatically includes the chain's
wrapped native token; the registry's `baseTokens` array adds the other tokens below.
PONS does not need a preset for an ETH/PONS quote: both endpoints are always eligible.
Its Robinhood address is `0x39dBED3a2bd333467115dE45665cC57F813C4571`.

Only pools from the configured Topaz factories are used. Adding AERO, for example, makes
Topaz pools involving the AERO token eligible; it does not add Aerodrome pool routing.
A useful intermediary must connect at least two counterparties with usable liquidity.

## Robinhood

WETH and USDG are the two general-purpose tokens with addresses published in
[Robinhood's contract list](https://docs.robinhood.com/chain/contracts/). They are the initial
native/stable routing candidates. xTOPAZ is an additional protocol-specific choice based
on our deployment, to cover future Topaz token pairs.

| Token  | Decimals | Address                                      | Address source                                                                             |
| ------ | -------: | -------------------------------------------- | ------------------------------------------------------------------------------------------ |
| WETH   |       18 | `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` | [Robinhood](https://docs.robinhood.com/chain/contracts/)                                   |
| USDG   |        6 | `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` | [Robinhood](https://docs.robinhood.com/chain/contracts/)                                   |
| xTOPAZ |       18 | `0x1aA89C4Ab9884Cb65B759A3Cc3A1690744d687a6` | [Our Robinhood deployment](../../xTopaz/topaz-xchain/deployments/robinhood/XTopazOFT.json) |

The initial research snapshot had two user pools: WETH/USDG and WETH/PONS, both CL.
Neither PONS nor xTOPAZ connected two counterparties in that snapshot; xTOPAZ
is included in anticipation of protocol liquidity. A PONS preset can be added if it becomes
a hub. Further Robinhood stablecoins or BTC wrappers need a verified chain-specific address
and evidence of useful Topaz pools before promotion into this small starter list.

## Base

USDC supplies the initial dollar leg; cbBTC supplies a BTC leg; wstETH and cbETH cover
staked ETH pairs. EURC and AERO are additional candidates for euro and Base ecosystem
pairs. This selection is supported by the same seven external tokens appearing in
[Velodrome's Sugar SDK Base connector configuration](https://github.com/velodrome-finance/sugar-sdk/blob/main/sugar/config.py).
That is evidence of their use as routing connectors elsewhere, not evidence of Topaz liquidity.
xTOPAZ is our protocol-specific addition. AERO and EURC are the first entries to trim if a
smaller initial list is preferred.

| Token  | Decimals | Address                                      | Address source                                                                                                             |
| ------ | -------: | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| WETH   |       18 | `0x4200000000000000000000000000000000000006` | [Superchain token list](https://github.com/ethereum-optimism/ethereum-optimism.github.io/blob/master/data/WETH/data.json)  |
| USDC   |        6 | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | [Circle](https://developers.circle.com/stablecoins/usdc-contract-addresses)                                                |
| cbBTC  |        8 | `0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf` | [Coinbase](https://www.coinbase.com/blog/coinbase-wrapped-btc-cbbtc-is-now-live)                                           |
| wstETH |       18 | `0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452` | [Lido](https://docs.lido.fi/deployed-contracts/)                                                                           |
| cbETH  |       18 | `0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22` | [Superchain token list](https://github.com/ethereum-optimism/ethereum-optimism.github.io/blob/master/data/cbETH/data.json) |
| EURC   |        6 | `0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42` | [Circle](https://developers.circle.com/stablecoins/eurc-contract-addresses)                                                |
| AERO   |       18 | `0x940181a94A35A4569E4529A3CDfB74e38FD98631` | [Aerodrome deployment](https://github.com/aerodrome-finance/contracts#deployment)                                          |
| xTOPAZ |       18 | `0x1aA89C4Ab9884Cb65B759A3Cc3A1690744d687a6` | [Our Base deployment](../../xTopaz/topaz-xchain/deployments/base/XTopazOFT.json)                                           |

Bridged USDT and DAI are reasonable later additions if Topaz pools use them. Their Base
representations are recorded in the [Superchain USDT metadata](https://github.com/ethereum-optimism/ethereum-optimism.github.io/blob/master/data/USDT/data.json)
and [DAI metadata](https://github.com/ethereum-optimism/ethereum-optimism.github.io/blob/master/data/DAI/data.json).
The initial dollar preset uses Circle's native USDC deployment. Tokens outside the presets
remain available as endpoints and through automatic neighbor discovery.

Address correction found during research: the archived frontend Base token list under
`../topaz-api/docs/evidence/bnb-curation-publication/frontend-source/packages/uniswap/src/data/apiClients/topaz/tokens/base.ts`
has cbETH ending in `DEC70`. That address had no deployed bytecode at the checked block.
The published and on-chain verified Base cbETH address above ends in `DEc22`.
The archived sibling file has not been changed; this finding does not establish which
address the live frontend currently uses.

## Ethereum

The initial selection covers dollar pairs through USDC, USDT, DAI and USDS; BTC pairs
through WBTC and cbBTC; and staked ETH through wstETH. USDS and cbBTC add alternatives
to DAI and WBTC respectively. These are candidates for future liquidity, without a
claim that each will be an active Topaz hub. xTOPAZ again covers protocol token pairs.
For staked ETH, [wstETH's non-rebasing balance model](https://docs.lido.fi/contracts/wsteth/)
is suitable for ordinary AMM pool accounting.

| Token  | Decimals | Address                                      | Address source                                                                                                            |
| ------ | -------: | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| WETH   |       18 | `0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2` | [Superchain token list](https://github.com/ethereum-optimism/ethereum-optimism.github.io/blob/master/data/WETH/data.json) |
| USDC   |        6 | `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` | [Circle](https://developers.circle.com/stablecoins/usdc-contract-addresses)                                               |
| USDT   |        6 | `0xdAC17F958D2ee523a2206206994597C13D831ec7` | [Tether](https://tether.to/en/supported-protocols/)                                                                       |
| DAI    |       18 | `0x6B175474E89094C44Da98b954EedeAC495271d0F` | [Sky Chainlog, MCD_DAI](https://chainlog.sky.money/api/mainnet/active.json)                                               |
| USDS   |       18 | `0xdC035D45d973E3EC169d2276DDab16f1e407384F` | [Sky deployment guide](https://developers.skyeco.com/guides/skylink/base-eth-native-bridge/)                              |
| WBTC   |        8 | `0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599` | [Superchain token list](https://github.com/ethereum-optimism/ethereum-optimism.github.io/blob/master/data/WBTC/data.json) |
| cbBTC  |        8 | `0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf` | [Coinbase](https://www.coinbase.com/blog/coinbase-wrapped-btc-cbbtc-is-now-live)                                          |
| wstETH |       18 | `0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0` | [Lido](https://docs.lido.fi/deployed-contracts/)                                                                          |
| xTOPAZ |       18 | `0x1aA89C4Ab9884Cb65B759A3Cc3A1690744d687a6` | [Our Ethereum deployment](../../xTopaz/topaz-xchain/deployments/ethereum/XTopazOFT.json)                                  |

## Verification and adjustment

All 20 chain/token entries, including each chain's WETH, passed checks for deployed
bytecode, `symbol()` and `decimals()` at a fixed block per chain. RPC chain IDs were
checked explicitly. [The public evidence snapshot](evidence/intermediary-tokens-2026-09-12.json)
records blocks, RPC URLs, metadata, graph endpoints and indexed user pools.

| Chain     | RPC verification block | Subgraph block | Indexed user pools |
| --------- | ---------------------: | -------------: | -----------------: |
| Robinhood |               60840233 |       60840257 |                  2 |
| Base      |               51199898 |       51199912 |                  0 |
| Ethereum  |               25959091 |       25959091 |                  0 |

All three graphs reported the expected chain ID and no indexing errors. Their snapshots
were read after the RPC metadata checks, so graph blocks may be slightly newer.
Base and Ethereum had no indexed user pools at this check. The list therefore reflects
deployment and ecosystem research, rather than a ranking of current Topaz liquidity.
Metadata checks establish token identity and decimals, not executable routes through
every candidate. A route still needs indexed pools and a successful on-chain quote.

A subsequent check on September 12, 2026 UTC confirmed WETH/USDC liquidity on both
Base and Ethereum and a third Robinhood pool, CASHCAT/WETH. Production quotes now pass
on all four enabled chains, including exact-input and exact-output ETH/USDC quotes and
native-input swap simulations on Base and Ethereum. CASHCAT → WETH → PONS also quotes
successfully. [The later verification evidence](evidence/all-chains-live-pools-2026-09-12.json)
records these results; the table above preserves the initial research snapshot.

The SDK build, TypeScript checks across the TypeScript workspaces, and all 125 unit
tests passed. The local API using the revised defaults also returned two-hop quotes
against live Robinhood pools in both directions: USDG → WETH → PONS and
PONS → WETH → USDG. These read-only quote results are included in the evidence file;
no swap transactions were sent. The existing opt-in fork/integration suites were skipped.

Edit each chain's `baseTokens` metadata in the registry to revise the shared SDK/API
defaults. BNB's existing list is unchanged. Production configuration currently inherits
these defaults; subsequent revisions require an API build and deployment.

For an API-specific list, a nonempty `chains[].baseTokens` address array in
`CHAINS_CONFIG_FILE` replaces the default preset for that chain. Include WETH explicitly
in such an override if it should remain a preset. Single-chain deployments can instead
use `ROUTING_BASE_TOKENS`. SDK callers can pass `RoutingConfig.baseTokens` as `Token[]`.
These overrides retain endpoint and neighbor discovery. Review candidates as Topaz
pools appear: keep tokens that connect useful counterparties and remove presets that
only expand costly route enumeration without improving quotes.

# Quotes on multiple chains

The routing API can serve any configured EVM deployment. Each request stays on one chain; this is not a bridge quote. The existing default is BNB Chain (56). Robinhood (4663), Base (8453) and Ethereum (1) are configured with their deployed factories, quoters, wrapped ETH, Universal Routers and unified subgraphs.

## Run BNB, Robinhood, Base and Ethereum together

From the repository root:

```bash
yarn build
CHAINS_CONFIG_FILE=config/chains.example.json yarn workspace @topazdex/routing-api start
```

The JSON file contains a default `chainId` and a `chains` array. Each entry can set `rpcUrl` or `rpcUrls`, `subgraphUrl`, `subgraphCacheTtlMs`, `universalRouterAddress`, `baseTokens` (token addresses), `multicallBatchSize`, `multicallConcurrency` and `quoteCacheTtlMs`. Supply production RPC endpoints in your deployment configuration. The example uses public defaults. Top-level `corsOrigins` applies to the server.

The Fly deployment uses [chains.production.json](../config/chains.production.json), included in the Docker image, to enable BNB, Robinhood, Base and Ethereum with public RPCs. Requests without `chainId` default to BNB. Add future deployed chains to that file before deploying the API.

Ethereum contract and subgraph configuration is recorded in [the chain registry](../packages/sdk-core/src/chains.ts).

Pool discovery is cached separately from quote responses. The production spoke entries set
`subgraphCacheTtlMs` to 30000 (30 seconds); BNB retains the SDK default of five minutes. Newly
indexed pools appear after that cache expires. `skipCache=true` and `Cache-Control: no-cache`
recompute the quote using live pool state while retaining the discovery cache. Single-chain servers can set
`SUBGRAPH_CACHE_TTL_MS`; SDK callers can set `RoutingConfig.refreshPools` for a fresh discovery.

For a single Robinhood instance:

```bash
CHAIN_ID=4663 RPC_URL=https://rpc.mainnet.chain.robinhood.com \
  yarn workspace @topazdex/routing-api start
```

Single-chain environment settings include `RPC_URL`, comma-separated `RPC_URLS`, `SUBGRAPH_URL`, `UNIVERSAL_ROUTER_ADDRESS`, `ROUTING_BASE_TOKENS`, `MULTICALL_BATCH_SIZE`, `MULTICALL_CONCURRENCY`, `QUOTE_CACHE_TTL_MS` and `CORS_ORIGINS`. `BSC_MAINNET_RPC` and `BSC_RPC_URLS` remain supported only for chain 56. When `CHAINS_CONFIG_FILE` is set, that file supplies the server configuration; `ROUTING_RPC_URLS_{chainId}` secret overrides still apply and `PORT` selects the listening port. See [hardening status and limits](../ROUTING_API_HARDENING.md); the prepared two-instance configuration has not been deployed.

## Request and response

Pass `chainId` in the GET query or POST body. Omission uses the server's default chain. Invalid or disabled chain IDs return 400. Each chain has separate RPC, token, pool-list and quote caches. RPC network identity is checked before quotes, including each failover endpoint.

```json
{
  "chainId": 4663,
  "tokenIn": "ETH",
  "tokenOut": "0xYourTokenAddress",
  "amount": "1000000000000000",
  "type": "exactIn"
}
```

`native`, the zero address, and the selected chain's native symbol (`BNB` or `ETH`) resolve to its native currency. Other tokens use ERC20 addresses. Amounts use the selected token's decimals. Successful quotes include `chainId`; `/health` adds `chainIds` for servers configured with a `chains` array. Adding `recipient` requests Universal Router calldata. The wallet network and Permit2 signing domain must use the response's chain ID.

Gas costs use the chain's wrapped native token. They remain heuristic execution estimates; separate L1 data fees on rollups are not included. Wallets should estimate transaction fees before execution.

## Unified pool discovery

The [intermediary token starter lists](INTERMEDIARY_TOKENS.md) document the per-chain
presets, verified addresses, research sources and override options. Other intermediaries
are also discovered from pools touching the traded tokens.

The adapter follows `../topaz-api/topaz-spoke-subgraph/schema.graphql`. Both v2 and CL queries go to one endpoint, using `pools`, `poolType`, `entityKind: USER`, the configured factory, raw reserves and liquidity. It verifies `chainState(id: "chain").chainId`. Protocol system pools are excluded. Token metadata can be resolved through RPC when the graph has no decimals. Pool addresses must match the selected chain's factory and clone implementation.

The unified schema has no USD reserve field. Unpriced pools remain discoverable; v2 candidates are ordered by raw token0 reserves and CL candidates by liquidity. As before, discovery is bounded by `subgraphPoolCount` (default 500 per protocol). These rankings are not cross-token USD comparisons. Final reserves, liquidity and fees come from RPC at the quote block.

BNB continues using its existing separate v2/v3 graphs. Setting its `subgraphUrl` switches it to the unified adapter. Robinhood is pinned to the version supplied at deployment:

```text
https://api.goldsky.com/api/public/project_cmgzljqwl006c5np2gnao4li4/subgraphs/topaz-chain-robinhood/r-8b4f23a5d335-4f8e4a2e72c2beff/gn
```

Both queries succeeded against the Robinhood and Base endpoints at initial deployment on September 11, 2026 (Vancouver), when both graphs and their factories reported zero pools. Robinhood now indexes liquid CL pools, including WETH/PONS. Exact-input and exact-output quotes for that pair and simulations of their returned Universal Router calldata passed after the discovery-cache fix. A pair still needs indexed liquidity to produce a route.

On September 12, 2026 UTC, the unified graphs reported three Robinhood user pools
(WETH/USDG, WETH/PONS and CASHCAT/WETH), one Base pool (WETH/USDC), and one Ethereum
pool (WETH/USDC). All reported no indexing errors. Production exact-input and exact-output
quotes passed for BNB/USDT, Robinhood ETH/USDG, Base ETH/USDC and Ethereum ETH/USDC.
Native-input swap simulations passed on all three spokes; reverse USDC-to-ETH quotes
passed on Base and Ethereum. CASHCAT → WETH → PONS also quoted successfully on Robinhood.
The existing API deployment discovered the pools automatically. See
[the live pool verification evidence](evidence/all-chains-live-pools-2026-09-12.json).

## Add another EVM chain

Shared deployment metadata lives in `packages/sdk-core/src/chains.ts`. SDK consumers can call `registerChain()` before constructing routers. The API also accepts a `deployment` object in each chain entry, merging it into a known chain or supplying a complete new `ChainDeployment`. That makes additional deployments configurable without modifying routing logic.

Provide:

- EVM chain ID, RPC endpoints, native name/symbol/decimals and wrapped-native address.
- v2 factory and Pool implementation, CL factory and CLPool implementation.
- MixedRouteQuoterV1 for exact input and QuoterV2 for CL exact output.
- Multicall3 and the unified subgraph endpoint.
- A compatible Topaz Universal Router and its Permit2 deployment for executable swaps.
- Optional routing hub token metadata or `baseTokens` addresses. Other intermediaries are discovered from pools.

Use the actual per-chain deployment records; matching spoke addresses are not assumed. Missing subgraphs and quoters produce configuration errors instead of using BNB contracts. A quote without `recipient` does not require Universal Router deployment. Then add the new chain ID to the enabled `chains` array. Base is already included in the example configuration.

## Robinhood Universal Router

Deployed address: **`0x268d1C8a538Ecf6628838C11d581e1EABD13D6A4`**.

Transaction: [`0xf6df9f7454c626e00c62eddcab0c9f9b89cf85ec4a4fee7b633d22fc666d4a2b`](https://robinhoodchain.blockscout.com/tx/0xf6df9f7454c626e00c62eddcab0c9f9b89cf85ec4a4fee7b633d22fc666d4a2b), block **60779600**, fee **0.000362482647356 ETH**.

The full public receipt summary, constructor parameters and bytecode hashes are in [robinhood-deployment.json](../packages/universal-router/deployment-addresses/robinhood-deployment.json). Creation input was checked against the compiled artifact and constructor arguments. Five tests passed against the deployed runtime on a Robinhood fork: bytecode/immutables, native v2 exact input, Permit2 v2 exact output, CL output to native ETH, and native CL exact output. Pools and liquidity for those tests existed only in the local fork.

```bash
ROBINHOOD_RPC_URL=https://rpc.mainnet.chain.robinhood.com \
ROBINHOOD_UNIVERSAL_ROUTER=0x268d1C8a538Ecf6628838C11d581e1EABD13D6A4 \
  forge test --root packages/universal-router --match-contract RobinhoodForkTest
```

Robinhood source verification passed on [Sourcify](https://repo.sourcify.dev/4663/0x268d1C8a538Ecf6628838C11d581e1EABD13D6A4) for both creation and runtime bytecode on September 12, 2026 UTC. Publication on Blockscout remains pending: direct API calls receive a browser challenge, and authenticated shared-API submissions/imports return HTTP 500. The API key is accepted for reads. Preserve the deployment artifact and [verification manifest](../packages/universal-router/deployment-addresses/router-verification-manifest.json); via-IR output depends on the compilation unit. See [source verification details](DEPLOYMENT.md).

## Base Universal Router

Deployed address: **`0xe4b23F13b24232C1E68AD0575191216152AA9480`**.

Transaction: [`0x72bcf4bae1e30dba5d1d03e5d21fb25a85c3dba48d17ae822fe01b33e90c6e18`](https://basescan.org/tx/0x72bcf4bae1e30dba5d1d03e5d21fb25a85c3dba48d17ae822fe01b33e90c6e18), block **51197232**. Execution fee: **0.00001765603362084 ETH**, plus the receipt's L1 fee of **45,271,393,609 wei**.

The [Base deployment record](../packages/universal-router/deployment-addresses/base-deployment.json) contains the constructor and bytecode checks. Both deployments retain their exact compiler artifacts alongside those records, so future compiler-unit changes cannot erase the deployment evidence. [BaseScan source verification](https://basescan.org/address/0xe4b23F13b24232C1E68AD0575191216152AA9480#code) passed on September 12, 2026 UTC; the published sources and constructor arguments match our records.

Base's `MixedRouteQuoterV1` is `0xA9Cd3aC90513663197E7Fd6c932f63f0C40701be` and `QuoterV2` is `0x2e7395A6E0De6eE1f390bEcE891069Cd18Ff8572`. They differ from Robinhood's; the SDK selects them by chain ID.

```text
https://api.goldsky.com/api/public/project_cmgzljqwl006c5np2gnao4li4/subgraphs/topaz-chain-base/r-8b4f23a5d335-b4f259122be58576/gn
```

Run the same five contract checks with `BASE_RPC_URL` and `BASE_UNIVERSAL_ROUTER` set, selecting `--match-contract BaseForkTest`. `packages/smart-order-router/src/spokes.test.ts` also tests complete exact-input and exact-output quotes followed by execution on local forks of both spokes. Set `ROBINHOOD_RPC_URL` and `BASE_RPC_URL` to run those tests; public subgraph discovery is replaced only for the temporary fork pools.

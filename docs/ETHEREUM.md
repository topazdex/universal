# Ethereum deployment

Ethereum uses chain ID **1**, native **ETH**, and WETH at
`0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2`.

Ethereum is enabled in the production and example API configurations alongside BNB, Robinhood
and Base. Requests without `chainId` still default to BNB.

Universal Router: **`0x606794d37991A426a189fD9FA8664D339A77f8ae`**.

Transaction: [`0x292d58b69f4cd791bd7a60b9c179177003dc644726a2da92eb8956107da5636c`](https://etherscan.io/tx/0x292d58b69f4cd791bd7a60b9c179177003dc644726a2da92eb8956107da5636c),
block **25958895**, fee **0.000233756134054908 ETH**.

The [deployment record](../packages/universal-router/deployment-addresses/ethereum-deployment.json)
contains the receipt summary, constructor parameters and bytecode hashes. All 27 artifact source
hashes matched the repository. Creation input matched the archived compiler artifact, and the
runtime and immutable parameters passed the fork comparison. Explorer source verification
remains pending.

## Deployment inputs

Imported from `../xTopaz` Ethereum deployment records on 2026-09-12:

| Contract | Address | Deployment block |
| --- | --- | --- |
| v2 PoolFactory | `0x1E3aC31cF96b20619c913384C9bf6010A824fB95` | 25958707 |
| v2 Pool implementation | `0x8776BE6cd50BB78414c655bc8bF9e86A0989722F` | 25958705 |
| CLFactory | `0xaa5865dC3A60b25D305226d66fd573021f0D8fFB` | 25958738 |
| CLPool implementation | `0x2DaA7cF731334b4Cd1c2E4E01E97Ca67F4B9C6AE` | 25958736 |
| MixedRouteQuoterV1 | `0x39A344d192D1D34a6Bee24DCF11093e93Fbb3993` | 25958763 |
| QuoterV2 | `0xA9Cd3aC90513663197E7Fd6c932f63f0C40701be` | 25958765 |

The v2 `implementation()` and CL `poolImplementation()` links were checked over Ethereum RPC.
Code was also checked for WETH, canonical Permit2
(`0x000000000022D473030F116dDEE9F6B43aC78BA3`) and Multicall3
(`0xcA11bde05977b3631167028862bE2a173976CA11`). Use each contract's Ethereum record even when
its address happens to match another spoke.

The quote contracts were imported from
`../xTopaz/topaz-slipstream/deployments/ethereum/{MixedRouteQuoterV1,QuoterV2}.json` and checked at
Ethereum block 25958768: both have code and the correct CL factory and WETH; the mixed quoter's
v2 factory also matches.
The unified graph uses `../topaz-api/topaz-spoke-subgraph/schema.graphql`:

```text
https://api.goldsky.com/api/public/project_cmgzljqwl006c5np2gnao4li4/subgraphs/topaz-chain-ethereum/r-8b4f23a5d335-51fb901bfc78d0a8/gn
```

At activation it reported chain ID 1, no indexing errors, and had indexed past all factory
creation blocks. Its first WETH/USDC CL pool, `0x1265e0ca0f4c107e2e4523e7de12180a7b14a8b1`,
was confirmed indexed on September 12, 2026 UTC. Production exact-input and exact-output
ETH-to-USDC quotes and simulations of their returned Universal Router calldata passed;
USDC-to-ETH quoting also passed. [Live verification evidence](evidence/all-chains-live-pools-2026-09-12.json)
records the quote blocks and pool state. Pool discovery picked up the liquidity without
another API deployment.

## Router rehearsal

[Etherscan source verification](https://etherscan.io/address/0x606794d37991A426a189fD9FA8664D339A77f8ae#code)
passed on September 12, 2026 UTC. The published 60-source compiler input and constructor
arguments match the reproduced deployment. See [the verification evidence](evidence/universal-router-source-verification-2026-09-12.json)
and [preparation instructions](DEPLOYMENT.md#reproduce-the-recorded-spoke-deployments).

Set `ETHEREUM_RPC_URL` to an Ethereum RPC. The public default is
`https://ethereum-rpc.publicnode.com`; fork tests need recent historical-state access.

From `packages/universal-router`, verify deployment inputs without a key or broadcast:

```bash
forge script script/deployParameters/DeployEthereumMainnet.s.sol:DeployEthereumMainnet \
  --rpc-url ethereum --sig 'verifyParams()'
```

Then rehearse native v2 exact input, Permit2 v2 exact output, CL output to native ETH and native
CL exact output using temporary pools on a local fork:

```bash
forge test --match-contract EthereumForkTest -vv
```

The API/SDK quote path can also be rehearsed against actual Ethereum factories, quoters and the
recorded Universal Router on a local Anvil fork. After building the workspaces and running the contract
suite above, run from the repository root:

```bash
ETHEREUM_RPC_URL="$ETHEREUM_RPC_URL" yarn workspace @topazdex/smart-order-router test \
  --runInBand --runTestsByPath src/spokes.test.ts --testNamePattern='Ethereum'
```

These tests create a temporary v2 pool, quote native ETH exact input and exact output, execute the
returned calldata, and check token balances. Only subgraph discovery is supplied by the fixture,
since the public graph cannot index pools inside a local fork.

Set `ETHEREUM_UNIVERSAL_ROUTER=0x606794d37991A426a189fD9FA8664D339A77f8ae` for the contract
suite to check the live deployment. Preserve `deployment-addresses/ethereum-router-artifact.json`:
via-IR compilation can vary with the compilation unit. The archived artifact reproduces the
exact deployed creation code.

Five contract fork checks passed against the deployed runtime: bytecode/immutables, native v2
exact input, Permit2 v2 exact output, CL output to native ETH, and native CL exact output. Both
end-to-end Ethereum quote/execution tests passed against that router. Pools and liquidity for
those tests existed only inside the fork.

## API requests

Use `chainId=1`, `tokenIn=ETH` for native input, and Ethereum ERC20 addresses. The wallet and
Permit2 signing domain must also use chain ID 1. To run a single-chain API locally:

```bash
CHAIN_ID=1 RPC_URL="$ETHEREUM_RPC_URL" yarn workspace @topazdex/routing-api start
```

Leave `CHAINS_CONFIG_FILE` unset for that command; it takes precedence over single-chain
environment settings. The public RPC default is `https://ethereum-rpc.publicnode.com`.

Production caches Ethereum pool discovery for 30 seconds. `skipCache=true` or the
`Cache-Control: no-cache` header refreshes discovery as well as the quote response.

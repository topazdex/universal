# @topazdex/universal-router

Topaz Dex fork of the Universal Router. One entrypoint that batches swaps, wrapping, Permit2 pulls
and fee payments across both Topaz stacks:

- **Topaz v2** — Solidly pools, volatile (`xy=k`) and stable (`x³y+xy³=k`), addressed by
  `(token0, token1, stable)`
- **Topaz CL** — Slipstream concentrated liquidity, addressed by `(token0, token1, tickSpacing)`

## Lineage

Forked from [velodrome-finance/universal-router](https://github.com/velodrome-finance/universal-router)
(`v1` branch), itself a fork of [Uniswap/universal-router](https://github.com/Uniswap/universal-router) v1.6.
Velodrome's fork already replaced Uniswap V2 pairs with Solidly pools and Uniswap V3 pools with Slipstream
CL pools, which is exactly the shape of Topaz. On top of that this fork:

- retargets every immutable at the Topaz BNB Chain deployment (`script/constants/BscMainnet.sol`)
- deletes the NFT marketplace commands (Seaport, LooksRare, NFTX, X2Y2, Foundation, Sudoswap, Element,
  CryptoPunks, NFT20), the LooksRare `RewardsCollector`, the ERC721/ERC1155 payment paths and the
  Mode chain fee-sharing extension — none of which exist on BNB Chain
- adds `TRANSFER_FROM` (`0x07`) so integrators can pull funds with a plain ERC20 approval
- restricts `receive()` to WBNB, so stray BNB can no longer be sent to the router
- replaces CreateX deterministic deployment with a plain deploy script that cross-checks the clone
  implementations against the live factories before broadcasting

Command IDs that survive keep their upstream values, so calldata encoders written against the Uniswap or
Velodrome routers stay valid. Removed commands are left permanently unused rather than renumbered.

## Pool addressing

Both Topaz factories deploy pools as ERC-1167 clones, so the router derives pool addresses locally
instead of calling the factory:

| stack | salt | deployer | implementation |
| --- | --- | --- | --- |
| v2 | `keccak256(abi.encodePacked(token0, token1, stable))` | `PoolFactory` | `PoolFactory.implementation()` |
| CL | `keccak256(abi.encode(token0, token1, tickSpacing))` | `CLFactory` | `CLFactory.poolImplementation()` |

`test/fork/PoolAddresses.t.sol` asserts the derived addresses equal what the live factories report.

## Commands

| value | command | notes |
| --- | --- | --- |
| `0x00` | `V3_SWAP_EXACT_IN` | Topaz CL. Path is `token (20) ‖ tickSpacing (3) ‖ token (20) …` |
| `0x01` | `V3_SWAP_EXACT_OUT` | Path is encoded in reverse, `tokenOut … tokenIn` |
| `0x02` | `PERMIT2_TRANSFER_FROM` | |
| `0x03` | `PERMIT2_PERMIT_BATCH` | |
| `0x04` | `SWEEP` | |
| `0x05` | `TRANSFER` | |
| `0x06` | `PAY_PORTION` | interface fees, in bips |
| `0x07` | `TRANSFER_FROM` | plain approval pull, falls back to Permit2 |
| `0x08` | `V2_SWAP_EXACT_IN` | Topaz v2. Routes are `Route[]` of `(from, to, stable)` |
| `0x09` | `V2_SWAP_EXACT_OUT` | volatile pools only, see below |
| `0x0a` | `PERMIT2_PERMIT` | |
| `0x0b` | `WRAP_ETH` | BNB → WBNB |
| `0x0c` | `UNWRAP_WETH` | WBNB → BNB |
| `0x0d` | `PERMIT2_TRANSFER_FROM_BATCH` | |
| `0x0e` | `BALANCE_CHECK_ERC20` | |
| `0x21` | `EXECUTE_SUB_PLAN` | |

Mixed routes are expressed as consecutive commands: swap into `ADDRESS_THIS`, then feed the next command
with `CONTRACT_BALANCE` and `payerIsUser = false`.

**Stable pools cannot serve exact output.** The Solidly stable invariant has no closed form inverse, so
`V2_SWAP_EXACT_OUT` reverts with `StableExactOutputUnsupported` for `stable = true` routes, matching
upstream Velodrome. Route builders must plan exact-output trades over volatile or CL pools.

## Tests

Everything is a fork test against live BNB Chain mainnet state. Expected amounts are not hardcoded: they
come from Topaz's own deployed quoters, so a passing suite means the router agrees with the pricing
infrastructure the smart order router uses.

| file | covers |
| --- | --- |
| `PoolAddresses.t.sol` | clone derivation vs the live factories |
| `TopazV2.t.sol` | volatile/stable exact in & out, multi-hop, BNB in/out, Permit2 and plain approval |
| `TopazCL.t.sol` | CL exact in & out, multi-hop, BNB in/out, callback authentication, vs `QuoterV2` |
| `TopazMixed.t.sol` | CL↔v2 routes and split routes, vs `MixedRouteQuoterV1` |
| `UniversalRouter.t.sol` | deadlines, command validation, revert flags, sub-plans |

```bash
cp ../../.env.example ../../.env   # set BSC_MAINNET_RPC
forge test
```

`FORK_BLOCK` pins the fork for reproducibility; unset it to run against the chain tip.

## Deploy

```bash
PRIVATE_KEY=0x… forge script script/deployParameters/DeployBscMainnet.s.sol:DeployBscMainnet \
  --rpc-url bsc --broadcast

# verification needs its own step, see docs/DEPLOYMENT.md for why --verify cannot work here
ETHERSCAN_API_KEY=… python3 script/verify-bscscan.py 0xDeployedAddress
```

Deployed on BNB Chain mainnet at
[`0x691e6171e0a434FfE5C9f1759621D05b9efcF6A6`](https://bscscan.com/address/0x691e6171e0a434FfE5C9f1759621D05b9efcF6A6),
verified, and byte-for-byte identical to this source (`DeployedRouterForkTest`).

The script reverts before broadcasting if `PoolFactory.implementation()` or `CLFactory.poolImplementation()`
no longer match the configured constants, since a stale implementation would silently derive pool addresses
that do not exist.

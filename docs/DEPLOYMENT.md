# Deploying the Universal Router

| chain | address | source verified |
| --- | --- | --- |
| BNB Chain mainnet (56) | [`0x691e6171e0a434FfE5C9f1759621D05b9efcF6A6`](https://bscscan.com/address/0x691e6171e0a434FfE5C9f1759621D05b9efcF6A6) | BscScan ✓, plus `DeployedRouterForkTest` byte for byte |

To re-verify a deployment, or to run the whole behavioural suite against the live contract rather
than one deployed into the fork:

```bash
cd packages/universal-router
DEPLOYED_UNIVERSAL_ROUTER=0x691e6171e0a434FfE5C9f1759621D05b9efcF6A6 forge test
```

The router's parameters are immutable and baked into its runtime code, so deploying this source with
the same parameters and comparing code proves both that the deployment is this source and that it
was handed the right factories.

The rest of this page is what deploying involves.

## 1. Check the parameters still hold

Both Topaz factories deploy pools as ERC-1167 clones, so the router derives pool addresses from the
clone implementation. If an implementation address in
[`script/constants/BscMainnet.sol`](../packages/universal-router/script/constants/BscMainnet.sol)
were stale, every derived address would point at nothing and every swap would revert with an opaque
error. The deploy script therefore refuses to broadcast unless the live factories agree:

```bash
cd packages/universal-router
forge test --match-contract PoolAddressesForkTest -vv
```

## 2. Deploy

```bash
cd packages/universal-router
PRIVATE_KEY=0x… forge script \
  script/deployParameters/DeployBscMainnet.s.sol:DeployBscMainnet \
  --rpc-url bsc --broadcast
```

Do not pass `--verify`: it fails for this project for the reason explained in step 3. Verify
afterwards with the script there.

The address is written to `deployment-addresses/bsc.json`.

Constructor parameters, all immutable afterwards:

| parameter | value |
| --- | --- |
| `permit2` | `0x000000000022D473030F116dDEE9F6B43aC78BA3` |
| `weth9` | WBNB `0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c` |
| `v2Factory` | `PoolFactory` `0x65E6cD0eF5D3467030103cf3d433034E570b5784` |
| `v2Implementation` | `Pool` `0xdC942D8e37cC20BCf9aD1Fe0111eE6c5908f3678` |
| `clFactory` | `CLFactory` `0x73DC984D9490286E735548f61dfCCec67Af82ed9` |
| `clImplementation` | `CLPool` `0x18e68051d1b1fB44cb539cA4436F112D28577AF7` |

The router holds no funds, has no owner and no upgrade path. Redeploying is the only way to change a
parameter, which is why the factories are cross-checked first.

## 3. Verify on BscScan

**`forge verify-contract` does not work for this project.** Use:

```bash
cd packages/universal-router
ETHERSCAN_API_KEY=… python3 script/verify-bscscan.py 0x691e6171e0a434FfE5C9f1759621D05b9efcF6A6
```

Why the standard tooling fails here is worth understanding, because it will recur on every deploy:

- The project builds with `via_ir = true`, and under via-IR a contract's bytecode depends on the
  **whole compilation unit**, not only the files reachable from it.
- Foundry compiles the entire project — contracts, tests and scripts — in one solc invocation, 60
  sources for this package.
- `forge verify-contract --show-standard-json-input` emits only the 27 sources reachable from
  `UniversalRouter.sol`. Those compile to bytecode 392 bytes shorter than what was deployed, so
  Etherscan correctly rejects it with *"Compiled contract deployment bytecode does NOT match the
  transaction deployment bytecode"*.

`script/verify-bscscan.py` sidesteps this by capturing the exact JSON foundry hands solc — it runs
`forge build --force --use <wrapper>` where the wrapper tees stdin — and submitting that. It touches
nothing outside a temp directory.

The same trap applies to any other verifier (Sourcify included) fed the reachable-subset input.

## 4. Record the address

Add it to `UNIVERSAL_ROUTER_ADDRESSES` in
[`packages/universal-router-sdk/src/constants.ts`](../packages/universal-router-sdk/src/constants.ts):

```ts
export const UNIVERSAL_ROUTER_ADDRESSES: { [chainId: number]: string } = {
  56: '0x691e6171e0a434FfE5C9f1759621D05b9efcF6A6'
}
```

Once recorded, `TopazRouter` and the routing API resolve it from the chain id. They still accept an
explicit `universalRouterAddress` / `UNIVERSAL_ROUTER_ADDRESS`, which is how the fork tests point at
a router deployed into their own fork.

## 5. What users must approve

The router pulls funds two ways, and tries them in this order:

1. **A plain ERC20 approval** to the router address. Simplest, and what the `NoPermit2` tests cover.
2. **Permit2.** The user approves Permit2 once per token, then either approves the router on Permit2
   or signs a `PERMIT2_PERMIT` that rides along in the same transaction.

Nothing needs approving for native BNB: it arrives as `msg.value` and is wrapped by the router.

## 6. Sanity check after deploying

Re-run the fork suites against the real deployment by pointing the tests at it, and quote something
end to end:

```bash
UNIVERSAL_ROUTER_ADDRESS=0x… yarn workspace @topazdex/routing-api start
curl 'localhost:3000/quote?tokenIn=BNB&tokenOut=0x55d398326f99059fF775485246999027B3197955&amount=100000000000000000&recipient=0x…'
```

Simulate the returned calldata (`cast call --from <recipient> <to> <calldata> --value <value>`)
before sending anything real.

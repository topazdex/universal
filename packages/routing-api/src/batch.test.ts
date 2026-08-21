import { USDT } from '@topazdex/sdk-core'
import { CommandType, PERMIT2_ADDRESS, SwapRouter } from '@topazdex/universal-router-sdk'
import { createFundedWallet, pickPort, startAnvilFork } from '@topazdex/universal-router-sdk/dist/test-utils/anvil'
import { deployUniversalRouter } from '@topazdex/universal-router-sdk/dist/test-utils/deployRouter'
import { BigNumber, Contract, constants, providers, Wallet } from 'ethers'
import type { Express } from 'express'
import request from 'supertest'

import { createApp } from './server'

const RPC = process.env.BSC_MAINNET_RPC
const FORK_BLOCK = process.env.FORK_BLOCK ? Number(process.env.FORK_BLOCK) : undefined

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)'
]
const PERMIT2_ABI = [
  'function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)',
  'function approve(address token, address spender, uint160 amount, uint48 expiration)'
]

const MAX_UINT160 = BigNumber.from(2).pow(160).sub(1)

/** The command bytes inside `execute` calldata, allow-revert flag stripped */
function commandsIn(calldata: string): number[] {
  const commands = SwapRouter.INTERFACE.parseTransaction({ data: calldata }).args.commands as string
  const bytes: number[] = []
  for (let index = 2; index < commands.length; index += 2) {
    bytes.push(parseInt(commands.slice(index, index + 2), 16) & 0x3f)
  }
  return bytes
}

const describeIfRpc = RPC ? describe : describe.skip

describeIfRpc('quoting for an EIP-5792 batch, where the Permit2 allowance is granted in-batch', () => {
  jest.setTimeout(600_000)

  let anvil: { provider: providers.JsonRpcProvider; stop: () => void }
  let signer: Wallet
  let app: Express
  let routerAddress: string
  let usdt: Contract
  let permit2: Contract

  beforeAll(async () => {
    const port = pickPort(1700)
    anvil = await startAnvilFork({ rpcUrl: RPC as string, blockNumber: FORK_BLOCK, port })
    signer = await createFundedWallet(anvil.provider, 'topaz-batch-test-account')

    const router = await deployUniversalRouter(signer)
    routerAddress = router.address
    app = createApp({ rpcUrl: `http://127.0.0.1:${port}`, universalRouterAddress: routerAddress })

    usdt = new Contract(USDT.address, ERC20_ABI, anvil.provider)
    permit2 = new Contract(PERMIT2_ADDRESS, PERMIT2_ABI, anvil.provider)

    // buy USDT with BNB so there is something to swap back
    const funding = await request(app).get('/quote').query({
      tokenIn: 'BNB',
      tokenOut: USDT.address,
      amount: '500000000000000000',
      recipient: signer.address
    })
    const { to, calldata, value } = funding.body.methodParameters
    await (await signer.sendTransaction({ to, data: calldata, value, gasLimit: 5_000_000 })).wait()
  }, 300_000)

  afterAll(() => anvil?.stop())

  it('returns permit-free calldata that succeeds behind the batch approvals', async () => {
    // #given no approval of any kind exists yet — the batch will grant both
    expect((await usdt.allowance(signer.address, PERMIT2_ADDRESS)).toString()).toEqual('0')
    const { amount: permitted } = await permit2.allowance(signer.address, USDT.address, routerAddress)
    expect(permitted.toString()).toEqual('0')

    // #when quoted with the allowance promised in-batch
    const amount = '10000000000000000000' // 10 USDT
    const response = await request(app).post('/quote').send({
      tokenIn: USDT.address,
      tokenOut: 'BNB',
      amount,
      type: 'exactIn',
      recipient: signer.address,
      slippageBips: 100,
      permitGrantedInBatch: true
    })

    // #then the calldata carries no PERMIT2_PERMIT command
    expect(response.status).toEqual(200)
    const { to, calldata, value } = response.body.methodParameters
    expect(commandsIn(calldata)).not.toContain(CommandType.PERMIT2_PERMIT)

    // #then it executes as the third call of the batch the client will build
    await (await usdt.connect(signer).approve(PERMIT2_ADDRESS, constants.MaxUint256)).wait()
    const expiration = Math.floor(Date.now() / 1000) + 30 * 24 * 3600
    await (await permit2.connect(signer).approve(USDT.address, to, MAX_UINT160, expiration)).wait()

    const before = await anvil.provider.getBalance(signer.address)
    const usdtBefore = await usdt.balanceOf(signer.address)
    const receipt = await (
      await signer.sendTransaction({ to, data: calldata, value, gasLimit: 5_000_000 })
    ).wait()

    expect(receipt.status).toEqual(1)
    expect(usdtBefore.sub(await usdt.balanceOf(signer.address)).toString()).toEqual(amount)

    const gas = receipt.gasUsed.mul(receipt.effectiveGasPrice)
    const received = (await anvil.provider.getBalance(signer.address)).sub(before).add(gas)
    expect(received.toString()).toEqual(response.body.quote)
  })

  it('supports exact output the same way', async () => {
    // #given the allowances granted by the previous test's batch are standing

    // #when an exact BNB output is quoted with the flag
    const amount = '5000000000000000' // 0.005 BNB out
    const response = await request(app).post('/quote').send({
      tokenIn: USDT.address,
      tokenOut: 'BNB',
      amount,
      type: 'exactOut',
      recipient: signer.address,
      slippageBips: 100,
      permitGrantedInBatch: true
    })

    // #then the calldata is permit-free and delivers exactly the requested output
    expect(response.status).toEqual(200)
    const { to, calldata, value } = response.body.methodParameters
    expect(commandsIn(calldata)).not.toContain(CommandType.PERMIT2_PERMIT)

    const before = await anvil.provider.getBalance(signer.address)
    const usdtBefore = await usdt.balanceOf(signer.address)
    const receipt = await (
      await signer.sendTransaction({ to, data: calldata, value, gasLimit: 5_000_000 })
    ).wait()

    expect(receipt.status).toEqual(1)
    const gas = receipt.gasUsed.mul(receipt.effectiveGasPrice)
    const received = (await anvil.provider.getBalance(signer.address)).sub(before).add(gas)
    expect(received.toString()).toEqual(amount)
    expect(usdtBefore.sub(await usdt.balanceOf(signer.address)).toString()).toEqual(response.body.quote)
  })

  it('ignores a permit supplied alongside the flag, even a malformed one', async () => {
    // #given a permit that would be rejected as malformed on the normal POST path
    const permit = { spender: routerAddress, sigDeadline: 1, signature: '0x00' }

    // #when both the permit and the flag are sent
    const response = await request(app).post('/quote').send({
      tokenIn: USDT.address,
      tokenOut: 'BNB',
      amount: '1000000000000000000',
      type: 'exactIn',
      recipient: signer.address,
      permitGrantedInBatch: true,
      permit
    })

    // #then the permit is ignored rather than validated or encoded
    expect(response.status).toEqual(200)
    expect(commandsIn(response.body.methodParameters.calldata)).not.toContain(CommandType.PERMIT2_PERMIT)
  })

  it('accepts the flag on the GET form', async () => {
    // #when the flag arrives as a query-string 'true'
    const response = await request(app).get('/quote').query({
      tokenIn: USDT.address,
      tokenOut: 'BNB',
      amount: '2000000000000000000',
      recipient: signer.address,
      permitGrantedInBatch: 'true'
    })

    // #then it is honoured exactly as on the POST form
    expect(response.status).toEqual(200)
    expect(commandsIn(response.body.methodParameters.calldata)).not.toContain(CommandType.PERMIT2_PERMIT)
  })

  it('is a no-op for a native input', async () => {
    // #when a BNB input, which never touches Permit2, carries the flag
    const response = await request(app).get('/quote').query({
      tokenIn: 'BNB',
      tokenOut: USDT.address,
      amount: '10000000000000000',
      recipient: signer.address,
      permitGrantedInBatch: 'true'
    })

    // #then the quote is the ordinary native one, funds carried as msg.value
    expect(response.status).toEqual(200)
    const { calldata, value } = response.body.methodParameters
    expect(BigNumber.from(value).gt(0)).toEqual(true)
    expect(commandsIn(calldata)).not.toContain(CommandType.PERMIT2_PERMIT)
  })
})

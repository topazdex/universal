import { USDT } from '@topazdex/sdk-core'
import { PERMIT2_ADDRESS } from '@topazdex/universal-router-sdk'
import { createFundedWallet, pickPort, startAnvilFork } from '@topazdex/universal-router-sdk/dist/test-utils/anvil'
import { deployUniversalRouter } from '@topazdex/universal-router-sdk/dist/test-utils/deployRouter'
import { BigNumber, Contract, constants, providers, Wallet } from 'ethers'
import type { Express } from 'express'
import request from 'supertest'

import { createApp } from './server'

const RPC = process.env.BSC_MAINNET_RPC
const FORK_BLOCK = process.env.FORK_BLOCK ? Number(process.env.FORK_BLOCK) : undefined
const FORK_LIMITS = { rpcTimeoutMs: 120_000, quoteTimeoutMs: 300_000, multicallBatchSize: 5 }

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)'
]
const PERMIT2_ABI = [
  'function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)'
]

/** Exactly what a wallet signs for Permit2, and what the frontend documentation describes */
const PERMIT2_TYPES = {
  PermitDetails: [
    { name: 'token', type: 'address' },
    { name: 'amount', type: 'uint160' },
    { name: 'expiration', type: 'uint48' },
    { name: 'nonce', type: 'uint48' }
  ],
  PermitSingle: [
    { name: 'details', type: 'PermitDetails' },
    { name: 'spender', type: 'address' },
    { name: 'sigDeadline', type: 'uint256' }
  ]
}

const describeIfRpc = RPC ? describe : describe.skip

describeIfRpc('quoting with a Permit2 signature', () => {
  jest.setTimeout(600_000)

  let anvil: { provider: providers.JsonRpcProvider; stop: () => void }
  let signer: Wallet
  let app: Express
  let routerAddress: string
  let usdt: Contract

  beforeAll(async () => {
    const port = pickPort(1300)
    anvil = await startAnvilFork({ rpcUrl: RPC as string, blockNumber: FORK_BLOCK, port })
    signer = await createFundedWallet(anvil.provider, 'topaz-permit-test-account')

    const router = await deployUniversalRouter(signer)
    routerAddress = router.address
    // a cold anvil fork pulls state from upstream on first touch, far slower than any live endpoint
    app = createApp({ rpcUrl: `http://127.0.0.1:${port}`, universalRouterAddress: routerAddress, ...FORK_LIMITS })

    usdt = new Contract(USDT.address, ERC20_ABI, anvil.provider)

    // buy USDT with BNB so there is something to permit
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

  it('pulls funds with a signed permit, with no allowance granted to the router', async () => {
    // #given the token is approved to Permit2 once, and the router itself is never approved
    await (await usdt.connect(signer).approve(PERMIT2_ADDRESS, constants.MaxUint256)).wait()
    expect((await usdt.allowance(signer.address, routerAddress)).toString()).toEqual('0')

    const permit2 = new Contract(PERMIT2_ADDRESS, PERMIT2_ABI, anvil.provider)
    const { nonce } = await permit2.allowance(signer.address, USDT.address, routerAddress)

    const amount = '10000000000000000000' // 10 USDT
    const permit = {
      details: {
        token: USDT.address,
        amount: BigNumber.from(2).pow(160).sub(1).toString(),
        expiration: Math.floor(Date.now() / 1000) + 3600,
        nonce
      },
      spender: routerAddress,
      sigDeadline: Math.floor(Date.now() / 1000) + 1800
    }

    // #when the user signs it and the API is asked for calldata
    const signature = await signer._signTypedData(
      { name: 'Permit2', chainId: 56, verifyingContract: PERMIT2_ADDRESS },
      PERMIT2_TYPES,
      permit
    )

    const response = await request(app)
      .post('/quote')
      .send({
        tokenIn: USDT.address,
        tokenOut: 'BNB',
        amount,
        type: 'exactIn',
        recipient: signer.address,
        slippageBips: 100,
        permit: { ...permit, signature }
      })

    expect(response.status).toEqual(200)

    const before = await anvil.provider.getBalance(signer.address)
    const usdtBefore = await usdt.balanceOf(signer.address)
    const { to, calldata, value } = response.body.methodParameters
    const receipt = await (
      await signer.sendTransaction({ to, data: calldata, value, gasLimit: 5_000_000 })
    ).wait()

    // #then the swap executed off a signature alone
    expect(receipt.status).toEqual(1)
    expect(usdtBefore.sub(await usdt.balanceOf(signer.address)).toString()).toEqual(amount)

    const gas = receipt.gasUsed.mul(receipt.effectiveGasPrice)
    const received = (await anvil.provider.getBalance(signer.address)).sub(before).add(gas)
    expect(received.toString()).toEqual(response.body.quote)
  })

  it('rejects a permit for a token other than the input', async () => {
    const response = await request(app)
      .post('/quote')
      .send({
        tokenIn: USDT.address,
        tokenOut: 'BNB',
        amount: '1000000000000000000',
        recipient: signer.address,
        permit: {
          details: { token: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', amount: '1', expiration: 1, nonce: 0 },
          spender: routerAddress,
          sigDeadline: 1,
          signature: '0xdead'
        }
      })

    expect(response.status).toEqual(400)
    expect(response.body.error).toContain('must be the input token')
  })

  it('rejects a malformed permit', async () => {
    const response = await request(app)
      .post('/quote')
      .send({
        tokenIn: USDT.address,
        tokenOut: 'BNB',
        amount: '1000000000000000000',
        recipient: signer.address,
        permit: { spender: routerAddress, sigDeadline: 1, signature: '0x00' }
      })

    expect(response.status).toEqual(400)
    expect(response.body.error).toContain('permit.details is required')
  })
})

import { USDT } from '@topazdex/sdk-core'
import { createFundedWallet, pickPort, startAnvilFork } from '@topazdex/universal-router-sdk/dist/test-utils/anvil'
import { deployUniversalRouter } from '@topazdex/universal-router-sdk/dist/test-utils/deployRouter'
import { BigNumber, Contract, providers, Wallet } from 'ethers'
import type { Express } from 'express'
import request from 'supertest'

import { createApp } from './server'

const RPC = process.env.BSC_MAINNET_RPC
const FORK_BLOCK = process.env.FORK_BLOCK ? Number(process.env.FORK_BLOCK) : undefined
const ERC20_ABI = ['function balanceOf(address) view returns (uint256)']

const describeIfRpc = RPC ? describe : describe.skip

describeIfRpc('routing-api', () => {
  jest.setTimeout(600_000)

  let anvil: { provider: providers.JsonRpcProvider; stop: () => void }
  let signer: Wallet
  let app: Express
  let routerAddress: string
  let rpcUrl: string

  beforeAll(async () => {
    const port = pickPort(900)
    anvil = await startAnvilFork({ rpcUrl: RPC as string, blockNumber: FORK_BLOCK, port })
    rpcUrl = `http://127.0.0.1:${port}`

    signer = await createFundedWallet(anvil.provider, 'topaz-routing-api-test-account')
    const router = await deployUniversalRouter(signer)
    routerAddress = router.address

    app = createApp({ rpcUrl, universalRouterAddress: routerAddress })
  }, 300_000)

  afterAll(() => anvil?.stop())

  it('reports healthy', async () => {
    const response = await request(app).get('/health')

    expect(response.status).toEqual(200)
    expect(response.body).toEqual({ status: 'ok', chainId: 56 })
  })

  it('quotes native BNB into USDT and describes the hops it chose', async () => {
    const response = await request(app).get('/quote').query({
      tokenIn: 'BNB',
      tokenOut: USDT.address,
      amount: '100000000000000000',
      type: 'exactIn'
    })

    expect(response.status).toEqual(200)
    expect(BigInt(response.body.quote)).toBeGreaterThan(0n)
    expect(response.body.routes.length).toBeGreaterThan(0)
    expect(response.body.routes[0].hops.length).toBeGreaterThan(0)
    expect(['cl', 'v2-volatile', 'v2-stable']).toContain(response.body.routes[0].hops[0].protocol)
    expect(response.body.methodParameters).toBeUndefined()
  })

  it('returns executable calldata when a recipient is supplied', async () => {
    const response = await request(app).get('/quote').query({
      tokenIn: 'BNB',
      tokenOut: USDT.address,
      amount: '100000000000000000',
      type: 'exactIn',
      recipient: signer.address,
      slippageBips: 100
    })

    expect(response.status).toEqual(200)
    const { calldata, value, to } = response.body.methodParameters
    expect(to).toEqual(routerAddress)

    const usdt = new Contract(USDT.address, ERC20_ABI, anvil.provider)
    const before = await usdt.balanceOf(signer.address)
    const receipt = await (
      await signer.sendTransaction({ to, data: calldata, value, gasLimit: 5_000_000 })
    ).wait()
    expect(receipt.status).toEqual(1)

    const received = (await usdt.balanceOf(signer.address)).sub(before)
    const quoted = BigNumber.from(response.body.quote)
    expect(received.gt(0)).toBe(true)
    expect(received.sub(quoted).abs().mul(10_000).div(quoted).toNumber()).toBeLessThanOrEqual(1)
  })

  it('rejects a malformed amount', async () => {
    const response = await request(app).get('/quote').query({
      tokenIn: 'BNB',
      tokenOut: USDT.address,
      amount: '0.1',
      type: 'exactIn'
    })

    expect(response.status).toEqual(400)
    expect(response.body.error).toContain('amount')
  })

  it('rejects a token it cannot resolve', async () => {
    const response = await request(app).get('/quote').query({
      tokenIn: 'BNB',
      tokenOut: '0x000000000000000000000000000000000000dEaD',
      amount: '100000000000000000',
      type: 'exactIn'
    })

    expect(response.status).toEqual(400)
    expect(response.body.error).toContain('could not resolve token')
  })
})

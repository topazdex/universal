import { StaticJsonRpcProvider } from '@ethersproject/providers'
import { spendRpcCall, WorkGate } from './work-budget'

const gate = new WorkGate()
let nextId = 1

/** Node 22 transport: aborts sockets and response bodies, without ethers' hidden HTTP retries. */
export class BoundedRpcProvider extends StaticJsonRpcProvider {
  public constructor(url: string, chainId: number, private readonly timeoutMs = 3_000) {
    super({ url, timeout: timeoutMs }, chainId)
  }

  public async send(method: string, params: unknown[]): Promise<any> {
    if (!['eth_chainId', 'eth_call', 'eth_blockNumber', 'eth_getBlockByNumber', 'eth_gasPrice', 'eth_estimateGas', 'eth_getCode'].includes(method)) {
      throw new Error('Unsupported routing RPC method')
    }
    const parent = spendRpcCall()
    const controller = new AbortController()
    const abort = () => controller.abort(parent?.reason)
    parent?.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(() => controller.abort(new Error('RPC request timeout')), this.timeoutMs)
    try {
      return await gate.run(controller.signal, async () => {
        const id = nextId++
        const response = await globalThis.fetch(this.connection.url, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
          signal: controller.signal, redirect: 'error'
        })
        if (!response.ok) { await response.body?.cancel(); throw new Error(`RPC HTTP ${response.status}`) }
        const reader = response.body?.getReader()
        if (!reader) throw new Error('RPC returned no body')
        const chunks: Uint8Array[] = []
        let size = 0
        try {
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            size += value.byteLength
            if (size > 4 * 1024 * 1024) throw new Error('RPC response too large')
            chunks.push(value)
          }
        } finally { await reader.cancel().catch(() => undefined) }
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        if (body.id !== id || body.jsonrpc !== '2.0') throw new Error('Invalid RPC envelope')
        if (body.error) {
          const message = String(body.error.message ?? 'RPC error').slice(0, 500)
          throw Object.assign(new Error(message), { code: body.error.code, data: body.error.data })
        }
        if (!Object.prototype.hasOwnProperty.call(body, 'result')) throw new Error('Missing RPC result')
        return body.result
      })
    } finally { clearTimeout(timer); parent?.removeEventListener('abort', abort) }
  }
}

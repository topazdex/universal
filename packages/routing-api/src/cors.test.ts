import type { Express } from 'express'
import request from 'supertest'

import { createApp, DEFAULT_CORS_ORIGINS } from './server'

// no RPC is touched: these only exercise the middleware
const app = (corsOrigins?: string[]): Express =>
  createApp({ rpcUrl: 'http://127.0.0.1:1', corsOrigins })

describe('CORS', () => {
  describe('allowed origins', () => {
    it.each(DEFAULT_CORS_ORIGINS)('echoes %s back by default', async origin => {
      // #when
      const response = await request(app()).get('/health').set('Origin', origin)

      // #then
      expect(response.headers['access-control-allow-origin']).toEqual(origin)
      expect(response.headers.vary).toContain('Origin')
    })

    it('answers the preflight a JSON POST triggers', async () => {
      // #given a POST with a JSON body is not a simple request
      const response = await request(app())
        .options('/quote')
        .set('Origin', 'http://localhost:3000')
        .set('Access-Control-Request-Method', 'POST')
        .set('Access-Control-Request-Headers', 'content-type')

      // #then
      expect(response.status).toEqual(204)
      expect(response.headers['access-control-allow-origin']).toEqual('http://localhost:3000')
      expect(response.headers['access-control-allow-methods']).toContain('POST')
      expect(response.headers['access-control-allow-headers']).toContain('content-type')
    })
  })

  describe('origins that are not allowed', () => {
    it('omits the header for an unknown origin, which is what blocks the browser', async () => {
      // #when
      const response = await request(app()).get('/health').set('Origin', 'https://evil.example')

      // #then the request still succeeds server side; the browser is what refuses to read it
      expect(response.status).toEqual(200)
      expect(response.headers['access-control-allow-origin']).toBeUndefined()
    })

    it('does not match on a prefix', async () => {
      const response = await request(app()).get('/health').set('Origin', 'https://app.topazdex.com.evil.example')

      expect(response.headers['access-control-allow-origin']).toBeUndefined()
    })

    it('does not match a different scheme or port', async () => {
      const wrongPort = await request(app()).get('/health').set('Origin', 'http://localhost:3001')
      const wrongScheme = await request(app()).get('/health').set('Origin', 'https://localhost:3000')

      expect(wrongPort.headers['access-control-allow-origin']).toBeUndefined()
      expect(wrongScheme.headers['access-control-allow-origin']).toBeUndefined()
    })
  })

  describe('configuration', () => {
    it('honours an explicit allowlist', async () => {
      const configured = app(['https://staging.topazdex.com'])

      const allowed = await request(configured).get('/health').set('Origin', 'https://staging.topazdex.com')
      const denied = await request(configured).get('/health').set('Origin', 'https://app.topazdex.com')

      expect(allowed.headers['access-control-allow-origin']).toEqual('https://staging.topazdex.com')
      expect(denied.headers['access-control-allow-origin']).toBeUndefined()
    })

    it('supports a wildcard, echoing the caller rather than *', async () => {
      const response = await request(app(['*'])).get('/health').set('Origin', 'https://anything.example')

      expect(response.headers['access-control-allow-origin']).toEqual('https://anything.example')
    })

    it('leaves non-browser callers untouched', async () => {
      const response = await request(app()).get('/health')

      expect(response.status).toEqual(200)
      expect(response.headers['access-control-allow-origin']).toBeUndefined()
    })
  })
})

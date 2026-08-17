import type { Express } from 'express'
import request from 'supertest'

import { createApp, DEFAULT_CORS_ORIGINS } from './server'

// no RPC is touched: these only exercise the middleware
const app = (corsOrigins?: string[]): Express =>
  createApp({ rpcUrl: 'http://127.0.0.1:1', corsOrigins })

describe('CORS', () => {
  describe('allowed origins', () => {
    it.each(DEFAULT_CORS_ORIGINS.filter(o => o.startsWith('http')))('echoes %s back by default', async origin => {
      // #when
      const response = await request(app()).get('/health').set('Origin', origin)

      // #then
      expect(response.headers['access-control-allow-origin']).toEqual(origin)
      expect(response.headers.vary).toContain('Origin')
    })

    it.each([
      'http://localhost:3000',
      'http://localhost:5173',
      'http://localhost:8080',
      'http://127.0.0.1:3000',
      'http://[::1]:3000'
    ])('allows the dev server at %s, whatever port or loopback spelling it uses', async origin => {
      // #given dev servers differ (Vite 5173, Next 3000) and 127.0.0.1 is a distinct origin
      const response = await request(app()).get('/health').set('Origin', origin)

      // #then
      expect(response.headers['access-control-allow-origin']).toEqual(origin)
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

  describe('request headers', () => {
    it('allows the Cache-Control the docs tell callers to send for a fresh quote', async () => {
      // #given Cache-Control is not CORS-safelisted, so a refresh preflights asking for it
      const response = await request(app())
        .options('/quote')
        .set('Origin', 'http://localhost:3000')
        .set('Access-Control-Request-Method', 'GET')
        .set('Access-Control-Request-Headers', 'cache-control')

      // #then the browser is told it may send it; replying only 'content-type' blocked the request
      expect(response.headers['access-control-allow-headers']).toContain('cache-control')
    })

    it('reflects whatever headers the caller asks for', async () => {
      const response = await request(app())
        .options('/quote')
        .set('Origin', 'http://localhost:3000')
        .set('Access-Control-Request-Method', 'POST')
        .set('Access-Control-Request-Headers', 'content-type,x-request-id')

      expect(response.headers['access-control-allow-headers']).toContain('x-request-id')
    })

    it('falls back to content-type when the caller asks for nothing', async () => {
      const response = await request(app())
        .options('/quote')
        .set('Origin', 'http://localhost:3000')
        .set('Access-Control-Request-Method', 'POST')

      expect(response.headers['access-control-allow-headers']).toEqual('content-type')
    })

    it('varies on origin and requested headers, so a shared cache cannot cross them', async () => {
      const response = await request(app()).get('/health').set('Origin', 'https://evil.example')

      // set even when the origin is refused, or a cache could serve that to an allowed origin
      expect(response.headers.vary).toContain('Origin')
      expect(response.headers.vary).toContain('Access-Control-Request-Headers')
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

    it('does not treat a hostname containing localhost as loopback', async () => {
      const response = await request(app()).get('/health').set('Origin', 'https://localhost.evil.example')

      expect(response.headers['access-control-allow-origin']).toBeUndefined()
    })

    it('refuses loopback when the allowlist does not include it', async () => {
      const response = await request(app(['https://app.topazdex.com']))
        .get('/health')
        .set('Origin', 'http://localhost:3000')

      expect(response.headers['access-control-allow-origin']).toBeUndefined()
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

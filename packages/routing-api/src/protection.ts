import { isIP } from 'net'
import { RequestHandler } from 'express'

/** Process-local quotas; Fly supplies the visitor identity, never X-Forwarded-For. */
export function quoteProtection(): RequestHandler {
  const visitors = new Map<string, { tokens: number; at: number }>()
  let active = 0
  return (request, response, next) => {
    if (request.path !== '/' || !['GET', 'POST'].includes(request.method)) { next(); return }
    response.setHeader('Cache-Control', 'private, no-store')
    const supplied = process.env.FLY_APP_NAME ? request.get('Fly-Client-IP') : request.socket.remoteAddress
    const key = clientNetwork(supplied ?? '')
    const now = Date.now()
    const entry = visitors.get(key) ?? { tokens: 12, at: now }
    entry.tokens = Math.min(12, entry.tokens + (now - entry.at) / 1000)
    entry.at = now
    visitors.delete(key); visitors.set(key, entry)
    if (visitors.size > 10_000) visitors.delete(visitors.keys().next().value as string)
    if (entry.tokens < 1) { response.setHeader('Retry-After', '1'); response.status(429).json({ error: 'Rate limit exceeded' }); return }
    entry.tokens--
    if (active >= 8) { response.setHeader('Retry-After', '1'); response.status(503).json({ error: 'Quote service is busy' }); return }
    if (request.originalUrl.length > 8192) { response.status(414).json({ error: 'Request URL too long' }); return }
    active++
    let released = false
    // Work remains counted after disconnect until its bounded computation actually finishes.
    response.locals.releaseQuote = () => { if (!released) { released = true; active-- } }
    const releaseUnstarted = () => { if (!response.locals.quoteStarted) response.locals.releaseQuote() }
    response.on('close', releaseUnstarted)
    request.on('aborted', releaseUnstarted)
    next()
  }
}

export function clientNetwork(input: string): string {
  const ip = input.trim().toLowerCase(), version = isIP(ip);
  if (!version) return "unknown";
  if (version === 4) return ip;
  let expanded = ip;
  if (ip.includes(".")) {
    const cut = ip.lastIndexOf(":"), v4 = ip.slice(cut + 1).split(".").map(Number);
    expanded = ip.slice(0, cut + 1) + ((v4[0] << 8) | v4[1]).toString(16) + ":" + ((v4[2] << 8) | v4[3]).toString(16);
  }
  const [left, right] = expanded.split("::"), a = left ? left.split(":") : [], b = right ? right.split(":") : [];
  const groups = (expanded.includes("::") ? [...a, ...Array(8 - a.length - b.length).fill("0"), ...b] : a).map(v => parseInt(v, 16));
  if (groups.slice(0, 5).every(n => n === 0) && groups[5] === 65535) {
    return [groups[6] >> 8, groups[6] & 255, groups[7] >> 8, groups[7] & 255].join(".");
  }
  return groups.slice(0, 4).map(n => n.toString(16)).join(":") + "::/64";
}

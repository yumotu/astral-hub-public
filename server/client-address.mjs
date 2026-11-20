import { isIP } from 'node:net';
const normalize = (ip) => (typeof ip === 'string' && ip.startsWith('::ffff:') ? ip.slice(7) : ip);
export function clientAddress(req, trustedProxies = '') {
  const remote = normalize(req.socket.remoteAddress) || 'unknown';
  const trusted = new Set(
    (Array.isArray(trustedProxies) ? trustedProxies : String(trustedProxies).split(','))
      .map((ip) => normalize(ip.trim()))
      .filter((ip) => isIP(ip)),
  );
  const forwarded = normalize(req.headers['x-real-ip']);
  return trusted.has(remote) && isIP(forwarded || '') ? forwarded : remote;
}

import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  AdaptiveTransport,
  ClientSecureTransport,
  RemoteClientCore,
  RemoteTypertGateway,
  generateKeyPair,
} from './vendor/dsh-remote/client.mjs';
import { fail } from './accounts.mjs';
import { createDshSessionChannel } from './dsh-session-channel.mjs';

const identifier = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9_.:-]+$/);
const identityKey = z
  .string()
  .regex(/^[A-Za-z0-9_-]{43}$/)
  .refine(
    (v) =>
      Buffer.from(v, 'base64url').length === 32 &&
      Buffer.from(v, 'base64url').toString('base64url') === v,
  );
export const remoteIdentitySchema = z
  .object({
    deviceId: z.string().uuid(),
    publicKey: identityKey,
    privateKey: identityKey,
  })
  .strict();
export const remotePeerSchema = z
  .object({
    deviceId: identifier,
    membershipId: z.string().min(1).max(200),
    publicKey: identityKey,
    name: z.string().trim().min(1).max(128),
  })
  .strict();
export const remoteTokenSchema = z
  .object({
    accessToken: z.string().min(16).max(8192),
    accessTokenExpiresAt: z.number().int().positive(),
    refreshToken: z.string().min(16).max(8192),
    refreshTokenExpiresAt: z.number().int().positive(),
  })
  .strict();
export const remoteHostSchema = z
  .object({
    deviceId: identifier,
    name: z.string().trim().min(1).max(128),
    platform: z.string().min(1).max(64),
    membershipId: z.string().min(1).max(200),
    online: z.boolean().optional(),
    lastSeenAt: z.number().int().nonnegative().optional(),
    clientVersion: z.string().max(64).optional(),
    harnessVersion: z.string().max(64).optional(),
  })
  .passthrough();

export function remoteOrigin(input, allowedOrigins) {
  let url;
  try {
    url = new URL(input);
  } catch {
    throw fail(400, 'Remote 服务地址无效。');
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.hash ||
    url.search ||
    !allowedOrigins.has(url.origin)
  )
    throw fail(403, '此 Remote 服务尚未由管理员允许，请检查连接设置。');
  // HTTP is limited to an explicitly configured loopback test/SSH endpoint.
  if (url.protocol === 'http:' && !['127.0.0.1', '[::1]'].includes(url.hostname))
    throw fail(403, 'Remote 服务需要 HTTPS。');
  return url.origin;
}

export function remoteFingerprint(publicKey) {
  identityKey.parse(publicKey);
  return createHash('sha256')
    .update(Buffer.from(publicKey, 'base64url'))
    .digest('hex')
    .toUpperCase();
}

export function createRemoteIdentity() {
  return { deviceId: randomUUID(), ...generateKeyPair() };
}

// The administrator's origin allowlist also governs redirects: none are followed.
// No arbitrary URL, headers or RPC method can be supplied by an Agent.
export function createRemoteServerApi({ origin, allowedOrigins, fetch: request = fetch }) {
  const base = remoteOrigin(origin, allowedOrigins);
  async function call(path, input, token, signal) {
    let response;
    try {
      response = await request(base + path, {
        method: input ? 'POST' : 'GET',
        redirect: 'error',
        headers: {
          ...(token ? { Authorization: 'Bearer ' + token } : {}),
          ...(input ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(input ? { body: JSON.stringify(input) } : {}),
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(15000)])
          : AbortSignal.timeout(15000),
      });
    } catch {
      throw fail(502, 'Remote 服务连接中断；未自动重试操作。');
    }
    const declared = Number(response.headers.get('content-length') || 0);
    if (declared > 2 * 1024 * 1024) {
      await response.body?.cancel();
      throw fail(502, 'Remote 服务响应过大。');
    }
    const reader = response.body?.getReader();
    const chunks = [];
    let size = 0;
    try {
      if (!reader) throw Error();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 2 * 1024 * 1024) throw Error();
        chunks.push(value);
      }
      const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!response.ok)
        throw Object.assign(
          fail(
            response.status === 401 || response.status === 403 ? 403 : 502,
            'Remote 服务拒绝请求，请检查登录和主机授权。',
          ),
          {
            remoteCode:
              typeof result.error?.code === 'string' ? result.error.code.slice(0, 100) : undefined,
          },
        );
      return result;
    } catch (error) {
      if (error.status) throw error;
      throw fail(502, 'Remote 服务返回无效响应；未自动重试操作。');
    } finally {
      if (reader) {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    }
  }
  return {
    origin: base,
    async authorize(identity, email, password, signal) {
      identity = remoteIdentitySchema.parse(identity);
      const account = z.string().trim().min(1).max(254).parse(email);
      const login = await call(
        '/api/v1/auth/login',
        {
          email: account,
          password: z.string().min(1).max(1024).parse(password),
        },
        undefined,
        signal,
      );
      const webToken = z.string().min(16).max(8192).parse(login.token);
      // Keep only the new independent device token. Never persist the password or web token.
      const pair = await call(
        '/api/v1/devices/register',
        {
          v: 1,
          device: {
            deviceId: identity.deviceId,
            name: 'Astral Hub',
            role: 'client',
            platform: 'astral-hub',
            identityKey: identity.publicKey,
            clientVersion: '0.8.12',
          },
        },
        webToken,
        signal,
      );
      return {
        account: z.string().min(1).max(254).parse(login.account),
        tokens: remoteTokenSchema.parse(pair),
      };
    },
    async refresh(identity, tokens, signal) {
      return remoteTokenSchema.parse(
        await call(
          '/api/v1/auth/refresh',
          {
            deviceId: remoteIdentitySchema.parse(identity).deviceId,
            refreshToken: remoteTokenSchema.parse(tokens).refreshToken,
          },
          undefined,
          signal,
        ),
      );
    },
    async hosts(tokens, signal) {
      const items = [],
        cursors = new Set(),
        ids = new Set();
      let cursor;
      do {
        const query = new URLSearchParams({ limit: '50' });
        if (cursor) query.set('cursor', cursor);
        const page = await call(
          '/api/v1/devices?' + query,
          undefined,
          remoteTokenSchema.parse(tokens).accessToken,
          signal,
        );
        const rows = z.array(remoteHostSchema).max(10000).parse(page.items);
        for (const row of rows) {
          if (ids.has(row.deviceId)) throw fail(502, 'Remote 服务返回重复主机。');
          ids.add(row.deviceId);
          // A list is not a trusted host key. Fetch the descriptor for pinning.
          const {
            deviceId,
            name,
            platform,
            membershipId,
            online,
            lastSeenAt,
            clientVersion,
            harnessVersion,
          } = row;
          items.push({
            deviceId,
            name,
            platform,
            membershipId,
            online,
            lastSeenAt,
            clientVersion,
            harnessVersion,
          });
        }
        if (items.length > 10000) throw fail(502, 'Remote 主机列表过大。');
        const next = page.nextCursor;
        if (
          next !== undefined &&
          next !== null &&
          (typeof next !== 'string' || !next || next.length > 512 || cursors.has(next))
        )
          throw fail(502, 'Remote 主机分页无效。');
        cursor = typeof next === 'string' ? next : undefined;
        if (cursor) cursors.add(cursor);
      } while (cursor);
      return items;
    },
    async peer(tokens, deviceId, signal) {
      const row = await call(
        '/api/v1/devices/' + encodeURIComponent(identifier.parse(deviceId)),
        undefined,
        remoteTokenSchema.parse(tokens).accessToken,
        signal,
      );
      const host = remoteHostSchema.parse(row);
      if (row.role !== 'host' || host.deviceId !== deviceId)
        throw fail(403, 'Remote 主机身份与所选设备不一致。');
      return remotePeerSchema.parse({
        deviceId: host.deviceId,
        name: host.name,
        membershipId: host.membershipId,
        publicKey: row.identityKey,
      });
    },
  };
}

const endpointMethods = Object.freeze({
  sessions: ['session/list', { _request: {} }],
  workspaces: ['workspace/follow', { args: {} }],
});
export async function connectDshRemote({ origin, allowedOrigins, identity, tokens, peer, signal }) {
  const base = remoteOrigin(origin, allowedOrigins);
  identity = remoteIdentitySchema.parse(identity);
  tokens = remoteTokenSchema.parse(tokens);
  peer = remotePeerSchema.parse(peer);
  const pair = generateKeyPair(Buffer.from(identity.privateKey, 'base64url'));
  if (pair.publicKey !== identity.publicKey) throw fail(409, 'Remote 客户端身份密钥不匹配。');
  if (tokens.accessTokenExpiresAt <= Date.now()) throw fail(403, 'Remote 设备凭据已过期。');
  signal?.throwIfAborted();
  const lifetime = new AbortController();
  const activeSignal = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
  const transport = new AdaptiveTransport(base.replace(/^http/, 'ws') + '/ws/v1/connect', {
    role: 'client',
    deviceId: identity.deviceId,
    accessToken: tokens.accessToken,
    targetDeviceId: peer.deviceId,
    preferredTransports: ['relay'],
    capabilities: ['transport.relay', 'transport.relay.attach'],
    forceRelay: true,
    // Upstream's three dial sites accept this narrow build-time injection.
    // A relay assignment cannot redirect a server client into another origin.
    WebSocket: class extends WebSocket {
      constructor(input) {
        const url = new URL(input);
        if (url.origin !== base.replace(/^http/, 'ws') || url.username || url.password || url.hash)
          throw fail(403, 'Remote 中继地址与已授权服务不一致。');
        super(url);
      }
    },
    signal: activeSignal,
  });
  const core = new RemoteClientCore(new ClientSecureTransport(transport, identity, peer), 15000);
  try {
    await core.connect();
    const description = z
      .object({
        capabilities: z.array(z.string().min(1).max(128)).max(256),
      })
      .passthrough()
      .parse(await core.rpc('harness.transport.describe', {}, activeSignal));
    const v1 = description.capabilities.includes('harness.remote.v1');
    const v3 = description.capabilities.includes('harness.remote.v3');
    if (v1 === v3) throw fail(409, '目标主机缺少支持的 DSH Remote 协议，请更新主机插件。');
    const gateway = new RemoteTypertGateway(core);
    let chat;
    core.onClose(() => {
      lifetime.abort();
      void chat?.close().catch(() => {});
    });
    const unary = async (endpoint, args, active) => {
      const result = await gateway.dispatch(
        endpoint,
        { args },
        active ? AbortSignal.any([active, activeSignal]) : activeSignal,
      );
      if (!result.ok) throw fail(502, 'DSH 主机拒绝操作；未重发。');
      return result.value;
    };
    return {
      description: { ...description, sessionFormat: v3 ? 3 : undefined },
      onClose: (callback) => core.onClose(callback),
      chat: () => {
        if (!v3)
          throw fail(409, '当前聊天接入需要支持 harness.remote.v3 的主机；旧主机仅可读取目录。');
        return (chat ||= createDshSessionChannel(gateway, {
          v3,
          signal: activeSignal,
          // Gateway dispatch can fall back to a transferred request after a
          // RESPONSE_TOO_LARGE error. Writes must never take that retry path.
          dispatchMutation: (endpoint, payload, active) =>
            core.rpc('harness.remote.call', { endpoint, payload }, active),
          onFailure: () => {
            void core.close().catch(() => {});
          },
        }));
      },
      // Fixed business subset; the shared client's generic RPC stays private.
      sessions: (active) => unary(endpointMethods.sessions[0], endpointMethods.sessions[1], active),
      workspaces: (active) =>
        gateway.open(
          'workspace/follow',
          { args: {} },
          active ? AbortSignal.any([active, activeSignal]) : activeSignal,
        ),
      async close() {
        lifetime.abort();
        await chat?.close();
        await core.close();
      },
    };
  } catch (error) {
    lifetime.abort();
    await core.close().catch(() => {});
    if (error.status) throw error;
    throw fail(502, 'DSH Remote 加密连接或协议协商失败。');
  }
}

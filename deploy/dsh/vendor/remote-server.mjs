// release/qa-dsh-s2/upstream/apps/server/src/server.ts
import { createServer } from "node:http";
import { existsSync as existsSync2, readFileSync as readFileSync2, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID as randomUUID2 } from "node:crypto";
import { isIP } from "node:net";
import { z as z4 } from "zod";

// release/qa-dsh-s2/upstream/packages/protocol/src/loopback.ts
import { z } from "zod";
var LOOPBACK_CHUNK_BYTES = 64 * 1024;
var LOOPBACK_MAX_BODY_BYTES = 1024 * 1024;
var LOOPBACK_MAX_WS_BYTES = 256 * 1024;
var id = z.string().uuid();
var data = z.string().max(Math.ceil(LOOPBACK_MAX_BODY_BYTES / 3) * 4).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);
var target = {
  port: z.number().int().min(1024).max(65535),
  path: z.string().min(1).max(8192).regex(/^\/(?!\/)[^\x00-\x20\x7f\\]*$/),
  headers: z.array(z.tuple([z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/), z.string().max(8192).regex(/^[^\x00-\x08\x0a-\x1f\x7f]*$/)])).max(64)
};
var loopbackRequestSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("describe") }).strict(),
  z.object({ op: z.literal("http.open"), id, ...target, method: z.enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]), body: data.optional() }).strict(),
  z.object({ op: z.literal("http.read"), id }).strict(),
  z.object({ op: z.literal("close"), id }).strict(),
  z.object({ op: z.literal("ws.open"), id, ...target, protocols: z.array(z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/)).max(16) }).strict(),
  z.object({ op: z.literal("ws.read"), id }).strict(),
  z.object({ op: z.literal("ws.send"), id, data, binary: z.boolean() }).strict()
]);

// release/qa-dsh-s2/upstream/packages/protocol/src/wire-json.ts
function parseWireJson(input) {
  try {
    const text = typeof input === "string" ? input : new TextDecoder("utf-8", { fatal: true }).decode(input);
    const value = JSON.parse(text);
    const objects = [];
    for (let index = 0; index < text.length; index += 1) {
      const char = text[index];
      if (char === "{") objects.push(/* @__PURE__ */ new Set());
      else if (char === "[") objects.push(void 0);
      else if (char === "}" || char === "]") objects.pop();
      else if (char === '"') {
        const start = index;
        for (index += 1; index < text.length; index += 1) {
          if (text[index] === "\\") index += 1;
          else if (text[index] === '"') break;
        }
        let next = index + 1;
        while (next < text.length && /\s/u.test(text[next])) next += 1;
        if (text[next] !== ":") continue;
        const keys = objects[objects.length - 1];
        const key = JSON.parse(text.slice(start, index + 1));
        if (keys.has(key)) throw new Error("Duplicate JSON field.");
        keys.add(key);
      }
    }
    return value;
  } catch {
    throw new Error("Invalid wire JSON.");
  }
}

// release/qa-dsh-s2/upstream/packages/protocol/src/index.ts
import { z as z2 } from "zod";

// release/qa-dsh-s2/upstream/packages/protocol/src/close-semantics.ts
var SERVER_SHUTDOWN_REASON = "server shutdown";

// release/qa-dsh-s2/upstream/packages/protocol/src/index.ts
var WEBRTC_LEASE_MS = 3e5;
var SERVER_SHUTDOWN_CLOSE_CODE = 4009;
var SERVER_SHUTDOWN_CLOSE_REASON = SERVER_SHUTDOWN_REASON;
var PROTOCOL_VERSION = 1;
var MAX_CONTROL_FRAME_BYTES = 64 * 1024;
var MAX_RELAY_FRAME_BYTES = 1024 * 1024;
var SECURE_FRAGMENT_CHUNK_BYTES = 48 * 1024;
var MAX_SECURE_MESSAGE_BYTES = 4 * 1024 * 1024;
var HARNESS_API_TRANSFER_CHUNK_BYTES = 512 * 1024;
var CODEX_APP_TRANSFER_CHUNK_BYTES = 512 * 1024;
var AGENT_ACP_TRANSFER_CHUNK_BYTES = 512 * 1024;
var MAX_HARNESS_API_TRANSFER_BYTES = 288 * 1024 * 1024;
var MAX_CODEX_APP_TRANSFER_BYTES = 288 * 1024 * 1024;
var MAX_AGENT_ACP_TRANSFER_BYTES = 288 * 1024 * 1024;
var MAX_DEVICE_NAME_LENGTH = 128;
var MAX_DEVICE_PLATFORM_LENGTH = 64;
var MAX_DEVICE_VERSION_LENGTH = 64;
var MAX_AUTH_TOKEN_LENGTH = 8 * 1024;
var MAX_REMOTE_CAPABILITY_ENTRIES = 128;
var MAX_REMOTE_WORKSPACE_TYPE_ENTRIES = 32;
var HOST_REGISTRATION_CODE_TTL_MS = 10 * 6e4;
var TRANSFER_IDLE_MS = 2 * 6e4;
var MAX_RPC_TEXT_INPUT_BYTES = 64 * 1024;
var MAX_FILEVIEWER_RANGE_BYTES = 512 * 1024;
var MIN_REPLAY_WINDOW_MS = 15 * 6e4;
var MAX_ACP_PROMPT_BYTES = 64 * 1024;
var MAX_ACP_UPDATE_BYTES = 512 * 1024;
var SECURE_FRAGMENT_MAGIC = new Uint8Array([68, 83, 72, 70]);
var messageTypes = [
  "rpc.request",
  "rpc.response",
  "rpc.error",
  "event"
];
var controlFrameTypes = [
  "hello",
  "hello.ack",
  "connect.request",
  "connect.incoming",
  "connect.accepted",
  "connect.rejected",
  "secure.handshake",
  "relay",
  "signal.offer",
  "signal.answer",
  "signal.ice",
  "transport.selected",
  "connection.lease.request",
  "connection.lease.ack",
  "connection.lease.close",
  "ping",
  "pong",
  "error"
];
var rpcMethods = [
  "workspace.upload.open",
  "workspace.upload.chunk",
  "workspace.upload.commit",
  "workspace.upload.abort",
  "harness.transport.describe",
  "remote.history.configure",
  "harness.api.call",
  "harness.api.transfer.open",
  "harness.api.transfer.chunk",
  "harness.api.transfer.commit",
  "harness.api.transfer.read",
  "harness.api.transfer.close",
  "harness.api.respond",
  "harness.api.stream.open",
  "harness.api.stream.close",
  "harness.remote.call",
  "harness.remote.transfer.open",
  "harness.remote.transfer.chunk",
  "harness.remote.transfer.commit",
  "harness.remote.transfer.read",
  "harness.remote.transfer.close",
  "harness.remote.stream.open",
  "harness.remote.stream.close",
  "loopback.call",
  "fileviewer.call",
  "codex.app.call",
  "codex.app.respond",
  "codex.app.stream.open",
  "codex.app.stream.close",
  "codex.app.transfer.open",
  "codex.app.transfer.chunk",
  "codex.app.transfer.commit",
  "codex.app.transfer.read",
  "codex.app.transfer.close",
  "agent.acp.call",
  "agent.acp.respond",
  "agent.acp.stream.open",
  "agent.acp.stream.close",
  "agent.acp.transfer.open",
  "agent.acp.transfer.chunk",
  "agent.acp.transfer.commit",
  "agent.acp.transfer.read",
  "agent.acp.transfer.close",
  "acp.initialize",
  "acp.session.new",
  "acp.session.load",
  "acp.session.prompt",
  "acp.session.respond_permission",
  "acp.session.cancel",
  "acp.session.set_mode",
  "plugin.route.call"
];
var errorCodes = [
  // Protocol / Version
  "INVALID_MESSAGE",
  "UNSUPPORTED_VERSION",
  "CAPABILITY_NOT_SUPPORTED",
  "METHOD_NOT_FOUND",
  "METHOD_NOT_ALLOWED",
  "REQUEST_CONFLICT",
  "FRAME_TOO_LARGE",
  "RATE_LIMITED",
  // Auth / Device
  "AUTH_REQUIRED",
  "AUTH_INVALID",
  "ACCOUNT_AUTH_REQUIRED",
  "TOKEN_EXPIRED",
  "DEVICE_NOT_FOUND",
  "DEVICE_REVOKED",
  "DEVICE_OWNERSHIP_REQUIRED",
  "MEMBERSHIP_REQUIRED",
  "PEER_IDENTITY_MISMATCH",
  "HOST_REGISTRATION_CODE_NOT_FOUND",
  "HOST_REGISTRATION_CODE_EXPIRED",
  "HOST_REGISTRATION_CODE_CONSUMED",
  // Connection / Transport
  "HOST_OFFLINE",
  "CONNECTION_NOT_FOUND",
  "CONNECTION_FAILED",
  "CONNECTION_REPLACED",
  "P2P_FAILED",
  "TURN_UNAVAILABLE",
  "RELAY_UNAVAILABLE",
  "SLOW_CONSUMER",
  "SECURE_CHANNEL_FAILED",
  // Harness
  "HARNESS_UNAVAILABLE",
  "HARNESS_VERSION_INCOMPATIBLE",
  "RESPONSE_TOO_LARGE",
  "SESSION_NOT_FOUND",
  "SESSION_NOT_READY",
  "AGENT_BUSY",
  "PERMISSION_DENIED",
  "PERMISSION_NOT_PENDING",
  "RPC_TIMEOUT",
  "FULL_RESYNC_REQUIRED",
  "INTERNAL_ERROR"
];
var selectedTransports = ["lan", "p2p", "turn", "relay"];
function normalizeSdpMLineIndex(value) {
  if (value === void 0) return void 0;
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) return null;
  return value;
}
var rpcMethodSchema = z2.enum(rpcMethods);
var messageTypeSchema = z2.enum(messageTypes);
var controlFrameTypeSchema = z2.enum(controlFrameTypes);
var errorCodeSchema = z2.enum(errorCodes);
var uniqueStrings = (values) => new Set(values).size === values.length;
var uniqueNumbers = (values) => new Set(values).size === values.length;
var utf8Length = (value) => new TextEncoder().encode(value).byteLength;
var boundedUtf8Schema = (minimum, maximum) => z2.string().refine((value) => utf8Length(value) >= minimum && utf8Length(value) <= maximum);
var deviceIdSchema = z2.string().refine((value) => /^[0-9A-HJKMNP-TV-Z]{26}$/iu.test(value) || /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value), "Device ID must be a ULID or UUID.");
var deviceNameSchema = boundedUtf8Schema(1, MAX_DEVICE_NAME_LENGTH).refine((value) => value.trim().length > 0, "Device name must contain visible text.");
var devicePlatformSchema = z2.string().min(1).max(MAX_DEVICE_PLATFORM_LENGTH).regex(/^[a-z0-9][a-z0-9._-]*$/u);
var identityKeySchema = z2.string().regex(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u);
var canonicalBase64UrlSchema = z2.string().min(1).regex(/^[A-Za-z0-9_-]+$/u).refine((value) => {
  const remainder = value.length % 4;
  if (remainder === 1) return false;
  if (remainder === 0) return true;
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const last = alphabet.indexOf(value.at(-1));
  return remainder === 2 ? (last & 15) === 0 : (last & 3) === 0;
}, "Value must use canonical Base64URL without padding.");
var deviceVersionSchema = boundedUtf8Schema(1, MAX_DEVICE_VERSION_LENGTH);
var authTokenSchema = boundedUtf8Schema(16, MAX_AUTH_TOKEN_LENGTH);
var expiresAtSchema = z2.number().int().positive().safe();
var hostDeviceDescriptorSchema = z2.object({
  deviceId: deviceIdSchema,
  name: deviceNameSchema,
  role: z2.literal("host"),
  platform: devicePlatformSchema,
  identityKey: identityKeySchema,
  clientVersion: deviceVersionSchema,
  harnessVersion: deviceVersionSchema.optional()
}).strict();
var clientDeviceDescriptorSchema = z2.object({
  deviceId: deviceIdSchema,
  name: deviceNameSchema,
  role: z2.literal("client"),
  platform: devicePlatformSchema,
  identityKey: identityKeySchema,
  clientVersion: deviceVersionSchema
}).strict();
var accountDeviceDescriptorSchema = z2.union([
  hostDeviceDescriptorSchema,
  clientDeviceDescriptorSchema
]);
var deviceRegistrationRequestSchema = z2.object({
  v: z2.literal(PROTOCOL_VERSION),
  device: accountDeviceDescriptorSchema
}).strict();
var hostRegistrationCodeRequestSchema = z2.object({
  v: z2.literal(PROTOCOL_VERSION),
  code: z2.string().regex(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/u),
  device: hostDeviceDescriptorSchema
}).strict();
var registerOwnedRoleRequestSchema = z2.object({
  v: z2.literal(PROTOCOL_VERSION),
  device: accountDeviceDescriptorSchema
}).strict();
var deviceRefreshRequestSchema = z2.object({
  deviceId: deviceIdSchema,
  refreshToken: authTokenSchema
}).strict();
var deviceTokenPairSchema = z2.object({
  accessToken: authTokenSchema,
  accessTokenExpiresAt: expiresAtSchema,
  refreshToken: authTokenSchema,
  refreshTokenExpiresAt: expiresAtSchema
}).strict();
var browserAuthorizationExchangeRequestSchema = z2.object({
  v: z2.literal(PROTOCOL_VERSION),
  device: z2.object({
    deviceId: deviceIdSchema,
    name: deviceNameSchema,
    role: z2.literal("client"),
    platform: z2.literal("browser"),
    identityKey: identityKeySchema,
    clientVersion: deviceVersionSchema
  }).strict()
}).strict();
var browserAuthorizationExchangeResponseSchema = z2.object({
  accessToken: authTokenSchema,
  accessTokenExpiresAt: expiresAtSchema,
  refreshToken: authTokenSchema,
  refreshTokenExpiresAt: expiresAtSchema,
  account: boundedUtf8Schema(1, 254).refine((value) => value.trim().length > 0)
}).strict();
var remoteMessageSchema = z2.object({
  v: z2.literal(PROTOCOL_VERSION),
  id: z2.string().min(1),
  type: messageTypeSchema,
  timestamp: z2.number().int().positive(),
  payload: z2.unknown()
});
var controlFrameSchema = z2.object({
  v: z2.literal(PROTOCOL_VERSION),
  id: z2.string().min(1),
  type: controlFrameTypeSchema,
  timestamp: z2.number().int().positive(),
  payload: z2.unknown()
}).strict();
var relayDataFrameSchema = z2.object({
  v: z2.literal(PROTOCOL_VERSION),
  id: z2.string().min(1),
  type: z2.string().min(1),
  timestamp: z2.number().int().positive().safe(),
  payload: z2.record(z2.string(), z2.unknown())
}).strict();
var transportEnum = z2.enum(["lan", "p2p", "turn", "relay"]);
var selectedTransportEnum = z2.enum(selectedTransports);
var MAX_PROTOCOL_LIST_ENTRIES = 16;
var MAX_CAPABILITY_ENTRIES = MAX_REMOTE_CAPABILITY_ENTRIES;
var MAX_WORKSPACE_TYPE_ENTRIES = MAX_REMOTE_WORKSPACE_TYPE_ENTRIES;
var MAX_PREFERRED_TRANSPORT_ENTRIES = selectedTransports.length;
var helloPayloadSchema = z2.object({
  recoveryTickets: z2.array(z2.string().min(1).max(4096)).max(64).optional(),
  role: z2.enum(["host", "client"]),
  deviceId: z2.string().min(1),
  accessToken: z2.string().min(1),
  protocols: z2.array(z2.unknown()).min(1).max(MAX_PROTOCOL_LIST_ENTRIES).pipe(
    z2.array(z2.number().int().nonnegative().safe()).refine(uniqueNumbers)
  ),
  capabilities: z2.array(z2.unknown()).max(MAX_CAPABILITY_ENTRIES).pipe(
    z2.array(z2.string().min(1)).refine(uniqueStrings)
  ),
  clientVersion: z2.string().optional(),
  harnessVersion: z2.string().optional()
});
var helloAckPayloadSchema = z2.object({
  protocol: z2.literal(PROTOCOL_VERSION),
  serverVersion: z2.string().min(1),
  connectionSessionId: z2.string().min(1),
  heartbeatIntervalMs: z2.number().int().positive().safe(),
  maxControlFrameBytes: z2.number().int().positive().max(MAX_CONTROL_FRAME_BYTES),
  maxRelayFrameBytes: z2.number().int().positive().max(MAX_RELAY_FRAME_BYTES),
  capabilities: z2.array(z2.unknown()).max(MAX_CAPABILITY_ENTRIES).pipe(
    z2.array(z2.string().min(1)).refine(uniqueStrings)
  ).optional(),
  webrtcEnabled: z2.boolean().optional(),
  webrtcFallbackTimeoutMs: z2.number().int().positive().safe().optional()
});
var remoteWorkspaceTypeDescriptionSchema = z2.object({
  id: z2.string().min(1),
  name: z2.string().min(1),
  capability: z2.string().min(1),
  available: z2.boolean()
});
var harnessTransportDescriptionSchema = z2.object({
  capabilities: z2.array(z2.unknown()).max(MAX_CAPABILITY_ENTRIES).pipe(
    z2.array(z2.string().min(1)).refine(uniqueStrings)
  ),
  workspaceTypes: z2.array(z2.unknown()).max(MAX_WORKSPACE_TYPE_ENTRIES).pipe(
    z2.array(remoteWorkspaceTypeDescriptionSchema)
  ).optional()
});
var connectRequestPayloadSchema = z2.object({
  hostDeviceId: z2.string().min(1),
  preferredTransports: z2.array(z2.unknown()).min(1).max(MAX_PREFERRED_TRANSPORT_ENTRIES).pipe(
    z2.array(transportEnum)
  )
});
var connectIncomingPayloadSchema = z2.object({
  relayRecoveryTicket: z2.string().min(1).max(4096).optional(),
  recoveryTicket: z2.string().min(1).max(4096).optional(),
  connectionId: z2.string().min(1),
  clientDeviceId: z2.string().min(1),
  clientIdentityKey: identityKeySchema,
  authorization: z2.literal("account"),
  preferredTransports: z2.array(z2.unknown()).min(1).max(MAX_PREFERRED_TRANSPORT_ENTRIES).pipe(
    z2.array(transportEnum)
  ),
  relayEndpoint: z2.string().url().optional(),
  relayTicket: z2.string().min(1).optional(),
  relayNodeId: z2.string().min(1).optional(),
  relayEpoch: z2.number().int().nonnegative().optional()
});
var connectAcceptedPayloadSchema = z2.object({
  relayRecoveryTicket: z2.string().min(1).max(4096).optional(),
  recoveryTicket: z2.string().min(1).max(4096).optional(),
  connectionId: z2.string().min(1),
  relayEndpoint: z2.string().url().optional(),
  relayTicket: z2.string().min(1).optional(),
  relayNodeId: z2.string().min(1).optional(),
  relayEpoch: z2.number().int().nonnegative().optional()
});
var connectRejectedPayloadSchema = z2.object({
  connectionId: z2.string().min(1),
  code: z2.string().optional(),
  message: z2.string().optional()
});
var secureHandshakePayloadSchema = z2.object({
  connectionId: z2.string().min(1),
  targetDeviceId: z2.string().min(1),
  step: z2.union([z2.literal(1), z2.literal(2)]),
  data: canonicalBase64UrlSchema
});
var relayPayloadSchema = z2.object({
  connectionId: z2.string().min(1),
  targetDeviceId: z2.string().min(1),
  counter: z2.number().int().nonnegative().safe(),
  ciphertext: canonicalBase64UrlSchema
});
var signalPayloadSchema = z2.object({
  connectionId: z2.string().min(1),
  targetDeviceId: z2.string().min(1),
  sdp: z2.string().min(1)
});
var signalIcePayloadSchema = z2.object({
  connectionId: z2.string().min(1),
  targetDeviceId: z2.string().min(1),
  candidate: z2.object({
    candidate: z2.string().optional(),
    sdpMid: z2.string().nullable().optional(),
    sdpMLineIndex: z2.preprocess(normalizeSdpMLineIndex, z2.number().int().nonnegative().nullable().optional()),
    usernameFragment: z2.string().nullable().optional()
  })
});
var transportSelectedPayloadSchema = z2.object({
  connectionId: z2.string().min(1),
  targetDeviceId: z2.string().min(1),
  transport: selectedTransportEnum,
  /** Relay hostname the initiator actually used when transport is "turn"
   *  (best-effort, from ICE stats; absent for other transports). */
  turnNode: z2.string().min(1).max(253).optional()
});
var pingPongPayloadSchema = z2.object({
  nonce: z2.string().min(1)
});
var controlErrorPayloadSchema = z2.object({
  code: z2.string().min(1),
  message: z2.string().min(1),
  retryable: z2.boolean().optional(),
  connectionId: z2.string().min(1).optional()
});
var connectionLeaseRequestSchema = z2.object({
  connectionId: z2.string().min(1).max(128),
  requestId: z2.string().min(1).max(128),
  ticket: z2.string().min(1).max(4096)
});
var connectionLeaseAckSchema = connectionLeaseRequestSchema.extend({
  leaseMs: z2.literal(WEBRTC_LEASE_MS)
});
var controlFramePayloadSchemas = {
  "hello": helloPayloadSchema,
  "hello.ack": helloAckPayloadSchema,
  "connect.request": connectRequestPayloadSchema,
  "connect.incoming": connectIncomingPayloadSchema,
  "connect.accepted": connectAcceptedPayloadSchema,
  "connect.rejected": connectRejectedPayloadSchema,
  "secure.handshake": secureHandshakePayloadSchema,
  "relay": relayPayloadSchema,
  "signal.offer": signalPayloadSchema,
  "signal.answer": signalPayloadSchema,
  "signal.ice": signalIcePayloadSchema,
  "transport.selected": transportSelectedPayloadSchema,
  "connection.lease.request": connectionLeaseRequestSchema,
  "connection.lease.ack": connectionLeaseAckSchema,
  "connection.lease.close": z2.object({ connectionId: z2.string().min(1).max(128) }),
  "ping": pingPongPayloadSchema,
  "pong": pingPongPayloadSchema,
  "error": controlErrorPayloadSchema
};
var rpcRequestPayloadSchema = z2.object({
  method: rpcMethodSchema,
  params: z2.unknown()
});
var rpcResponsePayloadSchema = z2.object({
  requestId: z2.string().min(1),
  result: z2.unknown()
});
var rpcErrorPayloadSchema = z2.object({
  requestId: z2.string().min(1),
  code: z2.string().min(1),
  message: z2.string().min(1),
  retryable: z2.boolean().optional(),
  details: z2.unknown().optional()
});
function createControlFrame(type, payload, id2 = cryptoRandomId()) {
  return {
    v: PROTOCOL_VERSION,
    id: id2,
    type,
    timestamp: Date.now(),
    payload
  };
}
function parseControlFrame(input) {
  const frame = controlFrameSchema.parse(input);
  const payloadSchema = controlFramePayloadSchemas[frame.type];
  if (payloadSchema) {
    return { ...frame, payload: payloadSchema.parse(frame.payload) };
  }
  return frame;
}
function decodeControlFrame(data2, limits = {}) {
  const encoded = typeof data2 === "string" ? new TextEncoder().encode(data2) : data2;
  if (encoded.byteLength > MAX_RELAY_FRAME_BYTES) throw new Error("Control frame exceeds the Relay frame limit.");
  const frame = parseControlFrame(parseWireJson(data2));
  assertControlFrameSize(encoded.byteLength, frame.type, limits);
  return frame;
}
function assertControlFrameSize(bytes, type, limits) {
  const configured = type === "relay" ? limits.maxRelayFrameBytes : limits.maxControlFrameBytes;
  const protocolMaximum = type === "relay" ? MAX_RELAY_FRAME_BYTES : MAX_CONTROL_FRAME_BYTES;
  const maximum = configured === void 0 ? protocolMaximum : Math.min(protocolMaximum, configured);
  if (!Number.isSafeInteger(maximum) || maximum <= 0) throw new Error("Control frame limit is invalid.");
  if (bytes > maximum) throw new Error(`${type === "relay" ? "Relay" : "Control"} frame exceeds its limit.`);
}
function cryptoRandomId() {
  const g = globalThis.crypto;
  if (g?.randomUUID) return g.randomUUID();
  return `msg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}

// release/qa-dsh-s2/upstream/apps/server/src/store.ts
import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z as z3 } from "zod";
var ApiError = class extends Error {
  constructor(code, status = 400) {
    super(code);
    this.code = code;
    this.status = status;
  }
  code;
  status;
};
var hash = (value) => createHash("sha256").update(value).digest("hex");
var secret = () => randomBytes(32).toString("base64url");
var equal = (left, right) => timingSafeEqual(Buffer.from(hash(left)), Buffer.from(hash(right)));
var tokenSchema = z3.object({
  kind: z3.enum(["access", "refresh"]),
  deviceId: z3.string(),
  expires: z3.number(),
  used: z3.boolean(),
  recovery: z3.object({ nonce: z3.string().regex(/^[A-Za-z0-9_-]{43}$/), accessExpires: z3.number().int().positive() }).optional()
});
var savedDeviceSchema = z3.object({ descriptor: accountDeviceDescriptorSchema, revoked: z3.boolean(), lastSeenAt: z3.number() });
var stateSchema = z3.object({ version: z3.literal(1), account: z3.string(), salt: z3.string(), verifier: z3.string(), devices: z3.record(z3.string(), savedDeviceSchema), tokens: z3.record(z3.string(), tokenSchema) });
function successor(token, nonce, deviceId) {
  const derive = (kind) => createHmac("sha256", token).update(JSON.stringify(["ds-harness-remote/refresh/v1", deviceId, nonce, kind])).digest("base64url");
  return { accessToken: derive("access"), refreshToken: derive("refresh") };
}
var Store = class {
  constructor(file, account, password) {
    this.file = file;
    this.account = account;
    const previous = existsSync(file) ? stateSchema.parse(JSON.parse(readFileSync(file, "utf8"))) : void 0;
    const salt = previous?.salt ?? secret();
    const verifier = scryptSync(password, salt, 32).toString("hex");
    this.state = previous ?? { version: 1, account, salt, verifier, devices: {}, tokens: {} };
    if (this.state.account !== account) this.state.devices = {};
    if (this.state.account !== account || !equal(this.state.verifier, verifier)) this.state.tokens = {};
    Object.assign(this.state, { account, verifier });
    this.save();
  }
  file;
  account;
  state;
  onInvalidate = () => {
  };
  save() {
    mkdirSync(dirname(this.file), { recursive: true, mode: 448 });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state), { mode: 384 });
    renameSync(tmp, this.file);
  }
  get(id2) {
    const d = Object.hasOwn(this.state.devices, id2) ? this.state.devices[id2] : void 0;
    if (!d) throw new ApiError("DEVICE_NOT_FOUND", 404);
    if (d.revoked) throw new ApiError("DEVICE_REVOKED", 403);
    return d;
  }
  list() {
    return Object.values(this.state.devices).filter((d) => !d.revoked);
  }
  register(descriptor) {
    const old = this.state.devices[descriptor.deviceId];
    if (old?.revoked) throw new ApiError("DEVICE_REVOKED", 403);
    if (old && (old.descriptor.identityKey !== descriptor.identityKey || old.descriptor.role !== descriptor.role)) throw new ApiError("PEER_IDENTITY_MISMATCH", 409);
    if (!old && Object.keys(this.state.devices).length >= 256) throw new ApiError("RATE_LIMITED", 429);
    this.state.devices[descriptor.deviceId] = { descriptor, revoked: false, lastSeenAt: old?.lastSeenAt ?? 0 };
    this.invalidate(descriptor.deviceId);
    return this.issue(descriptor.deviceId);
  }
  issue(deviceId, refreshTokenExpiresAt = Date.now() + 30 * 864e5, previous) {
    const tokens = { ...this.state.tokens };
    for (const [key, value] of Object.entries(tokens)) if (value.expires <= Date.now()) delete tokens[key];
    if (Object.keys(tokens).length + 2 > 16384) throw new ApiError("RATE_LIMITED", 429);
    const accessTokenExpiresAt = Date.now() + 60 * 6e4;
    const nonce = secret();
    const { accessToken, refreshToken } = previous ? successor(previous.token, nonce, deviceId) : { accessToken: secret(), refreshToken: secret() };
    if (previous) tokens[hash(previous.token)] = {
      ...previous.record,
      used: true,
      recovery: { nonce, accessExpires: accessTokenExpiresAt }
    };
    tokens[hash(accessToken)] = { kind: "access", deviceId, expires: accessTokenExpiresAt, used: false };
    tokens[hash(refreshToken)] = { kind: "refresh", deviceId, expires: refreshTokenExpiresAt, used: false };
    const before = this.state.tokens;
    this.state.tokens = tokens;
    try {
      this.save();
    } catch (error) {
      this.state.tokens = before;
      throw error;
    }
    return { accessToken, refreshToken, accessTokenExpiresAt, refreshTokenExpiresAt };
  }
  authenticate(token) {
    const record = this.state.tokens[hash(token)];
    if (!record || record.kind !== "access") throw new ApiError("AUTH_INVALID", 401);
    if (record.expires <= Date.now()) throw new ApiError("TOKEN_EXPIRED", 401);
    return this.get(record.deviceId);
  }
  refresh(deviceId, token) {
    this.get(deviceId);
    const record = this.state.tokens[hash(token)];
    if (!record || record.kind !== "refresh" || record.deviceId !== deviceId) throw new ApiError("AUTH_INVALID", 401);
    if (record.expires <= Date.now()) throw new ApiError("TOKEN_EXPIRED", 401);
    if (!record.used) return this.issue(deviceId, record.expires, { token, record });
    if (!record.recovery) throw new ApiError("AUTH_INVALID", 401);
    const pair = successor(token, record.recovery.nonce, deviceId);
    const next = this.state.tokens[hash(pair.refreshToken)];
    if (!next || next.kind !== "refresh" || next.deviceId !== deviceId || next.expires !== record.expires) {
      throw new ApiError("INTERNAL_ERROR", 503);
    }
    if (next.used) throw new ApiError("AUTH_INVALID", 401);
    const access = this.state.tokens[hash(pair.accessToken)];
    if (access ? access.kind !== "access" || access.deviceId !== deviceId || access.expires !== record.recovery.accessExpires : record.recovery.accessExpires > Date.now()) throw new ApiError("INTERNAL_ERROR", 503);
    return { ...pair, accessTokenExpiresAt: record.recovery.accessExpires, refreshTokenExpiresAt: next.expires };
  }
  invalidate(deviceId) {
    for (const [key, value] of Object.entries(this.state.tokens)) if (value.deviceId === deviceId) delete this.state.tokens[key];
    this.onInvalidate(deviceId);
    this.save();
  }
  revoke(id2) {
    this.get(id2).revoked = true;
    this.invalidate(id2);
  }
  rename(id2, name) {
    this.get(id2).descriptor.name = name;
    this.save();
  }
  touch(id2, clientVersion, harnessVersion) {
    const d = this.get(id2);
    d.lastSeenAt = Date.now();
    if (clientVersion) d.descriptor.clientVersion = clientVersion.slice(0, 64);
    if (d.descriptor.role === "host" && harnessVersion) d.descriptor.harnessVersion = harnessVersion.slice(0, 64);
    this.save();
  }
};

// release/qa-dsh-s2/upstream/apps/server/src/gateway.ts
import { randomUUID } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";

// release/qa-dsh-s2/upstream/apps/server/src/logger.ts
var LOG_LEVEL_SEVERITY = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 50
};
var SENSITIVE_KEYS = [
  "accesstoken",
  "refreshtoken",
  "token",
  "password",
  "passwd",
  "secret",
  "sdp",
  "ciphertext",
  "authorization",
  "cookie",
  "apikey"
];
function isSensitiveKey(key) {
  if (typeof key !== "string" || key === "") return false;
  const normalized = key.toLowerCase().replace(/[-_\s]/g, "");
  return SENSITIVE_KEYS.some((sensitive) => normalized === sensitive || normalized.endsWith(sensitive));
}
var REDACTED = "[REDACTED]";
var CIRCULAR = "[CIRCULAR]";
var DEPTH_LIMIT = "[DEPTH_LIMIT]";
var UNSERIALIZABLE = "[UNSERIALIZABLE]";
var MAX_DEPTH = 8;
var KEY_VOCABULARY = "access[_-]?token|refresh[_-]?token|token|password|passwd|secret|sdp|ciphertext|authorization|cookie|api[_-]?key";
var KEY_START = "(?<![A-Za-z0-9])";
var KEY_END = "(?![A-Za-z0-9])";
var JSON_VALUE = /"(?:[^"\x5C]|\x5C.)*"/;
var SINGLE_QUOTED_VALUE = /'(?:[^'\x5C]|\x5C.)*'/;
var BARE_VALUE = /[^\s,;&}"']+/;
var URL_VALUE = /[^&#\s"']*/;
var JSON_KEY_SEPARATOR = /\s*:\s*/;
var KEY_VALUE_SEPARATOR = /\s*[=:]\s*/;
var URL_PARAM = new RegExp(`([?&](?:${KEY_VOCABULARY})=)${URL_VALUE.source}`, "gi");
var JSON_FIELD = new RegExp(`("(?:${KEY_VOCABULARY})")(${JSON_KEY_SEPARATOR.source})(${JSON_VALUE.source})`, "gi");
var KEY_VALUE = new RegExp(
  `(${KEY_START}(?:${KEY_VOCABULARY})${KEY_END})(${KEY_VALUE_SEPARATOR.source})(${JSON_VALUE.source}|${SINGLE_QUOTED_VALUE.source}|${BARE_VALUE.source})`,
  "gi"
);
var BEARER = /(bearer\s+)[A-Za-z0-9._~+/-]+=*/gi;
var BASIC = /(basic\s+)[A-Za-z0-9+/=]+/gi;
function redactString(value) {
  return value.replace(URL_PARAM, `$1${REDACTED}`).replace(JSON_FIELD, `$1$2"${REDACTED}"`).replace(BEARER, `$1${REDACTED}`).replace(BASIC, `$1${REDACTED}`).replace(KEY_VALUE, `$1$2${REDACTED}`);
}
function readSafely(read, fallback) {
  try {
    const value = read();
    return value === void 0 || value === null ? fallback : value;
  } catch {
    return fallback;
  }
}
function redactSensitive(data2, seen = /* @__PURE__ */ new WeakSet(), depth = 0) {
  try {
    if (data2 === null || data2 === void 0) return data2;
    switch (typeof data2) {
      case "string":
        return redactString(data2);
      case "number":
        return Number.isFinite(data2) ? data2 : String(data2);
      case "boolean":
        return data2;
      case "bigint":
        return data2.toString();
      case "symbol":
        return data2.toString();
      case "function":
        return "[FUNCTION]";
      default:
        break;
    }
    if (depth >= MAX_DEPTH) return DEPTH_LIMIT;
    const object = data2;
    if (seen.has(object)) return CIRCULAR;
    seen.add(object);
    if (Array.isArray(object)) {
      return object.map((item) => redactSensitive(item, seen, depth + 1));
    }
    if (object instanceof Error) {
      const name = readSafely(() => typeof object.name === "string" ? object.name : "Error", "Error");
      const message = readSafely(() => redactString(typeof object.message === "string" ? object.message : ""), "");
      const stack = readSafely(() => typeof object.stack === "string" ? redactString(object.stack) : void 0, void 0);
      return { name, message, ...stack ? { stack } : {} };
    }
    const result = {};
    for (const key of Object.keys(object)) {
      if (isSensitiveKey(key)) {
        result[key] = REDACTED;
        continue;
      }
      const value = readSafely(() => object[key], UNSERIALIZABLE);
      result[key] = redactSensitive(value, seen, depth + 1);
    }
    return result;
  } catch {
    return UNSERIALIZABLE;
  }
}
var LABEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_.-]*$/;
function safeLabel(value, fallback) {
  if (typeof value !== "string" || value.length === 0 || value.length > 80 || !LABEL_PATTERN.test(value)) return fallback;
  return value;
}
function isLogLevel(value) {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(LOG_LEVEL_SEVERITY, value);
}
function severityOf(level) {
  return isLogLevel(level) ? LOG_LEVEL_SEVERITY[level] : LOG_LEVEL_SEVERITY.info;
}
var Logger = class _Logger {
  scope;
  level;
  sink;
  constructor(scope = "server", level = "info", sink) {
    this.scope = safeLabel(scope, "server");
    this.level = isLogLevel(level) ? level : "info";
    this.sink = sink;
  }
  child(subScope) {
    return new _Logger(`${this.scope}:${safeLabel(subScope, "child")}`, this.level, this.sink);
  }
  debug(event, meta) {
    this.log("debug", event, meta);
  }
  info(event, meta) {
    this.log("info", event, meta);
  }
  warn(event, meta) {
    this.log("warn", event, meta);
  }
  error(event, meta) {
    this.log("error", event, meta);
  }
  buildEntry(level, event, meta) {
    const ts = (/* @__PURE__ */ new Date()).toISOString();
    let cleanMeta = {};
    try {
      const redacted = meta === void 0 ? {} : redactSensitive(meta);
      cleanMeta = redacted !== null && typeof redacted === "object" && !Array.isArray(redacted) ? redacted : { value: redacted };
    } catch {
      cleanMeta = { redactionFailed: true };
    }
    return { ts, level, scope: this.scope, event: safeLabel(event, "invalid_event"), meta: cleanMeta };
  }
  log(level, event, meta) {
    try {
      if (severityOf(level) < severityOf(this.level)) return;
      const entry = this.buildEntry(level, event, meta);
      let line = "";
      try {
        const serialized = JSON.stringify(entry);
        if (typeof serialized !== "string") throw new TypeError("log entry is not serializable");
        line = serialized;
      } catch {
        line = JSON.stringify({
          ts: (/* @__PURE__ */ new Date()).toISOString(),
          level,
          scope: this.scope,
          event: safeLabel(event, "invalid_event"),
          meta: { serializationFailed: true }
        });
      }
      if (this.sink) {
        try {
          this.sink(line, entry);
        } catch {
        }
        return;
      }
      if (level === "error") console.error(line);
      else if (level === "warn") console.warn(line);
      else console.info(line);
    } catch {
    }
  }
};

// release/qa-dsh-s2/upstream/apps/server/src/config.ts
var HELLO_TIMEOUT_MS_RANGE = { min: 1e3, max: 6e4, fallback: 5e3 };
var HEARTBEAT_INTERVAL_MS_RANGE = { min: 5e3, max: 12e4, fallback: 25e3 };
var FORCE_TERMINATE_GRACE_MS_RANGE = { min: 100, max: 1e4, fallback: 1e3 };
var MAX_FRAMES_PER_SEC_RANGE = { min: 64, max: 65536, fallback: 512 };
var HEARTBEAT_DISCONNECT_MS_MIN_FACTOR = 2;
var HEARTBEAT_DISCONNECT_MS_MAX = 6e5;
var HEARTBEAT_DISCONNECT_MS_FLOOR = 75e3;
var HEARTBEAT_DISCONNECT_MS_FACTOR = 3;
function normalizeMs(value, range, label) {
  if (value === void 0 || value === null) return range.fallback;
  let candidate = Number.NaN;
  try {
    if (typeof value === "number") candidate = value;
    else if (typeof value === "string" && value.trim() !== "") candidate = Number(value);
  } catch {
    candidate = Number.NaN;
  }
  if (!Number.isFinite(candidate) || !Number.isInteger(candidate) || candidate < range.min || candidate > range.max) {
    console.warn(`[config] Invalid ${label}. Must be an integer between ${range.min} and ${range.max}. Falling back to ${range.fallback}.`);
    return range.fallback;
  }
  return candidate;
}
function normalizeHelloTimeoutMs(value) {
  return normalizeMs(value, HELLO_TIMEOUT_MS_RANGE, "DSH_SERVER_HELLO_TIMEOUT_MS");
}
function normalizeHeartbeatIntervalMs(value) {
  return normalizeMs(value, HEARTBEAT_INTERVAL_MS_RANGE, "DSH_SERVER_HEARTBEAT_INTERVAL_MS");
}
function heartbeatDisconnectFallback(heartbeatIntervalMs) {
  return Math.min(
    HEARTBEAT_DISCONNECT_MS_MAX,
    Math.max(HEARTBEAT_DISCONNECT_MS_FLOOR, heartbeatIntervalMs * HEARTBEAT_DISCONNECT_MS_FACTOR)
  );
}
function normalizeHeartbeatDisconnectMs(value, heartbeatIntervalMs) {
  const min = heartbeatIntervalMs * HEARTBEAT_DISCONNECT_MS_MIN_FACTOR;
  const fallback = heartbeatDisconnectFallback(heartbeatIntervalMs);
  if (value === void 0 || value === null) return fallback;
  let candidate = Number.NaN;
  try {
    if (typeof value === "number") candidate = value;
    else if (typeof value === "string" && value.trim() !== "") candidate = Number(value);
  } catch {
    candidate = Number.NaN;
  }
  if (!Number.isFinite(candidate) || !Number.isInteger(candidate) || candidate < min || candidate > HEARTBEAT_DISCONNECT_MS_MAX) {
    console.warn(
      `[config] Invalid DSH_SERVER_HEARTBEAT_DISCONNECT_MS. Must be an integer between ${min} and ${HEARTBEAT_DISCONNECT_MS_MAX} (at least ${HEARTBEAT_DISCONNECT_MS_MIN_FACTOR}x the heartbeat interval). Falling back to ${fallback}.`
    );
    return fallback;
  }
  return candidate;
}
function normalizeForceTerminateGraceMs(value) {
  return normalizeMs(value, FORCE_TERMINATE_GRACE_MS_RANGE, "DSH_SERVER_FORCE_TERMINATE_GRACE_MS");
}
function normalizeMaxFramesPerSec(value) {
  return normalizeMs(value, MAX_FRAMES_PER_SEC_RANGE, "DSH_SERVER_MAX_FRAMES_PER_SEC");
}
function normalizeGatewayOptions(options) {
  const source = options ?? {};
  const heartbeatIntervalMs = normalizeHeartbeatIntervalMs(source.heartbeatIntervalMs);
  return {
    helloTimeoutMs: normalizeHelloTimeoutMs(source.helloTimeoutMs),
    heartbeatIntervalMs,
    heartbeatDisconnectMs: normalizeHeartbeatDisconnectMs(source.heartbeatDisconnectMs, heartbeatIntervalMs),
    forceTerminateGraceMs: normalizeForceTerminateGraceMs(source.forceTerminateGraceMs)
  };
}

// release/qa-dsh-s2/upstream/apps/server/src/gateway.ts
var DROPPED_LINK_TTL_MS = 3e5;
var MAX_DROPPED_LINKS_PER_HOST = 64;
var MAX_DROPPED_LINKS = 16384;
var MAX_ICE_CANDIDATES_PER_CONNECTION = 256;
var WEBRTC_FALLBACK_TIMEOUT_MS = 12e3;
var SUPPORTED_TRANSPORTS = ["transport.lan", "transport.p2p", "transport.turn", "transport.relay"];
var TRANSPORT_NAMES = ["lan", "p2p", "turn", "relay"];
function modernHost(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:\+.*)?$/.exec(version);
  if (!match) return false;
  const [major, minor, patch] = match.slice(1).map(Number);
  return major > 0 || (minor > 2 || minor === 2 && patch >= 15);
}
var SAFE_TEXT = /^[A-Za-z0-9_.:-]+$/;
var SAFE_PATH = /^[A-Za-z0-9/._~-]*$/;
var SAFE_ADDRESS = /^[0-9a-fA-F:.]{2,45}$/;
var SAFE_ERROR_NAME = /^[A-Za-z][A-Za-z0-9]{0,31}$/;
var SAFE_ERROR_CODE = /^[A-Z0-9_]{1,32}$/;
function safeText(value, max = 64) {
  return typeof value === "string" && SAFE_TEXT.test(value) ? value.slice(0, max) : void 0;
}
function requestPath(rawUrl) {
  if (typeof rawUrl !== "string" || rawUrl === "") return "";
  const end = rawUrl.search(/[?#]/);
  const path = end === -1 ? rawUrl : rawUrl.slice(0, end);
  return SAFE_PATH.test(path) ? path.slice(0, 64) : "<invalid>";
}
function socketAddress(socket) {
  try {
    const address = socket?.remoteAddress;
    return typeof address === "string" && SAFE_ADDRESS.test(address) ? address : void 0;
  } catch {
    return void 0;
  }
}
function errorName(error) {
  try {
    const name = error instanceof Error ? error.name : void 0;
    return typeof name === "string" && SAFE_ERROR_NAME.test(name) ? name : "Error";
  } catch {
    return "Error";
  }
}
function errorCode(error) {
  try {
    const code = error?.code;
    return typeof code === "string" && SAFE_ERROR_CODE.test(code) ? code : void 0;
  } catch {
    return void 0;
  }
}
var Gateway = class {
  constructor(server, store, origin, options = {}) {
    this.store = store;
    const timing = normalizeGatewayOptions(options);
    this.helloTimeoutMs = timing.helloTimeoutMs;
    this.heartbeatIntervalMs = timing.heartbeatIntervalMs;
    this.heartbeatDisconnectMs = timing.heartbeatDisconnectMs;
    this.forceTerminateGraceMs = timing.forceTerminateGraceMs;
    this.maxFramesPerSec = normalizeMaxFramesPerSec(options.maxFramesPerSec);
    this.logger = options.logger ?? new Logger("gateway", options.logLevel ?? "info");
    this.turnEnabled = options.turnEnabled === true;
    store.onInvalidate = (id2) => this.disconnect(id2, "AUTH_INVALID");
    server.on("upgrade", (req, socket, head) => {
      const path = requestPath(req.url);
      const pathRejected = req.url !== "/ws/v1/connect";
      const originRejected = Boolean(req.headers.origin) && req.headers.origin !== origin;
      if (pathRejected || originRejected || this.wss.clients.size >= 256) {
        this.logger.warn("ws_upgrade_rejected", {
          // Parsed pathname only: the raw URL may carry credentials in its query.
          path: path === "" ? "unknown" : path,
          reason: pathRejected ? "invalid_url" : originRejected ? "origin_mismatch" : "connection_limit_reached",
          clientCount: this.wss.clients.size,
          hasOrigin: Boolean(req.headers.origin),
          remoteAddress: socketAddress(socket)
        });
        socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.accept(ws));
    });
    this.heartbeat = setInterval(() => {
      if (this.closed) return;
      for (const peer of this.peers.values()) {
        if (Date.now() - peer.lastPong > this.heartbeatDisconnectMs) {
          this.logger.warn("ws_heartbeat_timeout", {
            peerId: peer.id,
            role: peer.role,
            lastPong: peer.lastPong,
            elapsedMs: Date.now() - peer.lastPong,
            thresholdMs: this.heartbeatDisconnectMs
          });
          this.disconnect(peer.id, "CONNECTION_FAILED");
          continue;
        }
        peer.nonce = randomUUID();
        this.send(peer, createControlFrame("ping", { nonce: peer.nonce }));
      }
      for (const link of this.links.values()) {
        if (link.stage !== "ready" && Date.now() - link.created > 3e4) this.drop(link, "CONNECTION_FAILED");
      }
      this.pruneDroppedLinks(Date.now());
    }, this.heartbeatIntervalMs);
    this.heartbeat.unref();
  }
  store;
  peers = /* @__PURE__ */ new Map();
  links = /* @__PURE__ */ new Map();
  droppedLinks = /* @__PURE__ */ new Map();
  wss = new WebSocketServer({ noServer: true, maxPayload: MAX_RELAY_FRAME_BYTES, perMessageDeflate: false });
  heartbeat;
  closed = false;
  turnEnabled;
  helloTimeoutMs;
  heartbeatIntervalMs;
  heartbeatDisconnectMs;
  forceTerminateGraceMs;
  maxFramesPerSec;
  logger;
  pruneDroppedLinks(now) {
    for (const [id2, entry] of this.droppedLinks) {
      if (entry.expiresAt <= now) this.droppedLinks.delete(id2);
    }
  }
  evictDroppedLink(id2, entry, now) {
    this.droppedLinks.delete(id2);
    if (entry.expiresAt <= now) return;
    for (const peerId of [entry.host, entry.client]) {
      const p = this.peers.get(peerId);
      if (p) p.evictedTombstoneUntil = Math.max(p.evictedTombstoneUntil ?? 0, entry.expiresAt);
    }
  }
  recordDroppedLink(link) {
    const now = Date.now();
    this.pruneDroppedLinks(now);
    this.droppedLinks.delete(link.id);
    let hostCount = 0;
    let oldestForHost;
    for (const [id2, entry] of this.droppedLinks) {
      if (entry.host === link.host) {
        if (oldestForHost === void 0) oldestForHost = [id2, entry];
        hostCount += 1;
      }
    }
    if (hostCount >= MAX_DROPPED_LINKS_PER_HOST && oldestForHost !== void 0) {
      this.evictDroppedLink(oldestForHost[0], oldestForHost[1], now);
    }
    while (this.droppedLinks.size >= MAX_DROPPED_LINKS) {
      const oldest = this.droppedLinks.entries().next().value;
      if (oldest === void 0) break;
      this.evictDroppedLink(oldest[0], oldest[1], now);
    }
    this.droppedLinks.set(link.id, {
      host: link.host,
      client: link.client,
      expiresAt: now + DROPPED_LINK_TTL_MS,
      droppedFrames: 0
    });
  }
  isDroppedLinkFrame(peer, frame) {
    if (frame.type === "ping" || frame.type === "pong" || frame.type === "connect.request") return false;
    const p = frame.payload;
    const id2 = p.connectionId;
    if (typeof id2 !== "string" || this.links.has(id2)) return false;
    const now = Date.now();
    const dropped = this.droppedLinks.get(id2);
    if (!dropped) {
      return peer.evictedTombstoneUntil !== void 0 && now < peer.evictedTombstoneUntil;
    }
    if (dropped.expiresAt <= now) {
      this.droppedLinks.delete(id2);
      return false;
    }
    if (peer.id !== dropped.host && peer.id !== dropped.client) return false;
    dropped.droppedFrames += 1;
    if (dropped.droppedFrames === 1) {
      this.logger.debug("ws_stale_link_frames_dropped", {
        peerId: peer.id,
        role: peer.role,
        connectionId: safeText(id2)
      });
    }
    return true;
  }
  droppedLinkFrameCount(connectionId) {
    return this.droppedLinks.get(connectionId)?.droppedFrames ?? 0;
  }
  send(peer, frame) {
    if (peer.ws.readyState !== WebSocket.OPEN) return;
    if (peer.ws.bufferedAmount > 4 * MAX_RELAY_FRAME_BYTES) {
      this.disconnect(peer.id, "SLOW_CONSUMER");
      return;
    }
    peer.ws.send(JSON.stringify(frame));
  }
  drop(link, code) {
    this.links.delete(link.id);
    this.recordDroppedLink(link);
    for (const id2 of [link.host, link.client]) {
      const p = this.peers.get(id2);
      if (p && (p.role === "client" || modernHost(p.version))) this.send(p, createControlFrame("error", { code, message: code, connectionId: link.id, retryable: true }));
    }
  }
  disconnect(id2, code) {
    const peer = this.peers.get(id2);
    this.peers.delete(id2);
    for (const link of this.links.values()) if (link.host === id2 || link.client === id2) this.drop(link, code);
    if (!peer) return;
    this.logger.info("ws_peer_disconnected", { peerId: id2, code });
    try {
      peer.ws.close(code === "CONNECTION_REPLACED" ? 4003 : 4001, code);
    } catch {
    }
    const timer = setTimeout(() => {
      if (peer.ws.readyState !== WebSocket.CLOSED) peer.ws.terminate();
    }, this.forceTerminateGraceMs);
    timer.unref();
  }
  /**
   * Authorize a REST `/api/v1/turn/credentials` request. Only the two devices
   * of an active logical connection may obtain credentials, and only while
   * that connection is still being established.
   */
  authorizeIce(deviceId, connectionId) {
    const link = this.links.get(connectionId);
    if (link === void 0) return false;
    if (link.host !== deviceId && link.client !== deviceId) return false;
    if (link.stage !== "accepted" && link.stage !== "handshake") return false;
    return this.peers.has(link.host) && this.peers.has(link.client);
  }
  supportedCapabilities() {
    return SUPPORTED_TRANSPORTS.filter((capability) => capability !== "transport.turn" || this.turnEnabled);
  }
  negotiatedCapabilities(offered) {
    return this.supportedCapabilities().filter((capability) => offered.includes(capability));
  }
  accept(ws) {
    let state = "awaiting_hello";
    let peer;
    let deadline;
    let graceTimer;
    const clearDeadline = () => {
      if (deadline === void 0) return;
      clearTimeout(deadline);
      deadline = void 0;
    };
    const clearGrace = () => {
      if (graceTimer === void 0) return;
      clearTimeout(graceTimer);
      graceTimer = void 0;
    };
    const terminateSoon = (target2) => {
      clearGrace();
      graceTimer = setTimeout(() => {
        graceTimer = void 0;
        if (target2.readyState !== WebSocket.CLOSED) target2.terminate();
      }, this.forceTerminateGraceMs);
      graceTimer.unref();
    };
    this.logger.debug("ws_connection_accepted", { clientCount: this.wss.clients.size });
    deadline = setTimeout(() => {
      deadline = void 0;
      if (state !== "awaiting_hello") return;
      state = "closing";
      this.logger.warn("ws_hello_timeout", { timeoutMs: this.helloTimeoutMs, readyState: ws.readyState });
      if (ws.readyState === WebSocket.OPEN) {
        try {
          const frame = createControlFrame("error", {
            code: "HELLO_TIMEOUT",
            message: `Hello handshake timed out after ${this.helloTimeoutMs}ms`,
            retryable: true
          });
          ws.send(JSON.stringify(frame));
        } catch (error) {
          this.logger.warn("ws_hello_timeout_send_failed", { errorName: errorName(error) });
        }
      }
      try {
        ws.close(4001, "CONNECTION_FAILED");
      } catch {
      }
      terminateSoon(ws);
    }, this.helloTimeoutMs);
    deadline.unref();
    let windowStart = Date.now(), frames = 0, bytes = 0, droppedFrames = 0, droppedBytes = 0;
    ws.on("error", (error) => {
      this.logger.warn("ws_socket_error", {
        peerId: peer?.id,
        errorName: errorName(error),
        errorCode: errorCode(error)
      });
    });
    ws.on("close", (code, reason) => {
      state = "closed";
      clearDeadline();
      clearGrace();
      this.logger.info("ws_connection_closed", {
        ...peer ? { peerId: peer.id, role: peer.role } : {},
        code,
        // The close reason is arbitrary client text: report only its presence.
        hasReason: Buffer.isBuffer(reason) ? reason.length > 0 : false
      });
      if (peer && this.peers.get(peer.id) === peer) this.disconnect(peer.id, "CONNECTION_FAILED");
    });
    ws.on("message", (raw, binary) => {
      if (state !== "awaiting_hello" && state !== "authenticated") return;
      if (ws.readyState !== WebSocket.OPEN) return;
      let frame;
      try {
        if (binary) throw new ApiError("INVALID_MESSAGE");
        const text = raw.toString();
        const frameBytes = Buffer.byteLength(text);
        if (Date.now() - windowStart >= 1e3) {
          windowStart = Date.now();
          frames = 0;
          bytes = 0;
          droppedFrames = 0;
          droppedBytes = 0;
        }
        const maxDroppedFrames = Math.max(this.maxFramesPerSec * 2, 1024);
        const maxDroppedBytes = 8 * MAX_RELAY_FRAME_BYTES;
        if (frames + droppedFrames + 1 > this.maxFramesPerSec + maxDroppedFrames || bytes + droppedBytes + frameBytes > 16 * MAX_RELAY_FRAME_BYTES + maxDroppedBytes) {
          throw new ApiError("RATE_LIMITED");
        }
        if (state === "awaiting_hello" && (++frames > this.maxFramesPerSec || (bytes += frameBytes) > 16 * MAX_RELAY_FRAME_BYTES)) {
          throw new ApiError("RATE_LIMITED");
        }
        const envelope = JSON.parse(text);
        if (envelope && envelope.v !== 1) throw new ApiError("UNSUPPORTED_VERSION");
        frame = decodeControlFrame(text);
        if (state === "awaiting_hello") {
          if (frame.type !== "hello") throw new ApiError("AUTH_REQUIRED");
          const p = frame.payload;
          const device = this.store.authenticate(p.accessToken).descriptor;
          if (device.deviceId !== p.deviceId || device.role !== p.role) throw new ApiError("AUTH_INVALID");
          if (!p.protocols.includes(1)) throw new ApiError("UNSUPPORTED_VERSION");
          if (state !== "awaiting_hello") return;
          state = "authenticated";
          clearDeadline();
          this.disconnect(device.deviceId, "CONNECTION_REPLACED");
          peer = { ws, id: device.deviceId, role: device.role, capabilities: this.negotiatedCapabilities(p.capabilities), version: p.clientVersion ?? device.clientVersion, lastPong: Date.now() };
          this.peers.set(peer.id, peer);
          this.store.touch(peer.id, p.clientVersion, p.harnessVersion);
          this.logger.info("ws_hello_authenticated", {
            deviceId: safeText(peer.id),
            role: peer.role,
            clientVersion: safeText(peer.version),
            capabilities: peer.capabilities.filter((capability) => typeof capability === "string" && SAFE_TEXT.test(capability)).slice(0, 8)
          });
          this.send(peer, createControlFrame("hello.ack", {
            protocol: 1,
            serverVersion: "self-hosted/0.1.0",
            connectionSessionId: randomUUID(),
            heartbeatIntervalMs: this.heartbeatIntervalMs,
            maxControlFrameBytes: MAX_CONTROL_FRAME_BYTES,
            maxRelayFrameBytes: MAX_RELAY_FRAME_BYTES,
            capabilities: this.negotiatedCapabilities(p.capabilities),
            webrtcEnabled: true,
            webrtcFallbackTimeoutMs: WEBRTC_FALLBACK_TIMEOUT_MS
          }));
          return;
        }
        if (frame.type === "hello") throw new ApiError("INVALID_MESSAGE");
        if (!peer || this.peers.get(peer.id) !== peer) throw new ApiError("AUTH_INVALID");
        this.store.get(peer.id);
        if (this.isDroppedLinkFrame(peer, frame)) {
          if (++droppedFrames > maxDroppedFrames || (droppedBytes += frameBytes) > maxDroppedBytes) {
            throw new ApiError("RATE_LIMITED");
          }
          return;
        }
        if (++frames > this.maxFramesPerSec || (bytes += frameBytes) > 16 * MAX_RELAY_FRAME_BYTES) {
          throw new ApiError("RATE_LIMITED");
        }
        this.handle(peer, frame);
      } catch (error) {
        const code = error instanceof ApiError ? error.code : "INVALID_MESSAGE";
        this.logger.warn("ws_message_error", {
          code,
          peerId: peer?.id,
          // Never log error.message: JSON parse failures echo the payload.
          errorName: errorName(error)
        });
        const connectionId = frame?.payload?.connectionId;
        if (peer && typeof connectionId === "string" && code !== "RATE_LIMITED") {
          const link = this.links.get(connectionId);
          if (link && (link.host === peer.id || link.client === peer.id)) {
            this.drop(link, code);
            return;
          }
          this.send(peer, createControlFrame("error", { code, message: code, connectionId, retryable: false }));
          return;
        }
        state = "closing";
        clearDeadline();
        if (ws.readyState === WebSocket.OPEN) {
          try {
            ws.send(JSON.stringify(createControlFrame("error", { code, message: code, retryable: false })));
          } catch {
          }
        }
        if (peer) this.disconnect(peer.id, code);
        else {
          try {
            ws.close(4001, code);
          } catch {
          }
          terminateSoon(ws);
        }
      }
    });
  }
  handle(peer, frame) {
    const p = frame.payload;
    if (frame.type === "ping") {
      this.send(peer, createControlFrame("pong", { nonce: p.nonce }));
      return;
    }
    if (frame.type === "pong") {
      if (peer.nonce && p.nonce === peer.nonce) {
        peer.lastPong = Date.now();
        peer.nonce = void 0;
      }
      return;
    }
    if (frame.type === "connect.request") {
      const request = frame.payload;
      if (peer.role !== "client") throw new ApiError("MEMBERSHIP_REQUIRED");
      const candidateHost = this.peers.get(request.hostDeviceId);
      if (candidateHost && Date.now() - candidateHost.lastPong > this.heartbeatDisconnectMs) {
        this.logger.warn("ws_heartbeat_timeout", {
          peerId: candidateHost.id,
          role: candidateHost.role,
          lastPong: candidateHost.lastPong,
          elapsedMs: Date.now() - candidateHost.lastPong,
          thresholdMs: this.heartbeatDisconnectMs
        });
        this.disconnect(candidateHost.id, "CONNECTION_FAILED");
      }
      const host = this.peers.get(request.hostDeviceId);
      if (!host || host.role !== "host") {
        this.send(peer, createControlFrame("error", { code: "HOST_OFFLINE", message: "Host is offline.", retryable: true }));
        return;
      }
      this.store.get(host.id);
      if (!request.preferredTransports.includes("relay") || !peer.capabilities.includes("transport.relay") || !host.capabilities.includes("transport.relay")) throw new ApiError("CAPABILITY_NOT_SUPPORTED");
      const preferredTransports = [...new Set(request.preferredTransports)].filter((transport) => peer.capabilities.includes(`transport.${transport}`) && host.capabilities.includes(`transport.${transport}`));
      if (preferredTransports.length === 0) throw new ApiError("CAPABILITY_NOT_SUPPORTED");
      for (const old of this.links.values()) if (old.client === peer.id || old.host === host.id && !modernHost(host.version)) this.drop(old, "CONNECTION_REPLACED");
      if (this.links.size >= 256) throw new ApiError("RATE_LIMITED");
      const link2 = {
        id: randomUUID(),
        host: host.id,
        client: peer.id,
        stage: "pending",
        created: Date.now(),
        counters: /* @__PURE__ */ new Map(),
        preferredTransports,
        iceCandidates: 0
      };
      this.links.set(link2.id, link2);
      this.send(host, createControlFrame("connect.incoming", {
        connectionId: link2.id,
        clientDeviceId: peer.id,
        clientIdentityKey: this.store.get(peer.id).descriptor.identityKey,
        authorization: "account",
        preferredTransports: link2.preferredTransports
      }));
      return;
    }
    const id2 = p.connectionId;
    const link = typeof id2 === "string" ? this.links.get(id2) : void 0;
    if (!link || peer.id !== link.host && peer.id !== link.client) throw new ApiError("CONNECTION_NOT_FOUND");
    const otherId = peer.id === link.host ? link.client : link.host;
    const other = this.peers.get(otherId);
    this.store.get(otherId);
    if (!other) throw new ApiError("CONNECTION_FAILED");
    if (frame.type === "connect.accepted" || frame.type === "connect.rejected") {
      if (peer.id !== link.host || link.stage !== "pending") throw new ApiError("INVALID_MESSAGE");
      if (frame.type === "connect.rejected") {
        this.links.delete(link.id);
        this.recordDroppedLink(link);
      } else link.stage = "accepted";
      this.send(other, frame);
      return;
    }
    if (p.targetDeviceId !== otherId || link.stage === "pending") throw new ApiError("CONNECTION_NOT_FOUND");
    if (frame.type.startsWith("signal.")) {
      this.forwardSignal(link, peer, other, frame);
      return;
    }
    if (frame.type === "transport.selected") {
      this.forwardTransportSelected(link, peer, other, frame.payload);
      return;
    }
    if (frame.type === "secure.handshake") {
      const step = frame.payload.step;
      if (step === 1 && peer.id === link.client && link.stage === "accepted") link.stage = "handshake";
      else if (step === 2 && peer.id === link.host && link.stage === "handshake") link.stage = "ready";
      else throw new ApiError("INVALID_MESSAGE");
    } else if (frame.type === "relay") {
      const counter = frame.payload.counter;
      if (link.stage !== "ready" || counter <= (link.counters.get(peer.id) ?? -1)) throw new ApiError("INVALID_MESSAGE");
      link.counters.set(peer.id, counter);
    } else throw new ApiError("INVALID_MESSAGE");
    this.send(other, frame);
  }
  /**
   * Forward WebRTC signaling only while the logical connection is being
   * established, and only for a transport this link actually negotiated. A
   * relay-only link has no data plane to coordinate — the Host treats
   * unsolicited signaling as a protocol violation that closes its whole
   * Control connection and every tunnel on it, so such frames are dropped for
   * the Client to time out and fall back to Relay.
   */
  forwardSignal(link, peer, other, frame) {
    if (link.stage === "ready") return;
    if (!link.preferredTransports.some((transport) => transport !== "relay")) return;
    if (frame.type === "signal.offer") {
      if (peer.id !== link.client) throw new ApiError("INVALID_MESSAGE");
    } else if (frame.type === "signal.answer") {
      if (peer.id !== link.host) throw new ApiError("INVALID_MESSAGE");
    } else if (frame.type === "signal.ice") {
      if (++link.iceCandidates > MAX_ICE_CANDIDATES_PER_CONNECTION) throw new ApiError("INVALID_MESSAGE");
    } else {
      throw new ApiError("INVALID_MESSAGE");
    }
    this.send(other, frame);
  }
  /**
   * Forward the initiator's transport choice, gated on the transports the
   * link negotiated. `lan` is downgraded to `p2p` only when the link did not
   * negotiate `transport.lan` (old RC2 peers), as required by
   * docs/protocol.md. Relay keeps the legacy compatibility gate.
   */
  forwardTransportSelected(link, peer, other, payload) {
    if (peer.id !== link.client) return;
    if (link.stage !== "accepted" && link.stage !== "handshake") throw new ApiError("INVALID_MESSAGE");
    const transport = payload.transport;
    if (!TRANSPORT_NAMES.includes(transport)) throw new ApiError("INVALID_MESSAGE");
    const selected = transport === "lan" && !link.preferredTransports.includes("lan") && link.preferredTransports.includes("p2p") ? "p2p" : transport;
    if (!link.preferredTransports.includes(selected)) throw new ApiError("CAPABILITY_NOT_SUPPORTED");
    if (selected === "relay" && !modernHost(other.version)) return;
    this.send(other, selected === transport ? createControlFrame("transport.selected", { ...payload }) : createControlFrame("transport.selected", { ...payload, transport: selected }));
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.heartbeat);
    this.logger.info("ws_gateway_closing", { clientCount: this.wss.clients.size });
    for (const ws of this.wss.clients) {
      try {
        if (ws.readyState === WebSocket.OPEN) ws.close(SERVER_SHUTDOWN_CLOSE_CODE, SERVER_SHUTDOWN_CLOSE_REASON);
        else ws.terminate();
      } catch {
      }
      const timer = setTimeout(() => {
        if (ws.readyState !== WebSocket.CLOSED) ws.terminate();
      }, this.forceTerminateGraceMs);
      timer.unref();
    }
    this.wss.close();
  }
};

// release/qa-dsh-s2/upstream/apps/server/src/ice.ts
import { createHmac as createHmac2 } from "node:crypto";
var DEFAULT_TURN_TTL_SECONDS = 300;
var MAX_TURN_TTL_SECONDS = 3600;
var MIN_TURN_TTL_SECONDS = 60;
var TURN_URL_PATTERN = /^turns?:[^\s]+$/i;
var STUN_URL_PATTERN = /^stuns?:[^\s]+$/i;
function splitUrls(value, pattern, name) {
  if (value === void 0) return [];
  const urls = value.split(",").map((entry) => entry.trim()).filter(Boolean);
  for (const url of urls) {
    if (!pattern.test(url)) throw new Error(`Invalid ${name} entry "${url}": expected a stun:/stuns: or turn:/turns: URL.`);
  }
  return [...new Set(urls)];
}
function parseTtl(value) {
  if (value === void 0 || value.trim() === "") return DEFAULT_TURN_TTL_SECONDS;
  const ttl = Number(value);
  if (!Number.isSafeInteger(ttl) || ttl < MIN_TURN_TTL_SECONDS || ttl > MAX_TURN_TTL_SECONDS) {
    throw new Error(`Invalid DSH_SERVER_TURN_TTL_SECONDS: expected an integer between ${MIN_TURN_TTL_SECONDS} and ${MAX_TURN_TTL_SECONDS}.`);
  }
  return ttl;
}
function parseIceConfig(env) {
  const stunUrls = splitUrls(env.DSH_SERVER_STUN_URLS, STUN_URL_PATTERN, "DSH_SERVER_STUN_URLS");
  const turnUrls = splitUrls(env.DSH_SERVER_TURN_URLS, TURN_URL_PATTERN, "DSH_SERVER_TURN_URLS");
  const secret2 = env.DSH_SERVER_TURN_SECRET?.trim() || void 0;
  const turnUsername = env.DSH_SERVER_TURN_USERNAME?.trim() || void 0;
  const turnPassword = env.DSH_SERVER_TURN_PASSWORD?.trim() || void 0;
  const staticPair = turnUsername !== void 0 && turnPassword !== void 0;
  if (secret2 !== void 0 && (turnUsername !== void 0 || turnPassword !== void 0)) {
    throw new Error("Set either DSH_SERVER_TURN_SECRET or DSH_SERVER_TURN_USERNAME + DSH_SERVER_TURN_PASSWORD, not both.");
  }
  if (!staticPair && (turnUsername !== void 0 || turnPassword !== void 0)) {
    throw new Error("DSH_SERVER_TURN_USERNAME and DSH_SERVER_TURN_PASSWORD must be configured together.");
  }
  if (turnUrls.length > 0 && secret2 === void 0 && !staticPair) {
    throw new Error("DSH_SERVER_TURN_URLS requires DSH_SERVER_TURN_SECRET or DSH_SERVER_TURN_USERNAME + DSH_SERVER_TURN_PASSWORD.");
  }
  if ((secret2 !== void 0 || staticPair) && turnUrls.length === 0) {
    throw new Error("DSH_SERVER_TURN_URLS is required when TURN credentials are configured.");
  }
  return { stunUrls, turnUrls, turnSecret: secret2, turnUsername, turnPassword, turnTtlSeconds: parseTtl(env.DSH_SERVER_TURN_TTL_SECONDS) };
}
function buildIceServers(config, deviceId, now = Date.now()) {
  const servers = [];
  if (config.stunUrls.length > 0) {
    servers.push({ urls: config.stunUrls.length === 1 ? config.stunUrls[0] : [...config.stunUrls] });
  }
  if (config.turnUrls.length > 0) {
    if (config.turnSecret !== void 0) {
      const expiresAt = Math.floor((now + config.turnTtlSeconds * 1e3) / 1e3);
      const username = `${expiresAt}:${deviceId}`;
      servers.push({
        urls: config.turnUrls.length === 1 ? config.turnUrls[0] : [...config.turnUrls],
        username,
        credential: createHmac2("sha1", config.turnSecret).update(username).digest("base64")
      });
    } else if (config.turnUsername !== void 0 && config.turnPassword !== void 0) {
      servers.push({
        urls: config.turnUrls.length === 1 ? config.turnUrls[0] : [...config.turnUrls],
        username: config.turnUsername,
        credential: config.turnPassword
      });
    }
  }
  return servers;
}

// release/qa-dsh-s2/upstream/apps/server/src/server.ts
function parseHelloTimeout(val) {
  return normalizeHelloTimeoutMs(val);
}
function parseHeartbeatInterval(val) {
  return normalizeHeartbeatIntervalMs(val);
}
function parseHeartbeatDisconnect(val, heartbeatIntervalMs = HEARTBEAT_INTERVAL_MS_RANGE.fallback) {
  return normalizeHeartbeatDisconnectMs(val, heartbeatIntervalMs);
}
function parseForceTerminateGrace(val) {
  return normalizeForceTerminateGraceMs(val);
}
function parseMaxFramesPerSec(val) {
  return normalizeMaxFramesPerSec(val);
}
var loginSchema = z4.object({ email: z4.string().min(1).max(254), password: z4.string().min(1).max(1024) }).strict();
var publicDir = fileURLToPath(new URL("../dist/public/", import.meta.url));
function readAssets() {
  if (!existsSync2(publicDir)) return /* @__PURE__ */ new Map();
  const assets = /* @__PURE__ */ new Map();
  for (const entry of readdirSync(publicDir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = join(entry.parentPath, entry.name);
    const path = file.slice(publicDir.length).replaceAll("\\", "/");
    assets.set(path, readFileSync2(file));
  }
  return assets;
}
async function body(req) {
  if (!req.headers["content-type"]?.toLowerCase().startsWith("application/json")) throw new ApiError("INVALID_MESSAGE", 415);
  let length = 0;
  const chunks = [];
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 16384) throw new ApiError("FRAME_TOO_LARGE", 413);
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ApiError("INVALID_MESSAGE");
  }
}
function normalizeIp(value) {
  const family = isIP(value);
  if (family === 4) return value.toLowerCase();
  if (family !== 6) return null;
  let canonical;
  try {
    canonical = new URL(`http://[${value}]/`).hostname.slice(1, -1);
  } catch {
    return null;
  }
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(canonical);
  if (!mapped) return canonical;
  const high = Number.parseInt(mapped[1], 16), low = Number.parseInt(mapped[2], 16);
  return `${high >>> 8}.${high & 255}.${low >>> 8}.${low & 255}`;
}
function normalizeTrustedProxyIps(values = []) {
  const result = /* @__PURE__ */ new Set();
  for (const raw of values) {
    const value = raw.trim();
    const normalized = value === "" ? null : normalizeIp(value);
    if (normalized === null) throw new Error(`Invalid DSH_SERVER_TRUSTED_PROXY_IPS entry "${raw}": expected a bare IPv4/IPv6 address (no port, CIDR or hostname).`);
    result.add(normalized);
  }
  return result;
}
function readSingleForwardedFor(req) {
  let value;
  let count = 0;
  const raw = req.rawHeaders;
  for (let i = 0; i + 1 < raw.length; i += 2) {
    if (raw[i].toLowerCase() !== "x-forwarded-for") continue;
    count++;
    value = raw[i + 1];
  }
  if (count !== 1) throw new ApiError("INVALID_MESSAGE");
  return value;
}
function clientAddress(req, trustedProxyIps) {
  const peer = normalizeIp(req.socket.remoteAddress ?? "");
  if (peer === null) throw new ApiError("INVALID_MESSAGE");
  if (!trustedProxyIps.has(peer)) return peer;
  const forwarded = normalizeIp(readSingleForwardedFor(req));
  if (forwarded === null) throw new ApiError("INVALID_MESSAGE");
  return forwarded;
}
function createRemoteServer(config) {
  if (!config.account.trim() || config.password.length < 12) throw new Error("DSH_SERVER_ACCOUNT and DSH_SERVER_PASSWORD (at least 12 characters) are required.");
  const url = new URL(config.publicUrl);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("DSH_SERVER_PUBLIC_URL must be an HTTP(S) origin.");
  const trustedProxyIps = normalizeTrustedProxyIps(config.trustedProxyIps);
  const ice = config.ice ?? parseIceConfig({});
  const store = new Store(config.dataFile, config.account.trim(), config.password);
  const assets = readAssets();
  const sessions = /* @__PURE__ */ new Map();
  const limits = /* @__PURE__ */ new Map();
  function rate(key, max) {
    for (const [k, v] of limits) if (v.until < Date.now()) limits.delete(k);
    let entry = limits.get(key);
    if (!entry) {
      if (limits.size >= 4096) throw new ApiError("RATE_LIMITED", 429);
      entry = { count: 0, until: Date.now() + 6e4 };
      limits.set(key, entry);
    }
    if (++entry.count > max) throw new ApiError("RATE_LIMITED", 429);
  }
  function token(req) {
    const authorization = req.headers.authorization;
    if (authorization) return authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
    return /(?:^|;\s*)dsh_session=([A-Za-z0-9_-]+)/.exec(req.headers.cookie ?? "")?.[1] ?? "";
  }
  function accountAuth(req) {
    const key = hash(token(req));
    if ((sessions.get(key) ?? 0) <= Date.now()) {
      sessions.delete(key);
      throw new ApiError("ACCOUNT_AUTH_REQUIRED", 401);
    }
  }
  function deviceAuth(req) {
    if (!req.headers.authorization?.startsWith("Bearer ")) throw new ApiError("AUTH_REQUIRED", 401);
    return store.authenticate(req.headers.authorization.slice(7));
  }
  function cookie(value, age) {
    return `dsh_session=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${url.protocol === "https:" ? "; Secure" : ""}`;
  }
  const profile = () => ({ account: store.account, profile: { displayName: store.account }, isAdmin: false });
  const server = createServer({ requestTimeout: 15e3, headersTimeout: 1e4 }, (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    void route(req, res).catch((error) => {
      if (res.headersSent || res.destroyed) return;
      const e = error instanceof ApiError ? error : error instanceof z4.ZodError ? new ApiError("INVALID_MESSAGE") : new ApiError("INTERNAL_ERROR", 500);
      if (e.status === 429) res.setHeader("Retry-After", "60");
      json(res, e.status, { error: { code: e.code, message: e.code, requestId: randomUUID2(), retryable: e.status === 429 || e.status >= 500 } });
    });
  });
  const logger = new Logger("server", config.logLevel ?? "info");
  const timing = normalizeGatewayOptions({
    helloTimeoutMs: config.helloTimeoutMs,
    heartbeatIntervalMs: config.heartbeatIntervalMs,
    heartbeatDisconnectMs: config.heartbeatDisconnectMs,
    forceTerminateGraceMs: config.forceTerminateGraceMs
  });
  const gateway = new Gateway(server, store, url.origin, {
    ...timing,
    maxFramesPerSec: normalizeMaxFramesPerSec(config.maxFramesPerSec),
    logLevel: config.logLevel,
    logger: logger.child("gateway"),
    turnEnabled: ice.turnUrls.length > 0
  });
  function descriptor(d) {
    return { ...d.descriptor, membershipId: `account:${hash(store.account).slice(0, 16)}`, online: gateway.peers.has(d.descriptor.deviceId), lastSeenAt: d.lastSeenAt };
  }
  async function route(req, res) {
    const requestUrl = new URL(req.url ?? "/", url);
    const path = requestUrl.pathname;
    const method = req.method;
    if (req.headers.origin && req.headers.origin !== url.origin) throw new ApiError("AUTH_INVALID", 403);
    if (req.headers["sec-fetch-site"] === "cross-site") throw new ApiError("AUTH_INVALID", 403);
    const staticAsset = path.startsWith("/assets/") || ["/icon.png", "/brand-whale.webp", "/landing-atmosphere.webp"].includes(path);
    const spaRoute = method === "GET" && !staticAsset && !path.startsWith("/api/") && !path.startsWith("/ws/") && !["/health", "/healthz", "/ready"].includes(path);
    if (method === "GET" && (spaRoute || staticAsset)) {
      const name = staticAsset ? path.slice(1) : "index.html";
      const asset = assets.get(name);
      if (!asset) throw new ApiError("METHOD_NOT_FOUND", 404);
      const contentType = name.endsWith(".js") ? "text/javascript; charset=utf-8" : name.endsWith(".css") ? "text/css; charset=utf-8" : name.endsWith(".png") ? "image/png" : name.endsWith(".webp") ? "image/webp" : "text/html; charset=utf-8";
      if (!staticAsset) res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Content-Type", contentType);
      res.end(asset);
      return;
    }
    if (method === "GET" && (path === "/health" || path === "/healthz" || path === "/ready")) {
      json(res, 200, { status: "ok" });
      return;
    }
    const client = clientAddress(req, trustedProxyIps);
    rate(`api:${client}`, 240);
    if (method === "POST" && path === "/api/v1/auth/login") {
      rate(`login:${client}`, 20);
      const credentials = loginSchema.parse(await body(req));
      if (!equal(credentials.email.trim(), store.account) || !equal(credentials.password, config.password)) throw new ApiError("AUTH_INVALID", 401);
      for (const [key, expires] of sessions) if (expires <= Date.now()) sessions.delete(key);
      if (sessions.size >= 256) throw new ApiError("RATE_LIMITED", 429);
      const value = secret(), expiresAt = Date.now() + 8 * 36e5;
      sessions.set(hash(value), expiresAt);
      res.setHeader("Set-Cookie", cookie(value, 8 * 3600));
      json(res, 200, { ...profile(), token: value, expiresAt });
      return;
    }
    if (method === "GET" && path === "/api/v1/auth/me") {
      accountAuth(req);
      json(res, 200, profile());
      return;
    }
    if (method === "POST" && path === "/api/v1/auth/logout") {
      sessions.delete(hash(token(req)));
      res.setHeader("Set-Cookie", cookie("", 0));
      json(res, 200, { status: "ok" });
      return;
    }
    if (method === "GET" && path === "/api/v1/account/devices") {
      accountAuth(req);
      json(res, 200, { items: store.list().map(descriptor), serverUrl: url.origin, transport: "webrtc" });
      return;
    }
    if (method === "POST" && (path === "/api/v1/devices/register" || path === "/api/v1/devices/register-owned-role")) {
      const source = path.endsWith("register-owned-role") ? deviceAuth(req) : void 0;
      if (!source) accountAuth(req);
      const { device } = deviceRegistrationRequestSchema.parse(await body(req));
      if (source && (source.descriptor.deviceId === device.deviceId || source.descriptor.role === device.role)) throw new ApiError("INVALID_MESSAGE", 409);
      json(res, 200, store.register(device));
      return;
    }
    if (method === "POST" && path === "/api/v1/auth/refresh") {
      const data2 = deviceRefreshRequestSchema.parse(await body(req));
      json(res, 200, store.refresh(data2.deviceId, data2.refreshToken));
      return;
    }
    if (method === "DELETE" && path === "/api/v1/devices/self") {
      store.revoke(deviceAuth(req).descriptor.deviceId);
      json(res, 200, { status: "revoked" });
      return;
    }
    if (method === "GET" && path === "/api/v1/me") {
      json(res, 200, descriptor(deviceAuth(req)));
      return;
    }
    if (method === "GET" && path === "/api/v1/turn/credentials") {
      const source = deviceAuth(req);
      const connectionId = requestUrl.searchParams.get("connection_id") ?? "";
      if (!connectionId || connectionId.length > 128) throw new ApiError("INVALID_MESSAGE");
      if (!gateway.authorizeIce(source.descriptor.deviceId, connectionId)) throw new ApiError("CONNECTION_NOT_FOUND", 404);
      json(res, 200, { iceServers: buildIceServers(ice, source.descriptor.deviceId) });
      return;
    }
    if (method === "GET" && path === "/api/v1/devices") {
      const source = deviceAuth(req);
      if (source.descriptor.role !== "client") throw new ApiError("MEMBERSHIP_REQUIRED", 403);
      const items = store.list().filter((d) => d.descriptor.role === "host").map((d) => {
        const { identityKey: _key, ...item } = descriptor(d);
        return item;
      });
      json(res, 200, { items, nextCursor: null });
      return;
    }
    const renameMatch = /^\/api\/v1\/devices\/([^/]+)\/name$/.exec(path);
    if (method === "POST" && renameMatch) {
      accountAuth(req);
      const { name } = z4.object({ name: z4.string().trim().min(1).max(80) }).parse(await body(req));
      store.rename(renameMatch[1], name);
      json(res, 200, descriptor(store.get(renameMatch[1])));
      return;
    }
    const match = /^\/api\/v1\/devices\/([^/]+)(\/presence)?$/.exec(path);
    if (method === "GET" && match) {
      const source = deviceAuth(req), target2 = store.get(match[1]);
      if (source.descriptor.role === target2.descriptor.role) throw new ApiError("MEMBERSHIP_REQUIRED", 403);
      const d = descriptor(target2);
      json(res, 200, match[2] ? { deviceId: d.deviceId, online: d.online, lastSeenAt: d.lastSeenAt } : d);
      return;
    }
    throw new ApiError("METHOD_NOT_FOUND", 404);
  }
  return { server, store, gateway, logger, close: async () => {
    gateway.close();
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  } };
}
function json(res, status, value) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value));
}
export {
  FORCE_TERMINATE_GRACE_MS_RANGE,
  HEARTBEAT_DISCONNECT_MS_MAX,
  HEARTBEAT_INTERVAL_MS_RANGE,
  HELLO_TIMEOUT_MS_RANGE,
  MAX_FRAMES_PER_SEC_RANGE,
  clientAddress,
  createRemoteServer,
  normalizeForceTerminateGraceMs,
  normalizeGatewayOptions,
  normalizeHeartbeatDisconnectMs,
  normalizeHeartbeatIntervalMs,
  normalizeHelloTimeoutMs,
  normalizeIp,
  normalizeMaxFramesPerSec,
  normalizeTrustedProxyIps,
  parseForceTerminateGrace,
  parseHeartbeatDisconnect,
  parseHeartbeatInterval,
  parseHelloTimeout,
  parseMaxFramesPerSec
};

import { createHash } from 'node:crypto';
import { agentOrigin, agentRuntimeSchema } from '../shared/agent-runtime.mjs';
import { fail } from './accounts.mjs';

export const serverPiRuntime = (owner, conversation, projectId = null) => ({
  version: 1,
  backend: 'pi',
  transport: 'server',
  location: 'server',
  deviceId: null,
  connectionId: null,
  projectId: projectId || null,
  sessionKey: createHash('sha256').update(`${owner}:${conversation}`).digest('hex'),
});
export const computerPiRuntime = (deviceId, projectId, conversation) => ({
  version: 1,
  backend: 'pi',
  transport: 'astral-relay',
  location: 'computer',
  deviceId,
  connectionId: null,
  projectId,
  sessionKey: conversation,
});

export function createAgentBindings(db) {
  // Retain legacy server/computer namespaces: older data may share a UI UUID.
  db.exec(`CREATE TABLE IF NOT EXISTS agent_conversation_bindings(
    owner TEXT NOT NULL,origin TEXT NOT NULL,conversation_id TEXT NOT NULL,
    runtime TEXT NOT NULL,PRIMARY KEY(owner,origin,conversation_id));`);
  function checkScope(owner, origin, conversation) {
    if (
      typeof owner !== 'string' ||
      !owner ||
      typeof conversation !== 'string' ||
      !conversation ||
      !['server', 'computer', 'remote'].includes(origin)
    )
      throw fail(400, 'Agent 会话范围无效。');
  }
  const get = (owner, origin, conversation) => {
    checkScope(owner, origin, conversation);
    const row = db
      .prepare(
        'SELECT runtime FROM agent_conversation_bindings WHERE owner=? AND origin=? AND conversation_id=?',
      )
      .get(owner, origin, conversation);
    return row ? agentRuntimeSchema.parse(JSON.parse(row.runtime)) : null;
  };
  function assert(owner, origin, conversation, input) {
    checkScope(owner, origin, conversation);
    const runtime = agentRuntimeSchema.parse(input);
    if (origin !== agentOrigin(runtime)) throw fail(409, 'Agent 会话不能更换执行位置。');
    const old = get(owner, origin, conversation);
    if (old && Object.keys(runtime).some((key) => old[key] !== runtime[key]))
      throw fail(409, '此对话已绑定其他 Agent、电脑或项目，请建立新对话。');
    return old || runtime;
  }
  return {
    get,
    assert,
    bind(owner, origin, conversation, input) {
      const runtime = assert(owner, origin, conversation, input);
      db.prepare('INSERT OR IGNORE INTO agent_conversation_bindings VALUES(?,?,?,?)').run(
        owner,
        origin,
        conversation,
        JSON.stringify(runtime),
      );
      // Also validate the stored winner if another connection inserted the row.
      return assert(owner, origin, conversation, runtime);
    },
  };
}

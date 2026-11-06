// Run in the Pi image (no model requests, no native packages). Only a temporary
// session tree is written. PI_FORK_MODULE may point to a staged implementation.
import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
const { SessionManager, RpcClient } = await import(
  process.env.PI_SDK_MODULE ||
    '/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/dist/index.js'
);
const { sessionCheckpoint, forkNativeSession } = await import(
  process.env.PI_FORK_MODULE
    ? pathToFileURL(process.env.PI_FORK_MODULE).href
    : new URL('../../deploy/pi/session-fork.mjs', import.meta.url)
);
const root = await mkdtemp('/tmp/astral-v0727-native-');
let client;
try {
  const sessions = join(root, 'sessions'),
    sourceKey = 'a'.repeat(64),
    targetKey = 'b'.repeat(64),
    source = join(sessions, sourceKey);
  await mkdir(source, { recursive: true });
  const task = randomUUID(),
    m = SessionManager.create(root, source, { id: sourceKey });
  await sessionCheckpoint(
    SessionManager,
    source,
    task,
    { sessionFile: m.getSessionFile() },
    'before',
  );
  const first = m.appendMessage({
    role: 'user',
    content: [{ type: 'text', text: 'native branch fixture' }],
    timestamp: Date.now(),
  });
  m.appendMessage({
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: 'synthetic thought' },
      { type: 'toolCall', id: 'qa-read', name: 'read', arguments: { path: 'fixture.md' } },
    ],
    api: 'openai-completions',
    provider: 'fixture',
    model: 'fixture',
    stopReason: 'toolUse',
    timestamp: Date.now(),
  });
  m.appendMessage({
    role: 'toolResult',
    toolCallId: 'qa-read',
    toolName: 'read',
    content: [{ type: 'text', text: 'synthetic tool result' }],
    isError: false,
    timestamp: Date.now(),
  });
  m.appendMessage({
    role: 'assistant',
    content: [{ type: 'text', text: 'fixture response' }],
    api: 'openai-completions',
    provider: 'fixture',
    model: 'fixture',
    stopReason: 'stop',
    timestamp: Date.now(),
  });
  m.appendCompaction('Synthetic preserved summary', first, 800);
  await sessionCheckpoint(
    SessionManager,
    source,
    task,
    { sessionFile: m.getSessionFile() },
    'after',
  );
  m.appendMessage({
    role: 'user',
    content: [{ type: 'text', text: 'later running fixture' }],
    timestamp: Date.now(),
  });
  const before = await readFile(m.getSessionFile());
  const inheritedTurn = randomUUID();
  const request = {
    sourceKey,
    targetKey,
    turnId: task,
    position: 'after',
    input: 'native branch fixture',
    checkpoints: [{ from: task, to: inheritedTurn }],
  };
  await forkNativeSession(SessionManager, sessions, request);
  const ref = JSON.parse(await readFile(join(sessions, targetKey, 'native-session.json'), 'utf8'));
  const path = join(sessions, targetKey, ref.file),
    branch = SessionManager.open(path).getBranch();
  assert.equal(branch.filter((e) => e.type === 'message').length, 4);
  assert.equal(
    branch.filter((e) => e.type === 'message')[1].message.content[0].thinking,
    'synthetic thought',
  );
  assert.equal(branch.find((e) => e.type === 'compaction').summary, 'Synthetic preserved summary');
  assert.equal(
    branch.find((e) => e.message?.role === 'toolResult').message.content[0].text,
    'synthetic tool result',
  );
  assert.deepEqual(await readFile(m.getSessionFile()), before);
  const empty = 'c'.repeat(64);
  await forkNativeSession(SessionManager, sessions, {
    ...request,
    targetKey: empty,
    position: 'before',
  });
  assert.equal(
    (await readdir(join(sessions, empty))).filter((x) => x.endsWith('.jsonl')).length,
    0,
  );
  assert.deepEqual(await forkNativeSession(SessionManager, sessions, request), { native: true });
  const grandchild = 'e'.repeat(64);
  await forkNativeSession(SessionManager, sessions, {
    sourceKey: targetKey,
    targetKey: grandchild,
    turnId: inheritedTurn,
    position: 'after',
    input: 'UI text intentionally differs from native input',
  });
  const inheritedRef = JSON.parse(
    await readFile(join(sessions, grandchild, 'native-session.json'), 'utf8'),
  );
  assert.deepEqual(
    SessionManager.open(join(sessions, grandchild, inheritedRef.file)).getBranch(),
    branch,
  );
  const cwd = join(root, 'different-current-directory');
  await mkdir(cwd);
  client = new RpcClient({
    cliPath: '/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js',
    cwd,
    provider: 'astral-deepseek',
    model: process.env.DEEPSEEK_MODEL || 'deepseek-flash',
    args: [
      '--session',
      path,
      '--session-dir',
      join(sessions, targetKey),
      '--offline',
      '--no-extensions',
      '--no-skills',
      '--no-prompt-templates',
      '--no-themes',
      '--no-context-files',
      '--no-mcp',
      '--no-builtin-tools',
      '--no-approve',
    ],
  });
  await client.start();
  const state = await client.getState();
  assert.equal(state.isStreaming, false);
  assert.ok(state.messageCount > 0);
  console.log(
    JSON.stringify({
      result: 'passed',
      pi: '1.4.0',
      nativeBranch: true,
      thinkingPreserved: true,
      toolResultPreserved: true,
      compactionPreserved: true,
      laterMessagesExcluded: true,
      sourceUnchanged: true,
      emptyEditBranch: true,
      idempotent: true,
      rpcResumedFromDifferentDirectory: true,
      inheritedMessageBranchedAgain: true,
      modelCalls: 0,
    }),
  );
} finally {
  await client?.stop();
  await rm(root, { recursive: true, force: true });
}

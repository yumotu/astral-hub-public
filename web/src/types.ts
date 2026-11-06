export type Page =
  | 'tarot'
  | 'gallery'
  | 'history'
  | 'plugins'
  | 'settings'
  | 'account'
  | 'social'
  | 'pi'
  | 'mail'
  | 'learning';
export type Spread = 'single' | 'three';
export type Card = { id: string; reversed: boolean; position: string };
export type Analysis = {
  summary: string;
  cards: { title: string; text: string }[];
  advice: string[];
};
export type Reading = {
  id: string;
  createdAt: string;
  question: string;
  spread: Spread;
  cards: Card[];
  analysis: Analysis | null;
  source: 'local' | 'deepseek';
  model?: string;
};
export type Entry = { id: string; deleted: boolean; data: Reading | null };
export type Settings = {
  url: string;
  token: string;
  autoSync: boolean;
  remember: boolean;
  apiKey: string;
  model: string;
  rememberKey: boolean;
  aiMode: 'server' | 'local';
  sessionToken?: string;
  aiScope?: string;
};
export type SyncStatus = {
  syncReady: boolean;
  aiRequests: 'client-direct' | 'server';
  aiConfigured: boolean;
  model?: string;
  chatSync: boolean;
  version: string;
  accounts?: boolean;
  piConfigured?: boolean;
};
export type User = {
  id: string;
  username: string;
  displayName: string;
  bio: string;
  city: string;
  role: 'owner' | 'member';
  createdAt: string;
};
export type AuthSession = {
  token: string;
  user: User;
  expiresAt: string;
  server: string;
  remember: boolean;
};
export type Contact = User & {
  latest: { content: string; createdAt: string } | null;
  unread?: number;
};
export type LocationShare = {
  userId: string;
  latitude: number;
  longitude: number;
  accuracy: number;
  updatedAt: string;
  expiresAt: string;
};
export type SocialOverview = {
  me: User;
  contacts: Contact[];
  incoming: Pick<User, 'id' | 'username' | 'displayName'>[];
  outgoing: Pick<User, 'id' | 'username' | 'displayName'>[];
  locations: LocationShare[];
};
export type DirectMessage = {
  seq: number;
  id: string;
  senderId: string;
  recipientId: string;
  content: string;
  createdAt: string;
};
export type PiTimelineItem =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | ({ kind: 'tool' } & import('./ToolLog').ToolRun & {
        arguments?: string;
        added?: number;
        removed?: number;
      });
export type TodoItem = {
  id: string;
  text: string;
  status: 'pending' | 'running' | 'done' | 'cancelled';
};
export type PiMetrics = {
  modelTurns?: number;
  toolCalls?: number;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  responseMs?: number;
};
export type PiRuntimeDiagnostic = {
  code: string;
  message: string;
  details: string;
  phase: 'startup' | 'run';
  exitCode?: number;
};
export type PiExecution = {
  startedAt?: string;
  finishedAt?: string;
  metrics?: PiMetrics;
  context?: PiContext | null;
  runtimeWarnings?: PiRuntimeDiagnostic[];
};
export type PiContext = {
  limits?: ModelContext;
  messageCount?: number;
  autoCompaction?: boolean;
  stats?: {
    tokens?: {
      input?: number;
      output?: number;
      cacheRead?: number;
      cacheWrite?: number;
      total?: number;
    };
    contextUsage?: { tokens: number | null; contextWindow: number; percent: number | null };
    userMessages?: number;
    assistantMessages?: number;
    toolCalls?: number;
    cost?: number;
  };
};
export type PiSessionContext = {
  conversationId: string;
  revision: number;
  baselineTaskId: string | null;
  source: 'inspect' | 'compact' | 'task';
  observedAt: string;
  context: PiContext | null;
};
export type ModelContext = {
  model: string;
  contextWindow: number;
  requestedContextWindow: number | null;
  minContextWindow: number;
  maxContextWindow: number | null;
  maxOutputTokens: number | null;
  source: 'api' | 'cache' | 'unavailable';
  fetchedAt: string | null;
  warning: string;
  activeContextWindow?: number | null;
};
export type PiTurn = {
  execution?: PiExecution | null;
  supplements?: { id: string; input: string; attachments?: import('./ChatFiles').ChatFile[] }[];
  attachments?: import('./ChatFiles').ChatFile[];
  artifacts?: import('./ChatFiles').ChatFile[];
  seq?: number;
  thinking?: string;
  id: string;
  input: string;
  output: string;
  createdAt: string;
  projectId?: string | null;
  access?: 'read' | 'edit';
  tools?: import('./ToolLog').ToolRun[];
  timeline?: PiTimelineItem[];
};
export type Plugin = {
  id: string;
  name: string;
  version: '1.0.0';
  description: string;
  icon: 'sparkles' | 'book' | 'moon';
  prompt: string;
  inputLabel: string;
  inputPlaceholder: string;
  capabilities: 'ai.text'[];
};

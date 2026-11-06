import { useBackLayer } from './back-navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronLeft,
  Bot,
  ChevronDown,
  Copy,
  Inbox,
  FolderCog,
  MailOpen,
  MoveRight,
  Undo2,
  UserRound,
  LoaderCircle,
  Mail,
  PenLine,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Trash2,
  X,
  SlidersHorizontal,
} from 'lucide-react';
import { api, dateLabel } from './data';
import { MailComposer, type ReplySource } from './MailComposer';
import { PiMarkdown } from './PiMarkdown';
import { MailBody } from './MailBody';
import { UnreadBadge } from './unread';
import { MailActionDialog, type MailActionPreview, type MailOperation } from './MailActions';
import { MailAgent } from './MailAgent';
import { MailCache, mailTTL } from './mail-cache';
import { MailCacheSettings, type MailCacheInfo } from './MailCacheSettings';
import { defaultMailCacheSettings, mergeMailHistory } from '../../shared/mail-history.mjs';
import { serverIdentity } from './session';
import { mailBackTarget } from '../../shared/mail-navigation.mjs';
import { applyMailReadFlag } from '../../shared/mail-read.mjs';
import { invalidateAPI } from './resource-cache';
import type { AuthSession, Settings } from './types';

type MailProvider = 'gmail' | 'qq';
type MailAccount = {
  provider: MailProvider;
  providerLabel: string;
  address: string;
  createdAt: string;
  updatedAt: string;
} | null;
type Mailbox = { path: string; name: string; specialUse: string | null; unread?: number };
type MailSummary = {
  uid: number;
  subject: string;
  from: string;
  to: string;
  date: string | null;
  seen: boolean;
  flagged: boolean;
  size: number;
};
type DigestMessage = { uid: number; subject: string; from: string; date: string | null };
type MailHistory = {
  messages: MailSummary[];
  uidValidity: string | null;
  hasMore: boolean;
  nextCursor: string | null;
  scannedFrom: number | null;
  total: number;
};
type MailMessage = {
  uid: number;
  subject: string;
  from: string;
  fromAddress?: string;
  replyTo?: string;
  messageId?: string | null;
  to: string;
  date: string | null;
  text: string;
  hasHtml: boolean;
  html?: string;
  remoteImageCount?: number;
  truncated?: boolean;
  attachments: { filename: string; size: number; contentType: string }[];
};

function formatBytes(value: number) {
  if (!value) return '';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

export function MailPage({
  settings,
  session,
  login,
}: {
  settings: Settings;
  session: AuthSession | null;
  login: () => void;
}) {
  const cache = useMemo(
    () => new MailCache(JSON.stringify([serverIdentity(settings), session?.user.id || 'guest'])),
    [settings.url, session?.user.id],
  );
  const initial = cache.get<{
    mailbox: string;
    query: string;
    selected: number | null;
    unread?: boolean;
    since?: string;
    before?: string;
  }>('view', mailTTL.view)?.value;
  const firstBox = initial?.mailbox || 'INBOX';
  const firstQuery = initial?.query || '';
  const firstUnread = initial?.unread || false;
  const [since, setSince] = useState(initial?.since || ''),
    [before, setBefore] = useState(initial?.before || '');
  const dates = useRef({ since, before });
  dates.current = { since, before };
  const [cacheInfo, setCacheInfo] = useState<MailCacheInfo>({
    settings: { ...defaultMailCacheSettings },
    usage: { entries: 0, bytes: 0 },
  });
  const preferences = useRef(cacheInfo.settings);
  const [cacheOpen, setCacheOpen] = useState(false);
  const listKey = (box: string, search: string, unread = firstUnread, range = dates.current) =>
    JSON.stringify(['list', box, search.trim(), unread, range.since, range.before, 'history-v1']);
  const loadedContext = useRef({
    box: firstBox,
    search: firstQuery,
    unread: firstUnread,
    range: dates.current,
  });
  const bodyKey = (box: string, uid: number) => JSON.stringify(['body', box, uid, 'rich-v1']);
  const summaryKey = (box: string, uid: number) => JSON.stringify(['summary', box, uid]);
  const alive = useRef(true),
    listRequest = useRef(0),
    messageRequest = useRef(0),
    digestRequest = useRef(0);
  const reader = useRef<HTMLElement>(null),
    summaryCard = useRef<HTMLDivElement>(null);
  const [composer, setComposer] = useState<{ reply: ReplySource | null } | null>(null);
  const [account, setAccount] = useState<MailAccount>(
    () => cache.get<MailAccount>('account', mailTTL.account)?.value || null,
  );
  const [mailboxes, setMailboxes] = useState<Mailbox[]>(
    () => cache.get<Mailbox[]>('folders', mailTTL.folders)?.value || [],
  );
  const [mailbox, setMailbox] = useState(firstBox);
  const [messages, setMessages] = useState<MailSummary[]>(
    () => cache.get<MailHistory>(listKey(firstBox, firstQuery), mailTTL.list)?.value.messages || [],
  );
  const [history, setHistory] = useState<MailHistory | null>(
    () => cache.get<MailHistory>(listKey(firstBox, firstQuery), mailTTL.list)?.value || null,
  );
  const [selected, setSelected] = useState<number | null>(initial?.selected || null);
  const [message, setMessage] = useState<MailMessage | null>(() =>
    initial?.selected
      ? cache.get<MailMessage>(bodyKey(firstBox, initial.selected), mailTTL.body)?.value || null
      : null,
  );
  const [summary, setSummary] = useState(() =>
    initial?.selected
      ? cache.get<string>(summaryKey(firstBox, initial.selected), mailTTL.summary)?.value || ''
      : '',
  );
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [cachedAt, setCachedAt] = useState(
    () => cache.get(listKey(firstBox, firstQuery), mailTTL.list)?.at || 0,
  );
  const [draft, setDraft] = useState('');
  const [digest, setDigest] = useState('');
  const [digestMessages, setDigestMessages] = useState<DigestMessage[]>([]);
  const [selectedUids, setSelectedUids] = useState<Set<number>>(new Set());
  const [query, setQuery] = useState(firstQuery);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [setup, setSetup] = useState(false);
  const [provider, setProvider] = useState<MailProvider>('qq');
  const [address, setAddress] = useState('');
  const [appPassword, setAppPassword] = useState('');
  const [copied, setCopied] = useState('');
  const [plainText, setPlainText] = useState(false);
  const [unread, setUnread] = useState(firstUnread);
  const [actionPreview, setActionPreview] = useState<MailActionPreview | null>(null);
  useBackLayer(!!digest, closeDigest, 100);
  useBackLayer(setup && !!account, () => setSetup(false), 40);
  const [moveTarget, setMoveTarget] = useState('');
  const [folderEditor, setFolderEditor] = useState(false);
  const [folderAction, setFolderAction] = useState<'create-folder' | 'rename-folder'>(
    'create-folder',
  );
  const [folderName, setFolderName] = useState('');
  const [agentOpen, setAgentOpen] = useState(false);
  const [agentSuggestion, setAgentSuggestion] = useState('');
  const backTarget = mailBackTarget({
    folderEditor,
    summaryOpen,
    selected,
    selectedCount: selectedUids.size,
    query,
    unread,
    mailbox,
    since,
    before,
  });
  useBackLayer(!!backTarget && !setup, mailBack, 40);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (
        event.key === 'Escape' &&
        !event.defaultPrevented &&
        !composer &&
        !agentOpen &&
        !actionPreview &&
        backTarget &&
        !setup &&
        !digest
      ) {
        event.preventDefault();
        mailBack();
      }
    };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  });
  const currentBox = mailboxes.find((box) => box.path === mailbox);
  const inTrash =
    currentBox?.specialUse === '\\Trash' ||
    /^(Trash|Deleted Messages|已删除|回收站)$/i.test(currentBox?.name || '') ||
    mailbox === '[Gmail]/Trash';

  function draftKey(uid: number) {
    return `astral.mail.draft:${account?.address || ''}:${mailbox}:${uid}`;
  }

  function readDraft(uid: number) {
    try {
      return localStorage.getItem(draftKey(uid)) || '';
    } catch {
      return '';
    }
  }

  function toggleSelect(uid: number) {
    if (!selectedUids.has(uid) && selectedUids.size >= 1000) {
      setError('本批已选择1000封，请先整理本批后继续选择。');
      return;
    }
    setSelectedUids((current) => {
      const next = new Set(current);
      if (next.has(uid)) next.delete(uid);
      else next.add(uid);
      return next;
    });
  }

  async function loadMailboxes(nextMailbox = mailbox, refresh = false) {
    const generation = cache.generation;
    const hit = cache.get<Mailbox[]>('folders', mailTTL.folders);
    let boxes = hit?.value;
    if (!boxes || hit?.stale || refresh) {
      const result = await api<{ mailboxes: Mailbox[] }>(
        settings,
        '/mail/mailboxes' + (refresh ? '?refresh=1' : ''),
      );
      boxes = result.mailboxes;
      cache.set('folders', boxes, generation);
    }
    if (!alive.current || generation !== cache.generation) return;
    setMailboxes(boxes);
    const chosen = boxes.some((item) => item.path === nextMailbox)
      ? nextMailbox
      : boxes.find((item) => item.path === 'INBOX')?.path || boxes[0]?.path || 'INBOX';
    setMailbox(chosen);
    await loadMessages(chosen, query, refresh);
  }

  async function loadMessages(
    box = mailbox,
    search = query,
    refresh = false,
    unreadOnly = unread,
    older = false,
    range = dates.current,
  ) {
    const generation = cache.generation;
    const request = ++listRequest.current;
    const key = listKey(box, search, unreadOnly, range);
    loadedContext.current = { box, search, unread: unreadOnly, range: { ...range } };
    const hit = cache.get<MailHistory>(key, mailTTL.list);
    if (hit) {
      setMessages(hit.value.messages);
      setHistory(hit.value);
      setCachedAt(hit.at);
    } else {
      setMessages([]);
      setHistory(null);
      setCachedAt(0);
    }
    if (hit && !hit.stale && !refresh && !older) return;
    if (older && !hit?.value.nextCursor) return;
    const params = new URLSearchParams({
      mailbox: box,
      limit: String(preferences.current.pageSize),
    });
    if (refresh) params.set('refresh', '1');
    if (search.trim()) params.set('q', search.trim());
    if (unreadOnly) params.set('unread', '1');
    if (range.since) params.set('since', range.since);
    if (range.before) params.set('before', range.before);
    if (older && hit?.value.nextCursor) params.set('cursor', hit.value.nextCursor);
    const result = await api<MailHistory>(settings, `/mail/messages?${params.toString()}`);
    if (!alive.current || request !== listRequest.current || generation !== cache.generation)
      return;
    const validityKey = JSON.stringify(['validity', box]);
    const oldValidity = cache.get<string>(validityKey, mailTTL.body)?.value;
    if (oldValidity && result.uidValidity && oldValidity !== result.uidValidity) {
      cache.invalidateMailbox(box);
      resetSelection();
    }
    if (result.uidValidity) cache.set(validityKey, result.uidValidity);
    const merged = mergeMailHistory(hit?.value, result, { older }) as MailHistory;
    cache.set(key, merged);
    setMessages(merged.messages);
    setHistory(merged);
    setCachedAt(Date.now());
  }

  async function loadAccount() {
    if (!session) return;
    setError('');
    setBusy('account');
    try {
      await cache.ready();
      const result = await api<{ account: MailAccount }>(settings, '/mail/account');
      if (!alive.current) return;
      const old = cache.get<MailAccount>('account', mailTTL.account)?.value;
      if (old && JSON.stringify(old) !== JSON.stringify(result.account)) {
        cache.clear();
        setMessages([]);
        setMessage(null);
        setSelected(null);
        setSummary('');
        setCachedAt(0);
      }
      if (result.account) {
        const info = await api<MailCacheInfo>(settings, '/mail/cache');
        if (!alive.current) return;
        preferences.current = info.settings;
        cache.configure(info.settings);
        cache.set('account', result.account);
        setAccount(result.account);
        setCacheInfo(info);
        setProvider(result.account.provider);
        setSetup(false);
        await loadMailboxes();
        if (selected) await openMessage(selected);
      } else {
        cache.clear();
        setAccount(null);
        setSetup(true);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  }

  useEffect(() => {
    alive.current = true;
    if (!session) return;
    void loadAccount();
    // The account is scoped to the selected server and signed-in user.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    return () => {
      alive.current = false;
      listRequest.current++;
      messageRequest.current++;
      digestRequest.current++;
      cache.dispose();
    };
  }, [session?.user.id, settings.url]);

  useEffect(() => {
    if (account) cache.set('view', { mailbox, query, selected, unread, since, before });
  }, [cache, account, mailbox, query, selected, unread, since, before]);

  useEffect(() => {
    if (summaryOpen) summaryCard.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [summaryOpen, summary]);

  function resetSelection() {
    messageRequest.current++;
    digestRequest.current++;
    setBusy((current) => (['message', 'summary', 'digest'].includes(current) ? '' : current));
    setSelected(null);
    setMessage(null);
    setSummary('');
    setSummaryOpen(false);
    setDraft('');
    setSelectedUids(new Set());
    setDigest('');
    setDigestMessages([]);
  }

  function closeDigest() {
    digestRequest.current++;
    setDigest('');
    setDigestMessages([]);
    setBusy((current) => (current === 'digest' ? '' : current));
  }

  function mailBack() {
    if (backTarget === 'folder-editor') setFolderEditor(false);
    else if (backTarget === 'summary') setSummaryOpen(false);
    else if (backTarget === 'message') resetSelection();
    else if (backTarget === 'selection') setSelectedUids(new Set());
    else if (backTarget === 'filters') {
      setQuery('');
      setUnread(false);
      setSince('');
      setBefore('');
      setBusy('list');
      void loadMessages(mailbox, '', false, false, false, { since: '', before: '' })
        .catch((e) => setError(e.message))
        .finally(() => setBusy(''));
    } else if (backTarget === 'inbox') changeMailbox('INBOX');
  }

  function changeMailbox(box: string) {
    if (box === mailbox) return;
    resetSelection();
    setMailbox(box);
    setQuery('');
    setBusy('list');
    void loadMessages(box, '')
      .catch((e) => setError(e.message))
      .finally(() => setBusy(''));
  }

  async function previewAction(operation: MailOperation) {
    setBusy('manage');
    setError('');
    try {
      if (operation.action === 'read' || operation.action === 'unread') {
        await changeReadFlag(operation);
        return;
      }
      setActionPreview(await api<MailActionPreview>(settings, '/mail/actions/prepare', operation));
      setFolderEditor(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  }

  const flagTail = useRef<Promise<unknown>>(Promise.resolve());
  const autoReading = useRef(new Set<string>()),
    messagesNow = useRef(messages),
    mailboxNow = useRef(mailbox);
  messagesNow.current = messages;
  mailboxNow.current = mailbox;
  function changeReadFlag(operation: Extract<MailOperation, { action: 'read' | 'unread' }>) {
    const work = flagTail.current
      .catch(() => {})
      .then(async () => {
        if (!alive.current) return;
        const result = await applyMailReadFlag(
          (path: string, data?: unknown) =>
            api<MailActionPreview>(settings, path, data, undefined, false, { fresh: true }),
          operation,
        );
        cache.applySeen(operation.mailbox, operation.uids, operation.action === 'read');
        listRequest.current++;
        invalidateAPI(settings, '/mail/unread');
        window.dispatchEvent(new Event('astral:unread-change'));
        if (alive.current && operation.mailbox === mailboxNow.current) {
          const seen = operation.action === 'read';
          const delta = messagesNow.current.reduce(
            (n, row) =>
              operation.uids.includes(row.uid) && row.seen !== seen ? n + (seen ? -1 : 1) : n,
            0,
          );
          setMailboxes((old) =>
            old.map((box) =>
              box.path === operation.mailbox && typeof box.unread === 'number'
                ? { ...box, unread: Math.max(0, box.unread + delta) }
                : box,
            ),
          );
          setMessages((old) =>
            old
              .filter(
                (row) =>
                  !(unread && operation.action === 'read' && operation.uids.includes(row.uid)),
              )
              .map((row) =>
                operation.uids.includes(row.uid)
                  ? { ...row, seen: operation.action === 'read' }
                  : row,
              ),
          );
          // Keep the open message and scroll position while its flag changes.
          setSelectedUids(new Set());
        }
        return result;
      });
    flagTail.current = work;
    return work;
  }
  function markOpenedRead(uid: number) {
    if (messagesNow.current.find((m) => m.uid === uid)?.seen !== false) return;
    const key = mailbox + ':' + uid;
    if (autoReading.current.has(key)) return;
    autoReading.current.add(key);
    void changeReadFlag({ action: 'read', mailbox, uids: [uid] })
      .catch((e: Error) => {
        if (alive.current) setError('邮件已打开，但标为已读未确认：' + e.message);
      })
      .finally(() => autoReading.current.delete(key));
  }

  async function afterAction(result: MailActionPreview) {
    setActionPreview(null);
    setError('');
    setBusy('list');
    const nextBox =
      result.action === 'rename-folder' && result.mailbox === mailbox
        ? result.destination || 'INBOX'
        : mailbox;
    if (result.mailbox) cache.invalidateMailbox(result.mailbox);
    cache.invalidateLists();
    cache.set('account', account);
    resetSelection();
    setMoveTarget('');
    try {
      await loadMailboxes(nextBox, true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  }

  function managementButtons(uids: number[]) {
    return (
      <div className="mail-manage-buttons" aria-label="管理选中邮件">
        <button
          className="secondary"
          disabled={!!busy || !uids.length}
          onClick={() => void previewAction({ action: 'read', mailbox, uids })}
        >
          <MailOpen size={14} />
          已读
        </button>
        <button
          className="secondary"
          disabled={!!busy || !uids.length}
          onClick={() => void previewAction({ action: 'unread', mailbox, uids })}
        >
          <Mail size={14} />
          未读
        </button>
        <button
          className="secondary"
          disabled={!!busy || !uids.length}
          onClick={() =>
            void previewAction({
              action: inTrash ? 'restore' : 'trash',
              mailbox,
              uids,
              ...(inTrash ? { destination: 'INBOX' } : {}),
            } as MailOperation)
          }
        >
          {inTrash ? <Undo2 size={14} /> : <Trash2 size={14} />}
          {inTrash ? '恢复' : '回收站'}
        </button>
        <select
          value={moveTarget}
          aria-label="移动到文件夹"
          onChange={(e) => setMoveTarget(e.target.value)}
        >
          <option value="">移动到…</option>
          {mailboxes
            .filter((b) => b.path !== mailbox)
            .map((b) => (
              <option key={b.path} value={b.path}>
                {b.name}
              </option>
            ))}
        </select>
        <button
          className="secondary"
          aria-label="预览移动邮件"
          disabled={!!busy || !uids.length || !moveTarget}
          onClick={() =>
            void previewAction({ action: 'move', mailbox, uids, destination: moveTarget })
          }
        >
          <MoveRight size={14} />
          移动
        </button>
      </div>
    );
  }

  async function refreshMail() {
    setError('');
    setBusy('list');
    try {
      await loadMailboxes(mailbox, true);
      if (selected) await openMessage(selected, true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      if (alive.current) setBusy('');
    }
  }

  async function saveAccount() {
    setError('');
    setBusy('save');
    try {
      const result = await api<{ account: MailAccount }>(settings, '/mail/account', {
        provider,
        address: address.trim(),
        appPassword,
      });
      setAccount(result.account);
      cache.clear();
      cache.set('account', result.account);
      resetSelection();
      setSetup(false);
      setAppPassword('');
      await loadMailboxes();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  }

  async function removeAccount() {
    setError('');
    setBusy('remove');
    try {
      await api(settings, '/mail/account', undefined, 'DELETE');
      cache.clear();
      resetSelection();
      setAccount(null);
      setSetup(true);
      setMailboxes([]);
      setMessages([]);
      setSelected(null);
      setMessage(null);
      setDigest('');
      setDigestMessages([]);
      setSelectedUids(new Set());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  }

  async function openMessage(uid: number, refresh = false) {
    const generation = cache.generation;
    const request = ++messageRequest.current;
    const key = bodyKey(mailbox, uid);
    const hit = cache.get<MailMessage>(key, mailTTL.body);
    setSelected(uid);
    setMessage(hit?.value || null);
    const savedSummary = cache.get<string>(summaryKey(mailbox, uid), mailTTL.summary);
    setSummary(savedSummary && !savedSummary.stale ? savedSummary.value : '');
    setSummaryOpen(false);
    setDraft(readDraft(uid));
    reader.current?.scrollTo({ top: 0 });
    setError('');
    if (hit && !hit.stale && !refresh) {
      setBusy('');
      markOpenedRead(uid);
      return;
    }
    setBusy('message');
    try {
      const result = await api<MailMessage>(
        settings,
        `/mail/messages/${uid}?mailbox=${encodeURIComponent(mailbox)}${refresh ? '&refresh=1' : ''}`,
      );
      cache.set(key, result, generation);
      if (alive.current && request === messageRequest.current && generation === cache.generation) {
        setMessage(result);
        markOpenedRead(uid);
      }
    } catch (e) {
      if (alive.current && request === messageRequest.current) setError((e as Error).message);
    } finally {
      if (alive.current && request === messageRequest.current) setBusy('');
    }
  }

  async function summarize() {
    if (!selected) return;
    if (summary) {
      setSummaryOpen(!summaryOpen);
      return;
    }
    const generation = cache.generation;
    const request = messageRequest.current,
      key = summaryKey(mailbox, selected);
    setError('');
    setBusy('summary');
    setSummary('');
    try {
      const result = await api<{ summary: string }>(
        settings,
        `/mail/messages/${selected}/summarize`,
        { mailbox },
      );
      cache.set(key, result.summary, generation);
      if (alive.current && request === messageRequest.current && generation === cache.generation) {
        setSummary(result.summary);
        setSummaryOpen(true);
      }
    } catch (e) {
      if (alive.current && request === messageRequest.current) setError((e as Error).message);
    } finally {
      if (alive.current && request === messageRequest.current) setBusy('');
    }
  }

  async function makeDigest() {
    const request = ++digestRequest.current,
      generation = cache.generation;
    const current = () =>
      alive.current && request === digestRequest.current && generation === cache.generation;
    setError('');
    setBusy('digest');
    setDigest('');
    setDigestMessages([]);
    try {
      const result = await api<{ digest: string; messages: DigestMessage[] }>(
        settings,
        '/mail/digest',
        { mailbox, uids: [...selectedUids] },
      );
      if (current()) {
        setDigest(result.digest);
        setDigestMessages(result.messages);
      }
    } catch (e) {
      if (current()) setError((e as Error).message);
    } finally {
      if (current()) setBusy((value) => (value === 'digest' ? '' : value));
    }
  }

  async function copy(value: string, kind: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(kind);
      setTimeout(() => setCopied(''), 1800);
    } catch {
      setError('浏览器未允许剪贴板访问，请手动选中复制。');
    }
  }

  if (!session) {
    return (
      <section className="surface mail-empty">
        <div className="assistant-orb">
          <Mail size={32} />
        </div>
        <h2>登录后连接你的邮箱</h2>
        <p>支持 QQ 邮箱与 Gmail；读取、AI 摘要和起草回复，写入草稿或发送需要确认。</p>
        <button className="primary" onClick={login}>
          登录并开始
        </button>
      </section>
    );
  }

  if (setup || !account) {
    const qq = provider === 'qq';
    return (
      <section className="surface mail-setup">
        <div className="mail-setup-heading">
          <div className="assistant-orb">
            <Mail size={28} />
          </div>
          <div>
            <span className="eyebrow">MAIL INBOX</span>
            <h1>连接 {qq ? 'QQ 邮箱' : 'Gmail'}</h1>
            <p>
              使用{qq ? ' QQ 邮箱授权码' : ' Google 应用专用密码'}读取收件箱、摘要和起草；
              写入草稿或发送前都需要你确认。
            </p>
          </div>
        </div>
        <div className="mail-provider-switch" role="group" aria-label="邮箱类型">
          <button
            type="button"
            className={qq ? 'active' : ''}
            onClick={() => {
              setProvider('qq');
              setAddress('');
              setError('');
            }}
          >
            QQ 邮箱
          </button>
          <button
            type="button"
            className={!qq ? 'active' : ''}
            onClick={() => {
              setProvider('gmail');
              setAddress('');
              setError('');
            }}
          >
            Gmail
          </button>
        </div>
        <div className="mail-form">
          <label className="field-label" htmlFor="mail-address">
            {qq ? 'QQ 邮箱地址' : 'Gmail 地址'}
          </label>
          <input
            id="mail-address"
            type="email"
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            placeholder={qq ? '123456@qq.com' : 'you@gmail.com'}
            autoComplete="username"
          />
          <label className="field-label" htmlFor="mail-password">
            {qq ? 'QQ 邮箱授权码' : 'Google 应用专用密码'}
          </label>
          <input
            id="mail-password"
            type="password"
            value={appPassword}
            onChange={(event) => setAppPassword(event.target.value)}
            placeholder={qq ? 'QQ 邮箱设置中生成的授权码' : '16 位应用专用密码'}
            autoComplete="current-password"
          />
          {qq ? (
            <p className="inline-hint">
              不是 QQ 登录密码。请在 QQ 邮箱「设置 → 账号 → POP3/IMAP/SMTP 服务」中开启
              IMAP/SMTP，并生成授权码；QQ 邮箱需要先在网页端开启这些服务。
            </p>
          ) : (
            <p className="inline-hint">
              不是 Google 账号密码。需要先开启两步验证，再到{' '}
              <a href="https://myaccount.google.com/apppasswords" target="_blank" rel="noreferrer">
                Google 应用专用密码
              </a>{' '}
              生成；并确认 Gmail 设置中已启用 IMAP。
            </p>
          )}
          {error && (
            <div className="error" role="alert">
              {error}
            </div>
          )}
          <div className="action-row">
            <button
              className="primary"
              disabled={!address.trim() || !appPassword.trim() || busy === 'save'}
              onClick={() => void saveAccount()}
            >
              {busy === 'save' ? (
                <LoaderCircle size={16} className="spin" />
              ) : (
                <ShieldCheck size={16} />
              )}
              连接并读取
            </button>
            {account && (
              <button className="secondary" onClick={() => setSetup(false)}>
                返回邮箱
              </button>
            )}
          </div>
        </div>
      </section>
    );
  }

  return (
    <div className="mail-page">
      <MailAgent
        settings={settings}
        open={agentOpen}
        mailbox={mailbox}
        uids={selectedUids.size ? [...selectedUids] : selected ? [selected] : []}
        suggestion={agentSuggestion}
        filters={{
          q: loadedContext.current.search,
          unread: loadedContext.current.unread,
          since: loadedContext.current.range.since || undefined,
          before: loadedContext.current.range.before || undefined,
        }}
        onClose={() => setAgentOpen(false)}
        onSettled={() => {
          cache.invalidateLists();
          resetSelection();
          void refreshMail();
        }}
      />
      {actionPreview && (
        <MailActionDialog
          settings={settings}
          preview={actionPreview}
          onClose={() => setActionPreview(null)}
          onDone={(result) => void afterAction(result)}
        />
      )}
      {composer && (
        <MailComposer
          key={composer.reply ? `${composer.reply.mailbox}:${composer.reply.uid}` : 'new'}
          settings={settings}
          address={account.address}
          reply={composer.reply}
          onClose={() => setComposer(null)}
        />
      )}
      <header className="mail-heading">
        <div>
          <h1>
            {backTarget && (
              <button className="icon-btn" aria-label="返回邮件上一级" onClick={mailBack}>
                <ChevronLeft size={18} />
              </button>
            )}
            邮件 <span className="mail-account">{account.address}</span>
          </h1>
        </div>
        <div className="action-row">
          <button className="primary" onClick={() => setComposer({ reply: null })}>
            <PenLine size={15} />
            写邮件
          </button>
          <button
            className="secondary mail-agent-open"
            aria-label="打开邮件 Agent"
            onClick={() => {
              setAgentSuggestion('');
              setAgentOpen(true);
            }}
          >
            <Bot size={15} />
            <span className="mail-agent-label">邮件 Agent</span>
            <span className="mail-agent-short">Agent</span>
          </button>
          <span className="mail-readonly">
            <ShieldCheck size={14} />
            移动/删除需确认
          </span>
          <button
            className="icon-btn"
            aria-label="刷新邮件"
            disabled={!!busy}
            onClick={() => void refreshMail()}
          >
            <RefreshCw size={17} />
          </button>
          <button
            className="secondary mail-account-settings"
            aria-label="邮件账号设置"
            onClick={() => setSetup(true)}
          >
            <UserRound size={16} />
            <span>账号</span>
          </button>
          <button
            className="icon-btn"
            aria-label="整理邮件文件夹"
            onClick={() => setFolderEditor(!folderEditor)}
          >
            <FolderCog size={17} />
          </button>
        </div>
      </header>

      {cacheOpen && (
        <MailCacheSettings
          settings={settings}
          info={cacheInfo}
          storageError={cache.storageError}
          onClose={() => setCacheOpen(false)}
          onSave={(info) => {
            preferences.current = info.settings;
            cache.configure(info.settings);
            setCacheInfo(info);
            setCacheOpen(false);
          }}
        />
      )}

      {folderEditor && (
        <form
          className="mail-folder-editor"
          onSubmit={(e) => {
            e.preventDefault();
            void previewAction(
              folderAction === 'create-folder'
                ? { action: folderAction, name: folderName }
                : { action: folderAction, mailbox, name: folderName },
            );
          }}
        >
          <select
            aria-label="文件夹操作"
            value={folderAction}
            onChange={(e) => setFolderAction(e.target.value as typeof folderAction)}
          >
            <option value="create-folder">新建文件夹</option>
            <option value="rename-folder">重命名当前文件夹</option>
          </select>
          <input
            aria-label="新文件夹名称"
            placeholder="文件夹名称"
            value={folderName}
            maxLength={200}
            onChange={(e) => setFolderName(e.target.value)}
          />
          <button className="secondary" disabled={!!busy || !folderName.trim()}>
            预览
          </button>
          <button
            type="button"
            className="icon-btn"
            aria-label="关闭文件夹整理"
            onClick={() => setFolderEditor(false)}
          >
            <X size={16} />
          </button>
        </form>
      )}

      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}

      {digest && (
        <div
          className="mail-digest-overlay"
          role="dialog"
          aria-modal="true"
          aria-label="AI 收件箱整理"
        >
          <section className="mail-digest">
            <div className="mail-digest-head">
              <div>
                <span className="eyebrow">AGENT DIGEST</span>
                <h2>收件箱整理</h2>
                <p>{digestMessages.length} 封邮件 · 只读</p>
              </div>
              <div className="action-row">
                <button className="secondary" onClick={() => void copy(digest, 'digest')}>
                  <Copy size={14} />
                  {copied === 'digest' ? '已复制' : '复制整理'}
                </button>
                <button className="icon-btn" aria-label="关闭整理" onClick={closeDigest}>
                  <X size={16} />
                </button>
              </div>
            </div>
            <PiMarkdown text={digest} />
          </section>
        </div>
      )}

      <div className={`mail-layout${selected ? ' has-selection' : ''}`}>
        <label className="mail-mobile-folder">
          <Inbox size={16} />
          <select
            aria-label="选择邮件文件夹"
            value={mailbox}
            onChange={(e) => changeMailbox(e.target.value)}
          >
            {mailboxes.map((box) => (
              <option key={box.path} value={box.path}>
                {box.path === 'INBOX' ? '收件箱' : box.name}
                {box.unread ? ` (${box.unread} 未读)` : ''}
              </option>
            ))}
          </select>
        </label>
        <aside className="mail-folders" aria-label="邮箱文件夹">
          <div className="mail-folders-title">
            <Inbox size={15} />
            文件夹
          </div>
          {mailboxes.map((item) => (
            <button
              key={item.path}
              className={item.path === mailbox ? 'active' : ''}
              onClick={() => changeMailbox(item.path)}
            >
              <span>
                {item.path === 'INBOX' ? '收件箱' : item.name}{' '}
                <UnreadBadge count={item.unread} label="封未读邮件" />
              </span>
              <small>{item.path}</small>
            </button>
          ))}
          <button
            className="mail-remove-account"
            disabled={busy === 'remove'}
            onClick={() => void removeAccount()}
          >
            <Trash2 size={14} />
            移除账号
          </button>
        </aside>

        <section className="mail-list-panel">
          <div className="mail-list-tools">
            <span
              title={
                cachedAt ? `缓存更新于 ${new Date(cachedAt).toLocaleString('zh-CN')}` : undefined
              }
            >
              {selectedUids.size ? `已选 ${selectedUids.size} 封` : `${messages.length} 封邮件`}
              {cachedAt > 0 && (
                <small className="mail-cache-note">{busy === 'list' ? '更新中…' : '已缓存'}</small>
              )}
            </span>
            <button
              className="secondary"
              onClick={() => {
                setAgentSuggestion(
                  '整理当前选择和筛选范围的邮件，按主题、来源和用途合理分类，优先使用已有文件夹；需要时创建新文件夹。请分页查看历史邮件，保留不确定的邮件，先预览分组方案供我确认，再实际创建和移动，报告实际完成数量。',
                );
                setAgentOpen(true);
              }}
            >
              <FolderCog size={14} />
              分类整理
            </button>
            <button
              className="secondary"
              disabled={!!busy || !messages.length}
              onClick={() => void makeDigest()}
            >
              {busy === 'digest' ? (
                <LoaderCircle size={14} className="spin" />
              ) : (
                <Sparkles size={14} />
              )}
              摘要
            </button>
          </div>
          <div className="mail-filter-bar">
            <label>
              <input
                type="checkbox"
                checked={unread}
                onChange={(e) => {
                  const value = e.target.checked;
                  setUnread(value);
                  resetSelection();
                  setBusy('list');
                  void loadMessages(mailbox, query, false, value)
                    .catch((e) => setError(e.message))
                    .finally(() => setBusy(''));
                }}
              />
              只看未读
            </label>
            <button className="text-link" onClick={() => setCacheOpen(!cacheOpen)}>
              <SlidersHorizontal size={14} />
              缓存设置
            </button>
            <label>
              <input
                type="checkbox"
                aria-label="选择当前批次邮件（最多1000封）"
                checked={
                  messages.length > 0 && selectedUids.size === Math.min(messages.length, 1000)
                }
                onChange={(e) =>
                  setSelectedUids(
                    e.target.checked
                      ? new Set(messages.slice(0, 1000).map((m) => m.uid))
                      : new Set(),
                  )
                }
              />
              全选
            </label>
          </div>
          {selectedUids.size > 0 && managementButtons([...selectedUids])}
          <form
            className="mail-search"
            onSubmit={(event) => {
              event.preventDefault();
              resetSelection();
              setBusy('list');
              void loadMessages(mailbox, query)
                .catch((e) => setError(e.message))
                .finally(() => setBusy(''));
            }}
          >
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索邮件正文、主题或发件人"
              aria-label="搜索邮件"
            />
            <button className="secondary" disabled={busy === 'list'}>
              搜索
            </button>
          </form>
          <details className="mail-history-options">
            <summary>按收件日期筛选历史邮件</summary>
            <form
              className="mail-history-filter"
              onSubmit={(event) => {
                event.preventDefault();
                resetSelection();
                setBusy('list');
                setError('');
                void loadMessages(mailbox, query, true)
                  .catch((e) => setError(e.message))
                  .finally(() => setBusy(''));
              }}
            >
              <label>
                从
                <input
                  type="date"
                  aria-label="邮件开始日期"
                  value={since}
                  onChange={(e) => setSince(e.target.value)}
                />
              </label>
              <label>
                至（不含当天）
                <input
                  type="date"
                  aria-label="邮件结束日期"
                  value={before}
                  onChange={(e) => setBefore(e.target.value)}
                />
              </label>
              <button className="secondary" disabled={!!busy}>
                筛选
              </button>
            </form>
          </details>
          <div className="mail-list" role="list">
            {busy === 'list' && !messages.length && (
              <div className="mail-loading">
                <LoaderCircle size={18} className="spin" />
                正在读取邮件…
              </div>
            )}
            {!busy && !messages.length && (
              <div className="mail-empty-list">这个文件夹没有可显示的邮件。</div>
            )}
            {messages.map((item) => (
              <div
                key={item.uid}
                role="button"
                tabIndex={0}
                className={`mail-row ${selected === item.uid ? 'active' : ''} ${item.seen ? '' : 'unread'}`}
                onClick={() => void openMessage(item.uid)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    void openMessage(item.uid);
                  }
                }}
              >
                <input
                  className="mail-select"
                  type="checkbox"
                  checked={selectedUids.has(item.uid)}
                  aria-label={`选择 ${item.subject}`}
                  onClick={(event) => event.stopPropagation()}
                  onChange={() => toggleSelect(item.uid)}
                />
                <div className="mail-row-content">
                  <div className="mail-row-top">
                    <b>{item.from || '(未知发件人)'}</b>
                    <small>{item.date ? dateLabel(item.date) : ''}</small>
                  </div>
                  <strong>{item.subject}</strong>
                  <div className="mail-row-meta">
                    <span>{formatBytes(item.size)}</span>
                    {item.flagged && <span>已标记</span>}
                    {!item.seen && <span className="mail-unread-dot">未读</span>}
                  </div>
                </div>
              </div>
            ))}
            {history && (
              <div className="mail-history-more">
                <p className="inline-hint">
                  已加载 {messages.length} 封
                  {history.total >= messages.length ? ` · 匹配 ${history.total} 封` : ''}
                </p>
                {history.hasMore ? (
                  <button
                    className="secondary"
                    disabled={!!busy}
                    onClick={() => {
                      setBusy('older');
                      setError('');
                      const context = loadedContext.current;
                      void loadMessages(
                        context.box,
                        context.search,
                        false,
                        context.unread,
                        true,
                        context.range,
                      )
                        .catch((e) => setError(e.message))
                        .finally(() => setBusy(''));
                    }}
                  >
                    {busy === 'older' ? '加载中…' : '加载更早邮件'}
                  </button>
                ) : (
                  <span className="inline-hint">已加载全部匹配邮件</span>
                )}
              </div>
            )}
          </div>
        </section>

        <section className="mail-detail-panel" ref={reader}>
          {selected && !message && (
            <button className="secondary" onClick={resetSelection}>
              <ChevronLeft size={16} />
              返回邮件列表
            </button>
          )}
          {!selected && (
            <div className="mail-detail-empty">选择一封邮件查看正文、摘要或起草回复。</div>
          )}
          {busy === 'message' && !message && (
            <div className="mail-loading">
              <LoaderCircle size={18} className="spin" />
              正在打开邮件…
            </div>
          )}
          {message && (
            <>
              <div className="mail-detail-heading">
                <button
                  className="icon-btn mail-back"
                  aria-label="返回邮件列表"
                  onClick={() => {
                    resetSelection();
                  }}
                >
                  <ChevronLeft size={18} />
                </button>
                <div>
                  <h2>{message.subject}</h2>
                  <p>
                    {message.from} · {message.date ? dateLabel(message.date) : '日期未知'}
                  </p>
                  {message.to && <small>收件人：{message.to}</small>}
                </div>
              </div>
              {message.truncated && (
                <p className="inline-hint">
                  邮件超过 5 MiB，正文只读取了前 5 MiB；大附件请在原邮箱中查看。
                </p>
              )}
              <div className="action-row mail-reader-actions">
                <button
                  className="secondary"
                  disabled={busy === 'summary'}
                  onClick={() => void summarize()}
                  aria-expanded={summaryOpen}
                  aria-controls="mail-message-summary"
                >
                  {busy === 'summary' ? (
                    <LoaderCircle size={14} className="spin" />
                  ) : (
                    <Sparkles size={14} />
                  )}
                  {busy === 'summary' ? '正在生成摘要…' : summary ? '查看摘要' : 'AI 摘要'}
                  {summary && (
                    <ChevronDown size={13} className={summaryOpen ? 'mail-summary-expanded' : ''} />
                  )}
                </button>
                <button
                  className="secondary"
                  disabled={!message.replyTo && !message.fromAddress}
                  onClick={() =>
                    setComposer({
                      reply: {
                        uid: message.uid,
                        mailbox,
                        to: message.replyTo || message.fromAddress || '',
                        subject: message.subject,
                        text: message.text,
                        initialDraft: draft,
                      },
                    })
                  }
                >
                  <PenLine size={14} />
                  回复 · Agent 辅助撰写
                </button>
              </div>
              {managementButtons([message.uid])}
              {summary && summaryOpen && (
                <div
                  className="mail-ai-card mail-summary-card"
                  id="mail-message-summary"
                  ref={summaryCard}
                >
                  <div className="mail-ai-card-head">
                    <h3>
                      <Sparkles size={14} />
                      邮件摘要
                    </h3>
                    <div className="action-row">
                      <button className="text-link" onClick={() => void copy(summary, 'summary')}>
                        <Copy size={13} />
                        {copied === 'summary' ? '已复制' : '复制'}
                      </button>
                      <button
                        className="icon-btn"
                        aria-label="收起摘要"
                        onClick={() => setSummaryOpen(false)}
                      >
                        <X size={14} />
                      </button>
                    </div>
                  </div>
                  <PiMarkdown text={summary} />
                </div>
              )}
              <div className="mail-body-view" role="group" aria-label="邮件显示方式">
                <button
                  className={!plainText ? 'active' : ''}
                  aria-pressed={!plainText}
                  onClick={() => setPlainText(false)}
                >
                  排版视图
                </button>
                <button
                  className={plainText ? 'active' : ''}
                  aria-pressed={plainText}
                  onClick={() => setPlainText(true)}
                >
                  纯文本
                </button>
                <span>外部图片不自动加载</span>
              </div>
              {plainText ? (
                <pre className="mail-body">{message.text}</pre>
              ) : (
                <MailBody
                  key={`${mailbox}:${message.uid}`}
                  text={message.text}
                  html={message.html}
                  remoteImageCount={message.remoteImageCount}
                />
              )}
              {!!message.attachments.length && (
                <div className="mail-attachments">
                  <h3>附件（只读，不在星屿下载）</h3>
                  {message.attachments.map((item) => (
                    <div className="mail-attachment" key={`${item.filename}-${item.size}`}>
                      <span>{item.filename}</span>
                      <small>{formatBytes(item.size)}</small>
                    </div>
                  ))}
                </div>
              )}
              {draft.trim() && (
                <div className="mail-ai-card mail-ai">
                  <div className="mail-ai-card-head">
                    <h3>已有回复草稿</h3>
                    <button
                      className="text-link"
                      onClick={() =>
                        setComposer({
                          reply: {
                            uid: message.uid,
                            mailbox,
                            to: message.replyTo || message.fromAddress || '',
                            subject: message.subject,
                            text: message.text,
                            initialDraft: draft,
                          },
                        })
                      }
                    >
                      继续编辑
                    </button>
                  </div>
                  <pre>{draft}</pre>
                </div>
              )}
            </>
          )}
        </section>
      </div>
    </div>
  );
}

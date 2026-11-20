import { useEffect, useRef, useState } from 'react';
import { LoaderCircle, Monitor, Plus } from 'lucide-react';
import { api, dateLabel } from './data';
import {
  ConversationRow,
  ConversationMenu,
  ConversationEditor,
  type MenuAnchor,
  type Conversation,
  type ConversationAction,
} from './ConversationMenu';
import { ProjectConversationList } from './ProjectConversationList';
import { visibleConversations } from '../../shared/pi-conversation-list.mjs';
import { peekAPI } from './resource-cache';
import { ProjectSummary } from './ProjectSummary';
import { serverIdentity } from './session';
import { computerChatStorageKey, readComputerChatDraft } from '../../shared/assistant-target.mjs';
import type { Settings } from './types';
import type { ComputerProject } from './computer-api';
import type { ComputerGroup, ComputerTarget } from './assistant-computers';
export type ComputerConversation = {
  id: string;
  title: string;
  updatedAt: string;
  active?: number;
  pinnedAt?: string | null;
  archivedAt?: string | null;
};

export function AssistantComputerProjects({
  settings,
  owner,
  groups,
  selected,
  choose,
  connect,
  refresh,
  error,
  showArchived = false,
  titleChanged,
}: {
  settings: Settings;
  owner: string;
  groups: ComputerGroup[];
  selected: ComputerTarget | null;
  choose: (target: ComputerTarget) => void;
  connect: () => void;
  refresh: () => void;
  error: string;
  showArchived?: boolean;
  titleChanged: (id: string, title: string) => void;
}) {
  if (!groups.length) return null;
  return (
    <section className="assistant-computer-projects" aria-label="电脑项目">
      <div className="project-tree-heading">
        <h2>
          <Monitor size={13} /> 电脑
        </h2>
        <button className="icon-btn" aria-label="连接另一台电脑" onClick={connect}>
          <Plus size={16} />
        </button>
      </div>
      {error && (
        <p className="field-help error" role="status">
          {error}
        </p>
      )}
      {groups.map(({ device, projects, error: projectError }) => (
        <div className="assistant-device-group" key={device.id}>
          <div className="assistant-device-label" title={device.name}>
            <span className={'assistant-status-dot ' + (device.online ? 'ready' : '')} />
            <span>
              {device.local ? '本机 · ' : ''}
              {device.name}
            </span>
            <small>{device.online ? '在线' : '离线'}</small>
          </div>
          {projects.map((project) => (
            <ComputerProjectTree
              key={project.id}
              settings={settings}
              owner={owner}
              deviceId={device.id}
              project={project}
              selected={selected}
              choose={choose}
              refresh={refresh}
              showArchived={showArchived}
              titleChanged={titleChanged}
            />
          ))}
          {projectError && <p className="field-help">{projectError}</p>}
          {!projects.length && !projectError && (
            <p className="field-help">尚未授权项目，请在这台电脑上添加目录。</p>
          )}
        </div>
      ))}
    </section>
  );
}

function ComputerProjectTree({
  settings,
  owner,
  deviceId,
  project,
  selected,
  choose,
  refresh,
  showArchived,
  titleChanged,
}: {
  settings: Settings;
  owner: string;
  deviceId: string;
  project: ComputerProject;
  selected: ComputerTarget | null;
  choose: (target: ComputerTarget) => void;
  refresh: () => void;
  showArchived: boolean;
  titleChanged: (id: string, title: string) => void;
}) {
  const base =
    '/relay/conversations?deviceId=' + deviceId + '&projectId=' + project.id + '&archived=include';
  const active = selected?.deviceId === deviceId && selected.projectId === project.id;
  const draft = readComputerChatDraft(
    sessionStorage,
    computerChatStorageKey(serverIdentity(settings), owner, deviceId, project.id),
  );
  const [open, setOpen] = useState(active);
  const [conversations, setConversations] = useState<ComputerConversation[]>(
    () => peekAPI<{ conversations: ComputerConversation[] }>(settings, base)?.conversations || [],
  );
  const [next, setNext] = useState<string | null>(null),
    [error, setError] = useState('');
  const extended = useRef(false);
  const [menu, setMenu] = useState<MenuAnchor | null>(null),
    [editing, setEditing] = useState<{
      kind: 'rename' | 'delete';
      conversation: Conversation;
    } | null>(null);
  const visible = visibleConversations(conversations, showArchived);
  async function change(
    c: Conversation,
    patch: { title?: string; pinned?: boolean; archived?: boolean },
  ) {
    await api(settings, '/relay/conversations/' + c.id, patch, 'PATCH');
    if (patch.title) titleChanged(c.id, patch.title);
    setConversations((old) =>
      old.map((item) =>
        item.id !== c.id
          ? item
          : {
              ...item,
              ...(patch.title ? { title: patch.title } : {}),
              ...(patch.pinned !== undefined
                ? { pinnedAt: patch.pinned ? new Date().toISOString() : null }
                : {}),
              ...(patch.archived !== undefined
                ? { archivedAt: patch.archived ? new Date().toISOString() : null }
                : {}),
            },
      ),
    );
    refresh();
  }
  function action(kind: ConversationAction, c: Conversation) {
    if (kind === 'rename' || kind === 'delete') {
      setEditing({ kind, conversation: c });
      return;
    }
    if (kind === 'new') {
      select(crypto.randomUUID());
      return;
    }
    if (kind === 'directory') {
      choose({ deviceId, projectId: project.id, conversationId: c.id, panel: 'files' });
      return;
    }
    void change(c, kind === 'pin' ? { pinned: !c.pinnedAt } : { archived: !c.archivedAt }).catch(
      (e) => setError(e.message),
    );
  }
  useEffect(() => {
    if (!open && !active) return;
    let live = true,
      busy = false;
    const load = async (fresh = false) => {
      if (busy || document.visibilityState !== 'visible') return;
      busy = true;
      try {
        const r = await api<{ conversations: ComputerConversation[]; next: string | null }>(
          settings,
          base,
          undefined,
          undefined,
          false,
          { fresh },
        );
        if (live) {
          setConversations((old) =>
            extended.current
              ? [...new Map([...old, ...r.conversations].map((c) => [c.id, c])).values()].sort(
                  (a, b) => b.updatedAt.localeCompare(a.updatedAt),
                )
              : r.conversations,
          );
          if (!extended.current) setNext(r.next);
          setError('');
        }
      } catch (e) {
        if (live) setError((e as Error).message);
      } finally {
        busy = false;
      }
    };
    void load();
    const timer = setInterval(() => void load(true), 5000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [settings, base, open, active]);
  const select = (conversationId: string) =>
    choose({ deviceId, projectId: project.id, conversationId });
  function loadMore() {
    if (!next) return;
    void api<{ conversations: ComputerConversation[]; next: string | null }>(
      settings,
      base + '&before=' + encodeURIComponent(next),
    )
      .then((r) => {
        extended.current = true;
        setConversations((old) => [
          ...new Map([...old, ...r.conversations].map((c) => [c.id, c])).values(),
        ]);
        setNext(r.next);
      })
      .catch((e) => setError(e.message));
  }
  return (
    <>
      <details
        className={'project-tree computer-project-tree' + (active ? ' is-current' : '')}
        open={open || active}
        onToggle={(e) => setOpen(e.currentTarget.open)}
      >
        <ProjectSummary
          name={project.name}
          detail={project.readOnly ? '只读' : '可修改'}
          newConversation={() => select(crypto.randomUUID())}
          saveName={async (name) => {
            await api(
              settings,
              '/relay/projects/' + project.id + '/display-name?deviceId=' + deviceId,
              { name },
              'PUT',
            );
            refresh();
          }}
        />
        {(open || active) && (
          <>
            {draft &&
              (!active || selected.conversationId !== draft.id) &&
              !conversations.some((c) => c.id === draft.id) && (
                <div className="pi-conversation-row">
                  <button className="contact-choice" onClick={() => select(draft.id)}>
                    <b>{draft.input.slice(0, 40)}</b>
                    <small>本机草稿 · 尚未发送</small>
                  </button>
                </div>
              )}
            {active && !conversations.some((c) => c.id === selected.conversationId) && (
              <div className="pi-conversation-row is-selected">
                <button
                  className="contact-choice selected"
                  onClick={() => select(selected.conversationId)}
                >
                  <b>新对话</b>
                  <small>首条消息后保存</small>
                </button>
              </div>
            )}
            <ProjectConversationList hasMore={!!next} loadMore={() => void loadMore()}>
              {visible.map((c) => (
                <ConversationRow
                  key={c.id}
                  conversation={{ ...c, projectId: project.id }}
                  selected={active && selected.conversationId === c.id}
                  disabled={false}
                  choose={() => select(c.id)}
                  openMenu={setMenu}
                  detail={
                    c.active ? (
                      <>
                        <LoaderCircle className="spin" size={11} />
                        执行中
                      </>
                    ) : (
                      dateLabel(c.updatedAt)
                    )
                  }
                />
              ))}
            </ProjectConversationList>

            {error && <p className="field-help error">{error}</p>}
          </>
        )}
      </details>
      {menu && <ConversationMenu anchor={menu} close={() => setMenu(null)} action={action} />}
      {editing && (
        <ConversationEditor
          computer
          conversation={editing.conversation}
          kind={editing.kind}
          running={!!conversations.find((c) => c.id === editing.conversation.id)?.active}
          close={() => setEditing(null)}
          submit={async (title) => {
            if (editing.kind === 'rename') {
              await change(editing.conversation, { title });
              return;
            }
            await api(
              settings,
              '/relay/conversations/' + editing.conversation.id,
              undefined,
              'DELETE',
            );
            setConversations((old) => old.filter((c) => c.id !== editing.conversation.id));
            if (active && selected.conversationId === editing.conversation.id)
              select(crypto.randomUUID());
            refresh();
          }}
        />
      )}
    </>
  );
}

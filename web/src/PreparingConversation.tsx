import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { LoaderCircle, Menu, PanelRight } from 'lucide-react';
import { AssistantComposer } from './AssistantComposer';
import { AssistantComposerActions } from './AssistantComposerActions';
import { AssistantUserMessage } from './AssistantUserMessage';
import { useMobilePanels } from './MobilePanels';
import { UnifiedConversationNavigation, useUnifiedConversations } from './UnifiedConversations';
import { preparationTextLimit } from '../../shared/conversation-preparation.mjs';
import type { Settings } from './types';
import { api } from './data';
import './conversation-preparation.css';

export type PreparedMessage = { id: string; text: string };
/** Handoff only from the selected, freshly verified native composer. The journal
 * claims before dispatch, while the native outbox owns delivery/reconciliation. */
export function usePreparedConversation({
  origin,
  nativeId,
  ready,
  restoreDraft,
  send,
}: {
  origin: 'server' | 'computer' | 'remote';
  nativeId: string;
  ready: boolean;
  restoreDraft: (text: string) => void;
  send: (message: PreparedMessage, saved: () => void) => unknown;
}) {
  const model = useUnifiedConversations();
  const prep = model?.preparing;
  const latest = useRef({ model, restoreDraft, send });
  latest.current = { model, restoreDraft, send };
  const [verified, setVerified] = useState('');
  const identity = JSON.stringify([prep?.id, origin, nativeId]);
  const handoffIdentity = useRef(identity);
  handoffIdentity.current = identity;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    setVerified('');
    if (
      !model ||
      !prep ||
      prep.state !== 'ready' ||
      prep.resumeRequired ||
      prep.native?.origin !== origin ||
      prep.native.nativeId !== nativeId
    )
      return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const path =
      (origin === 'server'
        ? '/pi/conversations/'
        : origin === 'computer'
          ? '/relay/conversations/'
          : '/agent/remote/conversations/') + nativeId;
    const verify = async () => {
      try {
        const result = await api<{ conversation?: { id: string } }>(
          model.settings,
          path,
          undefined,
          undefined,
          false,
          { fresh: true, timeout: 8000, signal: controller.signal },
        );
        if (!controller.signal.aborted && result.conversation?.id === nativeId) {
          setVerified(identity);
          return;
        }
      } catch {
        /* Read-only reconciliation; never retry a create or submission. */
      }
      if (!controller.signal.aborted) timer = setTimeout(() => void verify(), 2000);
    };
    void verify();
    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [model?.settings, identity, prep?.state, prep?.resumeRequired]);
  useEffect(() => {
    if (
      verified !== identity ||
      !ready ||
      !prep ||
      prep.state !== 'ready' ||
      prep.resumeRequired ||
      prep.native?.origin !== origin ||
      prep.native.nativeId !== nativeId
    )
      return;
    const current = latest.current;
    void (async () => {
      let value;
      try {
        value = await current.model!.claimPreparation(prep.id);
      } catch {
        return;
      }
      if (
        !value ||
        !mounted.current ||
        handoffIdentity.current !== identity ||
        latest.current.model?.preparing?.id !== value.id
      )
        return;
      const saved = () => {
        if (
          !mounted.current ||
          handoffIdentity.current !== identity ||
          latest.current.model?.preparing?.id !== value.id
        )
          return;
        void current.model!.finishPreparation(value.id, current.restoreDraft).catch(() => {});
      };
      if (value.message) {
        try {
          await current.send(value.message, saved);
        } catch {
          /* Durable intent remains recoverable. */
        }
      } else saved();
    })();
  }, [ready, origin, nativeId, prep?.id, prep?.state, prep?.resumeRequired, verified, identity]);
}

export function PreparingConversation({
  settings,
  actions,
  openNavigation,
  manage,
}: {
  settings: Settings;
  actions: ReactNode;
  openNavigation: () => void;
  manage: () => void;
}) {
  const model = useUnifiedConversations()!;
  const prep = model.preparing!;
  const area = useRef<HTMLTextAreaElement>(null),
    history = useRef<HTMLDivElement>(null);
  const { setPanel } = useMobilePanels();
  const [error, setError] = useState(''),
    [tick, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((v) => v + 1), 2400);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => setError(''), [prep.id]);
  const waiting = prep.state === 'creating' || (prep.state === 'ready' && !prep.resumeRequired);
  const status =
    prep.state === 'ready'
      ? prep.resumeRequired
        ? '草稿已恢复，确认后继续。'
        : '正在核对会话状态…'
      : prep.state === 'creating'
        ? ['正在连接所选工作区…', '正在准备对话…', '连接完成后即可继续…'][tick % 3]
        : prep.state === 'handed'
          ? '发送交接尚未确认，正文仍保留。'
          : '对话尚未准备完成，内容已保留。';
  const [input, setInput] = useState(prep.draft);
  const inputValue = useRef(prep.draft);
  const inputVersion = useRef(0);
  const inputPreparation = useRef<string | null>(prep.id);
  const inputActivity = useRef({ id: prep.id, pending: 0, failed: false });
  const [inputRevision, setInputRevision] = useState(0);
  inputPreparation.current = prep.id;
  useEffect(() => {
    inputPreparation.current = prep.id;
    return () => {
      inputPreparation.current = null;
    };
  }, [prep.id]);
  useLayoutEffect(() => {
    if (inputActivity.current.id !== prep.id) {
      inputActivity.current = { id: prep.id, pending: 0, failed: false };
      inputValue.current = prep.draft;
      setInput(prep.draft);
      inputVersion.current++;
    } else if (
      !inputActivity.current.pending &&
      !inputActivity.current.failed &&
      inputValue.current !== prep.draft
    ) {
      // Adopt a different window's saved text before painting, only when this
      // editor has no unfinished or rejected local change to preserve.
      inputValue.current = prep.draft;
      setInput(prep.draft);
      inputVersion.current++;
    }
  }, [prep.id, prep.draft, inputRevision]);
  const change = (value: string) => {
    const expectedDraft = inputValue.current;
    inputValue.current = value;
    setInput(value);
    const version = ++inputVersion.current;
    const activity = inputActivity.current;
    const id = prep.id;
    activity.pending++;
    void model
      .preparationDraft(id, value, expectedDraft)
      .then(() => {
        if (inputPreparation.current === id && version === inputVersion.current) {
          activity.failed = false;
          setError('');
        }
      })
      .catch((e) => {
        if (inputPreparation.current === id && version === inputVersion.current) {
          activity.failed = true;
          setError((e as Error).message);
        }
      })
      .finally(() => {
        activity.pending--;
        if (inputPreparation.current === id) setInputRevision((value) => value + 1);
      });
  };
  const edit = async () => {
    const version = inputVersion.current;
    const id = prep.id;
    const expectedDraft = inputValue.current;
    const activity = inputActivity.current;
    activity.pending++;
    try {
      await model.preparationEdit(id, expectedDraft);
      if (inputPreparation.current !== id || inputVersion.current !== version) return;
      const value = (prep.message?.text || '') + (expectedDraft ? '\n\n' + expectedDraft : '');
      inputValue.current = value;
      setInput(value);
      activity.failed = false;
      setError('');
    } catch (e) {
      if (inputPreparation.current === id && inputVersion.current === version) {
        activity.failed = true;
        setError((e as Error).message);
      }
    } finally {
      activity.pending--;
      if (inputPreparation.current === id) setInputRevision((value) => value + 1);
    }
  };
  const submit = async () => {
    const version = inputVersion.current;
    const id = prep.id;
    const expectedDraft = inputValue.current;
    const activity = inputActivity.current;
    activity.pending++;
    try {
      await model.preparationQueue(id, expectedDraft, expectedDraft);
      if (inputPreparation.current !== id || inputVersion.current !== version) return;
      inputValue.current = '';
      setInput('');
      activity.failed = false;
      setError('');
    } catch (e) {
      if (inputPreparation.current === id && inputVersion.current === version) {
        activity.failed = true;
        setError((e as Error).message);
      }
    } finally {
      activity.pending--;
      if (inputPreparation.current === id) setInputRevision((value) => value + 1);
    }
  };
  return (
    <>
      <header className="assistant-workspace-heading">
        <button className="mobile-menu icon-btn" aria-label="打开导航" onClick={openNavigation}>
          <Menu size={19} />
        </button>
        <div className="pi-heading-info">
          <h1>新对话</h1>
          <span className="pi-model-status">
            {prep.target.origin === 'remote' ? 'DPH' : 'Pi'} ·{' '}
            {prep.target.locationName || '所选工作区'} · {model.projectName(prep.target)}
          </span>
        </div>
        {actions}
        <button
          className="icon-btn"
          aria-label="打开项目与对话"
          onClick={() => setPanel('conversations')}
        >
          <PanelRight size={18} />
        </button>
      </header>
      <div className="chat-layout pi-layout assistant-layout preparing-workspace">
        <UnifiedConversationNavigation manage={manage} />
        <section className="surface chat-panel">
          <div className="pi-message-area">
            <div
              className="message-scroll pi-messages"
              ref={history}
              role="region"
              aria-label="准备中的对话消息"
              tabIndex={0}
            >
              <div className="pi-message-content">
                {prep.message && (
                  <AssistantUserMessage
                    input={prep.message.text}
                    at={prep.createdAt}
                    settings={settings}
                    conversation={prep.id}
                  />
                )}
                <p className="conversation-preparation-status" role="status">
                  {waiting && <LoaderCircle size={16} className="spin" />}
                  {status}
                </p>
                {prep.message && waiting && (
                  <p className="field-help">首条消息已保留，准备完成后发送。</p>
                )}
                {prep.message && prep.state !== 'handed' && (
                  <button className="text-link" onClick={edit}>
                    编辑待发送消息
                  </button>
                )}
                {prep.error && (
                  <p className="error" role="alert">
                    {prep.error}
                  </p>
                )}
                {prep.recoveryError && (
                  <>
                    <p className="error" role="alert">
                      {prep.recoveryError}
                    </p>
                    <button
                      className="secondary"
                      onClick={() =>
                        void model
                          .refresh()
                          .catch((e) => setError('对话目录加载失败：' + (e as Error).message))
                      }
                    >
                      重新读取恢复状态
                    </button>
                  </>
                )}
                {!prep.recoveryError &&
                  !waiting &&
                  prep.state !== 'handed' &&
                  prep.state !== 'ready' && (
                    <button
                      className="secondary"
                      onClick={() => void model.retryPreparation(prep.id)}
                    >
                      核对并继续连接
                    </button>
                  )}
                {prep.state === 'ready' && prep.resumeRequired && (
                  <button
                    className="secondary"
                    onClick={async () => {
                      try {
                        await model.resumePreparation(prep.id);
                      } catch {
                        setError('本地保存失败，请保留内容后重试。');
                      }
                    }}
                  >
                    继续此对话
                  </button>
                )}
                {prep.state === 'handed' && (
                  <>
                    <p className="field-help">
                      不会自动重复发送。内容保留在此，可复制后对照已有记录。
                    </p>
                    <button
                      className="secondary"
                      onClick={() => model.openPreparedConversation(prep.id)}
                    >
                      查看对话记录
                    </button>
                  </>
                )}
                <div className="conversation-preparation-discard">
                  <button
                    type="button"
                    className="text-link"
                    onClick={async () => {
                      try {
                        await model.discardPreparation(prep.id);
                      } catch {
                        setError('本地草稿暂时无法移除，内容仍保留，请稍后重试。');
                      }
                    }}
                  >
                    放弃本地草稿
                  </button>
                  <p className="field-help">
                    只移除此处草稿，不取消已发出的请求；已有对话和主机记录仍保留。
                  </p>
                </div>
              </div>
            </div>
          </div>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <AssistantComposer
            area={area}
            history={history}
            value={input}
            onValue={change}
            send={submit}
            upload={async () => setError('对话连接完成后可上传附件，文字草稿会保留。')}
            attributes={{
              'aria-label': '新对话消息',
              placeholder: '发送消息… 连接完成后开始处理',
              maxLength: preparationTextLimit(prep.target.origin),
            }}
          >
            <AssistantComposerActions
              scope={prep.id}
              thinkingLevel="off"
              changeThinking={() => {}}
              thinkingDisabled
              thinkingDisabledReason="连接完成后可选择主机支持的思考强度。"
              insertVoice={(text) => change(input + text)}
              terminal={() => {}}
              terminalDisabled
              terminalDisabledReason="连接完成后可打开终端。"
              attach={() => {}}
              attachmentDisabled
              attachmentDisabledReason="连接完成后可上传附件。"
              commands={() => {}}
              commandsDisabled
              commandsDisabledReason="连接完成后可使用主机命令。"
              working={false}
              hasContent={!!input.trim()}
              stop={() => {}}
              sendDisabled={!input.trim() || !!prep.message || prep.state === 'handed'}
              sendDisabledReason={
                prep.message ? '首条消息已保留，可先编辑补充或修改待发送消息。' : '请输入消息。'
              }
              sendLabel="发送"
              sendAria="提交新对话消息"
            />
          </AssistantComposer>
        </section>
      </div>
    </>
  );
}

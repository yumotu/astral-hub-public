import { lazy, Suspense, useState, useEffect } from 'react';
import { FolderOpen, Monitor, TerminalSquare, Puzzle, RefreshCw, X } from 'lucide-react';
import { ComputerChat } from './ComputerChat';
import { ComputerFiles } from './ComputerFiles';
import { WithoutFileWorkbench } from './FileWorkbench';
import { useUnifiedConversations } from './UnifiedConversations';
import { useBackLayer } from './back-navigation';
import type { ComputerTarget, ComputerGroup } from './assistant-computers';
import type { Settings } from './types';
import './computer.css';
import './assistant-computers.css';
const ComputerTerminal = lazy(() =>
  import('./ComputerTerminal').then((m) => ({ default: m.ComputerTerminal })),
);
const ComputerPlugins = lazy(() =>
  import('./ComputerPlugins').then((m) => ({ default: m.ComputerPlugins })),
);

export function ComputerAssistantView({
  settings,
  owner,
  target,
  groups,
  ready,
  refreshing,
  error,
  retry,
  connect,
  newConversation,
  titleChanged,
}: {
  settings: Settings;
  owner: string;
  target: ComputerTarget;
  groups: ComputerGroup[];
  ready: boolean;
  refreshing: boolean;
  error: string;
  retry: () => void;
  connect: () => void;
  newConversation: () => void;
  titleChanged: (id: string, title: string) => void;
}) {
  const [settingsHost, setSettingsHost] = useState<HTMLDivElement | null>(null);
  const [panel, setPanel] = useState<'files' | 'terminal' | 'plugins' | null>(null);
  const [filesOpened, setFilesOpened] = useState(false);
  const [pluginsOpened, setPluginsOpened] = useState(false);
  useEffect(() => {
    setPanel(target.panel || null);
    if (target.panel === 'files') setFilesOpened(true);
    if (target.panel === 'plugins') setPluginsOpened(true);
  }, [target]);
  const model = useUnifiedConversations();
  const knownTarget = model?.targets.find(
    (t) =>
      t.origin === 'computer' && t.deviceId === target.deviceId && t.projectId === target.projectId,
  );
  const group = groups.find((g) => g.device.id === target.deviceId);
  const foundProject = group?.projects.find((p) => p.id === target.projectId);
  const project = foundProject || {
    id: target.projectId,
    name: knownTarget?.projectName || '电脑项目',
    readOnly: true,
    allowExecute: false,
  };
  const deviceName = group?.device.name || knownTarget?.locationName || '原电脑';
  const verified = !!foundProject && group?.verified === true;
  const blocked = verified ? '' : '正在核验原电脑项目，草稿和记录会保留；核验完成后可发送。';
  useEffect(() => {
    if (!verified) setPanel(null);
  }, [verified]);
  useBackLayer(!!panel, () => setPanel(null), 55);
  return (
    <WithoutFileWorkbench>
      <section
        className="surface chat-panel assistant-computer-view"
        aria-label="智能助手电脑工作区"
      >
        <>
          <div className="assistant-toolbar">
            <span className="current-project-name" title={deviceName + ' / ' + project.name}>
              <Monitor size={14} />
              {project.name}
            </span>
            <span className="computer-location-label" title={deviceName}>
              {group?.device.local ? '本机 · ' : '远程 · '}
              {deviceName} · {verified ? (group?.device.online ? '在线' : '离线') : '核验中'}
            </span>
            <button
              disabled={!verified}
              aria-pressed={panel === 'files'}
              onClick={() => {
                setFilesOpened(true);
                setPanel(panel === 'files' ? null : 'files');
              }}
            >
              <FolderOpen size={14} />
              文件
            </button>
            <button
              disabled={!verified}
              aria-pressed={panel === 'terminal'}
              onClick={() => setPanel(panel === 'terminal' ? null : 'terminal')}
            >
              <TerminalSquare size={14} />
              终端
            </button>
            {group?.device.capabilities?.includes('computer_plugins') && (
              <button
                disabled={!verified}
                aria-pressed={panel === 'plugins'}
                onClick={() => {
                  setPluginsOpened(true);
                  setPanel(panel === 'plugins' ? null : 'plugins');
                }}
              >
                <Puzzle size={14} />
                插件
              </button>
            )}
            <div ref={setSettingsHost} />
          </div>
          {!verified && (
            <div className="computer-recovery-banner" role="status">
              <span>
                {group?.error ||
                  error ||
                  (refreshing || !ready
                    ? '正在恢复原电脑项目，已有配对会保留。'
                    : '暂时无法核验原电脑项目，请重试或检查这台电脑的授权。')}
              </span>
              <button className="text-link" type="button" disabled={refreshing} onClick={retry}>
                <RefreshCw size={13} />
                {refreshing ? '正在刷新' : '重新读取'}
              </button>
              <button className="text-link" type="button" onClick={connect}>
                连接设置
              </button>
            </div>
          )}
          {verified && !group?.device.online && (
            <p className="computer-offline-banner" role="status">
              电脑离线，已缓存的记录仍可查看。新任务等待这台电脑连接，不会转移执行。
            </p>
          )}
          {verified &&
            group?.device.online &&
            !group.device.capabilities?.includes('chat_export') && (
              <p className="computer-offline-banner" role="status">
                这台电脑尚未加载文件发送工具。同步电脑执行器工具补丁并重启后，聊天即可接收图片和文件。
              </p>
            )}
          <div className="computer-unified-content">
            <div className="computer-unified-chat" hidden={!!panel} inert={!!panel}>
              <ComputerChat
                key={target.conversationId}
                settings={settings}
                owner={owner}
                deviceId={target.deviceId}
                project={project}
                conversationId={target.conversationId}
                settingsContainer={settingsHost}
                executionBlocked={blocked}
                terminal={() => {
                  if (verified) setPanel('terminal');
                }}
                files={() => {
                  if (!verified) return;
                  setFilesOpened(true);
                  setPanel('files');
                }}
                plugins={() => {
                  if (!verified) return;
                  setPluginsOpened(true);
                  setPanel('plugins');
                }}
                newConversation={newConversation}
                capabilities={group?.device.capabilities || []}
                locationName={(group?.device.local ? '本机 · ' : '远程 · ') + deviceName}
                titleChanged={titleChanged}
              />
            </div>
            {verified && filesOpened && (
              <div
                className="computer-unified-panel"
                hidden={panel !== 'files'}
                inert={panel !== 'files'}
              >
                <header className="workbench-heading">
                  <FolderOpen size={16} />
                  <strong>项目文件</strong>
                  <button
                    className="icon-btn"
                    aria-label="返回电脑对话"
                    onClick={() => setPanel(null)}
                  >
                    <X size={17} />
                  </button>
                </header>
                <ComputerFiles
                  settings={settings}
                  owner={owner}
                  deviceId={target.deviceId}
                  project={project}
                />
              </div>
            )}
            {verified && panel === 'terminal' && (
              <div className="computer-unified-panel">
                <header className="workbench-heading">
                  <TerminalSquare size={16} />
                  <strong>电脑终端</strong>
                  <button
                    className="icon-btn"
                    aria-label="返回电脑对话"
                    onClick={() => setPanel(null)}
                  >
                    <X size={17} />
                  </button>
                </header>
                <Suspense fallback={<p className="field-help">正在载入终端…</p>}>
                  <ComputerTerminal
                    settings={settings}
                    owner={owner}
                    deviceId={target.deviceId}
                    project={project}
                  />
                </Suspense>
              </div>
            )}
            {verified && pluginsOpened && (
              <div
                className="computer-unified-panel"
                hidden={panel !== 'plugins'}
                inert={panel !== 'plugins'}
              >
                <header className="workbench-heading">
                  <Puzzle size={16} />
                  <strong>电脑工具与插件</strong>
                  <button
                    className="icon-btn"
                    aria-label="返回电脑对话"
                    onClick={() => setPanel(null)}
                  >
                    <X size={17} />
                  </button>
                </header>
                <Suspense fallback={<p className="field-help">正在载入电脑插件…</p>}>
                  <ComputerPlugins
                    settings={settings}
                    owner={owner}
                    deviceId={target.deviceId}
                    projectId={project.id}
                    online={!!group?.device.online}
                    supportsOnline={!!group?.device.capabilities?.includes('online_packages')}
                    allowExecute={project.allowExecute}
                  />
                </Suspense>
              </div>
            )}
          </div>
        </>
      </section>
    </WithoutFileWorkbench>
  );
}

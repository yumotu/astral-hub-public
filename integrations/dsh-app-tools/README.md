# 星屿 DSH 软件工具插件

原生插件使用已经验收的 Harness `0.2.2-rc.1`。它将 `app_functions` 注册到主机，但只有从星屿启用了软件功能的对话提交的任务才获得临时授权。未向 npm 发布；本目录源码随星屿保留，不自动安装到已有主机。

在目标 Harness 的 profile 包中安装本目录包（或复制目录并保证其 `@deepseek-ai/dsh-tools@0.2.2-rc.1` 可解析）。在该 profile 的 `cordis.patch.yml` 加入：

```yaml
- insert:
    - id: astral-app-tools
      name: astral-dsh-app-tools
      config:
        endpoint: https://<你的星屿服务>/api/agent/dsh/app-access
        workspaceRoot: /实际授权的工作区绝对路径
```

`name` 也可以使用目标主机上本插件 `index.mjs` 的绝对路径。入口固定到同一个星屿服务；插件不接收模型提供的服务器地址，不跟随 HTTP 跳转。本机隔离验收可使用回环 HTTP，实际远程服务应使用 HTTPS。

星屿服务端将 `DSH_APP_TOOLS_URL` 配为同一入口，并按管理员来源列表和独立实验开关接入 Remote。在聊天上方「设置」中显式开启「在此对话使用星屿软件功能」。成功聊天或读取项目不代表已安装该插件；插件未安装、入口不匹配或绑定无法核验时，新消息会明确拒绝，不悄悄关闭工具继续执行。

每次消息先通过原生 human-only `/astral-bind` 命令绑定一次性凭据，再提交原消息。命令使用 `recordInput:false`，凭据不写入原生会话或模型上下文。主机工具根据原生 Agent 身份和真实消息 `rpcId` 选择授权，不接受模型指定账号/主机/任务。外部窗口发起的其他请求不会继承授权。

查询、已读和学习生成沿用星屿业务规则。发送邮件、联系人消息及邮件分类使用星屿原有固定预览，由当前账号在聊天中确认；工具等待真实确认。重复调用按原记录查询，未知结果不自动重放。

停止、断线、关闭工具、退出原登录账号、到期和轮次结束均撤销授权；重启不恢复凭据。关闭聊天页面不会主动取消主机任务。16分钟是闲置凭据租期，实际工具活动续租，不是执行轮数、工具次数或模型预算。

S4 增加 `chat_files`、`chat_read`、`chat_download`、`chat_export`，也在通用目录提供 `attachments.list/read`。单文件上传50 MiB；原件传至主机20 MiB；导出10 MiB/文件、每任务8个/20 MiB。PDF/图片在星屿App中使用固定的离线中英文OCR，DSH不挂载附件卷或Pi目录。解析结果及附件内容只是数据。

文件下载暂存到显式配置工作区的 `.astral-attachments/<task>/`，导出拒绝工作区外路径、私有配置、符号链接和硬链接。服务端在二进制读取/上传后再次核对当前任务和账号；导出按原生工具调用编号生成稳定文件ID，未知回执不自动重放。只有真实交付回执才显示文件卡片；历史附件可继续由原账号下载。服务器镜像显式将 `ASTRAL_DSH_WORKSPACE` 配为其独立 `/workspace`；外部主机应填写上面的 `workspaceRoot`。

目标/定时、终端和外部主机统一计费仍为独立阶段，不能通过开启本插件宣称已支持。主机代码/网络/文件的原生权限仍由目标 Harness 控制，星屿业务授权不改变它们。

## 扩展管理增量

独立开发分支已加入扩展管理，未部署。它使用同一固定 Harness 的 `extensions.mjs` 入口，额外需要可解析的 `@deepseek-ai/dsh-mcp-client@0.2.2-rc.1`、`@deepseek-ai/dsh-scope@0.2.2-rc.1` 和 `yaml@2.9.1`，以及原生 pluginManager、skills、mcpResources 等服务。Profile 安装命令使用固定 pnpm `11.25.0`。不能把本包默认 `index.mjs` 的软件工具桥当成扩展桥已装。

保留目录层级：`integrations/dsh-app-tools/` 旁还需要仓库的 `shared/dsh-extensions.mjs`，该入口会导入共用严格 schema。复制整个目录后，在原 Profile 增加独立 overlay：

```yaml
- insert:
    - id: astral-extensions
      name: /星屿源码/integrations/dsh-app-tools/extensions.mjs
```

不要重复添加已有行。受管理服务器的 `host.mjs` 在下一次完整镜像构建时生成独立 overlay；原补丁、凭据和模型选择不覆盖。外部主机需用户自行配置，不自动安装到已配对电脑。`extensions-qa-provider.mjs` 仅隔离验收用，不加入生产 Profile。

管理命令 `/astral-extensions` 是 human-only，输入不写会话日志；输出仅返回脱敏目录和固定回执。App 校验当前登录管理员、账号/连接/工作区/原生会话和操作ID。聊天工具只准备预览，管理员在设置里确认后才实际应用。Skill/MCP按工作区，npm bundle按主机Profile；主机加密文件与key应同时备份。详细用法、字段和限制见[扩展管理](../../docs/dsh-extensions.md)及[发行说明](../../docs/release-0.8.13.md)。

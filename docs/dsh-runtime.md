# DSH 运行时

0.8.13保留Pi默认助手，并提供固定Harness `0.2.2-rc.1`与Remote `14037e78f45e14f7a5ad56c2266944548def7e3d`的可选后端。DSH使用独立会话，不将原Pi历史伪装成DSH上下文，不自动重放未知任务。

## 连接已有Remote

维护者在私有环境配置 `DSH_REMOTE_ENABLED=1`、`DSH_REMOTE_CHAT_ENABLED=1` 和 `DSH_REMOTE_ALLOWED_ORIGINS` 的明确服务来源，再从助手驱动菜单添加Remote连接并核对主机指纹。Remote凭据按账号加密保存；选择DSH工作区后进入同一聊天界面。生产Remote应使用HTTPS，不公开原生Harness端口。

软件工具需额外安装本仓库的[原生工具插件](../integrations/dsh-app-tools/README.md)，配置同一个星屿服务的固定入口和明确工作区，再于对话设置中显式开启。服务端 `DSH_APP_TOOLS_URL` 必须与插件入口一致。聊天连接成功不等于工具安装完成；插件不匹配时提交明确失败，不静默降级。

## 独立服务器主机

服务器运行包和源码包含 `deploy/dsh/Dockerfile`、固定依赖锁、`host.mjs`、Remote的原始许可和摘要，以及 `integrations/dsh-app-tools`。主机健康应同时报告 `version=0.8.13`、`revision=dsh4`、`fileBridgeVersion=1`、`workbenchVersion=1`、`extensionManagerVersion=1`。

主机配置通过只读文件传入 `DSH_SERVER_CONFIG`，内容为部署者自己的回环Remote origin、account、至少32字符的password及name；这些值不进入镜像或仓库。内置主机固定使用 `http://127.0.0.1:8971/` 和健康端口8972。它需与App共用专用网络命名空间，两个端点只监听回环，不发布到公网。`DSH_HOME`、`/state` 和 `/workspace` 使用独立持久存储，不能挂载Pi状态、平台私有配置、附件卷或Docker socket。

App的 `DSH_MANAGED_CONFIG` 指向同一只读连接文件；原生工具入口为该网络命名空间内App的8787端口。模型凭据由部署者通过私有环境交给DSH主机，不能作为浏览器或Remote凭据使用。这个源码包提供可验证的运行时组件，不自动安装或迁移已有生产服务。

CI在无外部网络、无模型密钥、空白状态和工作区的容器中启动真实固定主机，检查dsh4健康、Remote摘要和工具加载；不会调用模型。业务、附件权限及取消逻辑另由完整测试覆盖。

## 能力与边界

支持流式文字、问答/审批、停止、重连、软件工具、附件原件传递和生成文件交付。上传50 MiB；传至主机的原件20 MiB；导出10 MiB/文件、每任务8件/20 MiB。只允许当前账号及任务明确绑定的附件，PDF和图片在App使用离线中英文OCR。文件插件拒绝工作区外路径、私有配置、符号链接和硬链接。

DSH支持终端、原生思考/技能/权限和[扩展管理](dsh-extensions.md)；目标/定时及统一账号费用尚未接入；不把缺失用量计为0。停止、退出登录、撤销和授权结束都不能恢复旧临时凭据。已有外部主机需主动更新插件，客户端升级不会替它安装第三方代码。

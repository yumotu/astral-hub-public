# 星屿 Astral Hub

可自托管的多平台 AI 工作空间。通过同一聊天界面使用服务器项目、明确授权的电脑项目、邮件、学习资料与应用工具。

## 功能

- 智能助手：流式回复、连续补充、历史分支、项目与文件、独立终端、语音草稿、附件预览。
- 电脑连接：桌面内置执行器、主动 HTTPS 连接、按项目授权读取/修改/执行，支持文件回传和插件许愿安装。
- 邮件与学习：邮件阅读/摘要/分类、草稿与发送预览；知识讲解、练习、智能判题、错题本。
- 多账号：成员目录与授权、联系人、未读提醒、账号 Token 用量及 DeepSeek 人民币费用估算；不扣余额。
- 网页、macOS、Windows、Android 共用前端，支持浅色、深色及护眼主题。

## 本地开发

需要 Node.js 24 或更新版本。Pi 与电脑执行器固定使用 Node.js 26.7.0 / Pi SDK 1.4.0。

```sh
npm ci
npm run init
npm run dev
```

`init` 生成本机私有 `.env`，已有配置不会覆盖。按需填写模型密钥，勿提交 `.env`。网页和 HTTP API 可独立运行；完整服务器助手还需配置 Pi，见[部署](docs/deployment.md)。

## 自托管与发行

- [部署与备份](docs/deployment.md)
- [电脑项目和权限](docs/computer-workspace.md)
- [账号用量及价格](docs/account-usage.md)
- [架构](docs/architecture.md)
- [构建发行版](docs/releasing.md)
- [贡献](CONTRIBUTING.md)、[安全](SECURITY.md)、[第三方素材](THIRD_PARTY_NOTICES.md)

公开 Actions 使用标准 Ubuntu/macOS/Windows 托管 runner 构建本仓库源码。完整原生检查通过后才发布 Release；Android 签名材料由受限发行步骤读取 Secrets，不进入源码、普通构建或公共缓存。GitHub 的大规格 runner、存储及其他服务按各自规则处理。

当前源码版本为 0.8.9；是否已发行以对应 Release 与成功 CI 为准。macOS 默认临时签名，正式 Developer ID/公证需维护者配置；不能将资源完整性检查当作 Apple 公证。

## 权限与数据

默认不连接电脑、不启用命令执行。电脑终端使用当前系统用户权限，项目目录不是 Shell 沙箱。服务器保存账号、聊天和加密后的邮件凭据；没有端到端加密。部署前阅读权限和备份说明。

本公开仓库从清理后的当前源码建立独立历史，不包含私人部署配置、运维记录、用户截图、数据或旧 Git 历史。项目暂未指定开源许可证；公开可见不代表授予额外使用许可，第三方内容遵循各自许可。

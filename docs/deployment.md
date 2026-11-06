# 自托管

需要 Docker Engine/Compose 和支持用户命名空间的 Linux；服务器助手执行隔离测试后再接入真实项目。

```sh
npm ci
npm run init
# 在本机编辑 .env，填写 DEEPSEEK_API_KEY；不要提交或公开该文件。
docker compose -f deploy/compose.yml up -d --build
```

默认 HTTP 只绑定 `127.0.0.1:8787`，用于本机访问或反向代理。远程客户端需要配置 HTTPS 与明确的 `ALLOWED_ORIGINS`，保留 Android/Electron 所需来源。可使用附带 Caddy 模板或 `deploy/https/nginx.conf.template`，将示例域名、证书路径替换为自己的配置。Nginx 模板适用于与应用同机的代理，保留 50 MiB 限额、流式请求和 WebSocket 配置。

`astral_data`、`chat_files`、`pi_home`、`pi_workspace`、`project_workspace` 是持久卷。默认不挂载宿主用户目录或平台源码；要接入真实项目，先配置受限挂载与 `deploy/pi/projects.json`。普通成员仍限制在各自用户名目录，目录外操作需授权。

完整模型助手需要 Pi 服务健康并完成插件启用检查；仅 HTTP health 成功不等同桥接全部就绪。联网、文件权限和宿主终端权限分别管理。

升级前使用 SQLite 在线备份，并保存配置、文件卷、原镜像与更新清单；活跃任务完成后再切换。不要 `down -v` 或用旧数据库覆盖新用户操作。密钥和数据库只存于受保护的私有备份，不上传到本仓库或公开 Actions。

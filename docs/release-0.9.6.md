# 星屿 0.9.6

## SuperAgent 管家

- 左侧顶部新增 Dot 风格的独立 SuperAgent 对话窗口。
- Leader 只负责短思考、澄清目标、委派和最终汇报。
- 任务统一委派给 subagent，Activity 显示进行中、待决定和已完成状态。
- 对话和 Activity 按账号保留，跨页面继续。
- 服务端新增账号隔离的 SuperAgent 委派任务账本。
- 新增 `/api/superagent/tasks` 任务创建、查询、状态回报和停止接口。
- 新增 Pi、DPH、Remote 统一 subagent dispatcher。未配置适配器时保持排队，未知结果不会自动重放。

## 兼容与限制

- 本版不改变既有 Pi、DPH、Remote 原生对话路由。
- macOS 使用临时签名，未进行 Developer ID 公证。
- Windows 未使用正式代码签名。
- Android 沿用当前发行流程中的调试签名，覆盖安装前需要卸载旧版并保留数据。
- 真实 subagent runtime adapter 需要在部署配置中显式启用。

源码提交和构建证明以本版本 `build-info.json`、`SHA256SUMS.txt` 与 GitHub Actions 结果为准。

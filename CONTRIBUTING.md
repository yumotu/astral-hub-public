# Contributing

先通过 Issue 说明问题、预期行为和最小复现。日志、截图与测试样本必须删除账号、令牌、真实邮件、机器路径和部署地址。

使用 Node.js 24+，运行 `npm ci`、`npm test`、`npm run build`。电脑执行器还需 `npm ci --prefix agent --ignore-scripts`、`npm --prefix agent run terminal:setup`，然后运行 `agent/tests/` 的原生测试。不要将测试用虚拟模型误报为实际模型验收。

提交说明应包括触发条件、最终行为、验证结果及实际限制。保持改动范围清楚，避免提交运行数据与编译产物。所有可远程执行的软件功能同时接入 `app_functions`，验证账号、目标和授权边界。

项目尚未指定开源许可证；提交贡献前请先与维护者确认贡献授权方式。第三方依赖和素材保留其原始许可与归属。

# 0.9.4 交接

## 发行

- Public Release [v0.9.4](https://github.com/yumotu/astral-hub-public/releases/tag/v0.9.4)
- CI [44897957092](https://github.com/yumotu/astral-hub-public/actions/runs/44897957092)
- 发布源提交 `d0fad9b7056e154a05f36e77db1399944944c6c2`
- Release 包含 macOS arm64/x64 DMG、Windows x64、Android APK、server tar、source zip、Remote Pi Agent、SHA256SUMS 和 build-info，共 11 件资产

## 功能

- 投资研究页继续使用受认证的只读研究服务
- 增加账号级持仓记录和增删刷新接口
- 支持股票、基金、黄金和货币的允许列表报价刷新
- 增加风险预算组合计划，包含风险状态、CVaR 与集中度提示、漂移阈值和解释性操作建议
- 投资 DSH 工具保持动态注册，新增 `build_portfolio_plan`
- 前端持仓面板在窄屏下保持单列布局，避免卡片和操作栏横向溢出

## 生产

- `https://120.26.29.170/api/health` 返回 `version=0.9.4` 和 `releaseName=0.9.4`
- App 镜像 `astral-hub:0.9.4-investment-d0fad9b`，镜像摘要 `sha256:93948ef0c28a7e3e88c93a5c6f76c4b9d2fb48528500b05f0aae4b9749796df2`
- DSH 镜像保持 `astral-dsh:0.8.12-dsh5-finance-3511f4d`，Pi 镜像保持 `astral-pi:1.4.0-v0820-learning1`
- 三个容器均为 healthy，Pi 未替换
- 更新清单已经原子切换到 `0.9.4`，四个平台文件共 1,059,430,978 字节，逐文件 SHA-256 通过
- 数据库切换后 `quick_check=ok`，外键违规为 0，`investment_holdings` 表存在且当前记录数为 0

## 回滚

- 数据库和清单备份位于 `/opt/astral-hub/backups/before-0.9.4-investment-20261121T114301Z`
- 备份中保留了切换前 compose、部署配置、DSH 工作区归档、数据库快照和 0.9.3 更新清单
- 回滚时恢复 0.9.3 compose 覆盖层，停止 DSH 后只重建 App，再恢复 DSH。Pi、数据卷、数据库和更新文件保持不动

## 原生签名

- macOS 使用临时签名，未进行 Developer ID 公证
- Windows 未使用正式代码签名
- Android 使用新的调试签名，安装前需要备份应用数据并卸载旧版

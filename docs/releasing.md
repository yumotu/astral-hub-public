# 使用公共 Actions 构建发行版

本仓库包含完整公开源码，Actions 从当前仓库 checkout，不拉取私有仓库。标准 Ubuntu/macOS/Windows runner 用于网页测试、Pi 隔离、三平台电脑执行器、Mac 双架构、Windows、Android APK 与实际模拟器验收。完整门槛成功后由单独的 Release job 发布源码、运行包、电脑包、安装包和摘要。

## 一次性配置

1. 在空 public 仓库建立独立根提交，不导入私人仓库的 `.git`、旧分支、标签、数据或产物。
2. 限制 main/发行标签的写入者，并配置 `release-signing` Environment 的维护者审核。
3. 将既有 Android 签名文件配置为 Environment Secret `ANDROID_KEYSTORE_BASE64`，密码分别为 `ANDROID_STORE_PASSWORD`、`ANDROID_KEY_PASSWORD`，别名为 `ANDROID_KEY_ALIAS`。代码中的 `android/signing-certificate.sha256` 固定既有证书指纹；可选公开变量 `ANDROID_CERT_SHA256` 只能用于额外的一致性核对，不能指定新证书。不要在聊天、Issue、代码或缓存中传递签名材料。
4. PR/普通构建只使用临时测试证书；完整验收后的独立步骤对已测试 APK 重新签名，对照固定证书指纹并生成与提交绑定的证明。缺原证书时正式发行失败，不能自动换证书。测试 APK 不用于覆盖现有安装，只有最终 Release APK 保持更新签名。
5. Mac 默认临时签名；当前公共工作流不读取 Apple 签名凭据，正式 Developer ID/公证需另行配置受保护的发行步骤。Windows 默认未正式签名。不得把临时签名称为已公证。

## 发版

维护者在默认分支手动运行 Build applications 并选择发布，或推送与 `package.json` 完全一致的正式标签（例如版本为 `0.8.9` 时使用 `v0.8.9`）。普通 main/PR 构建和 `v0.8.9-rc.*` 候选标签只执行验证，不发布稳定版本。发行 job 要求全部原生检查和 Android 最终签名通过，再校验组合资产、创建不可变正式版本标签及 GitHub Release。

相同版本已存在但提交不同会失败，不能覆盖已有标签或安装包。用 `build-info.json`、`SHA256SUMS.txt` 和签名证明核对实际来源。更新服务通过 `scripts/publish-updates.mjs` 接收完整、已验收的发行目录，不把 PR 开发包作为稳定更新。

标准托管 runner 的公开仓库构建不占私有仓库包含分钟；大规格 runner、制品存储和其他产品按 GitHub 当前规则。工作流制品短期保留，正式 Release 保存最终发行物。

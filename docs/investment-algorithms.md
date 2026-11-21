# 投资研究算法说明

## 当前实现

投资研究使用账户持仓、资产类别、市场状态和可用风险指标生成可复核的研究计划。计划包含目标区间、当前偏离、风险标记和分批调整建议，任何建议都不会自动下单。

- 风险预算按保守、均衡、成长三种画像设置资产类别先验。
- 市场状态对先验进行置信度受限的视图调整，风险收缩时降低股票目标并增加现金管理和黄金缓冲。
- 已有 CVaR、最大回撤、波动率和集中度数据时启用尾部风险保护。
- 单次偏离小于 5% 只显示持有，避免由小幅波动引起的频繁调仓。
- 有单项波动率时输出逆风险权重，作为风险平价检查，不把缺失数据伪装成精确优化结果。

## 研究过的先进方法

- HRP 通过相关性距离、层次聚类和递归二分分配风险，避免直接求逆协方差矩阵。接入前需要多资产、同频、无前视的收益序列和滚动回测。
- Black-Litterman 把市场均衡先验与带置信度的观点融合，适合已有市值权重和稳定观点来源的场景。当前系统先使用受限的 regime view，未声称完成完整后验矩阵计算。
- CVaR 的 Rockafellar–Uryasev 形式把尾部损失转为可优化的辅助变量问题。当前服务用于评分和风险门槛，完整线性规划将在收益序列和约束齐备后接入。
- HMM 或特征选择 HMM 可用于滚动识别牛市、震荡和风险收缩状态。启用前必须使用 walk-forward 验证、状态持续性门槛和交易成本，避免把历史拟合当作预测能力。

## 数据与账户边界

持仓通过当前账号的独立接口保存，支持股票、基金、黄金、货币、债券、现金和货币基金。当前价格可以手动录入，数据来源和日期随持仓保存。公共行情只作为研究输入，账号数据不会自动从邮箱、文件或其他账号读取。

推荐结果展示算法版本、数据日期、缺失字段、风险标记和调整依据。真实交易接口、自动下单和收益保证不在本功能范围内。

## 参考资料

- [Feature Saliency Hidden Markov Models for smart beta investing](https://arxiv.org/abs/1902.10849)
- [Conditional Value-at-Risk: Theory and Applications](https://arxiv.org/abs/1511.00140)
- [Portfolio Construction using Black-Litterman Model and Factors](https://arxiv.org/abs/2311.04475)
- [Latent Variable Estimation in Bayesian Black-Litterman Models](https://arxiv.org/abs/2505.02185)

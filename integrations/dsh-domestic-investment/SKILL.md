---
name: domestic-investment
description: Domestic and international investment research plus guarded holding, quote, schedule and order previews with dated evidence and explicit missing fields.
---

# Domestic and international investment research

Use the bundled `astral-domestic-investment` tools for fund screening, market-regime analysis, bond stress testing, long-term stock research, international comparisons, portfolio research actions, an explainable risk-budget plan, holding-intent drafts, quote refresh previews, and order previews. Pi exposes the matching account-scoped workflow through `app_functions`.

Research tools are read-only. Holding and order tools produce drafts or previews and never submit a real order. Schedule changes require a separate host confirmation. Preserve the `data_as_of` date, distinguish observed data from inference, and report missing fields and confidence.

Public live sources are used when available. Tushare Pro is optional and is selected only when the host provides `TUSHARE_TOKEN`. Never ask the model to reveal or repeat that token.

When a portfolio snapshot is supplied, preserve asset type, quantity, valuation date, missing fields, tail-risk flags, target drift, and the algorithm version. The plan is for review and never becomes an order instruction.

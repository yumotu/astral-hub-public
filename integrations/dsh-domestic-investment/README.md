# Astral DSH domestic investment bundle

This directory is the repository-owned DSH bundle for the maintained domestic investment algorithms. `deploy/dsh/host.mjs` adds it through the generated `astral-extensions.patch.yml`, and both production and disposable DSH images copy the directory into the image. The bundle is loaded from the image-relative entrypoint, so it does not depend on a developer machine path.

The bundle registers the `domestic-investment` Skill and nine read-only tools for methodology, live dashboard data, allowlisted Tushare queries, fund screening, bond stress, market regimes, long-term stocks, portfolio research actions, and explainable portfolio plans. It never places orders, changes holdings, sends messages, or creates schedules.

Public Tencent and Eastmoney sources work without credentials. Tushare Pro is optional. Set `TUSHARE_TOKEN` in the DSH host environment when licensed data is required. The host forwards the value only to the DSH process and never writes it into the bundle, browser state, or tool output.

User portfolio data is optional. Set `INVESTMENT_DATA_FILE` to a private workspace file when a portfolio snapshot is available. The independent investment window stores account-scoped holdings separately and does not read email or files automatically. The bundle otherwise keeps portfolio data empty and uses public live market sources.

The bundled bond evidence is public-source metadata under `data/bond-fund-evidence.json`. It is not a user account export.

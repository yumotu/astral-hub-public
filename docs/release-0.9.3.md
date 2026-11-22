# 0.9.3

0.9.3 adds an independent investment research window beside Mail and the other workspace tools.

- Investment Research is a first-class page with its own navigation entry, responsive layout, risk profile, refresh state, source/date metadata, and tabs for fund screening, market regime, long-term stocks, international market research, and personal funds.
- The investment page reads authenticated server routes and live public research sources through the bundled domestic-investment DSH service. It does not read or expose personal portfolio data unless a future account-scoped source is explicitly connected.
- The mail task compatibility layer normalizes legacy snapshots before rendering so older task records cannot blank the mail window.
- Native packages are rebuilt from the 0.9.3 source tree. Android uses the retained debug signing workflow. macOS and Windows signing status remains the status reported by the release verification artifacts.

The 0.9.2 server, package assets, and update manifest remain available for rollback.

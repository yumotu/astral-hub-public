# 0.9.3 交接

## 发行

- Public Release: https://github.com/yumotu/astral-hub-public/releases/tag/v0.9.3
- Verified source commit: `b2069324cc5ea19f51343a3b3224deb2e9e96d15`
- Assets: macOS arm64/x64 DMG, Windows x64 EXE, Android debug APK, server tar, source zip, remote Pi agent, checksums, and build provenance.
- CI run: https://github.com/yumotu/astral-hub-public/actions/runs/44886299803

## Product change

- Investment Research is a first-class page beside Mail. It has its own navigation entry, responsive layout, risk profile selector, refresh state, source/date metadata, and research tabs.
- The page uses authenticated read-only investment routes backed by the bundled domestic-investment service. Portfolio data is not read unless an explicit account-scoped source is configured.
- Legacy mail task snapshots are normalized before rendering to prevent the mail page from blanking on older records.

## Production

- Health reports `version=0.9.3` and `releaseName=0.9.3`.
- App image: `astral-hub:0.9.3-investment-b206932`, digest `sha256:acc7b8965df42b0a89dc2f1549f250a42797011a54b75aa83d8fb604d8b368f4`.
- DSH image: `astral-dsh:0.8.12-dsh5-finance-3511f4d`, Pi image remains `astral-pi:1.4.0-v0820-learning1`.
- Update manifest is `0.9.3` with four locally stored, SHA-256 verified installer assets.
- Database read-only checks passed with `quick_check=ok` and zero foreign-key violations. No active Pi, computer, terminal, learning, mail, function, DSH, or unified operations were running during the switch.
- Backup: `/opt/astral-hub/backups/before-0.9.3-investment-20261121T091123Z`.

## Rollback

Use the preserved `deploy/compose.0.9.2-mail-finance.yml` override with the existing compose layers, stop DSH, then recreate only App and DSH. Keep the Pi container, data volumes, database, update files, and DSH state untouched. The 0.9.3 update directory and manifest should be restored from the backup only if the rollback is intended to hide 0.9.3 from clients.

## Native signing status

macOS uses temporary signing and has no Developer ID notarization. Windows is unsigned. Android uses the retained debug-signing workflow and requires uninstall before installing over an older signed package.

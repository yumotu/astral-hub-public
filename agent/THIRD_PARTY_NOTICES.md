# Third-party notices

Original Astral Hub source is licensed under the root MIT LICENSE. Third-party packages and assets retain their own copyrights and licenses; the project license does not replace them.

- The vendored `pi-goal` 0.1.7 source remains unchanged under MIT. Its license and provenance are in `deploy/pi/vendor/pi-goal/LICENSE` and `UPSTREAM.json`; the computer executor retains copies in `agent/assets/vendor/pi-goal/`.
- The server-side DSH Remote client is built from MIT source at commit `14037e78f45e14f7a5ad56c2266944548def7e3d`. Its original license, bundled cryptography dependency licenses, build lock and input hashes are retained in `server/vendor/dsh-remote/`. `UPSTREAM.json` records the narrow per-connection WebSocket origin guard; it does not replace the upstream encryption protocol.
- The optional DSH server runtime uses the same fixed Remote revision. Its host/server bundles and upstream license, dependency notices and hashes are retained in `deploy/dsh/vendor/`. The Harness dependency is pinned separately in `deploy/dsh/package-lock.json`; its installed package licenses remain with the runtime image.
- The Lucide-derived brand icon retains its ISC/Feather attribution in `web/public/brand-icon-LICENSE.txt`.
- PDF.js resources retain the upstream license at `web/public/pdfjs/LICENSE` and the notices shipped with their fonts and other assets.
- Web builds generate `licenses/dependencies.txt` and `licenses/dependencies.json` from the installed production dependencies and their license/notice files. They also include `licenses/astral-hub-LICENSE.txt`. These resources travel with the web, Electron and Android web bundles.
- Electron and its Chromium runtime retain the license and credit files included by Electron packaging. The bundled computer executor installs its pinned npm dependencies with their original license files; the bundled Node distribution retains its own license. OCR data and native runtimes retain their upstream notices in those distributions.

Dependency versions are recorded in each package-lock.json. Generated dependency notices report the installed packages and their declared licenses; custom plugins installed by users retain the licenses and obligations of their respective authors.

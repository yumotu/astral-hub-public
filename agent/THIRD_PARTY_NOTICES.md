# Third-party notices

Original Astral Hub source is licensed under the root MIT LICENSE. Third-party packages and assets retain their own copyrights and licenses; the project license does not replace them.

- The vendored `pi-goal` 0.1.7 source remains unchanged under MIT. Its license and provenance are in `deploy/pi/vendor/pi-goal/LICENSE` and `UPSTREAM.json`; the computer executor retains copies in `agent/assets/vendor/pi-goal/`.
- The Lucide-derived brand icon retains its ISC/Feather attribution in `web/public/brand-icon-LICENSE.txt`.
- PDF.js resources retain the upstream license at `web/public/pdfjs/LICENSE` and the notices shipped with their fonts and other assets.
- Web builds generate `licenses/dependencies.txt` and `licenses/dependencies.json` from the installed production dependencies and their license/notice files. They also include `licenses/astral-hub-LICENSE.txt`. These resources travel with the web, Electron and Android web bundles.
- Electron and its Chromium runtime retain the license and credit files included by Electron packaging. The bundled computer executor installs its pinned npm dependencies with their original license files; the bundled Node distribution retains its own license. OCR data and native runtimes retain their upstream notices in those distributions.

Dependency versions are recorded in each package-lock.json. Generated dependency notices report the installed packages and their declared licenses; custom plugins installed by users retain the licenses and obligations of their respective authors.

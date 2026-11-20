#!/usr/bin/env bash
set -euo pipefail

# This job only builds Java/Kotlin and WebView assets. Keep cleanup confined to
# the disposable GitHub-hosted Linux runner, never a developer or server host.
if [[ "${GITHUB_ACTIONS:-}" != true || "${RUNNER_OS:-}" != Linux || "${RUNNER_ENVIRONMENT:-}" != github-hosted ]]; then
  echo 'Android emulator cleanup requires a disposable GitHub-hosted Linux runner.' >&2
  exit 1
fi

df -h "$RUNNER_TEMP"
for astral_unused_sdk in /usr/local/lib/android/sdk/ndk /usr/share/dotnet; do
  if [[ -e "$astral_unused_sdk" ]]; then
    du -sh "$astral_unused_sdk"
    sudo rm -rf -- "$astral_unused_sdk"
  fi
done
df -h "$RUNNER_TEMP"

# API 35's prebuilt userdata image can exceed disk.dataPartition.size. Reserve
# room for the system-image download/extraction, userdata and test reports.
astral_available_kib=$(df -Pk "$RUNNER_TEMP" | awk 'NR == 2 { print $4 }')
if (( astral_available_kib < 16 * 1024 * 1024 )); then
  echo 'At least 16 GiB of runner disk space is required before installing the emulator image.' >&2
  exit 1
fi

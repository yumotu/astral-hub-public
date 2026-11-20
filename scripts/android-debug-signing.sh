#!/usr/bin/env bash
set -euo pipefail

key=${ASTRAL_ANDROID_KEYSTORE:?Set the explicit debug keystore path}
case "${1:-}" in
  prepare)
    if [ ! -f "$key" ]; then
      if [ "${GITHUB_REF:-}" != "${DEFAULT_REF:-unset}" ] || [ "${BOOTSTRAP_SIGNING:-false}" != true ]; then
        echo '::error::Android signing cache is missing. Explicitly establish a signing baseline on the default branch; existing installations may have a different signature.'
        exit 1
      fi
      umask 077
      mkdir -p "$(dirname "$key")"
      keytool -genkeypair -keystore "$key" -storepass android -keypass android \
        -alias androiddebugkey -keyalg RSA -keysize 2048 -validity 10000 \
        -dname 'CN=Astral Debug, O=Astral Hub, C=CN'
    fi
    keytool -list -keystore "$key" -storepass android -alias androiddebugkey >/dev/null
    echo 'The explicit Android signing key is present and readable.'
    ;;
  verify)
    apk=${2:?APK path is required}
    signer="${ANDROID_HOME:?ANDROID_HOME is required}/build-tools/35.0.0/apksigner"
    expected=$(keytool -exportcert -keystore "$key" -storepass android -alias androiddebugkey | sha256sum | cut -d ' ' -f 1)
    actual=$("$signer" verify --print-certs "$apk" | sed -n 's/^Signer #1 certificate SHA-256 digest: //p')
    if [ "$expected" != "$actual" ]; then
      echo '::error::APK signer does not match the retained Android signing key.'
      exit 1
    fi
    printf 'Verified Android signer SHA-256: %s\n' "$actual"
    ;;
  *) echo 'Usage: android-debug-signing.sh prepare|verify APK' >&2; exit 2 ;;
esac

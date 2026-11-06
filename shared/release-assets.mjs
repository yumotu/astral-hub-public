export function expectedReleaseAssets(version) {
  const app = 'Astral-Hub-' + version + '-';
  return [
    app + 'mac-arm64.dmg',
    app + 'mac-arm64.zip',
    app + 'mac-x64.dmg',
    app + 'mac-x64.zip',
    app + 'win-x64.exe',
    app + 'android-debug.apk',
    app + 'source.zip',
    app + 'server.tar.gz',
    'Astral-Remote-Pi-Agent-' + version + '.zip',
  ];
}
export function checksumManifest(files) {
  const lf = String.fromCharCode(10);
  return (
    [...files]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((file) => file.sha256 + '  ' + file.name)
      .join(lf) + lf
  );
}

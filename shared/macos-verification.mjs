export function requiresMacVerification(version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Invalid release version.');
  const [major, minor] = version.split('.').map(Number);
  return major > 0 || minor >= 8;
}

export function macosVerification(report, { version, commit, files }) {
  if (!report || report.version !== version || report.commit !== commit ||
      !['integrity-only', 'developer-id'].includes(report.mode))
    throw new Error('Missing or mismatched macOS verification provenance.');
  const signed = report.mode === 'developer-id';
  if (report.apps?.length !== 2 || new Set(report.apps.map(a => a.arch)).size !== 2 ||
      !['arm64', 'x86_64'].every(arch => report.apps.some(a => a.arch === arch && a.integrity === true &&
        a.notarized === signed && a.gatekeeperAccepted === signed)))
    throw new Error('Both macOS architectures must pass the declared verification mode.');
  const names = ['arm64', 'x64'].flatMap(arch => ['dmg', 'zip'].map(ext => `Astral-Hub-${version}-mac-${arch}.${ext}`));
  if (report.assets?.length !== 4 || new Set(report.assets.map(a => a.name)).size !== 4 ||
      !names.every(name => report.assets.some(a => a.name === name && files.some(f => f.name === name && f.sha256 === a.sha256))))
    throw new Error('macOS verification does not match the packaged installer hashes.');
  return { mode: report.mode, integrity: true, notarized: signed, gatekeeperAccepted: signed, architectures: ['arm64', 'x86_64'] };
}

export function trustedMacDistribution(value) {
  if (!value) return false; // Earlier releases only establish integrity.
  if (value.mode === 'integrity-only' && value.integrity === true && value.notarized === false && value.gatekeeperAccepted === false)
    return false;
  if (value.mode !== 'developer-id' || value.integrity !== true || value.notarized !== true ||
      value.gatekeeperAccepted !== true || value.architectures?.length !== 2 ||
      !['arm64', 'x86_64'].every(arch => value.architectures.includes(arch)))
    throw new Error('macOS distribution verification is incomplete.');
  return true;
}

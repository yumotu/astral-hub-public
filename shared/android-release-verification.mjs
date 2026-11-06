export function requiresAndroidVerification(version) {
  const v = String(version).split('.').map(Number);
  return v.length === 3 && v.every(Number.isInteger) && (v[0] > 0 || v[1] > 8 || (v[1] === 8 && v[2] >= 9));
}
export function androidVerification(report, { version, commit, files }) {
  const apk = files.find(f => f.name === `Astral-Hub-${version}-android-debug.apk`);
  if (!report || report.version !== version || report.commit !== commit || report.integrity !== true || !/^[a-f0-9]{64}$/.test(report.certificateSha256 || '') || !Array.isArray(report.schemes) || !report.schemes.length || !report.schemes.every(s => /^v[1-4](?:\.\d)?$/.test(s)) || !apk || apk.sha256 !== report.apkSha256)
    throw Error('Android release signature provenance or installer hashes are incomplete.');
  return { version, commit, integrity: true, certificateSha256: report.certificateSha256, schemes: report.schemes, apkSha256: report.apkSha256 };
}

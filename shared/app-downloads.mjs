import { newerVersion } from './app-updates.mjs';
export function downloadableRelease(release, currentVersion, native) {
  return !!release && (!native || newerVersion(release.version, currentVersion));
}

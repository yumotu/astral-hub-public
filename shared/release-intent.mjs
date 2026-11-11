// An explicit maintainer release commit uses the same verification/signing gate
// as an exact version tag or the existing manual workflow input.
export function packageRelease({
  version,
  eventName,
  ref,
  defaultBranch,
  publishRelease,
  androidOnly,
  headMessage,
}) {
  if (!/^\d+\.\d+\.\d+$/.test(version || '') || androidOnly === true || androidOnly === 'true')
    return false;
  if (eventName === 'push' && ref === `refs/tags/v${version}`) return true;
  if (!defaultBranch || ref !== `refs/heads/${defaultBranch}`) return false;
  if (eventName === 'workflow_dispatch')
    return publishRelease === true || publishRelease === 'true';
  return eventName === 'push' && headMessage?.split(/\r?\n/)[0] === `release: v${version}`;
}

/** @typedef {import('../web/src/assistant-computers').ComputerGroup} ComputerGroup */

/**
 * The existing resource cache is scoped by server and login. Cached projects are
 * labels for restoring the view, never evidence that a grant is still valid.
 * @param {(path: string) => any} peek
 * @returns {ComputerGroup[]}
 */
export function readComputerCatalogueCache(peek) {
  // The unified tree can outlive individual relay entries after cache eviction.
  // Reuse exact target labels only; never infer a grant or merge by display name.
  // An explicit empty response is authoritative and must not revive old entries.
  const targets =
    peek('/assistant/targets?backend=pi')?.targets ??
    peek('/assistant/targets')?.targets ??
    peek('/assistant/conversations?targets=deferred')?.targets ??
    [];
  const fallback = new Map();
  for (const target of targets) {
    if (target.origin !== 'computer' || !target.deviceId || !target.projectId) continue;
    if (!fallback.has(target.deviceId))
      fallback.set(target.deviceId, {
        device: {
          id: target.deviceId,
          name: target.locationName || '远程电脑',
          online: false,
          lastSeen: '',
        },
        projects: [],
      });
    const group = fallback.get(target.deviceId);
    if (!group.projects.some((project) => project.id === target.projectId))
      group.projects.push({
        id: target.projectId,
        name: target.projectName || '电脑项目',
        readOnly: true,
        allowExecute: false,
      });
  }
  const devices = peek('/relay/devices')?.devices ?? [...fallback.values()].map((g) => g.device);
  return devices.map((device) => ({
    device,
    projects:
      peek('/relay/projects?deviceId=' + device.id)?.projects ??
      fallback.get(device.id)?.projects ??
      [],
    verified: false,
    loading: false,
  }));
}

/**
 * Publish the device list first and each project response independently. A slow
 * unrelated computer must not block restoring the current conversation.
 * @param {{
 *   seed?: ComputerGroup[],
 *   read: (path: string) => Promise<any>,
 *   onChange: (groups: ComputerGroup[]) => void,
 *   signal?: AbortSignal,
 *   active?: () => boolean,
 * }} options
 */
export async function refreshComputerCatalogue({
  seed = [],
  read,
  onChange,
  signal,
  active = () => true,
}) {
  const live = () => !signal?.aborted && active();
  let groups = seed;
  const publish = () => {
    if (live()) onChange(groups);
  };
  let devices;
  try {
    ({ devices } = await read('/relay/devices'));
  } catch (error) {
    if (!live()) return;
    groups = groups.map((group) => ({ ...group, verified: false, loading: false }));
    publish();
    throw error;
  }
  if (!live()) return;
  groups = devices.map((device) => {
    const previous = seed.find((group) => group.device.id === device.id);
    return {
      device,
      projects: previous?.projects || [],
      verified: previous?.verified === true,
      loading: true,
    };
  });
  publish();
  await Promise.all(
    devices.map(async (device) => {
      try {
        const { projects } = await read('/relay/projects?deviceId=' + device.id);
        if (!live()) return;
        groups = groups.map((group) =>
          group.device.id === device.id
            ? { device, projects, verified: true, loading: false }
            : group,
        );
      } catch (error) {
        if (!live()) return;
        groups = groups.map((group) =>
          group.device.id === device.id
            ? { ...group, verified: false, loading: false, error: error.message }
            : group,
        );
      }
      publish();
    }),
  );
}

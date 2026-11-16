/** @typedef {import('../web/src/assistant-computers').ComputerGroup} ComputerGroup */

/**
 * The existing resource cache is scoped by server and login. Cached projects are
 * labels for restoring the view, never evidence that a grant is still valid.
 * @param {(path: string) => any} peek
 * @returns {ComputerGroup[]}
 */
export function readComputerCatalogueCache(peek) {
  return (peek('/relay/devices')?.devices || []).map((device) => ({
    device,
    projects: peek('/relay/projects?deviceId=' + device.id)?.projects || [],
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

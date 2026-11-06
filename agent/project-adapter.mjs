import projectTools from './assets/project-tools.mjs';
import { loadConfig } from './config.mjs';
import { checkGrant } from './workspace.mjs';
import { createProjectFiles } from './assets/project-files.mjs';
import { dirname, join } from 'node:path';
export async function currentGrant() {
  const config = await loadConfig(process.env.ASTRAL_DEVICE_CONFIG);
  const grant = await checkGrant(
    config.projects.find((p) => p.id === process.env.ASTRAL_DEVICE_PROJECT),
  );
  if (
    grant.root !== process.env.ASTRAL_DEVICE_ROOT ||
    String(grant.ino) !== process.env.ASTRAL_DEVICE_INO ||
    String(grant.dev) !== process.env.ASTRAL_DEVICE_DEV
  )
    throw Error('本机授权目录已变化，请新建任务。');
  if (process.env.ASTRAL_PROJECT_ACCESS === 'edit' && !grant.allowWrite)
    throw Error('本机已撤销文件修改权限。');
  return grant;
}
export async function grantFiles() {
  const grant = await currentGrant();
  const privateDir = dirname(process.env.ASTRAL_DEVICE_CONFIG);
  const files = createProjectFiles({
    projects: [
      {
        id: 'device',
        name: grant.name,
        root: grant.root,
        canonicalRoot: grant.root,
        readOnly: process.env.ASTRAL_PROJECT_ACCESS !== 'edit' || !grant.allowWrite,
      },
    ],
    backupDir: process.env.ASTRAL_PROJECT_BACKUPS || join(privateDir, 'backups'),
    protectedPaths: [
      process.env.ASTRAL_DEVICE_CONFIG,
      join(privateDir, 'sessions'),
      join(privateDir, 'plugins'),
      join(privateDir, 'online-packages'),
      join(privateDir, 'online-package-locks'),
      ...JSON.parse(process.env.ASTRAL_PROJECT_PRIVATE_PATHS || '[]'),
    ],
  });
  return { grant, files };
}
export default async function (pi) {
  await projectTools({
    on: (...args) => pi.on(...args),
    registerTool: (spec) =>
      pi.registerTool({
        ...spec,
        execute: async (...args) => {
          await currentGrant();
          return spec.execute(...args);
        },
      }),
  });
}

// Only exact, registry-published npm packages are accepted. No shell, git URL,
// local path, tag or semver range can reach the native installer.
export const npmPackageName = /^(?:@[a-z0-9][a-z0-9._-]{0,100}\/)?[a-z0-9][a-z0-9._-]{0,100}$/;
export const exactPackageVersion = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
export function parseOnlinePackage(value) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((k) => !['name', 'version', 'integrity'].includes(k)) ||
    !npmPackageName.test(value.name || '') ||
    !exactPackageVersion.test(value.version || '') ||
    !/^sha512-[A-Za-z0-9+/]{86}==$/.test(value.integrity || '')
  )
    throw Error('网上插件需要有效的npm名称、固定版本和SHA-512校验。');
  return { name: value.name, version: value.version, integrity: value.integrity };
}
export const packageSource = (value) => {
  const p = parseOnlinePackage(value);
  return 'npm:' + p.name + '@' + p.version;
};
export const packageAuthority =
  '第三方Pi插件以电脑当前用户权限运行，可访问本机文件和网络，不受项目文件工具范围限制。安装脚本默认关闭；需要本机执行授权，且仅在勾选执行命令的任务中加载。';

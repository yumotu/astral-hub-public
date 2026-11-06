// Reuse the maintained Pi package; restrict this app to public web operations.
export async function registerPublicWebTools(pi, webAccess) {
  const allowed = new Set(['web_search', 'fetch_content', 'get_search_content']);
  const adapter = new Proxy(pi, {
    get(target, key) {
      if (key !== 'registerTool') return Reflect.get(target, key);
      return (tool) => {
        if (!allowed.has(tool.name)) return;
        pi.registerTool({
          ...tool,
          async execute(id, params, signal, onUpdate, ctx) {
            if (params.proxy || params.auth || params.forceClone)
              throw new Error('仅支持公开网页读取。');
            const urls = [params.url, ...(params.urls || [])].filter(Boolean);
            for (const value of urls) {
              let url;
              try {
                url = new URL(value);
              } catch {
                throw new Error('仅支持公开HTTP(S)网址。');
              }
              if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
                throw new Error('不支持本地路径或带凭据的网址。');
            }
            const next =
              tool.name === 'web_search'
                ? { ...params, provider: 'deepseek', workflow: 'none', includeContent: false }
                : params;
            return tool.execute(id, next, signal, onUpdate, ctx);
          },
        });
      };
    },
  });
  await webAccess(adapter);
}
export default async function (pi) {
  const { default: webAccess } =
    await import('/extensions/node_modules/pi-web-access/dist/index.js');
  await registerPublicWebTools(pi, webAccess);
}

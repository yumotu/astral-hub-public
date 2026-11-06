// Synthetic notification, never a real mailbox or workflow URL.
const nest = (content, depth) =>
  depth
    ? `<table role="presentation" width="600"><tr><td>${nest(content, depth - 1)}</td></tr></table>`
    : content;
export const nestedNotificationHtml = nest(
  `<p><a href="https://example.invalid/workflow">[合成项目] Build applications workflow run</a></p>
  <h1>Build applications: Some jobs were not successful</h1>
  ${nest('<a href="https://example.invalid/workflow">View workflow run</a>', 3)}
  <table role="presentation"><tr><td><img src="https://images.invalid/icon.png" alt="任务图标"></td><td><strong>Build applications / web-and-tests</strong><p>Succeeded in 1 minute and 20 seconds</p></td><td><a href="https://example.invalid/annotations">查看任务详情</a></td></tr><tr><td><img src="https://images.invalid/icon.png" alt="任务图标"></td><td><strong>Build applications / android</strong><p>Failed in 5 minutes</p></td><td><a href="https://example.invalid/annotations">查看任务详情</a></td></tr></table>
  <h2>合成数据表</h2><table><caption>阶段结果</caption><thead><tr><th>阶段</th><th>数量</th><th>状态</th></tr></thead><tbody><tr><td>网页</td><td>267</td><td>通过</td></tr><tr><td>手机</td><td>10</td><td>待复核</td></tr></tbody></table>
  <p>此邮件只用于排版检查，链接和图片均不加载。</p>`,
  5,
);

import { Type } from 'typebox';
import { Check } from 'typebox/value';
import projectTools, { currentGrant } from './project-adapter.mjs';
import fileTools from './file-tools.mjs';
import extraTools from './extra-tools.mjs';
import executeTools from './execute-tools.mjs';
import packageRead from './package-read.mjs';
import appTools from './assets/app-tools.mjs';
import inputTools from './input-tools.mjs';
import askUser from './assets/ask-user.mjs';
import { createComputerPluginStore } from './plugin-store.mjs';
import { pluginArguments, pluginPermissions } from './assets/computer-plugin.mjs';
export default async function (pi) {
  const tools = new Map();
  const adapter = {
    appendEntry: (...args) => pi.appendEntry(...args),
    on: (...args) => pi.on(...args),
    registerTool: (spec) => {
      tools.set(spec.name, spec);
      pi.registerTool(spec);
    },
  };
  await projectTools(adapter);
  fileTools(adapter);
  extraTools(adapter);
  executeTools(adapter);
  packageRead(adapter);
  appTools(adapter);
  inputTools(adapter);
  askUser(adapter);
  const grant = await currentGrant(),
    store = createComputerPluginStore(process.env.ASTRAL_DEVICE_CONFIG);
  for (const item of await store.list(grant.id)) {
    const plugin = item.manifest,
      permission = pluginPermissions(plugin);
    if (
      !item.enabled ||
      (permission.write && process.env.ASTRAL_PROJECT_ACCESS !== 'edit') ||
      (permission.execute && process.env.ASTRAL_DEVICE_EXECUTE !== '1')
    )
      continue;
    pi.registerTool({
      name: 'custom_' + plugin.id,
      label: plugin.name,
      description:
        plugin.description +
        '。这是用户注册的电脑插件，共' +
        plugin.steps.length +
        '步，输入：' +
        plugin.inputLabel +
        '。',
      parameters: Type.Object(
        { input: Type.String({ maxLength: 8000 }) },
        { additionalProperties: false },
      ),
      async execute(id, args, signal, onUpdate) {
        const results = [],
          summaries = [];
        for (let i = 0; i < plugin.steps.length; i++) {
          if (signal?.aborted) throw Error('插件已取消；已完成的步骤不会自动重放。');
          const fresh = await currentGrant();
          const active = (await store.list(fresh.id)).find((p) => p.manifest.id === plugin.id);
          if (!active?.enabled || active.sha256 !== item.sha256)
            throw Error('电脑插件已停用、删除或修改，请新建任务。');
          if (
            (permission.write && !fresh.allowWrite) ||
            (permission.execute && !fresh.allowExecute)
          )
            throw Error('本机已撤销插件所需权限。');
          const step = plugin.steps[i],
            tool = tools.get(step.tool);
          const parameters = pluginArguments(step.arguments, args.input, results);
          if (!tool || !Check(tool.parameters, parameters))
            throw Error(`插件第${i + 1}步参数不正确或当前任务未授权此工具。`);
          onUpdate?.({
            content: [
              {
                type: 'text',
                text:
                  '正在运行' +
                  plugin.name +
                  '：' +
                  (i + 1) +
                  '/' +
                  plugin.steps.length +
                  ' · ' +
                  step.tool,
              },
            ],
          });
          const result = await tool.execute(id + ':step:' + i, parameters, signal, onUpdate);
          const text =
            result.content
              ?.filter((c) => c.type === 'text')
              .map((c) => c.text)
              .join('\n') || '';
          let value;
          try {
            value = JSON.parse(text);
          } catch {
            value = { text };
          }
          results.push(value);
          summaries.push({ step: i, tool: step.tool, result: value });
          if (
            result.isError ||
            (Number.isInteger(result.details?.exitCode) && result.details.exitCode !== 0)
          )
            throw Error(`插件第${i + 1}步失败，已停止后续步骤；已执行的步骤不会自动重复。`);
        }
        const output = JSON.stringify({ plugin: plugin.name, steps: summaries });
        return {
          content: [
            {
              type: 'text',
              text:
                output.length > 48000
                  ? output.slice(0, 48000) + '\n[结果已截断，文件交付仍保留在聊天中]'
                  : output,
            },
          ],
          details: { summary: plugin.name + '：' + results.length + '步完成' },
        };
      },
    });
  }
}

export function skillRequest(input) {
  const match = /^\/skills\s+(?:安装|install|import)(?:\s+([\s\S]+))?$/iu.exec(input.trim());
  if (!match) {
    const management = /^\/skills(?:\s+([\s\S]+))?$/iu.exec(input.trim());
    if (!management) return input;
    return `用户希望在聊天中管理星屿技能：${JSON.stringify(management[1]?.trim() || '列出当前技能及启停状态')}。请实际调用 skill_list、skill_create、skill_install 或 skill_manage 完成明确要求。修改、启停、移除或恢复前，先用 skill_manage inspect 读取当前内容和 revision。仅列出技能时不要修改；要求不明确时先列出并询问具体操作。/skills 不是 Shell 命令，不打开管理面板，不运行安装脚本。缺少管理工具时说明管理员权限要求。`;
  }
  const path = match[1]?.trim() || 'skills';
  return `用户要求将当前项目中的技能目录 ${JSON.stringify(path)} 安装到星屿的持久技能库。请实际调用 skill_install，path 为 ${JSON.stringify(path)}，随后 skill_list 并用 read 读取新技能路径验证。/skills 是星屿应用命令，不是 Bash 命令。不要写 install-skills.sh，不要安装到临时 HOME 或 Claude/Codex 目录，不要用 dry-run 代替安装。若缺少 skill_install 工具，明确说明是否未选择项目或不是管理员，不要声称安装成功。`;
}

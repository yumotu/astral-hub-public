import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { createDomesticInvestmentService, createToolDefinitions } from "./tool-definitions.mjs";

export const name = "astral-domestic-investment";
export const inject = ["skills", "tools"];
const skillPath = fileURLToPath(new URL("./SKILL.md", import.meta.url));
const skillContent = readFileSync(skillPath, "utf8").replace(/^---[\s\S]*?---\s*/, "");

export async function apply(ctx, config = {}) {
  const service = await createDomesticInvestmentService(config);
  ctx.skills.register({ name: "domestic-investment", description: "Read-only domestic and international investment research with dated evidence and explicit missing fields.", whenToUse: "Use for fund screening, market regimes, bond risk, long-term stocks, international comparisons, and portfolio research actions.", source: "bundled", rank: 600, content: skillContent });
  const output = { schema: { type: "json" }, render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }] };
  for (const definition of createToolDefinitions(service)) ctx.tools.register(defineTool({ ...definition, output }));
}

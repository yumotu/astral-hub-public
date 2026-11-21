import { z } from 'zod';
import { createDomesticInvestmentService } from './domestic-investment-bundle/tool-definitions.mjs';

const riskProfile = z.enum(['conservative', 'balanced', 'growth']);
const fail = (status, message) => Object.assign(new Error(message), { status });

/**
 * The independent research window uses the same maintained service as the
 * DSH tools. It exposes public market research to signed-in users and keeps
 * personal portfolio input optional and server-configured.
 */
export async function createDomesticInvestment(options = {}) {
  const service =
    options.service ||
    (await createDomesticInvestmentService({
      workspaceRoot: options.workspaceRoot || '/var/astral-investment',
      ...(options.dataFile ? { dataFile: options.dataFile } : {}),
      ...(options.bondEvidenceFile ? { bondEvidenceFile: options.bondEvidenceFile } : {}),
    }));

  async function handle(req, url, json, actor) {
    if (!url.pathname.startsWith('/api/investment/')) return false;
    if (!actor?.id) throw fail(401, '请先登录账号查看投资研究。');
    if (req.method !== 'GET') throw fail(405, '投资研究窗口只提供读取操作。');
    if (url.pathname === '/api/investment/dashboard') {
      const profile = riskProfile.parse(url.searchParams.get('risk_profile') || 'balanced');
      json(200, await service.dashboard({ risk_profile: profile }));
      return true;
    }
    if (url.pathname === '/api/investment/methodology') {
      json(200, service.methodology());
      return true;
    }
    throw fail(404, '投资研究接口不存在。');
  }

  return { service, handle };
}

// Return only fixed, user-facing messages; provider error text can contain sensitive data.
export function providerError(message) {
  if (typeof message !== 'string') return null;
  if (/insufficient[_\s-]*balance|insufficient[_\s-]*quota|\b402\b/i.test(message))
    return { status: 402, message: 'DeepSeek API 余额不足或额度已用完，请检查账户余额并充值后重试。' };
  return null;
}

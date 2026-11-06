export const mailAssistantDefaults = {
  enabled: false,
  dailyEnabled: false,
  dailyTime: '09:00',
  timezone: 'Asia/Shanghai',
  mailbox: 'INBOX',
  limit: 8,
  newMailEnabled: false,
  pollMinutes: 30,
};

// Responses also contain scheduler observations. Only editable fields belong in a save request.
export function mailAssistantInput(value = {}) {
  return {
    enabled: value.enabled ?? mailAssistantDefaults.enabled,
    dailyEnabled: value.dailyEnabled ?? mailAssistantDefaults.dailyEnabled,
    dailyTime: value.dailyTime ?? mailAssistantDefaults.dailyTime,
    timezone: value.timezone ?? mailAssistantDefaults.timezone,
    mailbox: value.mailbox ?? mailAssistantDefaults.mailbox,
    limit: value.limit ?? mailAssistantDefaults.limit,
    newMailEnabled: value.newMailEnabled ?? mailAssistantDefaults.newMailEnabled,
    pollMinutes: value.pollMinutes ?? mailAssistantDefaults.pollMinutes,
  };
}

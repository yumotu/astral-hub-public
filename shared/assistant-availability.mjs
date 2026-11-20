/** @param {{capabilities?: string[], working?: boolean, uploading?: boolean, fileCount?: number}} [options] */
export function computerInputAvailability({
  capabilities = [],
  working = false,
  uploading = false,
  fileCount = 0,
} = {}) {
  return {
    thinking: !capabilities.includes('thinking_levels')
      ? '这台电脑的执行器尚未提供思考强度控制。请在目标电脑更新客户端或执行器后重新连接。'
      : working
        ? '当前任务或队列执行中，结束后可调整下一任务的思考强度。'
        : '',
    attachment: !capabilities.includes('chat_inputs')
      ? '这台电脑的执行器尚未提供聊天附件读取。请在目标电脑更新客户端或执行器后重新连接。'
      : uploading
        ? '正在上传附件，请等待完成或取消当前上传。'
        : fileCount >= 8
          ? '每条消息最多附加 8 个文件，请先移除附件或发送当前消息。'
          : '',
  };
}

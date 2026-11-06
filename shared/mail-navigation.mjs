/** The same hierarchy is used by mail's visible back button, Escape and native Back. */
export function mailBackTarget({
  folderEditor,
  summaryOpen,
  selected,
  selectedCount,
  query,
  unread,
  mailbox,
  since,
  before,
}) {
  if (folderEditor) return 'folder-editor';
  if (summaryOpen) return 'summary';
  if (selected) return 'message';
  if (selectedCount) return 'selection';
  if (query?.trim() || unread || since || before) return 'filters';
  if (mailbox && mailbox !== 'INBOX') return 'inbox';
  return null;
}

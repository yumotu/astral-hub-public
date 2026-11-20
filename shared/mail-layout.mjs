/** Old cached fragments have no presentation roles, so structure is the fallback. */
export function mailTableKind({
  role = '',
  heading = false,
  nested = false,
  containsTable = false,
  rowWidths = [],
}) {
  if (role === 'presentation' || role === 'none') return 'layout';
  if (heading) return 'data';
  if (nested || containsTable) return 'layout';
  return rowWidths.length >= 2 && rowWidths[0] >= 2 && rowWidths.every((n) => n === rowWidths[0])
    ? 'data'
    : 'layout';
}

/** Operates only inside the inert mail iframe, including already-cached HTML. */
export function normalizeMailTables(doc) {
  // Classify before wrapping so a nested data table cannot change its ancestors' kind.
  const tables = [...doc.querySelectorAll('table')].map((table) => ({
    table,
    kind: mailTableKind({
      role: table.getAttribute('role') || '',
      heading: [...table.querySelectorAll('th,caption')].some((n) => n.closest('table') === table),
      nested: !!table.parentElement?.closest('table'),
      containsTable: !!table.querySelector('table'),
      rowWidths: [...table.rows].map((row) =>
        [...row.cells].reduce((n, cell) => n + cell.colSpan, 0),
      ),
    }),
  }));
  for (const { table, kind } of tables) {
    table.dataset.mailTable = kind;
    for (const node of table.querySelectorAll('thead,tbody,tfoot,tr,td,th')) {
      if (node.closest('table') !== table) continue;
      if (kind === 'layout') node.setAttribute('data-mail-layout', '');
      else if (node.matches('td,th')) node.setAttribute('data-mail-cell', '');
    }
    if (kind === 'layout') {
      table.setAttribute('data-mail-layout', '');
      table.setAttribute('role', 'presentation');
    } else if (!table.parentElement?.classList.contains('mail-data-table')) {
      const wrapper = doc.createElement('div');
      wrapper.className = 'mail-data-table';
      wrapper.tabIndex = 0;
      wrapper.setAttribute('role', 'region');
      wrapper.setAttribute('aria-label', table.caption?.textContent || '邮件数据表格，可横向滚动');
      table.before(wrapper);
      wrapper.append(table);
    }
  }
}

export function selectionAnchor(rect, viewport) {
  if (viewport.mobile) {
    const margin = 12, height = 44, width = Math.min(184, viewport.width - margin * 2);
    const top = viewport.top || 0, left = viewport.left || 0;
    // Native Android/iOS selection menus normally sit above the text; handles
    // extend below it. Leave both areas free instead of competing on z-index.
    const below = rect.bottom + 44;
    const above = rect.top - height - 88;
    if (below + height > top + viewport.height - margin && above < top + margin) return null;
    return {mobile:true, left:Math.max(left+margin,Math.min(rect.left,left+viewport.width-width-margin)),
      top:below+height<=top+viewport.height-margin?below:above,maxWidth:width};
  }
  const margin = 8,
    width = Math.min(210, viewport.width - margin * 2),
    height = 44;
  const top = viewport.top || 0,
    left = viewport.left || 0;
  const above = rect.top - height - 12;
  return {
    left: Math.max(left + margin, Math.min(rect.left, left + viewport.width - width - margin)),
    top: Math.max(
      top + margin,
      Math.min(
        above >= top + margin ? above : rect.bottom + 12,
        top + viewport.height - height - margin,
      ),
    ),
    maxWidth: width,
  };
}

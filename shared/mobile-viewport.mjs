/** @param {{layoutHeight:number, visualHeight?:number, visualTop?:number, scale?:number, baselineHeight?:number, focused?:boolean, nativeKeyboard?:boolean|null}} options */
export function mobileViewport({
  layoutHeight,
  visualHeight,
  visualTop = 0,
  scale = 1,
  baselineHeight = layoutHeight,
  focused = false,
  nativeKeyboard = null,
}) {
  const zoomed = Math.abs(scale - 1) > 0.05;
  const top = zoomed ? 0 : Math.max(0, Math.min(visualTop, layoutHeight - 1));
  const height = Math.max(
    1,
    Math.floor(
      zoomed || !Number.isFinite(visualHeight) || visualHeight <= 0
        ? layoutHeight
        : Math.min(visualHeight, layoutHeight - top),
    ),
  );
  return {
    height,
    top,
    keyboard: nativeKeyboard ?? (!zoomed && focused && baselineHeight - height > 120),
  };
}

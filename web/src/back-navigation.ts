import { useEffect, useRef } from 'react';
import { createBackStack } from '../../shared/back-navigation.mjs';
export const backLayers = createBackStack();
export function useBackLayer(active: boolean, close: () => unknown, priority = 40) {
  const current = useRef(close);
  current.current = close;
  useEffect(() => {
    if (!active) return;
    return backLayers.register(() => current.current(), priority);
  }, [active, priority]);
}

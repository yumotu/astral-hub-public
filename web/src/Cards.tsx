import { createContext, useContext } from 'react';
import { deck } from './data';
export type DeckTheme = 'classic' | 'modern';
export const DeckThemeContext = createContext<DeckTheme>('classic');
export function CardVisual({
  id,
  className = '',
  lazy = false,
}: {
  id: string;
  className?: string;
  lazy?: boolean;
}) {
  const theme = useContext(DeckThemeContext);
  const info = deck.find((c) => c.id === id)!;
  if (theme === 'modern')
    return (
      <img
        className={`illustrated-card ${className}`}
        src={`./cards/${id}.svg`}
        alt={`${info.name} · 星屿原创牌面`}
        loading={lazy ? 'lazy' : undefined}
        draggable={false}
      />
    );
  return (
    <div className={`classic-card illustrated-card ${className}`}>
      <div className="classic-scene">
        <img
          src={`./cards/classic/${id}.jpg`}
          alt={`${info.name} · 经典韦特牌面`}
          loading={lazy ? 'lazy' : undefined}
          draggable={false}
        />
      </div>
      <div className="classic-caption">
        <strong>{info.name}</strong>
        <span>RIDER · WAITE · SMITH</span>
      </div>
    </div>
  );
}

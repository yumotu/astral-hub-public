import { useState, useEffect, useRef } from 'react';
import { Search, X, Download, ArrowRight, ArrowUpRight } from 'lucide-react';
import { deck } from './data';
import { CardVisual } from './Cards';
import type { DeckTheme } from './Cards';
import classicSources from '../public/cards/classic/sources.json';
export function Gallery({
  theme,
  onThemeChange,
}: {
  theme: DeckTheme;
  onThemeChange: (theme: DeckTheme) => void;
}) {
  const [suit, setSuit] = useState('major');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<(typeof deck)[number] | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const tabs = [
    ['major', '大阿卡纳', '22'],
    ['wands', '权杖', '14'],
    ['cups', '圣杯', '14'],
    ['swords', '宝剑', '14'],
    ['pentacles', '星币', '14'],
  ];
  useEffect(() => {
    if (!selected) return;
    closeRef.current?.focus();
    const escape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSelected(null);
    };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [selected]);
  const cards = deck.filter((c) =>
    query ? `${c.name} ${c.en}`.toLowerCase().includes(query.toLowerCase()) : c.suit === suit,
  );
  return (
    <>
      <div className="page-heading compact">
        <div className="eyebrow">
          {theme === 'classic'
            ? 'RIDER · WAITE · SMITH · CLASSIC TAROT'
            : 'THE INNER CONSTELLATION · ORIGINAL TAROT'}
        </div>
        <h1>
          一副牌，<em>七十八种看见。</em>
        </h1>
        <p>
          {theme === 'classic'
            ? '人物、旅途与古老象征。用经典韦特的七十八幅场景，重新看见此刻。'
            : '星屿 · 内在星图。以星轨、自然与古老符号，描绘属于此刻的内心风景。'}
        </p>
      </div>
      <div className="deck-theme-picker" role="group" aria-label="选择卡面风格">
        <button
          aria-pressed={theme === 'classic'}
          className={theme === 'classic' ? 'selected' : ''}
          onClick={() => onThemeChange('classic')}
        >
          经典韦特<span>人物 · 场景 · 传统象征</span>
        </button>
        <button
          aria-pressed={theme === 'modern'}
          className={theme === 'modern' ? 'selected' : ''}
          onClick={() => onThemeChange('modern')}
        >
          星屿原创<span>深绿 · 旧金 · 符号构图</span>
        </button>
      </div>
      <section className="deck-intro">
        <div>
          <span className="tag">
            {theme === 'classic' ? '经典韦特 · 78 张完整牌组' : '原创 SVG 牌组'}
          </span>
          <h2>
            让每一张牌，
            <br />
            都有自己的故事。
          </h2>
          <p>
            {theme === 'classic'
              ? '保留 Pamela Colman Smith 的人物与故事，搭配米白纸张、旧金边框与中文牌名。经典图像在应用内完整保存，抽牌时无需联网加载。'
              : '深绿与旧金，纸张与星光。22 张独立象征构图，四组花色以不同色调与牌阶展开。'}
          </p>
          <small>78 CARDS · ONE INNER UNIVERSE</small>
        </div>
        <div className="deck-showcase">
          <CardVisual id="major-18" />
          <CardVisual id="major-17" />
          <img src="./cards/back.svg" alt="星屿统一牌背" />
        </div>
      </section>
      <div className="gallery-toolbar">
        <div className="gallery-tabs" role="group" aria-label="选择牌组">
          {tabs.map(([id, label, count]) => (
            <button
              aria-pressed={suit === id}
              className={suit === id ? 'selected' : ''}
              key={id}
              onClick={() => {
                setSuit(id);
                setQuery('');
              }}
            >
              {label}
              <span>{count}</span>
            </button>
          ))}
        </div>
        <div className="search-box">
          <Search size={16} />
          <input
            aria-label="搜索牌面"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索牌名…"
          />
        </div>
      </div>
      <div className="card-gallery">
        {cards.map((c) => (
          <button
            className="gallery-card"
            key={c.id}
            onClick={() => setSelected(c)}
            aria-label={`查看${c.name}牌面`}
          >
            <CardVisual id={c.id} lazy />
            <span>
              {c.name}
              <ArrowRight size={12} />
            </span>
          </button>
        ))}
      </div>
      {!cards.length && <div className="empty-state">没有找到这张牌，试试中文或英文牌名。</div>}
      <p className="gallery-caption">
        {theme === 'classic' ? (
          <>
            经典韦特图像：Pamela Colman Smith / A. E. Waite · Wikimedia Commons，逐张核对 Public
            domain 标记。图像随应用打包。
            <a
              href="https://commons.wikimedia.org/wiki/File:RWS_Tarot_00_Fool.jpg"
              target="_blank"
              rel="noreferrer"
            >
              查看来源与作者说明 <ArrowUpRight size={13} aria-hidden="true" />
            </a>
          </>
        ) : (
          '每张牌均为项目内生成的可缩放矢量文件，手机、桌面与网页共用；无需联网加载第三方图片。'
        )}
      </p>
      {selected && (
        <div className="card-modal-backdrop" onClick={() => setSelected(null)}>
          <div
            className="card-modal"
            role="dialog"
            aria-modal="true"
            aria-label={`${selected.name}牌面详情`}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              ref={closeRef}
              className="icon-btn modal-close"
              aria-label="关闭牌面详情"
              onClick={() => setSelected(null)}
            >
              <X size={20} />
            </button>
            <div className="modal-card-image">
              <CardVisual id={selected.id} />
            </div>
            <div className="modal-card-copy">
              <div className="eyebrow">
                {theme === 'classic' ? 'RIDER · WAITE · SMITH' : 'ASTRAL · INNER CONSTELLATION'}
              </div>
              <h2>{selected.name}</h2>
              <p className="modal-card-english">{selected.en}</p>
              <h3>正位的提醒</h3>
              <p>{selected.upright}</p>
              <h3>逆位的视角</h3>
              <p>{selected.reversed}</p>
              <a
                className="secondary"
                href={
                  theme === 'classic'
                    ? `./cards/classic/${selected.id}.jpg`
                    : `./cards/${selected.id}.svg`
                }
                download={`${selected.name}.${theme === 'classic' ? 'jpg' : 'svg'}`}
              >
                <Download size={16} />
                下载{theme === 'classic' ? '经典' : 'SVG'}牌面
              </a>
              {theme === 'classic' && (
                <p className="card-source-note">
                  Pamela Colman Smith · A. E. Waite
                  <br />
                  <a
                    href={classicSources.cards.find((c) => c.id === selected.id)?.sourcePage}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Wikimedia Commons 来源及 Public domain 标记 <ArrowUpRight size={13} aria-hidden="true" />
                  </a>
                </p>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { deck } from '../shared/deck.mjs';

// 星屿原创矢量牌面。仅借鉴塔罗的通用符号语汇，不使用网上的牌图或字体文件。
const out = resolve('web/public/cards');
const roman = [
  '0',
  'I',
  'II',
  'III',
  'IV',
  'V',
  'VI',
  'VII',
  'VIII',
  'IX',
  'X',
  'XI',
  'XII',
  'XIII',
  'XIV',
  'XV',
  'XVI',
  'XVII',
  'XVIII',
  'XIX',
  'XX',
  'XXI',
];
const palettes = {
  major: ['#183f3a', '#cfb277', '#8b9e83'],
  wands: ['#464b31', '#dcc18c', '#9b9f68'],
  cups: ['#294b57', '#d7bc91', '#83a6a4'],
  swords: ['#38465a', '#d6c6a8', '#97a5b3'],
  pentacles: ['#3c513d', '#d9bd7d', '#a2af7e'],
};
const path = (d, extra = '') => `<path d="${d}" ${extra}/>`;
const circle = (x, y, r, extra = '') => `<circle cx="${x}" cy="${y}" r="${r}" ${extra}/>`;
const group = (content, t = '') => `<g ${t}>${content}</g>`;
const star = (x, y, r = 13) =>
  path(
    `M${x} ${y - r} ${x + r * 0.25} ${y - r * 0.25} ${x + r} ${y} ${x + r * 0.25} ${y + r * 0.25} ${x} ${y + r} ${x - r * 0.25} ${y + r * 0.25} ${x - r} ${y} ${x - r * 0.25} ${y - r * 0.25}Z`,
    'fill="var(--gold)" stroke="none"',
  );
function rays(x, y, r = 44, count = 16) {
  return Array.from({ length: count }, (_, i) =>
    path(`M${x} ${y - r}v-8`, `transform="rotate(${(i * 360) / count} ${x} ${y})"`),
  ).join('');
}
function moon(x, y, r = 28) {
  return path(
    `M${x + r * 0.4} ${y - r}a${r} ${r} 0 1 0 0 ${r * 2}C${x - r * 0.4} ${y + r * 0.4} ${x - r * 0.4} ${y - r * 0.4} ${x + r * 0.4} ${y - r}Z`,
    'fill="var(--gold)" stroke="none"',
  );
}
function plant(x, y, h = 65) {
  return path(
    `M${x} ${y}v-${h}m0 ${h * 0.25}q-24-4-19-22 18 0 19 22m0 16q26-4 22-22-20-2-22 22m0 14q-27-3-23-24 20 0 23 24`,
    'fill="none"',
  );
}
function person(x, y, size = 1, pose = 'robe') {
  return group(
    circle(0, -48, 12, 'fill="var(--muted)"') +
      path(
        pose === 'robe'
          ? 'M-8-34Q-30-6-33 44H33Q23-8 8-34Z'
          : 'M-8-34-20 3-11 11-15 45M8-34 22 2 12 10 17 45M-10-31H10L12 10H-11Z',
        'fill="var(--muted)"',
      ) +
      path('M-9-26-33-4m42-22L34-4', 'fill="none"'),
    `transform="translate(${x} ${y}) scale(${size})"`,
  );
}
function cup(x, y, scale = 1) {
  return group(
    path(
      'M-15-14H15L11 3Q0 15-11 3ZM0 10V23M-10 23H10M-15-9Q-30-11-24 1L-13 6M15-9Q30-11 24 1L13 6',
      'fill="var(--muted)"',
    ),
    `transform="translate(${x} ${y}) scale(${scale})"`,
  );
}
function wand(x, y, scale = 1) {
  return group(
    path('M-3 26 0-26 4 25Z', 'fill="var(--gold)"') +
      path('M1-10Q-17-8-14-22 0-22 1-10M2 6Q19 8 17-7 2-7 2 6', 'fill="var(--muted)"'),
    `transform="translate(${x} ${y}) scale(${scale})"`,
  );
}
function sword(x, y, scale = 1) {
  return group(
    path('M0-32 6-19 3 13H-3L-6-19ZM-13 14H13M0 14V29M-5 29H5', 'fill="var(--muted)"'),
    `transform="translate(${x} ${y}) scale(${scale})"`,
  );
}
function coin(x, y, scale = 1) {
  const p = Array.from({ length: 5 }, (_, i) => {
    const a = ((-90 + i * 144) * Math.PI) / 180;
    return `${Math.cos(a) * 14},${Math.sin(a) * 14}`;
  }).join(' ');
  return group(
    circle(0, 0, 21, 'fill="var(--muted)"') +
      circle(0, 0, 17, 'fill="none"') +
      `<polygon points="${p}" fill="none"/>`,
    `transform="translate(${x} ${y}) scale(${scale})"`,
  );
}
function wings(x, y) {
  return group(
    path('M0 14Q-30-38-77-25-48 11-11 21M0 14Q30-38 77-25 48 11 11 21', 'fill="var(--muted)"'),
    `transform="translate(${x} ${y})"`,
  );
}
function crown(x, y) {
  return group(
    path('M-22 8-27-14-10-3 0-22 10-3 27-14 22 8ZM-22 13H22', 'fill="var(--muted)"'),
    `transform="translate(${x} ${y})"`,
  );
}
function scene(n) {
  switch (n) {
    case 0:
      return (
        circle(195, 132, 34, 'fill="var(--muted)" opacity=".7"') +
        path(
          'M42 323 88 294 122 311 163 292 177 319 141 366H42M166 335 196 313 258 359',
          'fill="var(--muted)"',
        ) +
        person(127, 244, 0.86, 'walk') +
        path(
          'M101 220 170 181M165 183q20-11 19 12-18 16-19-12M162 302l12-11 12 4 7 17-21-1-10-9',
          'fill="none"',
        ) +
        star(74, 145, 10)
      );
    case 1:
      return (
        path(
          'M62 280H238M76 280V337M223 280V337M104 152q20-20 43 0t43 0q-21-20-43 0t-43 0',
          'fill="none"',
        ) +
        person(149, 230, 1.05) +
        wand(210, 189, 0.7) +
        cup(92, 268, 0.5) +
        sword(139, 267, 0.45) +
        coin(181, 266, 0.45) +
        plant(56, 354, 40) +
        plant(244, 354, 40)
      );
    case 2:
      return (
        `<rect x="53" y="145" width="30" height="184" rx="3" fill="var(--muted)"/><rect x="217" y="145" width="30" height="184" rx="3" fill="var(--muted)"/>` +
        path('M45 140H91M209 140H255M83 158Q150 127 217 158V329H83Z', 'fill="none"') +
        person(150, 249, 1.1) +
        moon(150, 131, 16) +
        path('M135 247H165V277H135Z M150 216v18m-8-9h16', 'fill="none"')
      );
    case 3:
      return (
        circle(150, 187, 49, 'fill="none"') +
        person(150, 258, 1.35) +
        crown(150, 162) +
        plant(62, 351, 69) +
        plant(238, 351, 69) +
        plant(93, 365, 41) +
        plant(207, 365, 41) +
        star(150, 119, 12) +
        path('M90 299H210V327H90Z', 'fill="var(--muted)"')
      );
    case 4:
      return (
        path(
          'M91 160H209V305H91ZM78 298H222V326H78ZM58 342l31-17 27 18 29-14 40 21 38-22 30 22',
          'fill="var(--muted)"',
        ) +
        person(150, 244, 1.05) +
        crown(150, 165) +
        circle(96, 173, 12, 'fill="none"') +
        circle(205, 173, 12, 'fill="none"') +
        path('M150 105v34m-10-23h20', 'fill="none"')
      );
    case 5:
      return (
        path('M73 152H93V317H73M207 152H227V317H207', 'fill="var(--muted)"') +
        person(150, 248, 1.25) +
        crown(150, 161) +
        path('M150 108v35m-15-26h30m-12 12h24M102 313l74 39m-3-40-72 39', 'fill="none"') +
        circle(101, 312, 7, 'fill="none"') +
        circle(176, 312, 7, 'fill="none"')
      );
    case 6:
      return (
        wings(150, 151) +
        circle(150, 144, 14, 'fill="var(--muted)"') +
        person(101, 273, 0.8) +
        person(200, 273, 0.8) +
        path('M122 239q28-35 56 0M77 335h146', 'fill="none"') +
        plant(59, 304, 83) +
        plant(242, 304, 83) +
        path('M150 211q-29-17-22-32 16-14 22 4 6-18 22-4 7 15-22 32Z', 'fill="var(--muted)"')
      );
    case 7:
      return (
        path(
          'M69 149H231L219 171H81ZM81 171V295H219V171M80 282H220V319H80Z',
          'fill="var(--muted)"',
        ) +
        person(150, 231, 0.9) +
        crown(150, 173) +
        circle(93, 326, 21, 'fill="none"') +
        circle(207, 326, 21, 'fill="none"') +
        star(150, 142, 11) +
        path('M135 345h30', 'fill="none"')
      );
    case 8:
      return (
        person(124, 226, 1.05) +
        path(
          'M130 277q55-36 93 0l-3 34h-67l-21-34ZM157 311v26m51-26v26m9-57q37 7 28-20',
          'fill="var(--muted)"',
        ) +
        circle(170, 270, 23, 'fill="none"') +
        path('M108 243q33-16 57 15M94 139q15-16 30 0t30 0q-15-16-30 0t-30 0', 'fill="none"')
      );
    case 9:
      return (
        path('M43 353 100 284 137 316 196 257 258 353', 'fill="var(--muted)" opacity=".8"') +
        person(146, 249, 1.17) +
        path('M181 221v118M113 214 85 197M78 178h27v36H78ZM85 177v-9h13v9', 'fill="none"') +
        star(91, 196, 7) +
        star(211, 149, 7)
      );
    case 10:
      return (
        circle(150, 239, 83, 'fill="none"') +
        circle(150, 239, 65, 'fill="var(--muted)" opacity=".5"') +
        circle(150, 239, 41, 'fill="none"') +
        Array.from({ length: 8 }, (_, i) =>
          path('M150 200v-39', `transform="rotate(${i * 45} 150 239)"`),
        ).join('') +
        star(150, 239, 23) +
        star(61, 143, 10) +
        star(239, 143, 10) +
        path('M91 345q-39-29-36-76M212 345q39-29 36-76', 'fill="none"')
      );
    case 11:
      return (
        person(150, 254, 1.2) +
        crown(150, 166) +
        sword(85, 216, 1.1) +
        path(
          'M214 173v88m-27-47h54M188 214l-13 29h26ZM241 214l-13 29h26ZM75 332H225',
          'fill="none"',
        )
      );
    case 12:
      return (
        path('M63 148H237M99 148v-19m103 19v-19M150 148v26', 'fill="none"') +
        group(person(150, 254, 1.1, 'walk'), 'transform="rotate(180 150 242)"') +
        circle(150, 283, 26, 'fill="none"') +
        path('M110 232l63-27', 'fill="none"') +
        plant(55, 344, 55) +
        plant(248, 344, 55)
      );
    case 13:
      return (
        path(
          'M63 350V241a87 87 0 0 1 174 0v109M90 350V248a60 60 0 0 1 120 0v102M115 350l36-50 34 50',
          'fill="none"',
        ) +
        circle(150, 228, 30, 'fill="var(--muted)"') +
        Array.from({ length: 7 }, (_, i) =>
          path(
            'M150 228q-36-18 0-42 36 24 0 42',
            `fill="none" transform="rotate(${(i * 360) / 7} 150 228)"`,
          ),
        ).join('') +
        path('M150 257v59', 'fill="none"') +
        star(150, 129, 16)
      );
    case 14:
      return (
        wings(150, 213) +
        person(150, 261, 1.15) +
        circle(150, 168, 25, 'fill="none"') +
        cup(100, 233, 0.72) +
        cup(204, 261, 0.72) +
        path('M115 230q48-2 76 24M53 345q43-18 94 0t100 0', 'fill="none"') +
        path('M150 232l-12 21h24Z', 'fill="var(--gold)"')
      );
    case 15:
      return (
        path(
          'M119 177 105 137 137 158M181 177l14-40-32 21M119 198q31-32 62 0l-6 35h-49Z',
          'fill="var(--muted)"',
        ) +
        circle(150, 201, 11, 'fill="none"') +
        path(
          'M150 235v54m0-33-44 28m44-28 44 28M110 302q-37 35-46-4m126 4q37 35 46-4',
          'fill="none"',
        ) +
        person(91, 318, 0.53) +
        person(209, 318, 0.53) +
        star(150, 120, 12)
      );
    case 16:
      return (
        path(
          'M100 199H196L213 350H86ZM111 183l-10-22 26 3 20-19 20 19 26-3-9 22ZM137 224h22v38h-22ZM120 298h22v39h-22',
          'fill="var(--muted)"',
        ) +
        path('M211 103 160 163h25l-45 60 16-47h-23Z', 'fill="var(--gold)"') +
        path('M70 239l-11 8m181 21 11 8M65 294l11 8m155 24 13-6', 'fill="none"')
      );
    case 17:
      return (
        star(150, 155, 35) +
        [
          [-64, 2],
          [62, 0],
          [-46, -37],
          [46, -37],
          [-50, 43],
          [50, 43],
          [-1, -66],
        ]
          .map(([x, y]) => star(150 + x, 155 + y, 7))
          .join('') +
        person(157, 292, 0.8) +
        cup(106, 297, 0.65) +
        path('M92 298q-18 26-31 33M194 293q12 26 35 27M48 346q42-20 83 0t83 0t42 0', 'fill="none"')
      );
    case 18:
      return (
        moon(150, 168, 42) +
        circle(150, 168, 54, 'fill="none"') +
        path(
          'M55 247H86V330H55ZM214 247H245V330H214ZM53 247v-12m17 12v-12m17 12v-12M212 247v-12m17 12v-12m17 12v-12M134 338q-7-37 16-55t6-44',
          'fill="none"',
        ) +
        path(
          'M102 313l-4-25 18 8 8 17ZM181 313l-4-25 18 8 8 17ZM45 350q50-11 106 0t104 0',
          'fill="var(--muted)"',
        )
      );
    case 19:
      return (
        circle(150, 177, 40, 'fill="var(--muted)"') +
        circle(150, 177, 30, 'fill="none"') +
        rays(150, 177, 49, 16) +
        person(150, 300, 0.67, 'walk') +
        plant(70, 350, 71) +
        plant(230, 350, 71) +
        path('M45 326H255M126 345h48', 'fill="none"')
      );
    case 20:
      return (
        wings(150, 179) +
        circle(150, 163, 15, 'fill="var(--muted)"') +
        path('M140 192l-25 26 16 16 29-26ZM115 218l-25 8 30 25 11-17', 'fill="var(--muted)"') +
        person(88, 313, 0.6) +
        person(150, 309, 0.7) +
        person(213, 313, 0.6) +
        path('M57 353q93-20 186 0M105 264l-15-14m60 7v-23m45 29 17-15', 'fill="none"')
      );
    case 21:
      return (
        `<ellipse cx="150" cy="242" rx="76" ry="103" fill="none"/><ellipse cx="150" cy="242" rx="67" ry="94" fill="none"/>` +
        Array.from({ length: 18 }, (_, i) =>
          path(
            'M150 145q-14-12-7-20 17-1 17 15',
            `fill="var(--muted)" transform="rotate(${i * 20} 150 242)"`,
          ),
        ).join('') +
        person(150, 245, 1.04, 'walk') +
        path('M133 221q42-11 31 43-11 32-39 16', 'fill="none"') +
        star(63, 140, 13) +
        star(236, 140, 13) +
        star(63, 344, 13) +
        star(236, 344, 13)
      );
    default:
      return '';
  }
}
const positions = {
  1: [[150, 230]],
  2: [
    [106, 210],
    [194, 268],
  ],
  3: [
    [150, 164],
    [95, 280],
    [205, 280],
  ],
  4: [
    [100, 174],
    [200, 174],
    [100, 292],
    [200, 292],
  ],
  5: [
    [100, 165],
    [200, 165],
    [150, 231],
    [100, 298],
    [200, 298],
  ],
  6: [
    [100, 164],
    [200, 164],
    [100, 234],
    [200, 234],
    [100, 304],
    [200, 304],
  ],
  7: [
    [100, 159],
    [200, 159],
    [150, 210],
    [100, 252],
    [200, 252],
    [100, 315],
    [200, 315],
  ],
  8: [
    [100, 152],
    [200, 152],
    [100, 210],
    [200, 210],
    [100, 268],
    [200, 268],
    [100, 326],
    [200, 326],
  ],
  9: [
    [84, 157],
    [150, 157],
    [216, 157],
    [84, 235],
    [150, 235],
    [216, 235],
    [84, 313],
    [150, 313],
    [216, 313],
  ],
  10: [
    [100, 140],
    [200, 140],
    [100, 189],
    [200, 189],
    [100, 238],
    [200, 238],
    [100, 287],
    [200, 287],
    [100, 336],
    [200, 336],
  ],
};
function minor(c) {
  const symbol = { wands: wand, cups: cup, swords: sword, pentacles: coin }[c.suit];
  const backdrop = {
    wands: path('M51 355q45-30 99 0t99 0M55 346V211m190 135V211', 'fill="none" opacity=".35"'),
    cups: path(
      'M46 343q25-13 52 0t52 0t52 0t52 0M46 356q25-13 52 0t52 0t52 0t52 0',
      'fill="none" opacity=".6"',
    ),
    swords: path('M45 350 95 298 133 334 185 295 255 350', 'fill="none" opacity=".35"'),
    pentacles: plant(55, 350, 63) + plant(245, 350, 63),
  }[c.suit];
  if (c.number <= 10)
    return (
      backdrop +
      positions[c.number]
        .map(([x, y]) => symbol(x, y, c.number === 1 ? 2.15 : c.number >= 8 ? 0.66 : 0.86))
        .join('') +
      (c.number === 1 ? circle(150, 230, 78, 'fill="none" opacity=".5"') : '')
    );
  let figure = person(150, 260, c.number === 11 ? 1.04 : 1.25, c.number === 12 ? 'walk' : 'robe');
  if (c.number === 12)
    figure += path(
      'M71 309q-23-49 25-52l29 28 57-4 34-46 27 18-7 62h-25l-8 29m-105-36-15 36',
      'fill="var(--muted)"',
    );
  if (c.number >= 13)
    figure =
      path('M87 193H213V315H87ZM79 315H221V333H79', 'fill="none"') + figure + crown(150, 159);
  if (c.number === 13) figure += moon(79, 158, 17) + plant(70, 306, 48) + star(226, 158, 7);
  if (c.number === 14)
    figure +=
      path('M73 180v137M63 192h20M74 180l-7-12 7-13 7 13Z', 'fill="none"') +
      circle(77, 268, 11, 'fill="var(--muted)"') +
      path('M109 180h82M109 187h82', 'fill="none"');
  if (c.number === 11) figure += circle(150, 171, 18, 'fill="none"') + star(150, 124, 12);
  return (
    backdrop +
    figure +
    symbol(c.number === 12 ? 203 : 211, 223, 0.95) +
    path('M93 349H207', 'fill="none"')
  );
}
function escape(s) {
  return s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
}
export function cardSvg(c) {
  const [bg, gold, muted] = palettes[c.suit];
  const stars = [
    [65, 114, 3],
    [231, 120, 4],
    [51, 201, 2],
    [254, 204, 2],
    [67, 327, 3],
    [233, 325, 3],
  ]
    .map(([x, y, r]) => star(x, y, r))
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 500" role="img" aria-labelledby="title" style="--gold:${gold};--muted:${muted}"><title id="title">星屿原创塔罗 · ${escape(c.name)}</title><defs><linearGradient id="sky" x2="0" y2="1"><stop stop-color="${bg}"/><stop offset="1" stop-color="#112d2d"/></linearGradient><pattern id="paper" width="7" height="7" patternUnits="userSpaceOnUse"><circle cx="2" cy="3" r=".4" fill="#aa9b78" opacity=".14"/></pattern><clipPath id="scene"><path d="M34 374V160a116 116 0 0 1 232 0v214Z"/></clipPath></defs><rect x="1" y="1" width="298" height="498" rx="14" fill="#f4eedf" stroke="#c9b681" stroke-width="2"/><rect x="10" y="10" width="280" height="480" rx="8" fill="url(#paper)" stroke="#cdbb90" stroke-width=".7"/><g fill="none" stroke="#b59b61" stroke-width=".8"><path d="M28 56H104m92 0h76M28 402h244"/>${circle(150, 50, 19)}${star(35, 30, 4)}${star(265, 30, 4)}</g><text x="150" y="54" text-anchor="middle" fill="#897644" font-family="Georgia,serif" font-size="${c.number > 10 && c.suit !== 'major' ? 10 : 12}" letter-spacing="1">${c.suit === 'major' ? roman[c.number] : c.number <= 10 ? roman[c.number] : ['PAGE', 'KNIGHT', 'QUEEN', 'KING'][c.number - 11]}</text><path d="M27 381V159a123 123 0 0 1 246 0v222Z" fill="none" stroke="#bba772" stroke-width="1"/><g clip-path="url(#scene)" style="--gold:${gold};--muted:${muted}"><path d="M34 374V160a116 116 0 0 1 232 0v214Z" fill="url(#sky)"/><g fill="none" stroke="${gold}" stroke-width="1.35" stroke-linejoin="round" stroke-linecap="round">${stars}${c.suit === 'major' ? scene(c.number) : minor(c)}</g></g><text x="150" y="428" text-anchor="middle" fill="#405847" font-family="Songti SC,STSong,serif" font-size="21" letter-spacing="4">${escape(c.name)}</text><text x="150" y="450" text-anchor="middle" fill="#9a875b" font-family="Georgia,serif" font-size="10" letter-spacing="1.1">${escape(c.en.toUpperCase())}</text><text x="150" y="478" text-anchor="middle" fill="#ada185" font-family="Arial,sans-serif" font-size="6.5" letter-spacing="3.5">ASTRAL · ${c.suit === 'major' ? 'MAJOR ARCANA' : c.suit.toUpperCase()}</text></svg>`;
}
export function backSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 500"><defs><radialGradient id="bg"><stop stop-color="#315d50"/><stop offset="1" stop-color="#12372f"/></radialGradient><pattern id="stars" width="29" height="29" patternUnits="userSpaceOnUse"><circle cx="14" cy="14" r=".6" fill="#d3c18f" opacity=".3"/></pattern></defs><rect x="1" y="1" width="298" height="498" rx="14" fill="#e3d4ad"/><rect x="7" y="7" width="286" height="486" rx="11" fill="url(#bg)"/><rect x="17" y="17" width="266" height="466" rx="5" fill="url(#stars)" stroke="#b5ad7f" stroke-width="1"/><g style="--gold:#d3c18f" stroke="#b5ad7f" stroke-width="1" fill="none"><rect x="26" y="26" width="248" height="448" rx="120"/><ellipse cx="150" cy="250" rx="82" ry="136"/><ellipse cx="150" cy="250" rx="54" ry="107" transform="rotate(36 150 250)"/><ellipse cx="150" cy="250" rx="54" ry="107" transform="rotate(-36 150 250)"/>${circle(150, 250, 55)}${rays(150, 250, 67, 24)}${star(150, 250, 47)}${star(43, 45, 8)}${star(257, 45, 8)}${star(43, 455, 8)}${star(257, 455, 8)}${moon(150, 84, 18)}${group(moon(150, 84, 18), 'transform="rotate(180 150 250)"')}<path d="M108 45h84M108 455h84"/></g><text x="150" y="358" text-anchor="middle" font-family="Georgia,serif" font-size="8" letter-spacing="5" fill="#d3c18f">ASTRAL</text></svg>`;
}
await mkdir(out, { recursive: true });
await Promise.all(deck.map((c) => writeFile(resolve(out, `${c.id}.svg`), cardSvg(c))));
await writeFile(resolve(out, 'back.svg'), backSvg());
await writeFile(
  resolve(out, 'deck.json'),
  JSON.stringify(
    {
      name: '星屿 · 内在星图',
      version: '1.0.0',
      kind: 'original-svg',
      cards: deck.map((c) => ({ id: c.id, name: c.name, file: `${c.id}.svg` })),
    },
    null,
    2,
  ),
);
console.log('已生成 78 张原创 SVG 牌面与统一牌背。');

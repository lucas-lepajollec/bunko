import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const COVERS_DIR = path.resolve('public/demo/covers');
const READER_DIR = path.resolve('public/demo/reader');
mkdirSync(COVERS_DIR, { recursive: true });
mkdirSync(READER_DIR, { recursive: true });

const WORKS = [
  { slug: 'glass-harbor', title: 'Glass Harbor', subtitle: 'K. MORITA', tag: 'MANGA', palette: ['#07131f', '#133a5c', '#38bdf8', '#e0f2fe'], motif: 'harbor', banner: true },
  { slug: 'clockwork-meridian', title: 'Clockwork Meridian', subtitle: 'R. TAKAHASHI', tag: 'MANGA', palette: ['#160e07', '#4a250b', '#f59e0b', '#fef3c7'], motif: 'astrolabe', banner: true },
  { slug: 'paper-lantern-district', title: 'Paper Lantern District', subtitle: 'S. FUJIMOTO', tag: 'MANGA', palette: ['#1a0910', '#581c36', '#fb7185', '#ffe4e6'], motif: 'lanterns', banner: false },
  { slug: 'iron-botanist', title: 'Iron Botanist', subtitle: 'H. KAWAGUCHI', tag: 'MANGA', palette: ['#061712', '#124637', '#34d399', '#d1fae5'], motif: 'botanical', banner: true },
  { slug: 'saltwater-alchemist', title: 'Saltwater Alchemist', subtitle: 'A. NISHIMURA', tag: 'MANGA', palette: ['#091326', '#1e3a6e', '#60a5fa', '#dbeafe'], motif: 'waves', banner: false },
  { slug: 'nocturne-rail', title: 'Nocturne Rail', subtitle: 'T. SHINODA', tag: 'MANGA', palette: ['#100a21', '#312163', '#a78bfa', '#ede9fe'], motif: 'rail', banner: true },
  { slug: 'tower-of-ash-amber', title: 'Tower of Ash & Amber', subtitle: 'J. HAN', tag: 'MANHWA', palette: ['#1b0d07', '#5c240d', '#f97316', '#ffedd5'], motif: 'monolith', banner: true },
  { slug: 'seoul-signal-1999', title: 'Seoul Signal 1999', subtitle: 'M. KANG', tag: 'MANHWA', palette: ['#06181f', '#0f4759', '#22d3ee', '#cffafe'], motif: 'signal', banner: true },
  { slug: 'silver-kiln', title: 'Silver Kiln', subtitle: 'Y. BAEK', tag: 'MANHWA', palette: ['#111419', '#2f3744', '#cbd5e1', '#f8fafc'], motif: 'ceramic', banner: false },
  { slug: 'monsoon-courier', title: 'Monsoon Courier', subtitle: 'D. PARK', tag: 'MANHWA', palette: ['#07190e', '#164d2b', '#4ade80', '#dcfce7'], motif: 'rain', banner: false },
  { slug: 'cloud-pavilion-chronicles', title: 'Cloud Pavilion Chronicles', subtitle: 'L. CHEN', tag: 'MANHUA', palette: ['#191406', '#523e0c', '#eab308', '#fef9c3'], motif: 'peaks', banner: false },
  { slug: 'jade-cartographer', title: 'Jade Cartographer', subtitle: 'W. ZHOU', tag: 'MANHUA', palette: ['#051711', '#0f4c3a', '#10b981', '#d1fae5'], motif: 'compass', banner: false },
  { slug: 'red-canyon-express', title: 'Red Canyon Express', subtitle: 'C. MOREAU', tag: 'COMIC', palette: ['#1c0909', '#611919', '#ef4444', '#fee2e2'], motif: 'canyon', banner: true },
  { slug: 'brass-observatory', title: 'The Brass Observatory', subtitle: 'E. LAURENT', tag: 'COMIC', palette: ['#171006', '#4d330c', '#d97706', '#fef3c7'], motif: 'astrolabe', banner: false },
  { slug: 'archipelago-drift', title: 'Archipelago Drift', subtitle: 'N. VERMEER', tag: 'COMIC', palette: ['#06161c', '#0e475c', '#06b6d4', '#cffafe'], motif: 'waves', banner: false },
  { slug: 'quiet-archivist-oakhaven', title: 'The Quiet Archivist of Oakhaven', subtitle: 'M. AOKI', tag: 'LIGHT NOVEL', palette: ['#160c21', '#452269', '#c084fc', '#f3e8ff'], motif: 'arch', banner: false },
  { slug: 'orbital-lighthouse', title: 'Letters from an Orbital Lighthouse', subtitle: 'K. SATO', tag: 'LIGHT NOVEL', palette: ['#071421', '#143f63', '#38bdf8', '#e0f2fe'], motif: 'beacon', banner: false },
  { slug: 'merchant-frozen-steppe', title: 'Merchant of the Frozen Steppe', subtitle: 'N. ISHIKAWA', tag: 'LIGHT NOVEL', palette: ['#091224', '#1d3969', '#93c5fd', '#eff6ff'], motif: 'peaks', banner: false },
  { slug: 'tidebinders-ledger', title: "Tidebinder's Ledger", subtitle: 'E. HALVORSEN', tag: 'WEB NOVEL', palette: ['#051817', '#114d48', '#14b8a6', '#ccfbf1'], motif: 'compass', banner: false },
  { slug: 'salt-glass-atlas', title: 'The Salt Glass Atlas', subtitle: 'C. DELACROIX', tag: 'NOVEL', palette: ['#1c0810', '#5e1530', '#f43f5e', '#ffe4e6'], motif: 'compass', banner: false },
  { slug: 'winter-over-val-claire', title: 'Winter Over Val-Claire', subtitle: 'L. MERCER', tag: 'NOVEL', palette: ['#0d0f24', '#272c6b', '#818cf8', '#e0e7ff'], motif: 'peaks', banner: false },
  { slug: 'nordic-lighthouses', title: 'Field Notes on Nordic Lighthouses', subtitle: 'H. LINDQVIST', tag: 'BOOK', palette: ['#171307', '#4d3b0f', '#fbbf24', '#fef3c7'], motif: 'beacon', banner: false },
  { slug: 'starlight-foundry', title: 'Starlight Foundry', subtitle: 'STUDIO ASTRA', tag: 'ANIME', palette: ['#081226', '#1b3b75', '#60a5fa', '#dbeafe'], motif: 'orbital', banner: true },
  { slug: 'kestrel-academy', title: 'Kestrel Academy of Winds', subtitle: 'STUDIO VERDANT', tag: 'ANIME', palette: ['#061a14', '#13523f', '#34d399', '#d1fae5'], motif: 'wind', banner: true },
  { slug: 'midnight-ramen-radio', title: 'Midnight Ramen & Radio', subtitle: 'STUDIO HIBIKI', tag: 'ANIME', palette: ['#1c0f07', '#5c2c0e', '#fb923c', '#ffedd5'], motif: 'lanterns', banner: true },
  { slug: 'echoes-copper-sea', title: 'Echoes of the Copper Sea', subtitle: 'STUDIO MARINA', tag: 'ANIME', palette: ['#1c0a17', '#5c1a47', '#f472b6', '#fce7f3'], motif: 'waves', banner: true },
  { slug: 'northwatch-station', title: 'Northwatch Station', subtitle: 'NORDIC TELEVISION', tag: 'SERIES', palette: ['#06131c', '#103c59', '#38bdf8', '#e0f2fe'], motif: 'signal', banner: true },
  { slug: 'velvet-timetable', title: 'The Velvet Timetable', subtitle: 'MERIDIAN DRAMA', tag: 'SERIES', palette: ['#19091f', '#4f1863', '#e879f9', '#fae8ff'], motif: 'rail', banner: true },
  { slug: 'horizon-line-zero', title: 'Horizon Line Zero', subtitle: 'SOLARIS PICTURES', tag: 'FILM', palette: ['#181005', '#52340b', '#f59e0b', '#fef3c7'], motif: 'orbital', banner: true },
  { slug: 'paper-whale-harbor-nine', title: 'The Paper Whale of Harbor Nine', subtitle: 'ATELIER KUMO', tag: 'ANIMATION', palette: ['#06191a', '#114d52', '#2dd4bf', '#ccfbf1'], motif: 'harbor', banner: true },
];

const esc = (s) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function wrapLines(title, maxChars) {
  const words = title.split(' ');
  const lines = [];
  let cur = '';
  for (const w of words) {
    if (!cur) cur = w;
    else if (cur.length + 1 + w.length <= maxChars) cur += ' ' + w;
    else {
      lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  return lines.slice(0, 3);
}

function motifSvg(motif, accent, pale, w, h, wide = false) {
  const cx = wide ? w * 0.68 : w * 0.52;
  const cy = wide ? h * 0.46 : h * 0.36;
  const r = wide ? 240 : 118;
  switch (motif) {
    case 'harbor':
      return `
        <circle cx="${cx}" cy="${cy - 30}" r="${r * 0.72}" fill="none" stroke="${accent}" stroke-opacity="0.35" stroke-width="1.5"/>
        <circle cx="${cx}" cy="${cy - 30}" r="${r * 0.44}" fill="${accent}" fill-opacity="0.14"/>
        <path d="M0 ${h * 0.62} Q${w * 0.28} ${h * 0.56} ${w * 0.56} ${h * 0.62} T${w} ${h * 0.58} L${w} ${h} L0 ${h} Z" fill="${accent}" fill-opacity="0.12"/>
        <path d="M${cx - r * 0.85} ${h * 0.6} L${cx - r * 0.2} ${cy - 45} L${cx + r * 0.45} ${h * 0.6} Z" fill="${pale}" fill-opacity="0.09" stroke="${accent}" stroke-opacity="0.32" stroke-width="1.2"/>
        <line x1="${cx}" y1="${cy - 110}" x2="${cx}" y2="${h * 0.64}" stroke="${pale}" stroke-opacity="0.32" stroke-width="1.4"/>
      `;
    case 'astrolabe':
      return `
        <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${accent}" stroke-opacity="0.4" stroke-width="1.6"/>
        <circle cx="${cx}" cy="${cy}" r="${r * 0.72}" fill="none" stroke="${pale}" stroke-opacity="0.25" stroke-width="1" stroke-dasharray="6 8"/>
        <circle cx="${cx}" cy="${cy}" r="${r * 0.42}" fill="${accent}" fill-opacity="0.16" stroke="${accent}" stroke-opacity="0.55" stroke-width="1.2"/>
        <ellipse cx="${cx}" cy="${cy}" rx="${r * 1.15}" ry="${r * 0.34}" transform="rotate(-24 ${cx} ${cy})" fill="none" stroke="${pale}" stroke-opacity="0.35" stroke-width="1.2"/>
        <line x1="${cx - r * 1.2}" y1="${cy}" x2="${cx + r * 1.2}" y2="${cy}" stroke="${accent}" stroke-opacity="0.22" stroke-width="1"/>
        <line x1="${cx}" y1="${cy - r * 1.2}" x2="${cx}" y2="${cy + r * 1.2}" stroke="${accent}" stroke-opacity="0.22" stroke-width="1"/>
      `;
    case 'lanterns':
      return `
        <line x1="0" y1="${cy - 70}" x2="${w}" y2="${cy - 30}" stroke="${pale}" stroke-opacity="0.25" stroke-width="1.2"/>
        <rect x="${cx - 70}" y="${cy - 46}" width="44" height="68" rx="22" fill="${accent}" fill-opacity="0.26" stroke="${pale}" stroke-opacity="0.55" stroke-width="1.4"/>
        <rect x="${cx + 12}" y="${cy - 22}" width="56" height="86" rx="28" fill="${accent}" fill-opacity="0.34" stroke="${pale}" stroke-opacity="0.65" stroke-width="1.5"/>
        <rect x="${cx - 130}" y="${cy - 10}" width="32" height="50" rx="16" fill="${accent}" fill-opacity="0.16" stroke="${accent}" stroke-opacity="0.4" stroke-width="1"/>
        <circle cx="${cx + 40}" cy="${cy + 20}" r="${r * 0.9}" fill="${accent}" fill-opacity="0.08"/>
      `;
    case 'botanical':
      return `
        <path d="M${cx} ${h * 0.72} C${cx - 10} ${cy + 50} ${cx - 80} ${cy - 20} ${cx - 10} ${cy - r * 0.85}" fill="none" stroke="${pale}" stroke-opacity="0.45" stroke-width="1.8"/>
        <path d="M${cx - 24} ${cy + 16} C${cx - 98} ${cy - 4} ${cx - 98} ${cy - 64} ${cx - 26} ${cy - 54} Z" fill="${accent}" fill-opacity="0.22" stroke="${accent}" stroke-opacity="0.5" stroke-width="1.2"/>
        <path d="M${cx - 8} ${cy - 12} C${cx + 76} ${cy - 36} ${cx + 82} ${cy - 98} ${cx + 2} ${cy - 78} Z" fill="${accent}" fill-opacity="0.18" stroke="${pale}" stroke-opacity="0.45" stroke-width="1.2"/>
        <circle cx="${cx}" cy="${cy - 10}" r="${r * 0.88}" fill="none" stroke="${accent}" stroke-opacity="0.22" stroke-width="1"/>
      `;
    case 'waves':
      return `
        <circle cx="${cx}" cy="${cy - 30}" r="${r * 0.56}" fill="${accent}" fill-opacity="0.2" stroke="${pale}" stroke-opacity="0.4" stroke-width="1.2"/>
        ${[0, 1, 2, 3]
          .map(
            (i) =>
              `<path d="M0 ${h * (0.48 + i * 0.08)} Q${w * 0.25} ${h * (0.42 + i * 0.08)} ${w * 0.5} ${h * (0.48 + i * 0.08)} T${w} ${h * (0.48 + i * 0.08)}" fill="none" stroke="${i % 2 ? pale : accent}" stroke-opacity="${0.45 - i * 0.08}" stroke-width="${2.2 - i * 0.3}"/>`,
          )
          .join('')}
      `;
    case 'rail':
      return `
        <polygon points="${cx - 18},${cy - 90} ${cx + 18},${cy - 90} ${cx + r * 1.4},${h} ${cx - r * 1.4},${h}" fill="${accent}" fill-opacity="0.12"/>
        <line x1="${cx - 12}" y1="${cy - 90}" x2="${cx - r * 1.1}" y2="${h}" stroke="${pale}" stroke-opacity="0.45" stroke-width="1.5"/>
        <line x1="${cx + 12}" y1="${cy - 90}" x2="${cx + r * 1.1}" y2="${h}" stroke="${pale}" stroke-opacity="0.45" stroke-width="1.5"/>
        <circle cx="${cx}" cy="${cy - 96}" r="${r * 0.42}" fill="${accent}" fill-opacity="0.24" stroke="${pale}" stroke-opacity="0.5" stroke-width="1.2"/>
        <rect x="${cx - r}" y="${cy + 36}" width="${r * 2}" height="2" fill="${accent}" fill-opacity="0.35"/>
      `;
    case 'monolith':
      return `
        <polygon points="${cx - 38},${cy - r * 0.95} ${cx + 38},${cy - r * 0.72} ${cx + 58},${h * 0.74} ${cx - 58},${h * 0.74}" fill="${accent}" fill-opacity="0.24" stroke="${pale}" stroke-opacity="0.55" stroke-width="1.5"/>
        <polygon points="${cx + 54},${cy - 18} ${cx + 106},${cy + 14} ${cx + 116},${h * 0.74} ${cx + 54},${h * 0.74}" fill="${accent}" fill-opacity="0.13" stroke="${accent}" stroke-opacity="0.35" stroke-width="1"/>
        <circle cx="${cx - 24}" cy="${cy - r * 0.5}" r="${r * 0.65}" fill="none" stroke="${pale}" stroke-opacity="0.28" stroke-width="1.1"/>
      `;
    case 'signal':
      return `
        ${[0.32, 0.56, 0.82, 1.08]
          .map(
            (s, i) =>
              `<circle cx="${cx}" cy="${cy}" r="${r * s}" fill="none" stroke="${accent}" stroke-opacity="${0.52 - i * 0.1}" stroke-width="1.4" stroke-dasharray="${i % 2 ? '10 6' : 'none'}"/>`,
          )
          .join('')}
        <line x1="${cx}" y1="${cy}" x2="${cx + r * 0.85}" y2="${cy - r * 0.55}" stroke="${pale}" stroke-opacity="0.7" stroke-width="2"/>
        <circle cx="${cx}" cy="${cy}" r="7" fill="${pale}"/>
      `;
    case 'ceramic':
      return `
        <path d="M${cx - 48} ${cy - 76} C${cx - 88} ${cy - 8} ${cx - 72} ${cy + 78} ${cx - 28} ${cy + 96} L${cx + 28} ${cy + 96} C${cx + 72} ${cy + 78} ${cx + 88} ${cy - 8} ${cx + 48} ${cy - 76} Z" fill="${accent}" fill-opacity="0.2" stroke="${pale}" stroke-opacity="0.5" stroke-width="1.5"/>
        <ellipse cx="${cx}" cy="${cy - 76}" rx="48" ry="11" fill="none" stroke="${pale}" stroke-opacity="0.5" stroke-width="1.4"/>
        <circle cx="${cx}" cy="${cy + 10}" r="${r * 0.92}" fill="none" stroke="${accent}" stroke-opacity="0.2" stroke-width="1"/>
      `;
    case 'rain':
      return `
        ${Array.from({ length: 14 }, (_, i) => {
          const x = (w / 14) * i + 24;
          const y1 = 40 + (i % 4) * 55;
          return `<line x1="${x}" y1="${y1}" x2="${x - 36}" y2="${y1 + 140}" stroke="${i % 3 === 0 ? pale : accent}" stroke-opacity="${0.18 + (i % 3) * 0.12}" stroke-width="${i % 3 === 0 ? 1.8 : 1.1}"/>`;
        }).join('')}
        <circle cx="${cx}" cy="${cy}" r="${r * 0.6}" fill="${accent}" fill-opacity="0.16" stroke="${pale}" stroke-opacity="0.35" stroke-width="1.2"/>
      `;
    case 'peaks':
      return `
        <polygon points="0,${h * 0.68} ${w * 0.32},${cy - 40} ${w * 0.64},${h * 0.68}" fill="${accent}" fill-opacity="0.18"/>
        <polygon points="${w * 0.25},${h * 0.72} ${cx},${cy - 85} ${w},${h * 0.72}" fill="${accent}" fill-opacity="0.24" stroke="${pale}" stroke-opacity="0.4" stroke-width="1.3"/>
        <circle cx="${cx - r * 0.55}" cy="${cy - 75}" r="${r * 0.28}" fill="${pale}" fill-opacity="0.35"/>
      `;
    case 'compass':
      return `
        <polygon points="${cx},${cy - r} ${cx + 22},${cy - 22} ${cx + r},${cy} ${cx + 22},${cy + 22} ${cx},${cy + r} ${cx - 22},${cy + 22} ${cx - r},${cy} ${cx - 22},${cy - 22}" fill="${accent}" fill-opacity="0.18" stroke="${pale}" stroke-opacity="0.5" stroke-width="1.3"/>
        <circle cx="${cx}" cy="${cy}" r="${r * 0.76}" fill="none" stroke="${accent}" stroke-opacity="0.38" stroke-width="1.2"/>
        <circle cx="${cx}" cy="${cy}" r="8" fill="${pale}" fill-opacity="0.8"/>
      `;
    case 'canyon':
      return `
        <path d="M0 ${h * 0.56} L${w * 0.24} ${cy - 30} L${w * 0.42} ${cy - 30} L${w * 0.5} ${cy + 18} L${w * 0.68} ${cy - 54} L${w} ${cy - 20} L${w} ${h} L0 ${h} Z" fill="${accent}" fill-opacity="0.22" stroke="${pale}" stroke-opacity="0.35" stroke-width="1.3"/>
        <circle cx="${cx - 28}" cy="${cy - 78}" r="${r * 0.42}" fill="${pale}" fill-opacity="0.24"/>
      `;
    case 'arch':
      return `
        <path d="M${cx - 80} ${h * 0.7} L${cx - 80} ${cy - 20} A80 80 0 0 1 ${cx + 80} ${cy - 20} L${cx + 80} ${h * 0.7}" fill="${accent}" fill-opacity="0.15" stroke="${pale}" stroke-opacity="0.5" stroke-width="1.6"/>
        <path d="M${cx - 52} ${h * 0.7} L${cx - 52} ${cy - 18} A52 52 0 0 1 ${cx + 52} ${cy - 18} L${cx + 52} ${h * 0.7}" fill="none" stroke="${accent}" stroke-opacity="0.45" stroke-width="1.2"/>
        <circle cx="${cx}" cy="${cy - 26}" r="22" fill="${pale}" fill-opacity="0.22"/>
      `;
    case 'beacon':
      return `
        <polygon points="${cx},${cy - 60} ${w},${cy - 150} ${w},${cy + 30}" fill="${pale}" fill-opacity="0.14"/>
        <polygon points="${cx},${cy - 60} 0,${cy - 110} 0,${cy - 10}" fill="${accent}" fill-opacity="0.12"/>
        <rect x="${cx - 18}" y="${cy - 54}" width="36" height="${h * 0.34}" rx="4" fill="${accent}" fill-opacity="0.3" stroke="${pale}" stroke-opacity="0.55" stroke-width="1.4"/>
        <circle cx="${cx}" cy="${cy - 62}" r="12" fill="${pale}" fill-opacity="0.85"/>
      `;
    case 'orbital':
      return `
        <circle cx="${cx}" cy="${cy}" r="${r * 0.48}" fill="${accent}" fill-opacity="0.26" stroke="${pale}" stroke-opacity="0.55" stroke-width="1.6"/>
        <ellipse cx="${cx}" cy="${cy}" rx="${r * 1.25}" ry="${r * 0.38}" transform="rotate(-18 ${cx} ${cy})" fill="none" stroke="${pale}" stroke-opacity="0.5" stroke-width="1.6"/>
        <ellipse cx="${cx}" cy="${cy}" rx="${r * 0.95}" ry="${r * 0.28}" transform="rotate(24 ${cx} ${cy})" fill="none" stroke="${accent}" stroke-opacity="0.42" stroke-width="1.2"/>
        <circle cx="${cx + r * 0.92}" cy="${cy - r * 0.24}" r="9" fill="${pale}"/>
      `;
    case 'wind':
    default:
      return `
        <path d="M0 ${cy - 40} C${w * 0.3} ${cy - 120} ${w * 0.65} ${cy + 40} ${w} ${cy - 50}" fill="none" stroke="${pale}" stroke-opacity="0.45" stroke-width="2"/>
        <path d="M0 ${cy + 10} C${w * 0.35} ${cy - 70} ${w * 0.7} ${cy + 90} ${w} ${cy}" fill="none" stroke="${accent}" stroke-opacity="0.5" stroke-width="1.6"/>
        <circle cx="${cx}" cy="${cy - 20}" r="${r * 0.5}" fill="${accent}" fill-opacity="0.16"/>
      `;
  }
}

function makePoster(work) {
  const [dark, mid, accent, pale] = work.palette;
  const lines = wrapLines(work.title, 16);
  const titleY = 472 - (lines.length - 1) * 34;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="600" viewBox="0 0 400 600" role="img" aria-label="${esc(work.title)}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${mid}"/>
      <stop offset="52%" stop-color="${dark}"/>
      <stop offset="100%" stop-color="#05070a"/>
    </linearGradient>
    <radialGradient id="glow" cx="55%" cy="32%" r="60%">
      <stop offset="0%" stop-color="${accent}" stop-opacity="0.34"/>
      <stop offset="100%" stop-color="${dark}" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="fade" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#05070a" stop-opacity="0"/>
      <stop offset="58%" stop-color="#05070a" stop-opacity="0.22"/>
      <stop offset="100%" stop-color="#05070a" stop-opacity="0.92"/>
    </linearGradient>
  </defs>
  <rect width="400" height="600" fill="url(#bg)"/>
  <rect width="400" height="600" fill="url(#glow)"/>
  <g opacity="0.14" stroke="${pale}" stroke-width="0.6">
    <line x1="28" y1="0" x2="28" y2="600"/>
    <line x1="372" y1="0" x2="372" y2="600"/>
    <line x1="0" y1="68" x2="400" y2="68"/>
  </g>
  ${motifSvg(work.motif, accent, pale, 400, 600, false)}
  <rect width="400" height="600" fill="url(#fade)"/>
  <rect x="24" y="24" width="352" height="552" rx="8" fill="none" stroke="${pale}" stroke-opacity="0.14" stroke-width="1"/>
  <rect x="36" y="38" width="96" height="22" rx="11" fill="${accent}" fill-opacity="0.18" stroke="${accent}" stroke-opacity="0.45" stroke-width="1"/>
  <text x="84" y="53" text-anchor="middle" fill="${pale}" font-family="ui-sans-serif, system-ui, -apple-system, sans-serif" font-size="9.5" font-weight="700" letter-spacing="1.6">${esc(work.tag)}</text>
  <rect x="36" y="${titleY - 40}" width="34" height="3" rx="1.5" fill="${accent}"/>
  <text x="36" y="${titleY}" fill="#f8fafc" font-family="ui-sans-serif, system-ui, -apple-system, sans-serif" font-size="31" font-weight="800" letter-spacing="-0.6">
    ${lines.map((line, i) => `<tspan x="36" dy="${i === 0 ? 0 : 35}">${esc(line)}</tspan>`).join('')}
  </text>
  <text x="36" y="556" fill="${pale}" fill-opacity="0.7" font-family="ui-sans-serif, system-ui, -apple-system, sans-serif" font-size="11" font-weight="600" letter-spacing="2.2">${esc(work.subtitle)}</text>
</svg>
`;
}

function makeBanner(work) {
  const [dark, mid, accent, pale] = work.palette;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900" viewBox="0 0 1600 900" role="img" aria-label="${esc(work.title)}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${dark}"/>
      <stop offset="48%" stop-color="${mid}"/>
      <stop offset="100%" stop-color="#05080d"/>
    </linearGradient>
    <radialGradient id="glow1" cx="72%" cy="38%" r="52%">
      <stop offset="0%" stop-color="${accent}" stop-opacity="0.42"/>
      <stop offset="60%" stop-color="${accent}" stop-opacity="0.08"/>
      <stop offset="100%" stop-color="${dark}" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="glow2" cx="24%" cy="76%" r="48%">
      <stop offset="0%" stop-color="${pale}" stop-opacity="0.12"/>
      <stop offset="100%" stop-color="${dark}" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="1600" height="900" fill="url(#bg)"/>
  <rect width="1600" height="900" fill="url(#glow1)"/>
  <rect width="1600" height="900" fill="url(#glow2)"/>
  <g opacity="0.1" stroke="${pale}" stroke-width="1">
    <line x1="0" y1="180" x2="1600" y2="180"/>
    <line x1="0" y1="720" x2="1600" y2="720"/>
    <line x1="960" y1="0" x2="960" y2="900"/>
    <line x1="1380" y1="0" x2="1380" y2="900"/>
  </g>
  ${motifSvg(work.motif, accent, pale, 1600, 900, true)}
  <g opacity="0.4">
    <circle cx="1290" cy="170" r="3" fill="${pale}"/>
    <circle cx="1370" cy="240" r="2" fill="${accent}"/>
    <circle cx="1180" cy="130" r="2.5" fill="${pale}"/>
    <circle cx="1440" cy="340" r="3" fill="${pale}"/>
    <circle cx="1060" cy="220" r="2" fill="${accent}"/>
  </g>
</svg>
`;
}

function makeReaderPage(num, caption, scene) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="1350" viewBox="0 0 900 1350" role="img" aria-label="Demo manga page ${num}">
  <defs>
    <pattern id="tone" width="8" height="8" patternUnits="userSpaceOnUse">
      <circle cx="2" cy="2" r="1.1" fill="#18202c" opacity="0.22"/>
    </pattern>
    <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#142235"/>
      <stop offset="100%" stop-color="#3b5f82"/>
    </linearGradient>
  </defs>
  <rect width="900" height="1350" fill="#f5f3ee"/>
  <rect x="38" y="38" width="824" height="1274" fill="#ffffff" stroke="#111318" stroke-width="4"/>
  <!-- Panel 1 -->
  <rect x="64" y="64" width="772" height="420" fill="url(#sky)" stroke="#111318" stroke-width="4"/>
  <rect x="64" y="64" width="772" height="420" fill="url(#tone)"/>
  ${scene.top}
  <rect x="92" y="92" width="320" height="62" rx="4" fill="#ffffff" stroke="#111318" stroke-width="2.5"/>
  <text x="112" y="130" fill="#111318" font-family="ui-sans-serif, system-ui, sans-serif" font-size="22" font-weight="700">${esc(caption.top)}</text>
  <!-- Panel 2 & 3 -->
  <rect x="64" y="510" width="372" height="370" fill="#e6ecf2" stroke="#111318" stroke-width="4"/>
  <rect x="64" y="510" width="372" height="370" fill="url(#tone)"/>
  ${scene.left}
  <rect x="464" y="510" width="372" height="370" fill="#182230" stroke="#111318" stroke-width="4"/>
  ${scene.right}
  <ellipse cx="650" cy="610" rx="145" ry="54" fill="#ffffff" stroke="#111318" stroke-width="2.5"/>
  <text x="650" y="618" text-anchor="middle" fill="#111318" font-family="ui-sans-serif, system-ui, sans-serif" font-size="21" font-weight="700">${esc(caption.mid)}</text>
  <!-- Panel 4 -->
  <rect x="64" y="906" width="772" height="360" fill="#eef2f6" stroke="#111318" stroke-width="4"/>
  <rect x="64" y="906" width="772" height="360" fill="url(#tone)"/>
  ${scene.bottom}
  <rect x="440" y="1164" width="368" height="74" rx="4" fill="#111318"/>
  <text x="624" y="1209" text-anchor="middle" fill="#f8fafc" font-family="ui-sans-serif, system-ui, sans-serif" font-size="20" font-weight="600">${esc(caption.bottom)}</text>
  <text x="450" y="1300" text-anchor="middle" fill="#525a66" font-family="ui-monospace, monospace" font-size="14">BUNKO DEMO READER · PAGE ${num} / 3</text>
</svg>
`;
}

for (const work of WORKS) {
  writeFileSync(path.join(COVERS_DIR, `${work.slug}.svg`), makePoster(work), 'utf8');
  if (work.banner) {
    writeFileSync(path.join(COVERS_DIR, `${work.slug}-banner.svg`), makeBanner(work), 'utf8');
  }
}

const PAGES = [
  {
    top: 'DAWN OVER GLASS HARBOR.',
    mid: 'The tide clock stopped.',
    bottom: 'CHAPTER PREVIEW · ORIGINAL DEMO ART',
    scene: {
      top: '<circle cx="670" cy="210" r="78" fill="#bae6fd" opacity="0.85"/><path d="M64 380 L280 260 L440 340 L630 220 L836 360 L836 484 L64 484 Z" fill="#0f172a"/>',
      left: '<circle cx="250" cy="695" r="110" fill="none" stroke="#111318" stroke-width="5"/><line x1="250" y1="695" x2="250" y2="605" stroke="#111318" stroke-width="6"/><line x1="250" y1="695" x2="315" y2="715" stroke="#111318" stroke-width="5"/>',
      right: '<path d="M464 810 L620 710 L836 790 L836 880 L464 880 Z" fill="#38bdf8" opacity="0.3"/>',
      bottom: '<path d="M64 1120 Q280 1020 480 1120 T836 1080" fill="none" stroke="#0f172a" stroke-width="6"/><rect x="140" y="960" width="90" height="240" fill="#1e293b"/>',
    },
  },
  {
    top: 'PIER SEVEN — ARCHIVE GATE.',
    mid: 'Signal received on Channel 4.',
    bottom: 'USE ARROW KEYS OR TAP TO TURN PAGES',
    scene: {
      top: '<rect x="180" y="180" width="540" height="304" fill="#0b1220"/><path d="M290 484 L290 290 A160 160 0 0 1 610 290 L610 484" fill="none" stroke="#7dd3fc" stroke-width="5"/>',
      left: '<polygon points="120,830 250,570 380,830" fill="#1e293b"/><circle cx="250" cy="650" r="34" fill="#ffffff"/>',
      right: '<circle cx="650" cy="760" r="90" fill="none" stroke="#38bdf8" stroke-width="3" stroke-dasharray="10 8"/>',
      bottom: '<line x1="64" y1="980" x2="836" y2="1120" stroke="#111318" stroke-width="4"/><line x1="64" y1="1060" x2="836" y2="1180" stroke="#111318" stroke-width="3"/>',
    },
  },
  {
    top: 'BEYOND THE BREAKWATER.',
    mid: 'Next chapter continues soon.',
    bottom: 'END OF DEMO CHAPTER SAMPLE',
    scene: {
      top: '<circle cx="450" cy="280" r="120" fill="#e0f2fe" opacity="0.24"/><path d="M64 420 Q450 280 836 420 L836 484 L64 484 Z" fill="#0f172a"/>',
      left: '<rect x="118" y="568" width="264" height="254" fill="#0f172a"/><circle cx="250" cy="695" r="64" fill="#38bdf8" opacity="0.7"/>',
      right: '<path d="M510 820 L650 690 L790 820 Z" fill="#e0f2fe" opacity="0.35"/>',
      bottom: '<circle cx="220" cy="1085" r="95" fill="none" stroke="#111318" stroke-width="5"/><circle cx="220" cy="1085" r="42" fill="#0f172a"/>',
    },
  },
];

PAGES.forEach((p, idx) => {
  writeFileSync(path.join(READER_DIR, `page-${idx + 1}.svg`), makeReaderPage(idx + 1, p, p.scene), 'utf8');
});

console.log(`Generated ${WORKS.length} posters, ${WORKS.filter((w) => w.banner).length} banners, and ${PAGES.length} reader pages.`);

// The constellation view — chartr's star-map aesthetic over wfdash's graph
// contract (wfdash#3). One SVG, regenerated wholesale like graph.js, holding no
// user state. Layout comes from lib/starlayout.js and depends only on numbers
// and edges, so a poll that changes a status re-colours a star but never moves
// it. Colour is the settled palette from graph.js — this view adds geometry,
// not a second colour language.

import { computeLayout, edgesOf, mulberry32 } from './lib/starlayout.js';
import { STATUS_COLOR, TYPE_GLYPH } from './graph.js';
import { DONE, TAKEABLE, clip } from './lib/layout.js';

const NS = 'http://www.w3.org/2000/svg';
const el = (name, attrs = {}, parent) => {
  const e = document.createElementNS(NS, name);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(e);
  return e;
};

const BG = '#05070d';
const PAD = 90;

/** Star radius speaks status: frontier loud, done quiet, everything else middling. */
function radiusOf(node) {
  if (TAKEABLE(node)) return 9;
  if (DONE(node)) return 4.5;
  return 7;
}

export function renderStars(graph, stage, { selected = null, ringed = new Set(), onSelect } = {}) {
  const pts = computeLayout(graph.nodes, graph.edges);
  const edges = edgesOf(graph.nodes, graph.edges);
  const byNumber = new Map(graph.nodes.map((n) => [n.number, n]));

  // Fit: bounds of the constellation plus label room, mapped to the stage width.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of graph.nodes) {
    const p = pts[n.number];
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
  }
  if (!graph.nodes.length) { minX = minY = -200; maxX = maxY = 200; }
  const vb = [minX - PAD, minY - PAD, maxX - minX + PAD * 2, maxY - minY + PAD * 2];

  const width = Math.max(320, stage.clientWidth - 16);
  const height = Math.round((width * vb[3]) / vb[2]);

  stage.innerHTML = '';
  const svg = el('svg', { viewBox: vb.join(' '), width, height: Math.min(height, 1600) }, stage);

  // The ground: a dark field with a deterministic dusting of background stars.
  // Seeded separately from the layout so the dust never shifts either.
  el('rect', { x: vb[0], y: vb[1], width: vb[2], height: vb[3], fill: BG, rx: 10 }, svg);
  const dust = mulberry32(42);
  const specks = Math.min(140, Math.round((vb[2] * vb[3]) / 9000));
  for (let i = 0; i < specks; i++) {
    el('circle', {
      cx: vb[0] + dust() * vb[2],
      cy: vb[1] + dust() * vb[3],
      r: dust() * 1.1 + 0.2,
      fill: '#e6edf3',
      'fill-opacity': (dust() * 0.22 + 0.05).toFixed(2),
    }, svg);
  }

  // Edges under stars: solid and faint once cleared, dashed and live while the
  // blocker still stands — the same waiting/cleared reading the box view uses.
  for (const e of edges) {
    const a = pts[e.from], b = pts[e.to];
    const cleared = DONE(byNumber.get(e.from));
    el('line', {
      x1: a.x, y1: a.y, x2: b.x, y2: b.y,
      stroke: cleared ? '#e6edf3' : STATUS_COLOR.blocked,
      'stroke-opacity': cleared ? 0.12 : 0.45,
      'stroke-width': 1.2,
      'stroke-dasharray': cleared ? 'none' : '5 4',
    }, svg);
  }

  for (const node of graph.nodes) {
    const p = pts[node.number];
    const colour = STATUS_COLOR[node.status] ?? '#8b949e';
    const r = radiusOf(node);
    const g = el('g', { class: 'node', 'data-n': node.number, transform: `translate(${p.x},${p.y})` }, svg);

    // Halo first, so the frontier reads as the bright edge of the map.
    if (TAKEABLE(node)) el('circle', { r: r * 2.6, fill: colour, 'fill-opacity': 0.16 }, g);
    // The selection/ring machinery targets `.frame`, same as the box view.
    el('circle', {
      class: 'frame', r,
      fill: DONE(node) ? BG : colour,
      'fill-opacity': DONE(node) ? 1 : 0.92,
      stroke: colour,
      'stroke-width': node.status === 'blocked' ? 1.6 : 1.3,
      'stroke-dasharray': node.status === 'blocked' ? '4 3' : 'none',
    }, g);
    if (node.status === 'out-of-scope') el('line', { x1: -r, y1: r, x2: r, y2: -r, stroke: colour, 'stroke-width': 1.2 }, g);

    const glyph = TYPE_GLYPH[node.type] ?? '';
    el('text', {
      y: r + 14, 'text-anchor': 'middle', class: 'num',
      style: 'font-size:10px', fill: '#e6edf3', 'fill-opacity': DONE(node) ? 0.45 : 0.9,
    }, g).textContent = `${glyph} #${node.number}`;
    el('text', {
      y: r + 26, 'text-anchor': 'middle', class: 'meta',
      style: 'font-size:9px', fill: '#e6edf3', 'fill-opacity': DONE(node) ? 0.3 : 0.55,
    }, g).textContent = clip(node.title, 26);
  }

  svg.addEventListener('click', (ev) => {
    const g = ev.target.closest('.node');
    if (g && onSelect) onSelect(Number(g.dataset.n));
  });

  // Re-apply marks the caller owns elsewhere in the box view.
  svg.querySelectorAll('.node').forEach((g) => {
    g.classList.toggle('sel', g.dataset.n === String(selected));
    g.classList.toggle('ringed', ringed.has(Number(g.dataset.n)));
  });
}

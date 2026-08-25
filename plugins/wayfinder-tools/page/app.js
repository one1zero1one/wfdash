// The dashboard's boot, routing and poll loops.
//
// The page never knows the Graph came from GitHub: it fetches two JSON shapes from a local
// server and draws them. That is what keeps the token out of the browser and the tracker
// read-only — there is no write endpoint to call even if this file wanted one.

import { drawGraph, applyRings, emphasise, highlight } from './graph.js';
import { renderMapPanel, renderTicketPanel, renderVanishedPanel, rememberScroll, syncRail, wireRail, markNewComments } from './dock.js';
import { renderOverview, applyCardRings } from './overview.js';
import { esc } from './lib/markdown.js';
import { fingerprint, changedNodes, selectionChanged, changedMaps, sortMaps, mapKey, backoffFor, totalTickets, byRecency } from './lib/change.js';

const $ = (id) => document.getElementById(id);

// The two routes poll at different intervals, and that is the design. 15 seconds is
// unaffordable on the overview at any query shape — at cost 30 it spends 144% of the
// hourly budget on one tab — and 120 seconds is also the *less torn* interval there, so
// the trade the map route had to make does not arise.
const MAP_INTERVAL = 15_000;
const OVERVIEW_INTERVAL = 120_000;
const MAP_BACKOFF = [15_000, 30_000, 60_000, 120_000];
const OVERVIEW_BACKOFF = [120_000, 240_000, 480_000, 960_000];
// Local, zero GitHub cost, and what stops the 30-minute idle timer reaping the server
// under an open tab. These two numbers are coupled and move together.
const HEARTBEAT = 10 * 60_000;

const S = {
  route: null,
  selected: null,
  graph: null,
  maps: null,
  order: [], // the frozen sort, as card keys
  dockOpen: true,
  ringed: new Set(),
  ringAt: null,
  deltas: new Map(),
  prevFp: null,
  prevMaps: null,
  prevText: null,
  pendingComments: 0,
  pendingGraph: null,
  poll: { n: 0, failures: 0, stale: false, err: null, lastGoodAt: null, lastSuccess: 0, nextAt: null, timer: null },
  /** What the last poll actually cost, summed off the response rather than assumed. */
  cost: null,
  /** Set by focus, consumed by the next overview render: recompute the order once. */
  refreeze: false,
  /**
   * The overview's filter, a plain substring over `owner/repo #number title`. Grouping by
   * repo was measured and rejected (see overview.js) — but `owner/` typed here *is* the
   * grouping, without the headers: the corpus's repo keys all start with their owner.
   */
  filter: '',
  /**
   * `banded` is upstream's sort — actionable first, recency within a band. `updated` is
   * pure recency, for the "what moved last" read the bands deliberately break. `tasks`,
   * `afk` and `hitl` sort by the card's own numbers, largest first, recency as the
   * tie-break. It changes what freezeOrder computes and nothing else: the
   * freeze/unfreeze rules are untouched.
   */
  sort: 'banded',
  /** Levels where the reply did not add up. Reported, never silently trusted. */
  truncated: [],
  heartbeat: null,
  /** wfdash#4: true when /api/health says the host instance has spawn on. */
  spawnOn: false,
  /** The wf:-named sessions from /api/agents, refreshed on their own 15s timer. */
  agents: [],
  agentTimer: null,
};

const clock = () => new Date().toTimeString().slice(0, 8);

// The sort cycle, in click order. `banded` is the default and stays out of the URL; the
// button's label says `active` for it because that is what the band rule reads as.
const SORTS = ['banded', 'updated', 'tasks', 'afk', 'hitl'];
const sortLabel = (v) => `sort: ${v === 'banded' ? 'active' : v}`;
// The three metric sorts, largest first. Attendance can be absent in theory (see
// overview.js `attendanceOf`); `?? 0` keeps the comparator total rather than NaN-poisoned.
const METRIC = {
  tasks: (m) => totalTickets(m),
  afk: (m) => m.attendance?.afk ?? 0,
  hitl: (m) => m.attendance?.hitl ?? 0,
};

// ------------------------------------------------------------------ the route

/** `/` is the overview; `/m/<owner>/<repo>/<number>` is a map. Nothing else exists. */
function parseRoute(pathname, search) {
  const t = new URLSearchParams(search).get('t');
  const selected = t && /^\d+$/.test(t) ? Number(t) : null;
  const m = /^\/m\/([^/]+)\/([^/]+)\/(\d+)\/?$/.exec(pathname);
  if (m) {
    const v = new URLSearchParams(search).get('v') === 'simple' ? 'simple' : 'full';
    return { kind: 'map', owner: m[1], repo: m[2], number: Number(m[3]), selected, view: v };
  }
  const q = new URLSearchParams(search);
  const s = q.get('s');
  return { kind: 'overview', selected: null, filter: q.get('f') ?? '', sort: SORTS.includes(s) ? s : 'banded' };
}

/**
 * **Changing which map you are looking at is history. Changing what is selected inside a
 * map is not.**
 *
 * With that split, one `back` from a map with four tickets visited lands on the overview,
 * and `forward` returns the map with `?t=` intact. Under `pushState` selection the same
 * session costs five backs to escape.
 */
function go(url, { push = true } = {}) {
  if (push) history.pushState(null, '', url);
  else history.replaceState(null, '', url);
  route();
}

/**
 * Selection only ever replaces, so walking the graph never fills the back stack. Built off
 * the current query rather than a fresh one, so `?v=simple` survives a selection change —
 * this is the one place both query keys meet, and dropping one silently would exit simple
 * mode on the next click.
 */
function writeSelection(number) {
  const q = new URLSearchParams(location.search);
  if (number == null) q.delete('t');
  else q.set('t', number);
  const s = q.toString();
  history.replaceState(null, '', s ? `${location.pathname}?${s}` : location.pathname);
}

/** The view toggle, same shape as writeSelection: replaces, keeps `?t=` intact. */
function writeView(view) {
  const q = new URLSearchParams(location.search);
  if (view === 'simple') q.set('v', 'simple');
  else q.delete('v');
  const s = q.toString();
  history.replaceState(null, '', s ? `${location.pathname}?${s}` : location.pathname);
}

// ------------------------------------------------------------------ rendering

function showOnly(id) {
  for (const k of ['overview', 'stage', 'error']) $(k).hidden = k !== id;
  $('filterbar').hidden = id !== 'overview';
  $('masthead').hidden = id !== 'stage';
  $('banner').classList.toggle('on', id === 'stage' && !!S.graph && isFullyResolved(S.graph));
  $('dock').hidden = id !== 'stage' || !S.dockOpen;
}

const isFullyResolved = (g) =>
  g.nodes.length > 0 && g.nodes.every((n) => n.status === 'resolved' || n.status === 'out-of-scope');

function renderMasthead(g) {
  $('maptitle').textContent = g.map.title;
  $('maptitle').href = g.map.url;
  $('where').textContent = `${g.repo} #${g.map.number}`;
  const dest = $('dest');
  dest.innerHTML = g.map.destination
    ? g.map.destination
        .split(/\n{2,}/)
        .map((p) => `<p>${esc(p.replace(/\n/g, ' ')).trim()}</p>`)
        .join('')
    : '<p>No destination recorded.</p>';
  dest.classList.add('clamped');
  // The toggle is present exactly when there is more, so nothing is truncated silently.
  requestAnimationFrame(() => {
    const overflowing = dest.scrollHeight > dest.clientHeight + 1;
    $('more').hidden = !overflowing;
    $('more').textContent = 'more';
  });

  // Fires only at 100%. A 26-of-27 map shows none, and the collapse keeps its best moment:
  // 26 small dim ticks read as a uniform field against one green box.
  if (isFullyResolved(g)) {
    $('banner').innerHTML = `<span class="tick">✓</span><span><b>Every ticket on this map is
      resolved</b> — ${g.nodes.length} of ${g.nodes.length}.</span>`;
  }
}

function renderDock() {
  const scroller = $('scroller');
  if (!S.graph) return;
  if (S.selected == null) return renderMapPanel(S.graph, scroller, { onSelect: select, onHover: hoverNode });
  const node = S.graph.nodes.find((n) => n.number === S.selected);
  if (!node) return renderVanishedPanel(S.selected, scroller);
  renderTicketPanel(S.graph, node, scroller, {
    onSelect: select,
    onHover: hoverNode,
    agents: S.agents,
    onSpawn: S.spawnOn ? (comment) => spawnAgent(node.number, comment) : undefined,
    newComments: S.pendingComments,
    onLoadNew: () => {
      S.pendingComments = 0;
      if (S.pendingGraph) S.graph = S.pendingGraph;
      S.pendingGraph = null;
      renderDock();
    },
  });
}

function renderGraph() {
  const stage = $('stage');
  const keepScroll = stage.scrollTop;
  if (!S.graph.nodes.length) {
    // Two of twenty-one maps have no tickets at all. The page is still the map's body
    // rather than a blank canvas — the dock is already showing it.
    stage.innerHTML = `<p id="empty">This map has no tickets yet. Its body is in the panel.</p>`;
  } else if (S.route.view === 'simple') {
    renderSimple(S.graph, stage);
    applyRings(stage, S.ringed);
    stage.querySelectorAll('.node').forEach((n) => n.classList.toggle('sel', n.dataset.n === String(S.selected)));
  } else {
    drawGraph(S.graph, stage, { selected: S.selected, ringed: S.ringed, onSelect: select });
  }
  stage.scrollTop = keepScroll;
}

/**
 * The simple checklist — a non-technical reading of the same graph the SVG draws. Derived
 * only: title, status and edges are already on the wire, nothing is fetched or invented.
 *
 * Rows carry the graph's own `.node` / `data-n` marks so the existing ring and selection
 * machinery (`applyRings`, `select`'s `.sel` toggle) works on them unchanged — the click
 * listener is wired once, below, under `wiring`.
 */
function renderSimple(graph, stage) {
  const byNumber = new Map(graph.nodes.map((n) => [n.number, n]));
  const todo = [];
  const inProgress = [];
  const waiting = [];
  const done = [];
  for (const n of graph.nodes) {
    if (n.status === 'out-of-scope') continue;
    if (n.status === 'resolved') {
      done.push(n);
    } else if (n.status === 'claimed') {
      inProgress.push(n);
    } else if (n.status === 'blocked' || n.status === 'undermined') {
      // Only an *unresolved* blocker really blocks. A blocker that finished since the edge
      // was drawn is not a reason to keep this row in "waiting" — it belongs in "to do".
      const blockers = graph.edges
        .filter((e) => e.blocked === n.number)
        .map((e) => byNumber.get(e.blocker))
        .filter((b) => b && b.status !== 'resolved' && b.status !== 'out-of-scope');
      if (blockers.length) waiting.push({ node: n, blockers });
      else todo.push(n);
    } else {
      todo.push(n);
    }
  }

  // The row's own text: a ticket body's optional `plain:` line wins, the title is the
  // fallback forever. The line is written at charting time, by a human or a session that
  // has the tone skills — never generated here. Absent means absent; nothing nags for it.
  const rowTitle = (n) => {
    const plain = /^plain:[ \t]*(\S.*)$/im.exec(n.body ?? '');
    return esc(plain ? plain[1].trim() : n.title);
  };

  const row = (n, box, note) =>
    `<li class="node simplerow" data-n="${n.number}"><span class="box">${box}</span>
      <span class="row-title">${rowTitle(n)}</span>${note ?? ''}</li>`;

  const section = (label, cls, items) =>
    items.length
      ? `<section class="simple-group ${cls}"><h2>${esc(label)}</h2><ul>${items.join('')}</ul></section>`
      : '';

  // No destination block here: the masthead above the stage already shows it, and the
  // checklist repeating it read as a bug. The list opens straight on the work.
  const html = [];
  html.push(`<div id="simple">`);
  html.push(section('to do', 'todo', todo.map((n) => row(n, '☐'))));
  html.push(section('in progress', 'progress', inProgress.map((n) => row(n, '☐', ' <span class="note">in progress</span>'))));
  html.push(
    section(
      'waiting',
      'waiting',
      waiting.map(({ node, blockers }) => row(node, '☐', ` <span class="note">— waiting on: ${blockers.map((b) => rowTitle(b)).join(', ')}</span>`)),
    ),
  );
  html.push(section('done', 'done', done.map((n) => row(n, '☑'))));
  html.push(`</div>`);
  stage.innerHTML = html.join('');
}

function hoverNode(num) {
  emphasise($('stage'), num);
  if (num != null) highlight($('stage'), num);
  else highlight($('stage'), null);
}

/** Selection is a `replaceState`, a class on one node, and a panel swap. Nothing else. */
function select(number) {
  if (S.selected != null) rememberScroll($('scroller'), 'ticket');
  else rememberScroll($('scroller'), 'map');
  S.selected = number;
  S.pendingComments = 0;
  writeSelection(number);

  // Selecting a ticket re-opens a closed dock, and that is the way back. The close control
  // hands the graph its full width back; asking for a ticket is asking for the surface
  // that reads one, so nothing else has to exist to undo it — and `esc` keeps exactly
  // three rungs rather than growing a fourth.
  const reopened = number != null && !S.dockOpen;
  if (reopened) {
    S.dockOpen = true;
    $('dock').hidden = false;
  }
  $('stage').querySelectorAll('.node').forEach((n) => n.classList.toggle('sel', n.dataset.n === String(number)));
  renderDock();
  // The graph pays for the dock, so it re-fits to the width that is left.
  if (reopened) renderGraph();
}

/** The button names the mode a click switches *to* — the `#more`/`less` pattern, not `#sortby`'s. */
function renderViewToggle() {
  $('viewtoggle').textContent = S.route.view === 'simple' ? 'full' : 'simple';
}

/** Flips the map between the SVG graph and the plain checklist. Never touches poll or fetch. */
function toggleView() {
  S.route.view = S.route.view === 'simple' ? 'full' : 'simple';
  writeView(S.route.view);
  renderViewToggle();
  if (S.graph) renderGraph();
}

// ------------------------------------------------------------------ agents (wfdash#4)

/**
 * One probe at boot: /api/health says whether this instance has spawn on. Only a
 * host instance started with WFDASH_SPAWN=1 does; the deployed container says
 * false and none of this runs — the page stays exactly the read-only dashboard.
 */
async function probeSpawn() {
  try {
    const h = await fetchJSON('/api/health');
    S.spawnOn = !!h.spawn;
  } catch {
    S.spawnOn = false;
  }
  if (!S.spawnOn) return;
  await pollAgents();
  S.agentTimer = setInterval(pollAgents, 15_000);
}

/**
 * The agents poll is local (a `claude agents --json` subprocess, no GitHub
 * cost). It updates the status-bar count and the selected ticket's chip in
 * place — never by re-rendering the panel, which would eat the reader's scroll
 * and selection, the same contract markNewComments keeps.
 */
async function pollAgents() {
  try {
    const r = await fetchJSON('/api/agents');
    S.agents = r.agents ?? [];
  } catch {
    S.agents = [];
  }
  renderStatus();
  if (S.route?.kind === 'map' && S.selected != null && S.graph) {
    const agent = S.agents.find((a) => a.name === `wf:${S.graph.repo}#${S.selected}`);
    const chip = $('scroller').querySelector('[data-agent-chip]');
    if (chip) {
      chip.textContent = agent?.state ?? 'none';
      chip.style.color = agent?.state === 'working' ? '#d29922' : '#8b949e';
    }
  }
}

/** POST the spawn, then poll immediately so the chip moves within a second. */
async function spawnAgent(ticket, comment) {
  try {
    const r = await fetchJSON2('/api/spawn', {
      repo: `${S.route.owner}/${S.route.repo}`,
      map: S.route.number,
      ticket,
      comment: comment || undefined,
    });
    void r;
  } catch (err) {
    const btn = $('scroller').querySelector('[data-spawn]');
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'start agent';
    }
    const chip = $('scroller').querySelector('[data-agent-chip]');
    if (chip) chip.textContent = `failed: ${err?.kind ?? 'error'}`;
    return;
  }
  await pollAgents();
  const btn = $('scroller').querySelector('[data-spawn]');
  if (btn) {
    btn.disabled = false;
    btn.textContent = 'start agent';
  }
}

/** The one POST the page makes, and only against a spawn-enabled host instance. */
async function fetchJSON2(url, body) {
  let res;
  try {
    res = await fetch(url, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' }, cache: 'no-store' });
  } catch (e) {
    throw { kind: 'server-dead', message: String(e?.message ?? e), hint: 'server not running — /wfdash' };
  }
  const payload = await res.json().catch(() => null);
  if (!payload) throw { kind: 'gh-failed', message: `unreadable reply from ${url}`, hint: 'check the server log' };
  if (payload.error) throw payload.error;
  return payload;
}

function renderError(err) {
  showOnly('error');
  $('error').innerHTML = `<h2>${esc(err.kind)}</h2><p>${esc(err.message ?? '')}</p>
    <p class="hint">${esc(err.hint ?? '')}</p>`;
}

// ------------------------------------------------------------------ the status bar

function renderStatus() {
  const bar = $('status');
  const bits = [];
  const p = S.poll;
  bits.push(`<span>${S.route?.kind === 'map' ? `poll ${MAP_INTERVAL / 1000}s` : `poll ${OVERVIEW_INTERVAL / 1000}s`}</span>`);
  // This number has moved twice under a query nobody edited, so it is read off every
  // response and shown, rather than quoted from a document.
  if (S.cost) bits.push(`<span>${esc(S.cost)}</span>`);
  // Silent truncation is designed out rather than priced around, and detecting it in the
  // Reader is only half of that — a guard whose finding never reaches the page is still
  // silent. The corpus outgrows a `first:` roughly once a year, and when it does the
  // counts on one card are quietly wrong until somebody is told.
  if (S.truncated.length) {
    const where = S.truncated.map((t) => `${t.where} ${t.have}/${t.total}`).join(', ');
    bits.push(`<span class="stale" title="${esc(where)}">truncated · ${esc(where.slice(0, 60))}</span>`);
  }
  if (S.spawnOn) {
    const working = S.agents.filter((a) => a.state === 'working').length;
    bits.push(`<span>${working} working · ${S.agents.length} agent${S.agents.length === 1 ? '' : 's'}</span>`);
  }
  if (S.ringed.size) bits.push(`<span class="chg">${S.ringed.size} changed · ${S.ringAt}</span>`);
  if (p.stale) {
    bits.push(`<span class="stale">stale · last good ${p.lastGoodAt} · ${esc(p.err?.kind ?? '')}</span>`);
    if (p.err?.hint) bits.push(`<span class="err">${esc(p.err.hint)}</span>`);
    const left = Math.max(0, Math.round((p.nextAt - Date.now()) / 1000));
    bits.push(`<span>retry in ${left}s</span>`);
  } else if (p.lastGoodAt) {
    bits.push(`<span>last good ${p.lastGoodAt}</span>`);
  }
  bits.push(`<span class="clock">poll #${p.n} · ${clock()}</span>`);
  bar.innerHTML = bits.join('');
}

// ------------------------------------------------------------------ polling

const intervalFor = () => (S.route.kind === 'map' ? MAP_INTERVAL : OVERVIEW_INTERVAL);
const stepsFor = () => (S.route.kind === 'map' ? MAP_BACKOFF : OVERVIEW_BACKOFF);

function schedule(ms) {
  clearTimeout(S.poll.timer);
  S.poll.nextAt = Date.now() + ms;
  S.poll.timer = setTimeout(() => poll('timer'), ms);
}

function onFailure(err) {
  const p = S.poll;
  p.failures++;
  p.err = err;
  // First load fails → the error page; there is nothing to preserve. A refresh failing
  // keeps the last good drawing and marks it stale, because the graph already held is a
  // complete working dashboard and blanking it over one failed poll is the worst trade
  // available.
  if (!p.lastGoodAt) {
    renderError(err);
  } else {
    p.stale = true;
  }
  schedule(backoffFor(stepsFor(), p.failures));
  renderStatus();
}

async function fetchJSON(url) {
  let res;
  try {
    res = await fetch(url, { cache: 'no-store' });
  } catch (e) {
    // Connection refused is a different failure from GitHub refusing, and the fixes
    // differ, so they are never collapsed into one message.
    throw { kind: 'server-dead', message: String(e?.message ?? e), hint: 'server not running — /wfdash' };
  }
  const body = await res.json().catch(() => null);
  if (!body) throw { kind: 'gh-failed', message: `unreadable reply from ${url}`, hint: 'check the server log' };
  if (body.error) throw body.error;
  return body;
}

/**
 * A byte-identical reply does zero DOM work — 99.4% of map-route polls. One string
 * compare, no diffing library.
 *
 * The comparison is over the *contract*, not the raw bytes: `rateLimit.remaining` and the
 * cache envelope move on every poll, so raw bytes are never identical and the property the
 * ADR measured would be quietly lost.
 */
const stableText = (fetched) =>
  S.route.kind === 'map'
    ? JSON.stringify({ repo: fetched.repo, map: fetched.map, nodes: fetched.nodes, edges: fetched.edges, truncated: fetched.truncated })
    : JSON.stringify(fetched.maps);

/** The map's own body, which changes far less often than its tickets do. */
const mapText = (graph) => JSON.stringify(graph.map);

async function poll(why) {
  const p = S.poll;
  p.n++;
  const url =
    S.route.kind === 'map'
      ? `/api/graph?repo=${encodeURIComponent(`${S.route.owner}/${S.route.repo}`)}&n=${S.route.number}`
      : '/api/overview';

  let fetched;
  try {
    fetched = await fetchJSON(url);
  } catch (err) {
    return onFailure(err);
  }

  p.failures = 0;
  p.stale = false;
  p.err = null;
  p.lastGoodAt = clock();
  p.lastSuccess = Date.now();

  const text = stableText(fetched);
  const unchanged = text === S.prevText;
  S.prevText = text;

  if (S.route.kind === 'map') applyGraph(fetched, unchanged, why);
  else applyOverview(fetched, unchanged);

  S.truncated = fetched.truncated ?? [];
  const cost = fetched.rateLimit?.cost;
  if (cost != null) S.cost = `cost ${cost}${fetched.cache ? ` · cache ${fetched.cache}` : ''}`;
  renderStatus();
  schedule(intervalFor());
}

function applyGraph(graph, unchanged, why) {
  const first = !S.graph;
  if (unchanged && !first) return;

  const nextFp = fingerprint(graph);
  const changed = first ? [] : changedNodes(S.prevFp, nextFp);
  const selectionMoved = !first && selectionChanged(S.prevFp, nextFp, S.selected);
  const before = S.graph;
  S.prevFp = nextFp;

  if (changed.length) {
    // **The ring accumulates.** Supersession was watched for an hour: 13 ring events, 12
    // wiped by a later change before anything cleared them, held 123–614s — which is
    // exactly the unrecoverable-change failure the persistent ring exists to prevent,
    // arriving on the second change instead of the first.
    changed.forEach((n) => S.ringed.add(String(n)));
    S.ringAt = clock();
  }

  if (selectionMoved && before) {
    const oldNode = before.nodes.find((n) => n.number === S.selected);
    const newNode = graph.nodes.find((n) => n.number === S.selected);
    const delta = (newNode?.comments?.length ?? 0) - (oldNode?.comments?.length ?? 0);
    if (delta > 0) {
      // The selected ticket never re-renders under the reader: scroll, expansions and text
      // selection survive, and the new prose is one click away. The graph redraws around
      // it; the panel is only *marked*, in place.
      S.pendingComments = (S.pendingComments ?? 0) + delta;
      S.pendingGraph = graph;
      S.graph = { ...graph, nodes: graph.nodes.map((n) => (n.number === S.selected ? oldNode : n)) };
      renderGraph();
      applyRings($('stage'), S.ringed);
      markNewComments($('scroller'), S.pendingComments, () => {
        S.pendingComments = 0;
        if (S.pendingGraph) S.graph = S.pendingGraph;
        S.pendingGraph = null;
        renderDock();
      });
      syncRail($('dock'), $('scroller'));
      return;
    }
  }

  const bodyMoved = !before || mapText(before) !== mapText(graph);
  S.graph = graph;
  // The masthead is rebuilt only when the map's own body moved. Rebuilding it every poll
  // would re-clamp the destination under a reader who had just pressed `more` — and the
  // record forfeits that toggle on a *reload*, which is user-initiated and rare, not on a
  // fifteen-second timer.
  if (first || bodyMoved) renderMasthead(graph);
  showOnly('stage');
  // Re-layout is an honest, instantaneous redraw with no transition of any kind.
  renderGraph();
  applyRings($('stage'), S.ringed);

  // The panel re-renders only when what it is showing actually changed, because a
  // wholesale redraw would reset a multi-minute read's scroll about eight times and take
  // every disclosure with it.
  const wasThere = before?.nodes.some((n) => n.number === S.selected);
  const isThere = graph.nodes.some((n) => n.number === S.selected);
  if (first) renderDock();
  else if (S.selected == null) {
    // The map panel is showing: only the map's own body can change it.
    if (bodyMoved) renderDock();
  } else if (selectionMoved || wasThere !== isThere) {
    renderDock();
  }
  void why;
}

function applyOverview(overview, unchanged) {
  const first = !S.maps;
  if (unchanged && !first) return;

  if (!first) {
    for (const { key, delta } of changedMaps(S.prevMaps, overview.maps)) {
      S.ringed.add(key);
      S.deltas.set(key, delta);
      S.ringAt = clock();
    }
  }
  S.prevMaps = overview.maps;
  S.maps = overview.maps;

  // The sort is computed at load and on focus and **held between polls**: reorder is rare
  // but violent and lands where the eye is — 7% of polls, then a mean 5.8 of 21 cards
  // move, and the top three change on 63% of them. Counts, ring and delta all update live
  // inside the frozen order; only position is held.
  //
  // Load and focus are the two triggers, and both are needed: a frozen order that never
  // unfreezes drifts without bound, and the measured worst case is 20 of 21 cards out of
  // place after an hour. `S.refreeze` is set by the focus path below.
  if (first || !S.order.length || S.refreeze) {
    freezeOrder();
    S.refreeze = false;
  }
  showOnly('overview');
  renderChips();
  paintOverview();
}

/**
 * Filtering happens at paint, never at fetch: the full corpus is already paid for, so
 * narrowing it costs zero queries and the filter can change between polls without one.
 * The frozen order is untouched — hiding cards is not reordering them.
 *
 * Each whitespace-separated token must match, as a substring first and as an in-order
 * subsequence second — `wfd` finds `wfdash`, `mrl` finds `meural` — so a few characters
 * from anywhere in the card's line are enough. A token containing `/` never falls back:
 * that is the chips' shape, and a chip is a grouping, not a guess — `owner/` must match
 * that owner's cards and no card whose title happens to hold the letters in order.
 */
const isSubsequence = (hay, needle) => {
  let i = 0;
  for (const ch of hay) if (ch === needle[i] && ++i === needle.length) return true;
  return needle.length === 0;
};
const matchesFilter = (m, f) => {
  const hay = `${m.repo} #${m.number} ${m.title}`.toLowerCase();
  return f.split(/\s+/).every((t) => hay.includes(t) || (!t.includes('/') && isSubsequence(hay, t)));
};

function paintOverview() {
  const host = $('overview');
  // The overview is the scroll container and the repaint replaces its whole innerHTML —
  // same trade renderGraph makes, same repair: the reader's place survives a keystroke.
  const keepScroll = host.scrollTop;
  const all = orderedMaps();
  const f = S.filter.trim().toLowerCase();
  const shown = f ? all.filter((m) => matchesFilter(m, f)) : all;
  renderOverview(shown, host, {
    ringed: S.ringed,
    deltas: S.deltas,
    total: all.length,
    onOpen: (href) => go(href),
  });
  host.scrollTop = keepScroll;
}

/**
 * Like selection, the filter only ever replaces: walking through three filters and
 * pressing `back` should leave the page, not replay the narrowings.
 *
 * Overview-only, debounced, and skipped when nothing moved. The route guard is what keeps
 * a stray write from replacing a map URL's `?t=` selection wholesale; the debounce and the
 * no-op skip are for Safari, which throttles replaceState (~100 calls per 30s) and throws —
 * mid-typing, inside the input handler — when a fast typist outruns it.
 */
let writeFilterTimer = null;
function writeFilter() {
  if (S.route?.kind !== 'overview') return;
  clearTimeout(writeFilterTimer);
  writeFilterTimer = setTimeout(() => {
    const q = new URLSearchParams();
    if (S.filter.trim()) q.set('f', S.filter.trim());
    if (S.sort !== 'banded') q.set('s', S.sort);
    const s = q.toString();
    const url = s ? `${location.pathname}?${s}` : location.pathname;
    if (url !== location.pathname + location.search) history.replaceState(null, '', url);
  }, 300);
}

/** The toggle re-freezes on purpose: changing the rule is asking for the reorder. */
function setSort(v) {
  S.sort = v;
  $('sortby').textContent = sortLabel(v);
  writeFilter();
  freezeOrder();
  paintOverview();
}

function setFilter(value) {
  S.filter = value;
  if ($('filter').value !== value) $('filter').value = value;
  writeFilter();
  renderChips();
  paintOverview();
}

/**
 * One chip per owner, drawn only when there are at least two — a single-owner corpus has
 * nothing to group. A chip is a saved keystroke, not a mode: it writes `owner/` into the
 * same filter the input holds, and clicking the active one clears it.
 */
function renderChips() {
  const owners = [...new Set((S.maps ?? []).map((m) => m.repo.split('/')[0]))].sort();
  const f = S.filter.trim().toLowerCase();
  const ownerChips =
    owners.length < 2
      ? ''
      : owners
          .map((o) => {
            const on = f === `${o.toLowerCase()}/`;
            return `<button class="chip${on ? ' on' : ''}" data-owner="${esc(o)}">${esc(o)}</button>`;
          })
          .join('');

  // Drill-in: an owner chip active (`f` is exactly `owner/`) draws one chip per repo of that
  // owner, narrowing to `owner/name`. `owner/name` also substring-matches `owner/name-longer`
  // in matchesFilter below — accepted here, same as the owner chips, because the chip always
  // writes the full repo string and a collision is a same-owner naming coincidence, not
  // something this drill-in introduces.
  const activeOwner = owners.find((o) => f === `${o.toLowerCase()}/`);
  const repos = activeOwner ? [...new Set((S.maps ?? []).filter((m) => m.repo.split('/')[0] === activeOwner).map((m) => m.repo))].sort() : [];
  const repoChips =
    repos.length < 2
      ? ''
      : repos
          .map((r) => {
            const on = f === r.toLowerCase();
            return `<button class="chip${on ? ' on' : ''}" data-repo="${esc(r)}">${esc(r.slice(activeOwner.length + 1))}</button>`;
          })
          .join('');

  $('chips').innerHTML = ownerChips + repoChips;
}

function freezeOrder() {
  const maps = S.maps ?? [];
  const metric = METRIC[S.sort];
  const sorted =
    S.sort === 'banded'
      ? sortMaps(maps)
      : S.sort === 'updated'
        ? [...maps].sort(byRecency)
        : [...maps].sort((a, b) => metric(b) - metric(a) || byRecency(a, b));
  S.order = sorted.map(mapKey);
}

function orderedMaps() {
  const byKey = new Map((S.maps ?? []).map((m) => [mapKey(m), m]));
  const out = S.order.map((k) => byKey.get(k)).filter(Boolean);
  // A map that appeared since the freeze still has to be drawn; it lands at the end until
  // the next unfreeze rather than being invisible.
  for (const m of S.maps ?? []) if (!S.order.includes(mapKey(m))) out.push(m);
  return out;
}

// ------------------------------------------------------------------ the route switch

function route() {
  const next = parseRoute(location.pathname, location.search);
  const sameMap =
    S.route?.kind === 'map' &&
    next.kind === 'map' &&
    S.route.owner === next.owner &&
    S.route.repo === next.repo &&
    S.route.number === next.number;

  S.route = next;
  S.selected = next.selected;
  // The filterbar belongs to the overview alone, and it hides *here*, at route time —
  // showOnly() also hides it, but that only runs after the map's first poll returns, and
  // the fetch-long flash of chips over a loading map was a reported bug.
  $('filterbar').hidden = next.kind !== 'overview';
  if (next.kind === 'overview') {
    // The filter arrives with the URL — a bookmarked `/?f=casa` opens narrowed — and the
    // input is synced here rather than trusted, because a `popstate` moves the URL alone.
    S.filter = next.filter ?? '';
    if ($('filter').value !== S.filter) $('filter').value = S.filter;
    S.sort = next.sort ?? 'banded';
    $('sortby').textContent = sortLabel(S.sort);
  } else {
    renderViewToggle();
  }

  if (!sameMap) {
    // Nothing about one map's state carries to another. The ring is per-surface too: a
    // ring is an "I have not seen this" mark, and leaving the surface is not seeing it.
    clearTimeout(S.poll.timer);
    S.graph = null;
    S.maps = null;
    S.prevFp = null;
    S.prevMaps = null;
    S.prevText = null;
    S.order = [];
    S.ringed = new Set();
    S.deltas = new Map();
    S.pendingComments = 0;
    S.poll = { n: 0, failures: 0, stale: false, err: null, lastGoodAt: null, lastSuccess: 0, nextAt: null, timer: null };
    S.cost = null;
    S.truncated = [];
    $('scroller').textContent = '';
    poll('load');
  } else {
    renderDock();
    $('stage').querySelectorAll('.node').forEach((n) => n.classList.toggle('sel', n.dataset.n === String(S.selected)));
  }
  renderStatus();
}

// ------------------------------------------------------------------ wiring

// `← all maps` also repairs the history: a tab *created* at a map URL carries one entry
// and `history.back()` leaves URL and document unchanged — not weak, inert. Clicking this
// takes `history.length` from 1 to 2, and the browser's back button works from then on.
// Nothing pushes a synthetic entry at load; that would lie about where the reader came from.
$('back').addEventListener('click', (e) => {
  e.preventDefault();
  go('/');
});

$('more').addEventListener('click', () => {
  const dest = $('dest');
  const clamped = dest.classList.toggle('clamped');
  $('more').textContent = clamped ? 'more' : 'less';
});

$('filter').addEventListener('input', () => setFilter($('filter').value));

$('sortby').addEventListener('click', () => setSort(SORTS[(SORTS.indexOf(S.sort) + 1) % SORTS.length]));

$('viewtoggle').addEventListener('click', toggleView);

// Delegated, and scoped to `.simplerow` alone: the SVG's `.node`s wire their own click
// inside drawGraph, and only one of the two renderers is ever in `#stage` at a time.
$('stage').addEventListener('click', (e) => {
  const row = e.target.closest('.simplerow');
  if (row) select(Number(row.dataset.n));
});

$('chips').addEventListener('click', (e) => {
  const repoChip = e.target.closest('[data-repo]');
  if (repoChip) {
    const want = repoChip.dataset.repo;
    // The active repo chip drops back one level, to the owner chip's `owner/` — not to ''.
    setFilter(S.filter.trim().toLowerCase() === want.toLowerCase() ? `${want.split('/')[0]}/` : want);
    return;
  }
  const chip = e.target.closest('[data-owner]');
  if (!chip) return;
  const want = `${chip.dataset.owner}/`;
  setFilter(S.filter.trim().toLowerCase() === want.toLowerCase() ? '' : want);
});

$('scroller').addEventListener('scroll', () => {
  rememberScroll($('scroller'), S.selected == null ? 'map' : 'ticket');
});
wireRail($('dock'), $('scroller'));

document.addEventListener('click', (e) => {
  if (e.target.closest('[data-close]')) {
    S.dockOpen = false;
    $('dock').hidden = true;
    renderGraph();
    return;
  }
  // Chrome is not the page: narrowing, sorting or chipping is *hiding* cards, and a click
  // that hides a ringed card has not seen it. Only clicks on the surface itself clear.
  if (e.target.closest('#filterbar')) return;
  // A ring is cleared **by a click and by nothing else**. A later change on a different
  // node is not evidence that you saw the earlier one.
  if (S.ringed.size) {
    S.ringed.clear();
    S.deltas.clear();
    S.ringAt = null;
    applyRings($('stage'), S.ringed);
    applyCardRings($('overview'), S.ringed);
    renderStatus();
  }
});

// One escape ladder — selection, then map, then the overview. The second press is the only
// keyboard exit on the two maps with no ticket to deselect.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  // The filter gets its own rung below the ladder: `esc` in the box clears it and hands
  // focus back to the page, so narrowing is always one key from undone.
  if (e.target === $('filter')) {
    setFilter('');
    $('filter').blur();
    return;
  }
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
  if (S.route.kind === 'overview' && S.filter) return setFilter('');
  if (S.route.kind !== 'map') return;
  if (S.selected != null) return select(null);
  // One ladder, exactly three rungs: selection, then map, then the overview. Re-opening a
  // closed dock is not a rung — the dock has its own control, and inserting a step here
  // would mean `esc` sometimes leaves the map and sometimes does not.
  go('/');
});

addEventListener('popstate', route);
addEventListener('resize', () => {
  if (S.route?.kind === 'map' && S.graph) renderGraph();
  syncRail($('dock'), $('scroller'));
});

/**
 * Hidden tabs never poll — a second dashboard tab sat open 63 minutes and polled exactly
 * once. Returning to the tab is the one moment a fixed interval always gets wrong, so it
 * refreshes immediately; but the browser also fires `focus` on a newly-opened document, so
 * a focus poll within one interval of the last success is suppressed or every tab open
 * spends double before it draws anything.
 */
function wake(why) {
  if (document.hidden) return;
  // Focus is an explicit "try now", and on the overview it is also the moment the frozen
  // order is allowed to move: the reader has just looked away and back, so nothing is
  // under the cursor.
  S.refreeze = true;
  if (Date.now() - S.poll.lastSuccess < intervalFor()) {
    // Suppressed as a *poll*, but the order still unfreezes against the counts already
    // held — otherwise a tab focused inside one interval never re-orders at all.
    if (S.route?.kind === 'overview' && S.maps) applyOverviewOrder();
    return;
  }
  S.poll.failures = 0;
  poll(why);
}

/** Re-order against the counts already held, without spending a query to do it. */
function applyOverviewOrder() {
  freezeOrder();
  S.refreeze = false;
  paintOverview();
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    clearTimeout(S.poll.timer);
    clearInterval(S.heartbeat);
    S.heartbeat = setInterval(() => fetch('/api/health', { cache: 'no-store' }).catch(() => {}), HEARTBEAT);
  } else {
    clearInterval(S.heartbeat);
    S.heartbeat = null;
    wake('visible');
  }
});
addEventListener('focus', () => wake('focus'));

setInterval(renderStatus, 1000);
route();
probeSpawn();

// What a browser-driven test reads instead of guessing at internals. It reports only what
// the page has actually rendered or measured, so an assertion here is an assertion about
// the page rather than about this file.
window.WFDASH = () => {
  const svg = document.querySelector('#stage svg');
  const vb = svg?.getAttribute('viewBox')?.split(' ');
  return {
    route: S.route,
    selected: S.selected,
    dockOpen: S.dockOpen && !$('dock').hidden,
    nodes: S.graph?.nodes.length ?? 0,
    // Counted off the drawn lane heads rather than off the graph, so it reports the columns
    // the page produced rather than the arithmetic it was given.
    lanes: document.querySelectorAll('#stage .lane-head').length,
    fit: svg && vb ? +(svg.getBoundingClientRect().width / Number(vb[2])).toFixed(3) : null,
    ringed: [...S.ringed],
    filter: S.filter,
    sort: S.sort,
    cards: document.querySelectorAll('#overview .card').length,
    truncated: S.truncated,
    ringAt: S.ringAt,
    order: S.order,
    poll: { n: S.poll.n, stale: S.poll.stale, failures: S.poll.failures, err: S.poll.err, lastGoodAt: S.poll.lastGoodAt },
    pendingComments: S.pendingComments,
    historyLength: history.length,
    url: location.pathname + location.search,
    status: $('status').innerText.replace(/\s+/g, ' ').trim(),
    mastheadHeight: $('masthead').hidden ? 0 : Math.round($('masthead').getBoundingClientRect().height),
    rail: (() => {
      const s2 = $('scroller');
      return {
        overflowing: $('dock').classList.contains('overflowing'),
        gutter: $('dock').clientWidth - s2.clientWidth,
        prose: s2.clientWidth,
        thumb: Math.round($('thumb').getBoundingClientRect().height),
      };
    })(),
    banner: $('banner').classList.contains('on') ? $('banner').innerText.replace(/\s+/g, ' ').trim() : null,
  };
};

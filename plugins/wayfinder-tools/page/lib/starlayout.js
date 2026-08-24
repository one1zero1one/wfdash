// Deterministic star-map layout, ported from chartr's web/src/lib/starmap/layout.ts
// (github.com/rengwu/chartr @ be8073f, MIT). See wfdash#3 for the adoption decision.
//
// Positions are seeded from the ticket data itself and relaxed a fixed number of
// steps, so the same map lays out the same way every load — a ticket stays where
// you learned it. The function is pure and depends only on ticket numbers and
// their blocker edges, never on status: a refresh that changes only a ticket's
// status can never move a star, because status is not an input to layout at all.

export const TAU = 6.2831853;

// A small, fast, seedable PRNG (mulberry32) — one stream, seeded constant, so a
// given map relaxes into the same shape on every machine.
export function mulberry32(seed) {
  let t = seed >>> 0;
  return function () {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

// wfdash carries edges as {blocker, blocked} pairs on the graph; chartr's layout
// wants blocker→dependent. Dangling edges are dropped so a malformed map still
// lays out.
export function edgesOf(nodes, edges) {
  const present = new Set(nodes.map((n) => n.number));
  const out = [];
  for (const e of edges ?? []) {
    if (present.has(e.blocker) && present.has(e.blocked)) out.push({ from: e.blocker, to: e.blocked });
  }
  return out;
}

// Dependency depth per node: a ticket's rank is one past its deepest blocker, so
// roots sit at rank 0 and the layout radiates outward.
export function rankOf(nodes, edges) {
  const rank = {};
  for (const n of nodes) rank[n.number] = 0;
  for (let pass = 0; pass < nodes.length; pass++) {
    for (const e of edges) {
      if (rank[e.from] === undefined || rank[e.to] === undefined) continue;
      if (rank[e.to] < rank[e.from] + 1) rank[e.to] = rank[e.from] + 1;
    }
  }
  return rank;
}

function ringR(rank) {
  return 130 + rank * 165;
}

// Compute the deterministic layout: a physics relaxation that spreads nodes into
// an organic constellation, each soft-pulled toward a radius set by its
// dependency depth. Nodes are seeded in ascending number order so the single RNG
// stream — and therefore the whole layout — is independent of arrival order.
export function computeLayout(nodes, rawEdges) {
  const sorted = [...nodes].sort((a, b) => a.number - b.number);
  const edges = edgesOf(sorted, rawEdges);
  const rank = rankOf(sorted, edges);

  const pts = {};
  const rnd = mulberry32(1337);
  for (const n of sorted) {
    const ang = rnd() * TAU;
    const jit = (rnd() - 0.5) * 70;
    const R = ringR(rank[n.number]) + jit;
    pts[n.number] = { x: Math.cos(ang) * R, y: Math.sin(ang) * R };
  }

  const REP = 9000,
    SPRING = 0.02,
    REST = 150,
    RADIAL = 0.05;
  for (let it = 0; it < 420; it++) {
    // Pairwise repulsion: stars push apart so the constellation doesn't clump.
    for (let i = 0; i < sorted.length; i++) {
      const a = pts[sorted[i].number];
      for (let j = i + 1; j < sorted.length; j++) {
        const b = pts[sorted[j].number];
        const dx = a.x - b.x,
          dy = a.y - b.y,
          d2 = dx * dx + dy * dy || 0.01,
          d = Math.sqrt(d2),
          f = REP / d2,
          ux = dx / d,
          uy = dy / d;
        a.x += ux * f;
        a.y += uy * f;
        b.x -= ux * f;
        b.y -= uy * f;
      }
    }
    // Edge springs: a blocker and its dependent settle toward a rest length, so
    // "what unblocks what" stays mostly monotonic and readable.
    for (const e of edges) {
      const a = pts[e.from],
        b = pts[e.to];
      const dx = b.x - a.x,
        dy = b.y - a.y,
        d = Math.hypot(dx, dy) || 0.01,
        f = (d - REST) * SPRING,
        ux = dx / d,
        uy = dy / d;
      a.x += ux * f;
      a.y += uy * f;
      b.x -= ux * f;
      b.y -= uy * f;
    }
    // Radial pull toward the depth ring: roots drift inward, deeper tickets rim.
    for (const n of sorted) {
      const p = pts[n.number];
      const d = Math.hypot(p.x, p.y) || 0.01,
        f = (ringR(rank[n.number]) - d) * RADIAL;
      p.x += (p.x / d) * f;
      p.y += (p.y / d) * f;
    }
  }
  return pts;
}

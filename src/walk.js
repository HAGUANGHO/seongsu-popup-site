// 실제 걷는 길로 거리를 셈한다. src/data/walk.json(OSM 보행 길 그물, tools/build_walk_graph.py)을 쓴다.
// 길찾기 서비스에 묻지 않고 브라우저에서 다익스트라로 푼다.

import { km } from './route.js';

// 길에서 이만큼 넘게 떨어진 곳은 길 그물로 셈하지 않는다
const MAX_SNAP_M = 300;

let graphPromise = null;

export function loadGraph(url = 'src/data/walk.json') {
  graphPromise ??= fetch(url).then((r) => {
    if (!r.ok) throw new Error(`walk.json ${r.status}`);
    return r.json();
  }).then(prepare).catch((err) => { graphPromise = null; throw err; });
  return graphPromise;
}

function prepare(data) {
  const s = data.scale;
  const n = data.nodes.length / 2;
  const nodes = Array.from({ length: n }, (_, i) => ({ lat: data.nodes[2 * i] / s, lng: data.nodes[2 * i + 1] / s }));
  const adj = Array.from({ length: n }, () => []);
  const edges = data.edges.map(([a, b, len, mid], id) => {
    const pts = [nodes[a]];
    for (let i = 0; i < mid.length; i += 2) pts.push({ lat: mid[i] / s, lng: mid[i + 1] / s });
    pts.push(nodes[b]);
    // 각 점까지 누적 길이(m). 끝값을 len에 맞춘다
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + km(pts[i - 1], pts[i]) * 1000);
    const k = cum[cum.length - 1] ? len / cum[cum.length - 1] : 1;
    for (let i = 0; i < cum.length; i++) cum[i] *= k;
    adj[a].push([b, len, id]);
    adj[b].push([a, len, id]);
    return { a, b, len, pts, cum };
  });
  return { nodes, edges, adj };
}

// 점을 가장 가까운 길 위로 옮긴다: 어느 길의 어디쯤(앞 꼭짓점에서 몇 m)인지
function snap(g, p) {
  const cos = Math.cos(p.lat * Math.PI / 180);
  let best = null;
  g.edges.forEach((e, id) => {
    for (let i = 0; i < e.pts.length - 1; i++) {
      const a = e.pts[i], b = e.pts[i + 1];
      const ax = (a.lng - p.lng) * cos, ay = a.lat - p.lat;
      const bx = (b.lng - p.lng) * cos, by = b.lat - p.lat;
      const dx = bx - ax, dy = by - ay;
      const L = dx * dx + dy * dy;
      const t = L ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L)) : 0;
      const x = ax + t * dx, y = ay + t * dy;
      const d2 = x * x + y * y;
      if (!best || d2 < best.d2) best = { d2, id, i, t };
    }
  });
  const e = g.edges[best.id];
  const a = e.pts[best.i], b = e.pts[best.i + 1];
  const on = { lat: a.lat + (b.lat - a.lat) * best.t, lng: a.lng + (b.lng - a.lng) * best.t };
  const along = e.cum[best.i] + (e.cum[best.i + 1] - e.cum[best.i]) * best.t;
  return { edge: best.id, seg: best.i, on, along, off: km(p, on) * 1000 };
}

// 작은 이진 힙
class Heap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  push(item) {
    const a = this.a; a.push(item);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p][0] <= a[i][0]) break;
      [a[p], a[i]] = [a[i], a[p]]; i = p;
    }
  }
  pop() {
    const a = this.a, top = a[0], last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && a[l][0] < a[m][0]) m = l;
        if (r < a.length && a[r][0] < a[m][0]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]]; i = m;
      }
    }
    return top;
  }
}

// 붙은 점 s에서 모든 꼭짓점까지의 거리
function dijkstra(g, s) {
  const n = g.nodes.length;
  const dist = new Float64Array(n).fill(Infinity);
  const prev = new Int32Array(n).fill(-1);   // 앞 꼭짓점
  const via = new Int32Array(n).fill(-1);    // 지나온 길
  const e = g.edges[s.edge];
  const heap = new Heap();
  const seed = (v, d) => { if (d < dist[v]) { dist[v] = d; via[v] = -2; heap.push([d, v]); } };
  seed(e.a, s.along);
  seed(e.b, e.len - s.along);
  while (heap.size) {
    const [d, v] = heap.pop();
    if (d > dist[v]) continue;
    for (const [w, len, id] of g.adj[v]) {
      const nd = d + len;
      if (nd < dist[w]) { dist[w] = nd; prev[w] = v; via[w] = id; heap.push([nd, w]); }
    }
  }
  return { dist, prev, via };
}

// 길의 from~to(앞 꼭짓점에서 m) 부분 모양. from > to면 거꾸로
function piece(e, from, to) {
  const lo = Math.min(from, to), hi = Math.max(from, to);
  const at = (m) => {
    let i = 0;
    while (i < e.cum.length - 2 && e.cum[i + 1] < m) i++;
    const span = e.cum[i + 1] - e.cum[i];
    const t = span ? (m - e.cum[i]) / span : 0;
    const a = e.pts[i], b = e.pts[i + 1];
    return { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t };
  };
  const out = [at(lo)];
  for (let i = 0; i < e.pts.length; i++) if (e.cum[i] > lo && e.cum[i] < hi) out.push(e.pts[i]);
  out.push(at(hi));
  return from <= to ? out : out.reverse();
}

// s에서 t까지 걷는 거리(m)와 길 모양
function legBetween(g, s, tree, t) {
  const e = g.edges[t.edge];
  let best = { m: tree.dist[e.a] + t.along, end: e.a };
  if (tree.dist[e.b] + e.len - t.along < best.m) best = { m: tree.dist[e.b] + e.len - t.along, end: e.b };
  // 같은 길 위면 바로 간다
  if (s.edge === t.edge && Math.abs(s.along - t.along) <= best.m) {
    return { m: Math.abs(s.along - t.along), path: piece(e, s.along, t.along) };
  }
  // 꼭짓점을 거슬러 올라가 모양을 잇는다
  const back = [];
  let v = best.end;
  while (tree.via[v] >= 0) {
    const ed = g.edges[tree.via[v]], u = tree.prev[v];
    back.push(ed.a === u ? ed.pts : [...ed.pts].reverse());
    v = u;
  }
  const se = g.edges[s.edge];
  const head = v === se.a ? piece(se, s.along, 0) : piece(se, s.along, se.len);
  const tail = best.end === e.a ? piece(e, 0, t.along) : piece(e, e.len, t.along);
  const path = [...head, ...back.reverse().flat(), ...tail];
  return { m: best.m, path };
}

// 여러 점 사이 걷는 거리 표. 길에서 너무 먼 점이 있으면 null (직선 어림으로 돌아간다)
export function walkTable(g, points) {
  const snaps = points.map((p) => snap(g, p));
  if (snaps.some((s) => s.off > MAX_SNAP_M)) return null;
  const trees = snaps.map((s) => dijkstra(g, s));
  const legs = points.map((p, i) => points.map((q, j) => {
    if (i === j) return { m: 0, path: [p] };
    const leg = legBetween(g, snaps[i], trees[i], snaps[j]);
    if (!Number.isFinite(leg.m)) return null;
    // 길까지 걸어 들어가는 몫도 더한다
    return { m: leg.m + snaps[i].off + snaps[j].off, path: [p, ...leg.path, q] };
  }));
  if (legs.some((row) => row.some((l) => !l))) return null;
  return legs;
}

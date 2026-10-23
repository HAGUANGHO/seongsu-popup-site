// 고른 곳들을 걷기 좋은 순서로 잇는다. 거리는 실제 걷는 길(walk.js)로 셈하고, 못 하면 직선거리로 어림한다.

// 출발 지점. 좌표는 OpenStreetMap 역 노드.
export const STARTS = [
  { id: 'seongsu', name: '성수역 (2호선)', lat: 37.5445688, lng: 127.0561016 },      // node 5935554450
  { id: 'ttukseom', name: '뚝섬역 (2호선)', lat: 37.5472351, lng: 127.0474100 },     // node 12969391184
  { id: 'seoulforest', name: '서울숲역 (수인분당선)', lat: 37.5435916, lng: 127.0447397 }, // node 6312484234
];

// 길 그물을 못 쓸 때는 직선거리의 1.3배로 어림한다. 화면에도 어림값이라고 적는다.
export const DETOUR = 1.3;
export const WALK_KMH = 4;

export function km(a, b) {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export const walkKm = (a, b) => km(a, b) * DETOUR;
export const walkMin = (d) => Math.round(d / WALK_KMH * 60);

function pathLength(start, list, dist) {
  let sum = 0, prev = start;
  for (const p of list) { sum += dist(prev, p); prev = p; }
  return sum;
}

// 가까운 곳부터 고른 뒤 2-opt로 꼬인 곳을 푼다. 출발점은 고정, 끝은 자유.
// dist(a, b)는 km. 걷는 길은 방향에 따라 조금 다를 수 있어 a→b 순서로 묻는다.
export function orderStops(start, places, dist = km) {
  const left = [...places], order = [];
  let cur = start;
  while (left.length) {
    let best = 0;
    for (let i = 1; i < left.length; i++) if (dist(cur, left[i]) < dist(cur, left[best])) best = i;
    cur = left.splice(best, 1)[0];
    order.push(cur);
  }
  let improved = true;
  while (improved) {
    improved = false;
    for (let i = 0; i < order.length - 1; i++) {
      for (let j = i + 1; j < order.length; j++) {
        const next = [...order.slice(0, i), ...order.slice(i, j + 1).reverse(), ...order.slice(j + 1)];
        if (pathLength(start, next, dist) + 1e-9 < pathLength(start, order, dist)) { order.splice(0, order.length, ...next); improved = true; }
      }
    }
  }
  return order;
}

// 출발점에서 가까운 n곳을 고른다 (1.5km 안).
export function nearest(start, places, n = 5, maxKm = 1.5) {
  return places
    .map((p) => [km(start, p), p])
    .filter(([d]) => d <= maxKm)
    .sort((a, b) => a[0] - b[0])
    .slice(0, n)
    .map(([, p]) => p);
}

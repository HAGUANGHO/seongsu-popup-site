import { STARTS, orderStops, nearest, walkKm, walkMin } from './route.js';
import { loadGraph, walkTable } from './walk.js';

const KINDS = {
  popup: { label: '팝업', color: 'var(--popup)' },
  exhibit: { label: '전시', color: 'var(--exhibit)' },
  event: { label: '행사', color: 'var(--event)' },
};
const WHEN = [
  ['all', '전체'],
  ['open', '오늘 열림'],
  ['weekend', '이번 주말'],
  ['ending', '곧 끝남'],
  ['soon', '곧 시작'],
];
const WEEKDAYS = '일월화수목금토';

// ---------- 작은 도우미 ----------

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) node.append(c);
  return node;
}

const load = (key, fallback) => {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
};
const save = (key, value) => {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* 저장 못 해도 화면은 돈다 */ }
};

// 지도는 캔버스로 그려서 CSS 변수를 바로 못 쓴다
const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

const safeLink =(url) => (/^https?:\/\//.test(url || '') ? url : null);

// 위치를 모르는 곳은 카카오맵 검색 링크로만 잇는다 (키 없음, 카카오 자료를 받거나 저장하지 않음)
// 검색어: manual.json의 search가 있으면 그것('' 이면 링크 없음), 없으면 장소 이름(괄호 밖이 비면 괄호 안)
function kakaoSearch(ev) {
  let q = ev.search;
  if (q == null) {
    const place = ev.place || '';
    const outer = place.replace(/\(.*?\)/g, ' ').replace(/^\s*성수동?\s*/, '').trim();
    q = outer || (place.match(/\((.*?)\)/) || [])[1] || ev.title;
  }
  return q ? 'https://map.kakao.com/link/search/' + encodeURIComponent(`성수 ${q}`) : null;
}

// 'YYYY-MM-DD' → 그날 0시 (브라우저 시간대)
const day = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const fmt = (d) => `${d.getMonth() + 1}.${d.getDate()}(${WEEKDAYS[d.getDay()]})`;
const daysBetween = (a, b) => Math.round((b - a) / 86400000);

function todayDate() {
  const n = new Date();
  return new Date(n.getFullYear(), n.getMonth(), n.getDate());
}

// 이번 주말: 오늘이 주말이면 오늘~일요일, 아니면 다가오는 토·일
function weekendRange(today) {
  const dow = today.getDay();
  const sat = new Date(today); sat.setDate(today.getDate() + (dow === 0 ? -1 : 6 - dow));
  const sun = new Date(sat); sun.setDate(sat.getDate() + 1);
  return [dow === 0 || dow === 6 ? today : sat, sun];
}

function matchesWhen(ev, when, today) {
  const s = day(ev.start), e = day(ev.end);
  switch (when) {
    case 'open': return s <= today && today <= e;
    case 'weekend': { const [a, b] = weekendRange(today); return s <= b && a <= e; }
    case 'ending': return s <= today && daysBetween(today, e) <= 3 && e >= today;
    case 'soon': return s > today && daysBetween(today, s) <= 14;
    default: return e >= today;
  }
}

function status(ev, today) {
  const s = day(ev.start), e = day(ev.end);
  if (s > today) {
    const n = daysBetween(today, s);
    return { text: n === 1 ? '내일 시작' : `${n}일 뒤 시작`, tone: 'soon' };
  }
  const left = daysBetween(today, e);
  if (left === 0) return { text: '오늘 마감', tone: 'ending' };
  if (left <= 3) return { text: `${left}일 남음`, tone: 'ending' };
  return { text: '열림', tone: 'open' };
}

// ---------- 상태 ----------

const state = {
  events: [],
  when: 'all',
  kinds: new Set(Object.keys(KINDS)),
  freeOnly: false,
  plan: load('seongsu.plan', []),        // 담은 곳 id
  start: load('seongsu.start', STARTS[0].id),
  tab: 'list',
  perks: [],
  perkArea: 'all',
};

let map, markerLayer, planLayer;
// 보행 길 그물: 동선에 담은 곳이 생기면 그때 불러온다
const walk = { graph: null, failed: false, key: '', table: null };
const markers = new Map();

// ---------- 지도 ----------

function setupMap() {
  map = L.map('map', { preferCanvas: true, fadeAnimation: false, zoomControl: false })
    .setView([37.5445, 127.0535], 15);
  L.control.zoom({ position: 'bottomright' }).addTo(map);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> 기여자',
  }).addTo(map);
  markerLayer = L.layerGroup().addTo(map);
  planLayer = L.layerGroup().addTo(map);
  setupFocus();
  window.__map = map;
}

// ---------- 고른 점 강조 (국토종주와 같은 기준, 사용자 요청) ----------
// 말풍선이 열리면 지도 전체를 반투명 어두운 막(dimPane)으로 덮고, 고른 점만 막 위(focusPane)에 크게 다시 그린다.
// 층 순서: 점(오버레이 400) < 어두운 막(450) < 고른 점(620) < 말풍선(700)
// PC(마우스)는 올리기만 해도 열고(지도는 옮기지 않음), 점과 말풍선 밖으로 나가면 닫는다.
// 누르면 고정되고, 고정된 동안에는 지도를 움직이지 않는다. 지도 빈 곳을 누르거나 Esc로 닫는다.
// marker.hoverMode: 'hover'(올려서 연 것) | 'pinned'(눌러서 연 것) | null
const canHover = matchMedia('(hover: hover) and (pointer: fine)').matches;
let focus = null;
let focusLayer = null;
let focusRenderer = null;

function setupFocus() {
  const dimPane = map.createPane('dimPane');
  dimPane.style.zIndex = 450;
  dimPane.style.pointerEvents = 'none';
  dimPane.append(el('div', { class: 'map-dim' }));
  map.createPane('focusPane').style.zIndex = 620;
  focusRenderer = L.svg({ pane: 'focusPane' });
  focusLayer = L.layerGroup().addTo(map);
  // 안전장치: 말풍선이 하나도 없는데 막이 남아 있으면 걷는다
  const clearStale = () => setTimeout(() => {
    if (focus && !map.getContainer().querySelector('.leaflet-popup')) setFocus(null);
  }, 0);
  map.on('popupclose', clearStale);
  map.on('click', clearStale);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') map.closePopup(); });
}

function setFocus(next) {
  focus = next;
  const pinned = Boolean(next && !next.hover);
  map.getContainer().classList.toggle('map-focus', Boolean(next));
  for (const h of ['scrollWheelZoom', 'dragging', 'doubleClickZoom', 'touchZoom', 'boxZoom', 'keyboard']) {
    if (pinned) map[h]?.disable(); else map[h]?.enable();
  }
  focusLayer.clearLayers();
  if (next) {
    const ll = next.marker.getLatLng();
    const r = next.marker.options.radius;
    L.circleMarker(ll, {
      pane: 'focusPane', renderer: focusRenderer, radius: r + 5, stroke: false, fillColor: '#000', fillOpacity: 0.35, interactive: false,
    }).addTo(focusLayer);
    L.circleMarker(ll, {
      ...next.marker.options, pane: 'focusPane', renderer: focusRenderer, radius: r + 3, interactive: false,
    }).addTo(focusLayer);
  }
  window.__focusDebug = next ? (next.hover ? 'hover' : 'pinned') : null;
}

function hoverPopup(marker) {
  marker.on('popupopen', () => {
    if (marker.hoverMode !== 'hover') resetNudge(marker.getPopup());
    setFocus({ marker, hover: marker.hoverMode === 'hover' });
  });
  marker.on('popupclose', () => { marker.hoverMode = null; });
  if (!canHover) return;
  let timer = null;
  let openTimer = null;
  const keep = () => clearTimeout(timer);
  const leave = () => {
    keep();
    timer = setTimeout(() => { if (marker.hoverMode === 'hover') marker.closePopup(); }, 200);
  };
  // 점 위를 빠르게 스쳐 지나갈 때 엉키지 않게, 잠깐 머물러야 연다
  marker.on('mouseover', () => {
    keep();
    clearTimeout(openTimer);
    if ((focus && !focus.hover) || marker.isPopupOpen()) return; // 고정된 말풍선이 있으면 그대로 둔다
    openTimer = setTimeout(() => {
      if ((focus && !focus.hover) || marker.isPopupOpen() || !marker._map) return;
      openHover(marker);
      const box = marker.getPopup().getElement();
      if (box && !box.hoverBound) { // 말풍선 안으로 마우스를 옮겨 버튼을 누를 수 있게
        box.hoverBound = true;
        box.addEventListener('mouseenter', keep);
        box.addEventListener('mouseleave', leave);
      }
    }, 80);
  });
  marker.on('mouseout', () => {
    clearTimeout(openTimer);
    leave();
  });
  marker.on('click', () => {
    keep();
    clearTimeout(openTimer);
    marker.hoverMode = 'pinned';
    if (marker.isPopupOpen()) setFocus({ marker, hover: false });
  });
}

// 지도를 옮기지 않고 '올려서 연' 말풍선으로 연다
function openHover(marker) {
  const popup = marker.getPopup();
  const { autoPan } = popup.options;
  popup.options.autoPan = false;
  marker.hoverMode = 'hover';
  marker.openPopup();
  popup.options.autoPan = autoPan;
  nudgePopup(popup);
}

// 올려서 연 말풍선이 왼쪽 카드에 가리거나 화면 밖으로 나가면 몸통만 옆으로 비킨다 (꼬리는 그대로 점을 가리킨다)
function nudgePopup(popup) {
  const box = popup.getElement();
  const wrap = box?.querySelector('.leaflet-popup-content-wrapper');
  if (!wrap) return;
  wrap.style.transform = '';
  const gap = 8;
  const mapBox = map.getContainer().getBoundingClientRect();
  const sheet = document.querySelector('.sheet').getBoundingClientRect();
  const left = (isMobile() ? mapBox.left : Math.max(mapBox.left, sheet.right)) + gap;
  const right = mapBox.right - gap;
  const r = wrap.getBoundingClientRect();
  let dx = 0;
  if (r.right > right) dx = right - r.right;
  if (r.left + dx < left) dx = left - r.left;
  wrap.style.transform = dx ? `translateX(${Math.round(dx)}px)` : '';
}

function resetNudge(popup) {
  popup.getElement()?.querySelector('.leaflet-popup-content-wrapper')?.style.removeProperty('transform');
}

function popupContent(ev) {
  const today = todayDate();
  const st = status(ev, today);
  const link = safeLink(ev.link);
  return el('div', { class: 'pop' },
    el('span', { class: `badge ${ev.kind}` }, KINDS[ev.kind].label),
    el('strong', {}, ev.title),
    ev.about && el('p', { class: 'about' }, ev.about),
    el('div', { class: 'pop-info' },
      el('p', {}, `${fmt(day(ev.start))} ~ ${fmt(day(ev.end))} · ${st.text}`),
      ev.place && el('p', {}, ev.place),
      giftList(ev),
      ev.approx && el('p', { class: 'muted' }, '대략 위치예요(길 위치로 찍었어요).')),
    el('div', { class: 'pop-actions' },
      planButton(ev),
      link && el('a', { href: link, target: '_blank', rel: 'noopener' }, '공식 안내 ↗')));
}

function drawMarkers(list) {
  markerLayer.clearLayers();
  markers.clear();
  for (const ev of list) {
    if (ev.nopin) continue;
    const m = L.circleMarker([ev.lat, ev.lng], {
      radius: ev.kind === 'popup' ? 8 : 6,
      color: '#fff', weight: 2,
      fillColor: cssVar(`--${ev.kind}`),
      fillOpacity: 1,
    }).bindPopup(() => popupContent(ev), { maxWidth: 260 });
    hoverPopup(m);
    m.addTo(markerLayer);
    markers.set(ev.id, m);
  }
  window.__mapDebug = { markers: markers.size };
}

function focusEvent(ev) {
  map.setView([ev.lat, ev.lng], Math.max(map.getZoom(), 16));
  markers.get(ev.id)?.openPopup();
  if (isMobile()) setSheetOpen(false);
}

// ---------- 목록 ----------

function visibleEvents() {
  const today = todayDate();
  return state.events.filter((ev) => state.kinds.has(ev.kind) && matchesWhen(ev, state.when, today)
    && (!state.freeOnly || hasFree(ev)));
}

function planButton(ev) {
  if (ev.nopin) return null;  // 위치를 모르면 동선에 넣을 수 없다
  const inPlan = state.plan.includes(ev.id);
  return el('button', {
    type: 'button',
    class: `btn small ${inPlan ? 'on' : ''}`,
    'aria-pressed': String(inPlan),
    onclick: (e) => { e.stopPropagation(); togglePlan(ev.id); },
  }, inPlan ? '✓ 담았어요' : '+ 동선에 담기');
}

// 사지 않아도 받거나 해 볼 수 있는 게 있는 곳: 구매 조건 없는 사은품·체험, 또는 무료 입장
function hasFree(ev) {
  return (ev.gifts || []).some((g) => g.how !== '구매 시 증정') || /무료/.test(ev.fee || '');
}

// 사은품 줄: [선착순] 키링 · 하루 100명
function giftList(ev) {
  if (!ev.gifts?.length) return null;
  return el('ul', { class: 'gifts' }, ev.gifts.map((g) => el('li', {},
    el('span', { class: 'gift-icon', 'aria-hidden': 'true' }, '🎁'),
    g.how && el('span', { class: `how ${HOW_TONE[g.how] || ''}` }, g.how),
    el('span', {}, g.what + (g.note ? ` · ${g.note}` : '')))));
}
const HOW_TONE = { '선착순': 'rush', '추첨': 'luck', '뽑기': 'luck', '100% 증정': 'sure', '구매 시 증정': 'buy', '참여 시 증정': 'sure' };

function card(ev, today) {
  const st = status(ev, today);
  const link = safeLink(ev.link);
  const isNew = ev.added && daysBetween(day(ev.added), today) <= 2;
  return el('li', { class: 'card', 'data-id': ev.id },
    el('button', { type: 'button', class: 'card-main', onclick: () => ev.nopin || focusEvent(ev) },
      el('div', { class: 'card-tags' },
        el('span', { class: `badge ${ev.kind}` }, KINDS[ev.kind].label),
        el('span', { class: `status ${st.tone}` }, st.text),
        isNew && el('span', { class: 'status new' }, '새로 올라옴')),
      el('strong', { class: 'card-title' }, ev.title),
      ev.about && el('span', { class: 'card-about' }, ev.about),
      el('span', { class: 'card-meta' }, `${fmt(day(ev.start))} ~ ${fmt(day(ev.end))}${ev.time ? ' · ' + ev.time : ''}`),
      ev.place && el('span', { class: 'card-meta' }, ev.place + (ev.fee ? ` · ${ev.fee}` : '')),
      ev.nopin && el('span', { class: 'card-meta nopin' }, '📍 정확한 위치는 확인 중이라 지도에 없어요.'),
      giftList(ev)),
    el('div', { class: 'card-actions' },
      planButton(ev),
      ev.nopin && kakaoSearch(ev) && el('a', { class: 'btn small', href: kakaoSearch(ev), target: '_blank', rel: 'noopener' }, '카카오맵에서 찾기 ↗'),
      link && el('a', { class: 'btn small ghost', href: link, target: '_blank', rel: 'noopener' }, '공식 안내 ↗')));
}

function renderChips() {
  const when = document.getElementById('when-chips');
  when.replaceChildren(...WHEN.map(([id, label]) => el('button', {
    type: 'button', class: 'chip', 'aria-pressed': String(state.when === id),
    onclick: () => { state.when = id; renderList(); },
  }, label)));
  const kinds = document.getElementById('kind-chips');
  kinds.replaceChildren(...Object.entries(KINDS).map(([id, k]) => el('button', {
    type: 'button', class: `chip kind ${id}`, 'aria-pressed': String(state.kinds.has(id)),
    onclick: () => {
      if (state.kinds.has(id) && state.kinds.size > 1) state.kinds.delete(id); else state.kinds.add(id);
      renderList();
    },
  }, k.label)), el('button', {
    type: 'button', class: 'chip gift', 'aria-pressed': String(state.freeOnly),
    onclick: () => { state.freeOnly = !state.freeOnly; renderList(); },
  }, '🎁 무료로 받거나 해 볼 수 있는 곳'));
}

function renderList() {
  renderChips();
  const today = todayDate();
  const list = visibleEvents();
  const popups = list.filter((e) => e.kind === 'popup').length;
  const free = list.filter(hasFree).length;
  const nopin = list.filter((e) => e.nopin).length;
  // 기간·종류로 걸러 보일 때는 아직 안 끝난 전체 수도 함께 적는다 (시작 전인 곳이 빠져 보이는 걸 헷갈리지 않게)
  const total = state.events.filter((e) => matchesWhen(e, 'all', today)).length;
  document.getElementById('list-count').textContent = list.length
    ? `${list.length < total ? `전체 ${total}곳 중 ` : ''}${list.length}곳${popups ? ` · 팝업 ${popups}` : ''}${free ? ` · 무료 혜택 ${free}` : ''}${nopin ? ` · 지도에 없음 ${nopin}` : ''}` : '';
  const cards = document.getElementById('cards');
  cards.replaceChildren(...(list.length
    ? list.map((ev) => card(ev, today))
    : [el('li', { class: 'empty' }, state.events.length ? '이 조건에 맞는 곳이 없어요. 기간을 바꿔 보세요.' : '아직 모은 곳이 없어요.')]));
  drawMarkers(list);
}

// ---------- 동선 ----------

function togglePlan(id) {
  const i = state.plan.indexOf(id);
  if (i >= 0) state.plan.splice(i, 1); else state.plan.push(id);
  save('seongsu.plan', state.plan);
  renderList();
  renderPlan();
}

function startPoint() {
  return STARTS.find((s) => s.id === state.start) || STARTS[0];
}

function renderPlan() {
  const byId = new Map(state.events.map((e) => [e.id, e]));
  // 끝났거나 사라진 곳은 동선에서 뺀다
  const today = todayDate();
  state.plan = state.plan.filter((id) => byId.has(id) && !byId.get(id).nopin && day(byId.get(id).end) >= today);
  save('seongsu.plan', state.plan);
  document.getElementById('plan-count').textContent = state.plan.length || '';

  const start = startPoint();
  const items = state.plan.map((id) => byId.get(id));
  const table = walkLegs(start, items);
  const pts = [start, ...items];
  const leg = (a, b) => table?.[pts.indexOf(a)][pts.indexOf(b)];
  const dist = table ? (a, b) => leg(a, b).m / 1000 : walkKm;
  const ordered = orderStops(start, items, dist);
  const stops = document.getElementById('stops');
  const rows = [el('li', { class: 'stop start' }, el('span', { class: 'num' }, '출발'), el('strong', {}, start.name))];
  let total = 0, prev = start;
  ordered.forEach((ev, i) => {
    const d = dist(prev, ev);
    total += d;
    const st = status(ev, today);
    rows.push(el('li', { class: 'leg' }, `걸어서 약 ${walkMin(d)}분 · ${d < 1 ? Math.round(d * 1000) + 'm' : d.toFixed(1) + 'km'}`));
    rows.push(el('li', { class: 'stop' },
      el('span', { class: 'num' }, String(i + 1)),
      el('button', { type: 'button', class: 'stop-main', onclick: () => focusEvent(ev) },
        el('strong', {}, ev.title),
        el('span', { class: 'card-meta' }, `${ev.place || ''}${st.tone !== 'open' ? ' · ' + st.text : ''}`)),
      el('button', { type: 'button', class: 'icon-btn', 'aria-label': `${ev.title} 빼기`, onclick: () => togglePlan(ev.id) }, '✕')));
    prev = ev;
  });
  stops.replaceChildren(...(ordered.length ? rows : []));
  document.getElementById('plan-empty').hidden = ordered.length > 0;
  document.getElementById('clear-plan').hidden = !ordered.length;
  document.getElementById('plan-summary').textContent = ordered.length
    ? `${ordered.length}곳 · 걷는 거리 약 ${total.toFixed(1)}km · 약 ${walkMin(total)}분 ${table
      ? '(지도 위 걷는 길 기준, 시속 4km로 셈했어요)'
      : walk.graph || walk.failed ? '(직선거리의 1.3배로 어림했어요)' : '(걷는 길을 찾는 중이에요)'}`
    : '';

  planLayer.clearLayers();
  if (state.tab === 'plan' && ordered.length) {
    const stopPts = [start, ...ordered];
    if (table) {
      // 실제 걷는 길을 따라 그린다
      const line = stopPts.slice(1).flatMap((p, i) => leg(stopPts[i], p).path.map((q) => [q.lat, q.lng]));
      L.polyline(line, { color: cssVar('--accent'), weight: 5, opacity: .9, lineJoin: 'round' }).addTo(planLayer);
    } else {
      L.polyline(stopPts.map((p) => [p.lat, p.lng]), { color: cssVar('--accent'), weight: 4, dashArray: '2 8', lineCap: 'round' }).addTo(planLayer);
    }
    const pts = stopPts.map((p) => [p.lat, p.lng]);
    L.marker([start.lat, start.lng], { icon: L.divIcon({ className: 'num-pin start', html: '출발', iconSize: null }) }).addTo(planLayer);
    ordered.forEach((ev, i) => L.marker([ev.lat, ev.lng], {
      icon: L.divIcon({ className: 'num-pin', html: String(i + 1), iconSize: [26, 26] }),
    }).on('click', () => markers.get(ev.id)?.openPopup() ?? focusEvent(ev)).addTo(planLayer));
    fitTo(pts);
  }
  window.__planDebug = { order: ordered.map((e) => e.id), km: total, walked: !!table };
}

// 출발점과 담은 곳 사이 걷는 거리 표. 길 그물이 아직 없으면 불러오고 null (그동안은 직선 어림)
function walkLegs(start, items) {
  if (!items.length) return null;
  if (!walk.graph) {
    if (!walk.failed && !walk.loading) {
      walk.loading = true;
      loadGraph()
        .then((g) => { walk.graph = g; })
        .catch(() => { walk.failed = true; })
        .finally(() => { walk.loading = false; renderPlan(); });
    }
    return null;
  }
  const key = [start.id, ...items.map((e) => e.id)].join('|');
  if (key !== walk.key) {
    walk.key = key;
    walk.table = walkTable(walk.graph, [start, ...items]);
  }
  return walk.table;
}

function suggest() {
  const today = todayDate();
  const open = state.events.filter((e) => e.kind === 'popup' && !e.nopin && matchesWhen(e, 'open', today));
  const picked = nearest(startPoint(), open, 5);
  if (!picked.length) {
    document.getElementById('plan-summary').textContent = '출발 지점 1.5km 안에 오늘 열린 팝업이 없어요.';
    return;
  }
  state.plan = picked.map((e) => e.id);
  save('seongsu.plan', state.plan);
  renderList();
  renderPlan();
}

// ---------- 화면 틀 ----------

const isMobile = () => matchMedia('(max-width: 720px)').matches;

function setSheetOpen(open) {
  document.body.classList.toggle('sheet-closed', !open);
  const handle = document.querySelector('.sheet-handle');
  handle.setAttribute('aria-expanded', String(open));
  handle.setAttribute('aria-label', open ? '목록 접기' : '목록 보기');
  setTimeout(() => map.invalidateSize(), 250);
}

// 카드에 가려지는 부분을 빼고 맞춘다
function fitTo(points) {
  const sheet = document.querySelector('.sheet').getBoundingClientRect();
  const closed = document.body.classList.contains('sheet-closed');
  const pad = isMobile()
    ? { paddingTopLeft: [30, 30], paddingBottomRight: [30, closed ? 60 : window.innerHeight - sheet.top + 20] }
    : { paddingTopLeft: [sheet.right + 30, 40], paddingBottomRight: [60, 40] };
  map.fitBounds(L.latLngBounds(points), { ...pad, maxZoom: 16 });
}

function setTab(tab) {
  state.tab = tab;
  for (const b of document.querySelectorAll('[data-tab]')) b.setAttribute('aria-selected', String(b.dataset.tab === tab));
  for (const id of ['list', 'plan', 'perks']) document.getElementById(`tab-${id}`).hidden = tab !== id;
  renderPlan();
  if (tab === 'perks') renderPerks();
}

// ---------- 가입 혜택 ----------

// 매장 혜택만 모은다 (온라인 혜택은 싣지 않음)
const PERK_AREAS = [['all', '전체'], ['seongsu', '성수'], ['other', '다른 동네']];
const inSeongsu = (p) => /성수|서울숲/.test(p.area || '');
const PERK_TONE = { '응모': 'luck', '출석': 'luck', '퀴즈': 'luck' };

// 매장 혜택은 카카오맵 검색 링크로만 잇는다 (키 없음, 저장 없음)
const perkMap = (p) => 'https://map.kakao.com/link/search/'
  + encodeURIComponent(p.place.includes(p.brand) ? p.place : `${p.brand} ${p.place}`);

function perkCard(p, today) {
  const link = safeLink(p.link);
  const left = p.end ? daysBetween(today, day(p.end)) : null;
  const status = left == null ? { text: '상시', tone: 'open' }
    : left === 0 ? { text: '오늘 마감', tone: 'ending' }
      : left <= 3 ? { text: `${left}일 남음`, tone: 'ending' } : { text: `${fmt(day(p.end))}까지`, tone: 'open' };
  return el('li', { class: 'card perk', 'data-id': p.id },
    el('div', { class: 'card-main' },
      el('div', { class: 'card-tags' },
        el('span', { class: `badge ${inSeongsu(p) ? 'popup' : 'event'}` }, p.area || '매장'),
        el('span', { class: `status ${status.tone}` }, status.text)),
      el('strong', { class: 'card-title' }, p.title),
      el('span', { class: 'card-meta' }, [p.brand, p.place].filter(Boolean).join(' · ')),
      p.address && el('span', { class: 'card-meta' }, p.address),
      el('ul', { class: 'gifts' }, el('li', {},
        el('span', { class: 'gift-icon', 'aria-hidden': 'true' }, '🎁'),
        el('span', { class: `how ${PERK_TONE[p.how] || 'sure'}` }, p.how),
        el('span', {}, p.what + (p.note ? ` · ${p.note}` : '')))),
      el('span', { class: 'card-meta' }, p.end
        ? `${p.start ? fmt(day(p.start)) : ''} ~ ${fmt(day(p.end))}`
        : `끝나는 날 안 알려짐 · ${fmt(day(p.checked))} 확인`)),
    el('div', { class: 'card-actions' },
      el('a', { class: 'btn small', href: perkMap(p), target: '_blank', rel: 'noopener' }, '카카오맵에서 찾기 ↗'),
      link && el('a', { class: 'btn small ghost', href: link, target: '_blank', rel: 'noopener' }, '공식 안내 ↗')));
}

function renderPerks() {
  const today = todayDate();
  const live = state.perks.filter((p) => p.channel === 'store' && (!p.end || day(p.end) >= today));
  const list = live.filter((p) => state.perkArea === 'all' || (state.perkArea === 'seongsu') === inSeongsu(p));
  document.getElementById('perk-chips').replaceChildren(...PERK_AREAS.map(([id, label]) => el('button', {
    type: 'button', class: 'chip', 'aria-pressed': String(state.perkArea === id),
    onclick: () => { state.perkArea = id; renderPerks(); },
  }, label)));
  const seongsu = live.filter(inSeongsu).length;
  document.getElementById('perk-count').textContent = live.length
    ? `${list.length < live.length ? `전체 ${live.length}건 중 ` : ''}${list.length}건 · 성수 ${seongsu} · 다른 동네 ${live.length - seongsu}` : '';
  document.getElementById('perk-cards').replaceChildren(...(list.length
    ? list.map((p) => perkCard(p, today))
    : [el('li', { class: 'empty' }, live.length ? '이 조건에 맞는 혜택이 없어요.' : '아직 모은 혜택이 없어요.')]));
  window.__perkDebug = { shown: list.length, live: live.length };
}

async function main() {
  setupMap();
  for (const b of document.querySelectorAll('[data-tab]')) b.addEventListener('click', () => setTab(b.dataset.tab));
  document.querySelector('.sheet-handle').addEventListener('click', () =>
    setSheetOpen(document.body.classList.contains('sheet-closed')));

  const select = document.getElementById('start-select');
  select.replaceChildren(...STARTS.map((s) => el('option', { value: s.id, selected: s.id === state.start }, s.name)));
  select.addEventListener('change', () => { state.start = select.value; save('seongsu.start', state.start); renderPlan(); });
  document.getElementById('suggest').addEventListener('click', suggest);
  document.getElementById('clear-plan').addEventListener('click', () => {
    state.plan = []; save('seongsu.plan', []); renderList(); renderPlan();
  });

  try {
    const res = await fetch('src/data/events.json', { cache: 'no-cache' });
    const data = await res.json();
    state.events = data.events.filter((e) => KINDS[e.kind] && (Number.isFinite(e.lat) || e.nopin));
    document.getElementById('updated').textContent = `매일 아침 새로 모아요 · ${data.checked} 확인`;
  } catch {
    document.getElementById('updated').textContent = '목록을 불러오지 못했어요. 잠시 뒤 다시 열어 주세요.';
  }
  try {
    const res = await fetch('src/data/perks.json', { cache: 'no-cache' });
    state.perks = (await res.json()).perks || [];
  } catch { /* 혜택 목록이 없어도 지도는 돈다 */ }
  renderList();
  renderPlan();
  // 처음에는 보이는 곳이 다 들어오게 (카드에 가리는 쪽은 빼고)
  const first = visibleEvents().filter((e) => !e.nopin);
  if (first.length) fitTo(first.map((e) => [e.lat, e.lng]));
  document.body.dataset.ready = '1';
}

main();

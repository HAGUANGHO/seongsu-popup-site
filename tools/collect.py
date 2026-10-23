"""성수동 팝업·행사를 모아 src/data/events.json을 만든다. 하루 한 번 GitHub Actions가 돌린다.

자료원 (모두 저장·재배포가 허용된 것만 쓴다. 사진·소개 문장은 가져오지 않는다)
  1. 서울시 문화행사 정보 (서울 열린데이터광장 OA-15486, 공공누리 1유형, 하루 1회 갱신)
     키: 환경변수 SEOUL_API_KEY (없으면 건너뛴다)
  2. data/manual.json: 공식 발표(브랜드 공식 계정·보도자료)를 보고 사람이 적은 사실 + 원문 링크

주소 → 좌표
  1. 통계청 SGIS 지오코딩 (건물 번지까지). 키: SGIS_KEY, SGIS_SECRET (없으면 건너뛴다)
     약관: 키는 발급받은 사람만, 하루 5만 회, 영업 활동은 사전 승낙 필요 (2026-10-22 확인)
  2. OSM Nominatim (번지를 못 찾으면 길 위치 → '대략 위치')

실행: .venv\\Scripts\\python tools\\collect.py
"""
import json
import math
import os
import re
import sys
import time
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'src' / 'data' / 'events.json'
MANUAL = ROOT / 'data' / 'manual.json'
SEEN = ROOT / 'data' / 'seen.json'           # 처음 본 날 (새로 올라온 표시용)
GEOCODE_CACHE = ROOT / 'data' / 'geocode-cache.json'
PERKS = ROOT / 'data' / 'perks.json'             # 가입·팔로우·인증으로 받는 혜택 (사람이 확인해 적음)
PERKS_OUT = ROOT / 'src' / 'data' / 'perks.json'
PERK_STALE_DAYS = 90                              # 끝나는 날 없는 상시 혜택은 이만큼 다시 확인 안 하면 내린다
PERK_FIELDS = ('id', 'title', 'brand', 'channel', 'place', 'address', 'area', 'start', 'end',
               'what', 'how', 'note', 'link', 'checked')

KST = timezone(timedelta(hours=9))
USER_AGENT = 'seongsu-popup/0.1 (+https://github.com/HAGUANGHO)'

# 성수동 범위 (서울숲~성수역~뚝섬유원지 앞). 이 안의 행사만 싣는다.
BBOX = {'south': 37.532, 'north': 37.556, 'west': 127.036, 'east': 127.072}


def load_json(path, default):
    try:
        return json.loads(path.read_text(encoding='utf-8'))
    except FileNotFoundError:
        return default


def save_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')


def get(url, timeout=30):
    req = urllib.request.Request(url, headers={'User-Agent': USER_AGENT})
    with urllib.request.urlopen(req, timeout=timeout) as res:
        return res.read().decode('utf-8')


def in_seongsu(lat, lng):
    return BBOX['south'] <= lat <= BBOX['north'] and BBOX['west'] <= lng <= BBOX['east']


def same_event(a, b):
    """기간이 같고, 이름이 한쪽에 다 들어가고, (둘 다 위치가 있으면) 200m 안이면 같은 행사로 본다."""
    if (a['start'], a['end']) != (b['start'], b['end']):
        return False
    na, nb = (re.sub(r'\[.*?\]|[^0-9a-z가-힣]', '', e['title'].lower()) for e in (a, b))
    if not na or not nb or (na not in nb and nb not in na):
        return False
    if 'lat' in a and 'lat' in b:
        return math.hypot((a['lat'] - b['lat']) * 111000, (a['lng'] - b['lng']) * 88000) < 200
    return True


# 사은품 받는 방식. 앞의 것이 먼저 잡힌다 (예: '선착순 100% 증정'은 선착순)
GIFT_HOW = [
    ('뽑기', r'뽑기|럭키\s*드로우|가챠|랜덤\s*박스'),
    ('추첨', r'추첨|응모|경품'),
    ('선착순', r'선착순'),
    ('100% 증정', r'100\s*%|전원|모든\s*(방문객|분)'),
    ('구매 시 증정', r'구매\s*(시|고객|금액)|이상\s*구매'),
    ('참여 시 증정', r'참여\s*(시|고객|하면)|인증\s*시|팔로우'),
]
GIFT_WORDS = r'사은품|증정|굿즈|경품|선물|기념품|뽑기|럭키\s*드로우|추첨'
GIFT_HOWS = [h for h, _ in GIFT_HOW]


def gift_how(text):
    for how, pattern in GIFT_HOW:
        if re.search(pattern, text, re.I):
            return how
    return ''


def gifts_from_text(text):
    """서울시 자료(공공누리 1유형)의 소개 글에서 사은품 문장을 찾는다."""
    out = []
    for sentence in re.split(r'(?<=[.!?])\s+|\n|·|※|-\s', text or ''):
        s = sentence.strip(' -*※·')
        if len(s) < 4 or not re.search(GIFT_WORDS, s):
            continue
        out.append({'what': s[:80], 'how': gift_how(s), 'note': ''})
        if len(out) == 3:
            break
    return out


def kind_of(title, category=''):
    if '팝업' in title or 'pop-up' in title.lower() or 'popup' in title.lower():
        return 'popup'
    if '전시' in category or '미술' in category or '전시' in title:
        return 'exhibit'
    return 'event'


# 분야 (화면의 분야 칩). manual.json에 topic이 있으면 그것, 없으면 제목·브랜드·소개 낱말로 어림한다. 앞의 것이 먼저 잡힌다
TOPICS = ('beauty', 'fashion', 'character', 'food', 'tech', 'culture', 'market', 'etc')
TOPIC_WORDS = [
    ('market', r'장터|마켓|플리|야장|직거래'),
    ('food', r'먹거리|음식|푸드|라면|분식|카페|커피|디저트|맥주|와인|소주|과자|스낵'),
    ('beauty', r'뷰티|화장품|메이크업|스킨|틴트|립스틱|향수|퍼퓸|헤어|네일|치약'),
    ('fashion', r'패션|의류|옷|신발|스니커|가방|안경|주얼리|애슬레저|컬렉션'),
    ('character', r'캐릭터|굿즈|앨범|아이돌|게임|애니|웹툰|피규어|포켓몬|산리오'),
    ('tech', r'\bAI\b|인공지능|통신|모바일|스마트폰|로봇|테크|\bIT\b'),
    ('culture', r'공연|콘서트|연극|뮤지컬|클래식|국악|무용|영화|상영|전시|미술|아트|갤러리|개인전|책방|도서|서가|강연|강좌|교육'),
]


def topic_of(text, category=''):
    # 서울시 자료의 분류는 축제만 빼면 공연·전시·교육 같은 문화 행사다
    if category and not category.startswith('축제'):
        return 'culture'
    for topic, words in TOPIC_WORDS:
        if re.search(words, text):
            return topic
    return 'etc'


# ---------- 1. 서울시 문화행사 정보 ----------

def seoul_events(key, today):
    """성동구 행사 중 성수동 범위 안, 아직 끝나지 않은 것."""
    rows, start, size = [], 1, 1000
    while True:
        url = f'http://openapi.seoul.go.kr:8088/{key}/json/culturalEventInfo/{start}/{start + size - 1}/'
        data = json.loads(get(url)).get('culturalEventInfo')
        if not data:
            break
        rows += data.get('row', [])
        if start + size > data.get('list_total_count', 0):
            break
        start += size
        time.sleep(0.3)
    return seoul_filter(rows, today)


def first_sentence(text, limit=70):
    s = re.split(r'(?<=[.!?다요])\s+|\n', (text or '').strip())[0].strip()
    return s if len(s) <= limit else s[:limit - 1] + '…'


def seoul_filter(rows, today):
    out = []
    for r in rows:
        if r.get('GUNAME') != '성동구':
            continue
        try:
            lat, lng = float(r['LAT']), float(r['LOT'])
        except (KeyError, ValueError):
            continue
        # 위도·경도가 서로 바뀌어 들어온 행이 있다
        if lat > 100:
            lat, lng = lng, lat
        if not in_seongsu(lat, lng):
            continue
        s, e = r.get('STRTDATE', '')[:10], r.get('END_DATE', '')[:10]
        if not s or not e or e < today.isoformat():
            continue
        title = r['TITLE'].strip()
        out.append({
            'id': 'seoul-' + re.sub(r'\D', '', r.get('HMPG_ADDR', '').split('cultcode=')[-1].split('&')[0]) or title,
            'title': title,
            'kind': kind_of(title, r.get('CODENAME', '')),
            'topic': topic_of(title, r.get('CODENAME', '')),
            'start': s,
            'end': e,
            'place': r.get('PLACE', '').strip(),
            'lat': round(lat, 6),
            'lng': round(lng, 6),
            'time': r.get('PRO_TIME', '').strip(),
            'fee': '무료' if r.get('IS_FREE') == '무료' else (r.get('USE_FEE', '').strip() or ''),
            'about': first_sentence(r.get('PROGRAM', '')),
            'gifts': gifts_from_text(f"{r.get('PROGRAM', '')}\n{r.get('ETC_DESC', '')}"),
            'link': r.get('HMPG_ADDR') or r.get('ORG_LINK') or '',
            'source': 'seoul',
        })
    return out


# ---------- 2. 직접 적은 공식 발표 ----------

# UTM-K(EPSG:5179, GRS80 횡메르카토르) → 위도·경도
_A, _F = 6378137.0, 1 / 298.257222101
_E2 = _F * (2 - _F)
_EP2 = _E2 / (1 - _E2)
_LAT0, _LON0, _K0, _FE, _FN = math.radians(38), math.radians(127.5), 0.9996, 1000000.0, 2000000.0


def _meridian(phi):
    e2, e4, e6 = _E2, _E2 ** 2, _E2 ** 3
    return _A * ((1 - e2 / 4 - 3 * e4 / 64 - 5 * e6 / 256) * phi
                 - (3 * e2 / 8 + 3 * e4 / 32 + 45 * e6 / 1024) * math.sin(2 * phi)
                 + (15 * e4 / 256 + 45 * e6 / 1024) * math.sin(4 * phi)
                 - (35 * e6 / 3072) * math.sin(6 * phi))


def utmk_to_wgs84(x, y):
    m = _meridian(_LAT0) + (y - _FN) / _K0
    mu = m / (_A * (1 - _E2 / 4 - 3 * _E2 ** 2 / 64 - 5 * _E2 ** 3 / 256))
    e1 = (1 - math.sqrt(1 - _E2)) / (1 + math.sqrt(1 - _E2))
    phi1 = (mu + (3 * e1 / 2 - 27 * e1 ** 3 / 32) * math.sin(2 * mu)
            + (21 * e1 ** 2 / 16 - 55 * e1 ** 4 / 32) * math.sin(4 * mu)
            + (151 * e1 ** 3 / 96) * math.sin(6 * mu) + (1097 * e1 ** 4 / 512) * math.sin(8 * mu))
    s, c, tn = math.sin(phi1), math.cos(phi1), math.tan(phi1)
    c1, t1 = _EP2 * c * c, tn * tn
    n1 = _A / math.sqrt(1 - _E2 * s * s)
    r1 = _A * (1 - _E2) / (1 - _E2 * s * s) ** 1.5
    d = (x - _FE) / (n1 * _K0)
    lat = phi1 - (n1 * tn / r1) * (d ** 2 / 2 - (5 + 3 * t1 + 10 * c1 - 4 * c1 ** 2 - 9 * _EP2) * d ** 4 / 24
                                   + (61 + 90 * t1 + 298 * c1 + 45 * t1 ** 2 - 252 * _EP2 - 3 * c1 ** 2) * d ** 6 / 720)
    lon = _LON0 + (d - (1 + 2 * t1 + c1) * d ** 3 / 6
                   + (5 - 2 * c1 + 28 * t1 - 3 * c1 ** 2 + 8 * _EP2 + 24 * t1 ** 2) * d ** 5 / 120) / c
    return math.degrees(lat), math.degrees(lon)


class Sgis:
    """통계청 SGIS 지오코딩. 토큰은 처음 쓸 때 받는다."""
    BASE = 'https://sgisapi.kostat.go.kr/OpenAPI3'

    def __init__(self, key, secret):
        self.key, self.secret, self.token = key, secret, None

    def _call(self, path, params):
        data = json.loads(get(f'{self.BASE}/{path}?' + urllib.parse.urlencode(params)))
        if str(data.get('errCd')) not in ('0', 'None'):
            raise RuntimeError(f"SGIS {path}: {data.get('errCd')} {data.get('errMsg')}")
        return data.get('result')

    def geocode(self, address):
        if not self.token:
            self.token = self._call('auth/authentication.json',
                                    {'consumer_key': self.key, 'consumer_secret': self.secret})['accessToken']
        time.sleep(0.2)
        result = self._call('addr/geocode.json', {'accessToken': self.token, 'address': address, 'resultcount': 1})
        rows = (result or {}).get('resultdata') or []
        if not rows:
            return None
        lat, lng = utmk_to_wgs84(float(rows[0]['x']), float(rows[0]['y']))
        return {'lat': round(lat, 6), 'lng': round(lng, 6), 'approx': False, 'by': 'sgis'}


def geocode(address, cache, sgis=None):
    """SGIS가 있으면 먼저(번지까지), 없거나 못 찾으면 OSM Nominatim.
    Nominatim 정책: 1초에 1번, 정기 작업은 1분에 4번 이하, 결과는 캐시."""
    hit = cache.get(address)
    # SGIS를 쓸 수 있으면 대략 위치·못 찾음으로 남은 것은 다시 찾는다
    if address in cache and (hit and not hit.get('approx') or not sgis):
        return hit
    if sgis:
        try:
            found = sgis.geocode(address)
        except Exception as e:  # noqa: BLE001  SGIS가 안 되면 Nominatim으로
            print(f'  SGIS 실패 ({address}): {e}', file=sys.stderr)
            found = None
        if found and in_seongsu(found['lat'], found['lng']):
            # 번지 없이 길 이름만 준 주소는 길 위 한 점일 뿐이다
            found['approx'] = not re.search(r'\s\d+(-\d+)?$', address.strip())
            cache[address] = found
            return found
        if address in cache:
            return hit
    # 성수동 범위 안에서만 찾는다 (긴 길은 범위 밖 구간이 잡힐 수 있다)
    url = 'https://nominatim.openstreetmap.org/search?' + urllib.parse.urlencode(
        {'format': 'json', 'limit': 1, 'countrycodes': 'kr', 'q': address, 'bounded': 1,
         'viewbox': f"{BBOX['west']},{BBOX['north']},{BBOX['east']},{BBOX['south']}"})
    time.sleep(15)  # 1분에 4번
    found = json.loads(get(url))
    if found:
        f = found[0]
        # 건물이 아니라 길만 찾았으면 대략 위치
        cache[address] = {'lat': round(float(f['lat']), 6), 'lng': round(float(f['lon']), 6),
                          'approx': f.get('class') == 'highway'}
    else:
        cache[address] = None
    return cache[address]


def manual_events(today, cache, sgis=None):
    out = []
    for m in load_json(MANUAL, []):
        if m.get('end', '9999') < today.isoformat():
            continue
        ev = {
            'id': 'm-' + m['id'],
            'title': m['title'],
            'kind': m.get('kind') or kind_of(m['title']),
            'topic': m.get('topic') or topic_of(f"{m['title']} {m.get('brand', '')} {m.get('about', '')}"),
            'start': m['start'],
            'end': m['end'],
            'place': m.get('place', ''),
            'address': m.get('address', ''),
            'time': m.get('time', ''),
            'fee': m.get('fee', ''),
            'brand': m.get('brand', ''),
            'about': m.get('about', ''),
            'gifts': [g for g in m.get('gifts', []) if g.get('what')],
            'link': m['link'],
            'source': 'manual',
            **({'search': m['search']} if 'search' in m else {}),
            **({'reserve': True} if m.get('reserve') else {}),
        }
        for g in ev['gifts']:
            if g.get('how') and g['how'] not in GIFT_HOWS:
                print(f'  모르는 받는 방식 "{g["how"]}": {ev["title"]}', file=sys.stderr)
        if 'lat' in m and 'lng' in m:
            ev['lat'], ev['lng'] = m['lat'], m['lng']
        elif ev['address']:
            g = geocode(ev['address'], cache, sgis)
            if not g:
                print(f'  주소를 못 찾음: {ev["title"]} / {ev["address"]}', file=sys.stderr)
                continue
            ev['lat'], ev['lng'] = g['lat'], g['lng']
            if g['approx']:
                ev['approx'] = True
        elif m.get('nopin'):
            # 기간은 확인했지만 번지를 못 찾은 곳: 지도에 찍지 않고 목록에만 싣는다
            ev['nopin'] = True
        else:
            print(f'  주소·좌표 없음: {ev["title"]}', file=sys.stderr)
            continue
        out.append(ev)
    return out


def perks(today):
    """끝난 혜택과 오래 확인 안 한 상시 혜택을 뺀다."""
    stale = (today - timedelta(days=PERK_STALE_DAYS)).isoformat()
    out = []
    for p in load_json(PERKS, []):
        if p.get('end') and p['end'] < today.isoformat():
            continue
        if not p.get('end') and p.get('checked', '') < stale:
            continue
        out.append({k: p.get(k, '') for k in PERK_FIELDS})
    out.sort(key=lambda p: (p['end'] or '9999', p['title']))
    return out


def local_env():
    """로컬에서는 .env.local(Git 제외)의 KEY=값을 읽는다."""
    try:
        lines = (ROOT / '.env.local').read_text(encoding='utf-8').splitlines()
    except FileNotFoundError:
        return {}
    return {k.strip(): v.strip() for k, _, v in (l.partition('=') for l in lines) if v and not k.startswith('#')}


def main():
    today = datetime.now(KST).date()
    cache = load_json(GEOCODE_CACHE, {})
    events, sources = [], []

    key = os.environ.get('SEOUL_API_KEY', '').strip() or local_env().get('SEOUL_API_KEY', '')
    if key:
        found = seoul_events(key, today)
        print(f'서울시 문화행사: {len(found)}건')
        events += found
        sources.append('seoul')
    else:
        print('SEOUL_API_KEY가 없어 서울시 문화행사는 건너뜀')
        # 키가 없을 때는 지난번 결과의 서울시 행사를 그대로 둔다
        old = load_json(OUT, {}).get('events', [])
        events += [e for e in old if e['source'] == 'seoul' and e['end'] >= today.isoformat()]

    env = local_env()
    sgis_key = os.environ.get('SGIS_KEY', '').strip() or env.get('SGIS_KEY', '')
    sgis_secret = os.environ.get('SGIS_SECRET', '').strip() or env.get('SGIS_SECRET', '')
    sgis = Sgis(sgis_key, sgis_secret) if sgis_key and sgis_secret else None
    if not sgis:
        print('SGIS_KEY·SGIS_SECRET이 없어 주소는 Nominatim으로만 찾음')
    found = manual_events(today, cache, sgis)
    # 서울시 자료에 이미 있는 행사는 직접 적은 쪽을 뺀다
    dup = [m for m in found if any(same_event(m, s) for s in events)]
    for m in dup:
        print(f'  서울시 자료와 겹쳐 뺌: {m["title"]}', file=sys.stderr)
    found = [m for m in found if m not in dup]
    print(f'직접 적은 공식 발표: {len(found)}건')
    events += found
    save_json(GEOCODE_CACHE, cache)

    seen = load_json(SEEN, {})
    for e in events:
        seen.setdefault(e['id'], today.isoformat())
        e['added'] = seen[e['id']]
    # 끝난 지 30일 지난 기록은 지운다
    cutoff = (today - timedelta(days=30)).isoformat()
    live = {e['id'] for e in events}
    seen = {k: v for k, v in seen.items() if k in live or v >= cutoff}
    save_json(SEEN, seen)

    events.sort(key=lambda e: (e['end'], e['title']))
    old = load_json(OUT, {})
    now = datetime.now(KST).strftime('%Y-%m-%d %H:%M')
    # checked: 마지막으로 확인한 때, updated: 목록이 마지막으로 바뀐 때
    data = {'checked': now,
            'updated': old.get('updated') if old.get('events') == events and old.get('updated') else now,
            'events': events}
    save_json(OUT, data)
    print(f'모두 {len(events)}건 → {OUT.relative_to(ROOT)}')

    found = perks(today)
    save_json(PERKS_OUT, {'checked': now, 'perks': found})
    print(f'가입·팔로우 혜택 {len(found)}건 → {PERKS_OUT.relative_to(ROOT)}')


if __name__ == '__main__':
    main()

from flask import Flask, request, jsonify, send_from_directory
import re
import os
from urllib.parse import quote

app = Flask(__name__, static_folder='static')
BASE_DIR = os.path.dirname(os.path.abspath(__file__))


# ── URL parsers ──────────────────────────────────────────────────────────────

def extract_youtube_id(url):
    url = url.strip()
    patterns = [
        r'(?:youtube\.com\/watch\?v=|youtu\.be\/)([^&\n?#\s]+)',
        r'youtube\.com\/embed\/([^&\n?#\s]+)',
        r'^([a-zA-Z0-9_-]{11})$',
    ]
    for pattern in patterns:
        match = re.search(pattern, url)
        if match:
            return match.group(1)
    return None


def extract_bilibili_id(url):
    """Extract BV number from a Bilibili URL."""
    url = url.strip()
    patterns = [
        r'bilibili\.com/video/(BV[a-zA-Z0-9]+)',
        r'^(BV[a-zA-Z0-9]+)$',
    ]
    for pattern in patterns:
        match = re.search(pattern, url)
        if match:
            return match.group(1)
    return None


# ── Sentence helpers ──────────────────────────────────────────────────────────

def split_into_sentences(text):
    parts = re.split(r'(?<=[.!?。！？])\s+(?=[A-Z\u4e00-\u9fff])', text.strip())
    return [p.strip() for p in parts if p.strip()]


def merge_segments(raw):
    merged = []
    buf_text = ''
    buf_start = 0.0
    buf_end = 0.0

    def flush():
        nonlocal buf_text
        if not buf_text:
            return
        sentences = split_into_sentences(buf_text)
        if not sentences:
            sentences = [buf_text.strip()]
        total_chars = sum(len(s) for s in sentences)
        total_dur = buf_end - buf_start
        t = buf_start
        for s in sentences:
            frac = len(s) / total_chars if total_chars > 0 else 1.0
            dur = total_dur * frac
            merged.append({'start': round(t, 2), 'duration': round(max(dur, 0.5), 2), 'text': s})
            t += dur
        buf_text = ''

    for i, item in enumerate(raw):
        text = item['text'].replace('\n', ' ').strip()
        if not text:
            continue
        if not buf_text:
            buf_start = item['start']
        buf_end = item['start'] + item['duration']
        buf_text = (buf_text + ' ' + text).strip() if buf_text else text
        ends_sentence = buf_text[-1] in '.!?。！？'
        too_long = len(buf_text) > 300
        gap = raw[i + 1]['start'] - buf_end if i + 1 < len(raw) else 999
        long_pause = gap >= 1.0 and len(buf_text) >= 15
        if ends_sentence or too_long or long_pause:
            flush()

    flush()
    return merged


# ── Translation ──────────────────────────────────────────────────────────────

def translate_texts(texts, source='en', target='zh-CN'):
    """Batch-translate a list of texts. Returns list of translated strings."""
    try:
        from deep_translator import GoogleTranslator
        SEPARATOR = ' ||| '
        MAX_CHARS = 4500
        results = [''] * len(texts)
        batch_indices, batch_parts, batch_chars = [], [], 0

        def flush_batch(indices, parts):
            if not indices:
                return
            joined = SEPARATOR.join(parts)
            try:
                translated = GoogleTranslator(source=source, target=target).translate(joined) or ''
                chunks = translated.split(SEPARATOR.strip())
                for k, idx in enumerate(indices):
                    results[idx] = chunks[k].strip() if k < len(chunks) else ''
            except Exception:
                pass

        for i, text in enumerate(texts):
            if batch_chars + len(text) > MAX_CHARS and batch_indices:
                flush_batch(batch_indices, batch_parts)
                batch_indices, batch_parts, batch_chars = [], [], 0
            batch_indices.append(i)
            batch_parts.append(text)
            batch_chars += len(text) + len(SEPARATOR)

        flush_batch(batch_indices, batch_parts)
        return results
    except ImportError:
        return [''] * len(texts)


# ── Bilibili WBI signature ────────────────────────────────────────────────────
# Bilibili's newer API endpoints require a signed "w_rid" parameter.
# Reference: https://socialsisteryi.github.io/bilibili-API-collect/docs/misc/sign/wbi.html

import hashlib
import time
from urllib.parse import urlencode

_WBI_MIXIN_KEY_ENC_TAB = [
    46, 47, 18,  2, 53,  8, 23, 32, 15, 50, 10, 31, 58,  3, 45, 35,
    27, 43,  5, 49, 33,  9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
    37, 48,  7, 16, 24, 55, 40, 61, 26, 17,  0,  1, 60, 51, 30,  4,
    22, 25, 54, 21, 56, 59,  6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
]

def _get_mixin_key(raw: str) -> str:
    return ''.join(raw[i] for i in _WBI_MIXIN_KEY_ENC_TAB)[:32]

def _wbi_sign(params: dict, img_key: str, sub_key: str) -> dict:
    """Add wts + w_rid to params and return the signed dict."""
    mixin_key = _get_mixin_key(img_key + sub_key)
    params = dict(params)
    params['wts'] = int(time.time())
    # Sort and strip forbidden chars
    params = {
        k: ''.join(c for c in str(v) if c not in "!'()*")
        for k, v in sorted(params.items())
    }
    query = urlencode(params)
    params['w_rid'] = hashlib.md5((query + mixin_key).encode()).hexdigest()
    return params

def _fetch_wbi_keys(session) -> tuple:
    """Return (img_key, sub_key) from Bilibili nav API."""
    nav = session.get(
        'https://api.bilibili.com/x/web-interface/nav',
        timeout=8
    ).json()
    wbi = nav.get('data', {}).get('wbi_img', {})
    def _stem(url):
        return url.rsplit('/', 1)[-1].split('.')[0]
    return _stem(wbi.get('img_url', '')), _stem(wbi.get('sub_url', ''))


# ── Bilibili subtitle fetcher ─────────────────────────────────────────────────

def get_bilibili_transcript(bvid):
    """Return (segments, source_lang, title).
    Tries unsigned player/v2 first, then WBI-signed player/wbi/v2 as fallback.
    """
    import requests as req

    session = req.Session()
    session.headers.update({
        'User-Agent': (
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
            'AppleWebKit/537.36 (KHTML, like Gecko) '
            'Chrome/124.0.0.0 Safari/537.36'
        ),
        'Referer': 'https://www.bilibili.com',
    })

    # 1. Get video info (cid + title)
    info = session.get(
        f'https://api.bilibili.com/x/web-interface/view?bvid={bvid}',
        timeout=10
    ).json()
    if info.get('code') != 0:
        raise Exception(f'获取视频信息失败：{info.get("message", "未知错误")}')
    cid   = info['data']['cid']
    title = info['data'].get('title', bvid)

    # 2a. Try unsigned player/v2 first (works for some videos)
    subtitles = []
    try:
        r = session.get(
            f'https://api.bilibili.com/x/player/v2?bvid={bvid}&cid={cid}',
            timeout=10
        ).json()
        subtitles = r.get('data', {}).get('subtitle', {}).get('subtitles', [])
    except Exception:
        pass

    # 2b. Fallback: WBI-signed player/wbi/v2
    if not subtitles:
        try:
            img_key, sub_key = _fetch_wbi_keys(session)
            if img_key and sub_key:
                signed = _wbi_sign({'bvid': bvid, 'cid': cid}, img_key, sub_key)
                r2 = session.get(
                    'https://api.bilibili.com/x/player/wbi/v2',
                    params=signed, timeout=10
                ).json()
                subtitles = r2.get('data', {}).get('subtitle', {}).get('subtitles', [])
        except Exception:
            pass

    if not subtitles:
        raise Exception(
            '该视频没有字幕轨道。\n'
            '请确认：① 视频播放器里点击「字幕」按钮能看到字幕；'
            '② 字幕不是烧录在画面上的硬字幕。'
        )

    # 3. Choose best track: prefer English > AI-English > AI-Chinese > Chinese
    priority = ['en', 'en-US', 'en-GB', 'ai-en', 'ai-zh', 'zh-CN', 'zh-Hans', 'zh']
    chosen = None
    for lang_pref in priority:
        for sub in subtitles:
            lan = sub.get('lan', '')
            if lan == lang_pref or lan.startswith(lang_pref):
                chosen = sub
                break
        if chosen:
            break
    if not chosen:
        chosen = subtitles[0]

    source_lang = 'zh' if chosen.get('lan', '').startswith(('zh', 'ai-zh')) else 'en'
    sub_url = chosen.get('subtitle_url', '')
    if sub_url.startswith('//'):
        sub_url = 'https:' + sub_url
    if not sub_url:
        raise Exception('字幕地址为空，无法下载字幕')

    # 4. Download subtitle JSON
    body = session.get(sub_url, timeout=10).json().get('body', [])
    if not body:
        raise Exception('字幕内容为空')

    segments = [
        {
            'text': item['content'],
            'start': item['from'],
            'duration': item['to'] - item['from'],
        }
        for item in body
    ]
    return segments, source_lang, title


def get_youtube_title(video_id):
    """Fetch YouTube video title via oEmbed (no API key required)."""
    try:
        import requests as req
        resp = req.get(
            f'https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v={video_id}&format=json',
            timeout=5
        )
        return resp.json().get('title', video_id)
    except Exception:
        return video_id


def _get_youtube_title_invidious(video_id):
    """Fetch title from an Invidious instance as a fallback."""
    try:
        import requests as req
        for base_url in _get_invidious_instances():
            try:
                resp = req.get(f'{base_url}/api/v1/videos/{video_id}', timeout=8)
                if resp.ok:
                    title = (resp.json() or {}).get('title', '').strip()
                    if title:
                        return title
            except Exception:
                continue
    except Exception:
        pass
    return video_id


# ── YouTube transcript fetcher ────────────────────────────────────────────────

def _get_yt_transcript_scraperapi(video_id, api_key):
    """Fetch YouTube transcript using ScraperAPI.

    Step 1 — HTML page:  ScraperAPI REST API  (confirmed working on Railway)
    Step 2 — Caption JSON: try direct with SSL disabled → fallback ScraperAPI REST
              with autoparse=false so it returns raw bytes instead of parsed HTML.
    """
    import requests as req
    import json
    import urllib3

    urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

    UA = (
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
        'AppleWebKit/537.36 (KHTML, like Gecko) '
        'Chrome/124.0.0.0 Safari/537.36'
    )
    HEADERS = {'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9'}

    def sa_rest(url, **extra):
        """Fetch URL via ScraperAPI REST endpoint."""
        params = {'api_key': api_key, 'url': url, **extra}
        r = req.get('http://api.scraperapi.com', params=params, timeout=30)
        r.raise_for_status()
        return r

    # ── 1. Fetch video page via ScraperAPI REST ───────────────────────────────
    page = sa_rest(f'https://www.youtube.com/watch?v={video_id}').text
    if len(page) < 500:
        raise Exception(
            f'ScraperAPI 返回内容过短（{len(page)} 字节），'
            '请确认 SCRAPERAPI_KEY 正确且账户有剩余额度'
        )

    # ── 2. Extract ytInitialPlayerResponse ────────────────────────────────────
    m = re.search(r'ytInitialPlayerResponse\s*=\s*', page)
    if not m:
        raise Exception('视频页面中未找到字幕数据，请稍后重试')
    decoder = json.JSONDecoder()
    try:
        player_data, _ = decoder.raw_decode(page, m.end())
    except Exception as e:
        raise Exception(f'无法解析视频数据：{e}')

    tracks = (player_data
              .get('captions', {})
              .get('playerCaptionsTracklistRenderer', {})
              .get('captionTracks', []))
    if not tracks:
        raise Exception('该视频未开启字幕功能')

    # ── 3. Choose English track ───────────────────────────────────────────────
    chosen = None
    for lang in ('en', 'en-US', 'en-GB'):
        chosen = next((t for t in tracks if t.get('languageCode') == lang), None)
        if chosen:
            break
    if not chosen:
        chosen = next(
            (t for t in tracks if t.get('languageCode', '').startswith('en')),
            tracks[0]
        )

    caption_url = chosen.get('baseUrl', '')
    if not caption_url:
        raise Exception('无法获取字幕地址')
    if 'fmt=' not in caption_url:
        caption_url += '&fmt=json3'

    # ── 4. Fetch caption JSON ─────────────────────────────────────────────────
    events = None
    errors = []

    # Attempt A: direct request with SSL verification disabled
    try:
        r = req.get(
            caption_url,
            headers={**HEADERS, 'Referer': f'https://www.youtube.com/watch?v={video_id}'},
            verify=False,
            timeout=15,
        )
        if r.status_code == 200 and r.text.strip():
            events = r.json().get('events', [])
    except Exception as e:
        errors.append(f'直连: {e}')

    # Attempt B: ScraperAPI REST with autoparse=false (returns raw response body)
    if events is None:
        try:
            r = sa_rest(caption_url, autoparse='false', render='false')
            if r.text.strip():
                events = r.json().get('events', [])
            else:
                errors.append('ScraperAPI REST: 返回空响应')
        except Exception as e:
            errors.append(f'ScraperAPI REST: {e}')

    if events is None:
        if not errors:
            errors.append('未拿到任何字幕响应')
        raise Exception(f'字幕文件获取失败（{"; ".join(errors)}）')

    # ── 5. Build segments ─────────────────────────────────────────────────────
    segments = []
    for e in events:
        if 'segs' not in e:
            continue
        text = ''.join(s.get('utf8', '') for s in e['segs']).replace('\n', ' ').strip()
        if text:
            segments.append({
                'text': text,
                'start': e['tStartMs'] / 1000,
                'duration': e.get('dDurationMs', 3000) / 1000,
            })
    if not segments:
        raise Exception('字幕内容为空')
    return segments


def _get_invidious_instances():
    """Return candidate Invidious base URLs.

    Priority:
      1. INVIDIOUS_INSTANCES env var (comma-separated)
      2. Official public instances API
      3. Small built-in fallback list
    """
    manual = [
        item.strip().rstrip('/')
        for item in os.environ.get('INVIDIOUS_INSTANCES', '').split(',')
        if item.strip()
    ]
    if manual:
        return manual

    fallback = [
        'https://yewtu.be',
        'https://inv.nadeko.net',
        'https://invidious.nerdvpn.de',
    ]

    try:
        import requests as req
        resp = req.get('https://api.invidious.io/instances.json', timeout=8)
        resp.raise_for_status()
        data = resp.json()
        instances = []
        for row in data:
            if not isinstance(row, list) or len(row) < 2:
                continue
            host, meta = row[0], row[1] or {}
            if not meta.get('api', False):
                continue
            if not meta.get('monitor', {}).get('up', True):
                continue
            uri = (meta.get('uri') or '').strip().rstrip('/')
            if uri.startswith('https://'):
                instances.append(uri)
            elif host:
                instances.append(f'https://{host}')
        if instances:
            deduped = []
            seen = set()
            for url in instances + fallback:
                if url not in seen:
                    seen.add(url)
                    deduped.append(url)
            return deduped
    except Exception:
        pass

    return fallback


def _parse_vtt_timestamp(ts):
    parts = ts.strip().split(':')
    if len(parts) == 3:
        hours, minutes, seconds = parts
    elif len(parts) == 2:
        hours = '0'
        minutes, seconds = parts
    else:
        raise ValueError(f'无效时间戳: {ts}')
    return int(hours) * 3600 + int(minutes) * 60 + float(seconds.replace(',', '.'))


def _parse_vtt_captions(vtt_text):
    """Parse WebVTT into transcript segments."""
    segments = []
    block = []

    def flush(lines):
        if not lines:
            return
        cue_idx = 0
        if '-->' not in lines[0] and len(lines) > 1:
            cue_idx = 1
        if cue_idx >= len(lines) or '-->' not in lines[cue_idx]:
            return
        timing = lines[cue_idx]
        text_lines = lines[cue_idx + 1:]
        text = ' '.join(text_lines).strip()
        text = re.sub(r'<[^>]+>', '', text)
        text = re.sub(r'\s+', ' ', text).strip()
        if not text:
            return
        start_raw, end_raw = [part.strip() for part in timing.split('-->', 1)]
        end_raw = end_raw.split(' ')[0].strip()
        start = _parse_vtt_timestamp(start_raw)
        end = _parse_vtt_timestamp(end_raw)
        segments.append({
            'text': text,
            'start': start,
            'duration': max(end - start, 0.5),
        })

    for raw_line in vtt_text.splitlines():
        line = raw_line.strip('\ufeff').rstrip()
        if not line.strip():
            flush(block)
            block = []
            continue
        if line.startswith('WEBVTT') or line.startswith('Kind:') or line.startswith('Language:'):
            continue
        block.append(line.strip())
    flush(block)

    if not segments:
        raise Exception('字幕内容为空')
    return segments


def _get_yt_transcript_invidious(video_id):
    """Fetch captions from public Invidious instances."""
    import requests as req

    errors = []
    for base_url in _get_invidious_instances()[:8]:
        try:
            tracks_resp = req.get(f'{base_url}/api/v1/captions/{video_id}', timeout=10)
            if not tracks_resp.ok:
                errors.append(f'{base_url}: HTTP {tracks_resp.status_code}')
                continue
            tracks = (tracks_resp.json() or {}).get('captions', [])
            if not tracks:
                errors.append(f'{base_url}: 无字幕轨道')
                continue

            chosen = None
            for lang in ('en', 'en-US', 'en-GB'):
                chosen = next((t for t in tracks if t.get('languageCode') == lang), None)
                if chosen:
                    break
            if not chosen:
                chosen = next(
                    (t for t in tracks if t.get('languageCode', '').startswith('en')),
                    tracks[0]
                )

            query = ''
            language_code = chosen.get('languageCode', '').strip()
            label = chosen.get('label', '').strip()
            if language_code:
                query = f'lang={quote(language_code)}'
            elif label:
                query = f'label={quote(label)}'
            else:
                errors.append(f'{base_url}: 字幕轨道缺少语言信息')
                continue

            caption_resp = req.get(
                f'{base_url}/api/v1/captions/{video_id}?{query}',
                timeout=12,
            )
            if not caption_resp.ok or not caption_resp.text.strip():
                errors.append(f'{base_url}: 字幕文件下载失败')
                continue

            return _parse_vtt_captions(caption_resp.text)
        except Exception as e:
            errors.append(f'{base_url}: {str(e)}')

    preview = '; '.join(errors[:3])
    raise Exception(f'Invidious 字幕兜底失败{f"（{preview}）" if preview else ""}')


def _fetch_yt_raw(video_id):
    """Return raw transcript segments for a YouTube video.

    Priority:
      1. ScraperAPI REST API  – set SCRAPERAPI_KEY env var
      2. Webshare proxy       – set WEBSHARE_PROXY_USERNAME + WEBSHARE_PROXY_PASSWORD
      3. No proxy             – local dev / clean-IP host
    """
    from youtube_transcript_api import YouTubeTranscriptApi
    from youtube_transcript_api._errors import NoTranscriptFound, TranscriptsDisabled

    # ── Option 1: ScraperAPI REST (recommended for Railway) ──────────────────
    scraper_key = os.environ.get('SCRAPERAPI_KEY', '').strip()
    if scraper_key:
        try:
            return _get_yt_transcript_scraperapi(video_id, scraper_key)
        except Exception:
            pass

    # ── Option 2: Webshare residential proxy ─────────────────────────────────
    proxy_user = os.environ.get('WEBSHARE_PROXY_USERNAME', '').strip()
    proxy_pass = os.environ.get('WEBSHARE_PROXY_PASSWORD', '').strip()
    if proxy_user and proxy_pass:
        try:
            from youtube_transcript_api.proxies import WebshareProxyConfig
            api = YouTubeTranscriptApi(proxy_config=WebshareProxyConfig(
                proxy_username=proxy_user,
                proxy_password=proxy_pass,
            ))
        except Exception:
            api = YouTubeTranscriptApi()
    else:
        # ── Option 3: No proxy ────────────────────────────────────────────────
        api = YouTubeTranscriptApi()

    try:
        raw = api.fetch(video_id, languages=['en', 'en-US', 'en-GB'])
    except NoTranscriptFound:
        try:
            transcript_list = api.list(video_id)
            try:
                raw = transcript_list.find_generated_transcript(['en']).fetch()
            except Exception:
                raw = next(iter(transcript_list)).fetch()
        except Exception:
            return _get_yt_transcript_invidious(video_id)
    except TranscriptsDisabled:
        raise Exception('该视频未开启字幕功能')
    except Exception:
        return _get_yt_transcript_invidious(video_id)

    return [{'text': s.text, 'start': s.start, 'duration': s.duration} for s in raw]


# ── Routes ────────────────────────────────────────────────────────────────────

@app.route('/')
def index():
    return send_from_directory(BASE_DIR, 'index.html')


@app.route('/api/transcript')
def get_transcript():
    url = request.args.get('url', '').strip()
    if not url:
        return jsonify({'error': '请提供视频链接'}), 400

    # ── Bilibili ──────────────────────────────────────────
    bvid = extract_bilibili_id(url)
    if bvid:
        try:
            segments, source_lang, video_title = get_bilibili_transcript(bvid)
            merged = merge_segments(segments)
            if not merged:
                return jsonify({'error': '字幕内容为空'}), 400

            raw_texts = [item['text'] for item in merged]

            if source_lang == 'zh':
                # Chinese subtitle → translate to English
                english_texts = translate_texts(raw_texts, source='zh-CN', target='en')
                chinese_texts = raw_texts
            else:
                # English subtitle → translate to Chinese
                english_texts = raw_texts
                chinese_texts = translate_texts(raw_texts, source='en', target='zh-CN')

            result = [
                {
                    'start': round(item['start'], 2),
                    'duration': round(item['duration'], 2),
                    'english': english_texts[i],
                    'chinese': chinese_texts[i],
                }
                for i, item in enumerate(merged)
            ]
            return jsonify({
                'platform': 'bilibili',
                'video_id': bvid,
                'title': video_title,
                'source_lang': source_lang,
                'transcript': result,
            })
        except Exception as e:
            return jsonify({'error': f'获取字幕失败：{str(e)}'}), 500

    # ── YouTube ───────────────────────────────────────────
    video_id = extract_youtube_id(url)
    if not video_id:
        return jsonify({'error': '无法识别视频链接，请粘贴 YouTube 或 Bilibili 视频链接'}), 400

    try:
        raw_list = _fetch_yt_raw(video_id)
        merged = merge_segments(raw_list)
        if not merged:
            return jsonify({'error': '字幕内容为空'}), 400

        english_texts = [item['text'] for item in merged]
        chinese_texts = translate_texts(english_texts, source='en', target='zh-CN')

        result = [
            {
                'start': round(item['start'], 2),
                'duration': round(item['duration'], 2),
                'english': item['text'],
                'chinese': chinese_texts[i],
            }
            for i, item in enumerate(merged)
        ]
        title = get_youtube_title(video_id)
        if not title or title == video_id:
            title = _get_youtube_title_invidious(video_id)

        return jsonify({
            'platform': 'youtube',
            'video_id': video_id,
            'title': title,
            'source_lang': 'en',
            'transcript': result,
        })

    except Exception as e:
        return jsonify({'error': f'获取字幕失败：{str(e)}'}), 500


if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5001))
    debug = os.environ.get('FLASK_ENV') != 'production'
    app.run(debug=debug, host='0.0.0.0', port=port)

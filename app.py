from flask import Flask, request, jsonify, send_from_directory
import re
import os

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


# ── YouTube API builder (proxy support for Railway deployment) ────────────────

class _NoVerifyProxyConfig:
    """GenericProxyConfig equivalent that also disables SSL verification.
    Needed when ScraperAPI (or any MITM proxy) intercepts HTTPS traffic and
    presents its own certificate — which Python's default CA bundle rejects.
    """
    def __init__(self, http_url: str, https_url: str):
        self._http = http_url
        self._https = https_url

    def __call__(self) -> dict:
        return {
            'proxies': {'http': self._http, 'https': self._https},
            'verify': False,
        }


def _build_yt_api():
    """Return a YouTubeTranscriptApi instance, optionally configured with a proxy.

    Priority:
      1. ScraperAPI  – set SCRAPERAPI_KEY env var (free tier: scraperapi.com)
      2. Webshare    – set WEBSHARE_PROXY_USERNAME + WEBSHARE_PROXY_PASSWORD
      3. No proxy    – local development / environments with clean IPs
    """
    import urllib3
    from youtube_transcript_api import YouTubeTranscriptApi

    # ── Option 1: ScraperAPI residential proxy ────────────────────────────────
    scraper_key = os.environ.get('SCRAPERAPI_KEY', '').strip()
    if scraper_key:
        try:
            urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
            proxy_url = f'http://scraperapi:{scraper_key}@proxy-server.scraperapi.com:8001'
            return YouTubeTranscriptApi(proxy_config=_NoVerifyProxyConfig(
                http_url=proxy_url,
                https_url=proxy_url,
            ))
        except Exception:
            pass  # fall through to next option

    # ── Option 2: Webshare residential proxy ─────────────────────────────────
    proxy_user = os.environ.get('WEBSHARE_PROXY_USERNAME', '').strip()
    proxy_pass = os.environ.get('WEBSHARE_PROXY_PASSWORD', '').strip()
    if proxy_user and proxy_pass:
        try:
            from youtube_transcript_api.proxies import WebshareProxyConfig
            return YouTubeTranscriptApi(proxy_config=WebshareProxyConfig(
                proxy_username=proxy_user,
                proxy_password=proxy_pass,
            ))
        except Exception:
            pass  # fall through to no-proxy fallback

    # ── Option 3: No proxy (local dev or clean-IP host) ───────────────────────
    return YouTubeTranscriptApi()


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
        from youtube_transcript_api import YouTubeTranscriptApi
        from youtube_transcript_api._errors import NoTranscriptFound, TranscriptsDisabled

        api = _build_yt_api()

        raw = None
        try:
            raw = api.fetch(video_id, languages=['en', 'en-US', 'en-GB'])
        except NoTranscriptFound:
            transcript_list = api.list(video_id)
            try:
                raw = transcript_list.find_generated_transcript(['en']).fetch()
            except Exception:
                raw = next(iter(transcript_list)).fetch()
        except TranscriptsDisabled:
            return jsonify({'error': '该视频未开启字幕功能'}), 400

        raw_list = [{'text': s.text, 'start': s.start, 'duration': s.duration} for s in raw]
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
        return jsonify({
            'platform': 'youtube',
            'video_id': video_id,
            'title': get_youtube_title(video_id),
            'source_lang': 'en',
            'transcript': result,
        })

    except Exception as e:
        return jsonify({'error': f'获取字幕失败：{str(e)}'}), 500


if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5001))
    debug = os.environ.get('FLASK_ENV') != 'production'
    app.run(debug=debug, host='0.0.0.0', port=port)

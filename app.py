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


# ── Bilibili subtitle fetcher ─────────────────────────────────────────────────

def get_bilibili_transcript(bvid):
    """Return (segments, source_lang).
    segments = list of {text, start, duration}
    source_lang = 'zh' or 'en'
    """
    import requests as req
    headers = {
        'User-Agent': (
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
            'AppleWebKit/537.36 (KHTML, like Gecko) '
            'Chrome/124.0.0.0 Safari/537.36'
        ),
        'Referer': 'https://www.bilibili.com',
    }

    # 1. Get video info (cid)
    info = req.get(
        f'https://api.bilibili.com/x/web-interface/view?bvid={bvid}',
        headers=headers, timeout=10
    ).json()
    if info.get('code') != 0:
        raise Exception(f'获取视频信息失败：{info.get("message", "未知错误")}')
    cid = info['data']['cid']

    # 2. Get subtitle list
    player = req.get(
        f'https://api.bilibili.com/x/player/v2?bvid={bvid}&cid={cid}',
        headers=headers, timeout=10
    ).json()
    subtitles = player.get('data', {}).get('subtitle', {}).get('subtitles', [])
    if not subtitles:
        raise Exception('该视频没有字幕，请选择有 CC 字幕的视频')

    # 3. Choose: prefer English, then Chinese AI, then Chinese, then first
    priority = ['en', 'en-US', 'en-GB', 'ai-en', 'ai-zh', 'zh-CN', 'zh-Hans', 'zh']
    chosen = None
    for lang_pref in priority:
        for sub in subtitles:
            if sub['lan'] == lang_pref or sub['lan'].startswith(lang_pref):
                chosen = sub
                break
        if chosen:
            break
    if not chosen:
        chosen = subtitles[0]

    source_lang = 'zh' if chosen['lan'].startswith(('zh', 'ai-zh')) else 'en'
    sub_url = chosen['subtitle_url']
    if sub_url.startswith('//'):
        sub_url = 'https:' + sub_url

    # 4. Download subtitle JSON
    body = req.get(sub_url, headers=headers, timeout=10).json().get('body', [])
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
    return segments, source_lang


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
            segments, source_lang = get_bilibili_transcript(bvid)
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

        proxy_user = os.environ.get('WEBSHARE_PROXY_USERNAME')
        proxy_pass = os.environ.get('WEBSHARE_PROXY_PASSWORD')
        if proxy_user and proxy_pass:
            from youtube_transcript_api.proxies import WebshareProxyConfig
            api = YouTubeTranscriptApi(proxy_config=WebshareProxyConfig(
                proxy_username=proxy_user,
                proxy_password=proxy_pass,
            ))
        else:
            api = YouTubeTranscriptApi()

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
            'source_lang': 'en',
            'transcript': result,
        })

    except Exception as e:
        return jsonify({'error': f'获取字幕失败：{str(e)}'}), 500


if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5001))
    debug = os.environ.get('FLASK_ENV') != 'production'
    app.run(debug=debug, host='0.0.0.0', port=port)

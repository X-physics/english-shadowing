from flask import Flask, request, jsonify, send_from_directory
import re
import os

app = Flask(__name__, static_folder='static')
BASE_DIR = os.path.dirname(os.path.abspath(__file__))


def extract_video_id(url):
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


def split_into_sentences(text):
    """Split a block of text into individual sentences on .!? boundaries.
    Uses a lookbehind for .!? followed by space + uppercase letter so that
    decimals like "1.5" and abbreviations are not mis-split.
    """
    parts = re.split(r'(?<=[.!?])\s+(?=[A-Z])', text.strip())
    return [p.strip() for p in parts if p.strip()]


def merge_segments(raw):
    """Merge short transcript segments into complete sentences (one per item).

    Strategy:
    1. Accumulate raw caption segments until a sentence-ending punctuation is
       found, a long inter-segment pause occurs, or the buffer is too long.
    2. On each flush, further split the buffered text into individual sentences
       using punctuation, distributing timestamps proportionally by character
       count.  This ensures exactly ONE sentence per output item.
    """
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
            merged.append({'start': round(t, 2), 'duration': round(max(dur, 0.5), 2), 'english': s})
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

        ends_sentence = buf_text[-1] in '.!?'
        too_long = len(buf_text) > 300

        gap = raw[i + 1]['start'] - buf_end if i + 1 < len(raw) else 999
        long_pause = gap >= 1.0 and len(buf_text) >= 15

        if ends_sentence or too_long or long_pause:
            flush()

    flush()
    return merged


def translate_texts(texts):
    """Translate a list of English texts to Chinese using batched requests."""
    try:
        from deep_translator import GoogleTranslator
        # Join sentences with a unique separator, translate in one request per batch
        SEPARATOR = ' ||| '
        MAX_CHARS = 4500  # Google Translate limit per request
        results = [''] * len(texts)

        batch_indices = []
        batch_chars = 0
        batch_parts = []

        def flush_batch(indices, parts):
            if not indices:
                return
            joined = SEPARATOR.join(parts)
            try:
                translated = GoogleTranslator(source='en', target='zh-CN').translate(joined) or ''
                chunks = translated.split(SEPARATOR.strip())
                for k, idx in enumerate(indices):
                    results[idx] = chunks[k].strip() if k < len(chunks) else ''
            except Exception:
                pass  # leave as empty string

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


@app.route('/')
def index():
    return send_from_directory(BASE_DIR, 'index.html')


@app.route('/api/transcript')
def get_transcript():
    url = request.args.get('url', '').strip()
    if not url:
        return jsonify({'error': '请提供 YouTube 视频链接'}), 400

    video_id = extract_video_id(url)
    if not video_id:
        return jsonify({'error': '无法识别 YouTube 视频 ID，请检查链接格式'}), 400

    try:
        from youtube_transcript_api import YouTubeTranscriptApi
        from youtube_transcript_api._errors import NoTranscriptFound, TranscriptsDisabled

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

        # Normalise to list of dicts (new API returns snippet objects)
        raw_list = [{'text': s.text, 'start': s.start, 'duration': s.duration} for s in raw]
        merged = merge_segments(raw_list)
        if not merged:
            return jsonify({'error': '字幕内容为空'}), 400

        english_texts = [item['english'] for item in merged]
        chinese_texts = translate_texts(english_texts)

        result = [
            {
                'start': round(item['start'], 2),
                'duration': round(item['duration'], 2),
                'english': item['english'],
                'chinese': chinese_texts[i],
            }
            for i, item in enumerate(merged)
        ]

        return jsonify({'video_id': video_id, 'transcript': result})

    except Exception as e:
        return jsonify({'error': f'获取字幕失败：{str(e)}'}), 500


if __name__ == '__main__':
    import os
    port = int(os.environ.get('PORT', 5001))
    debug = os.environ.get('FLASK_ENV') != 'production'
    app.run(debug=debug, host='0.0.0.0', port=port)

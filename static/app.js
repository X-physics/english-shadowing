/* ── State ── */
let player = null;          // YouTube player instance
let platform = 'youtube';   // 'youtube' | 'bilibili'
let bilibiliVideoId = '';   // current BV number
let transcript = [];
let currentIndex = -1;
let syncTimer = null;
let segmentTimer = null;   // for single-sentence playback + auto-pause
let favorites = new Set();
let shadowTarget = null;
let recognition = null;
let isRecording = false;

/* ── Helpers ── */
function fmt(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function esc(str) {
  if (!str) return '';
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

/* ── YouTube IFrame API ── */
window.onYouTubeIframeAPIReady = function () {};

function initYouTubePlayer(videoId) {
  if (player) { player.destroy(); player = null; }
  document.getElementById('player').style.display = '';
  document.getElementById('bilibiliPlayer').style.display = 'none';

  player = new YT.Player('player', {
    videoId,
    playerVars: { playsinline: 1, rel: 0, modestbranding: 1 },
    events: {
      onReady() { startSync(); },
      onStateChange(e) {
        if (e.data === YT.PlayerState.PLAYING) startSync();
        else { stopSync(); syncNow(); }
      }
    }
  });
}

function initBilibiliPlayer(bvid) {
  bilibiliVideoId = bvid;
  document.getElementById('player').style.display = 'none';
  const iframe = document.getElementById('bilibiliPlayer');
  iframe.style.display = '';
  iframe.src = bilibiliEmbedUrl(bvid, 0, false);
  // Bilibili can't push state changes, so we rely on manual sync
  startSync();
}

function bilibiliEmbedUrl(bvid, t, autoplay) {
  return `https://player.bilibili.com/player.html?bvid=${bvid}&page=1&t=${Math.floor(t)}&autoplay=${autoplay ? 1 : 0}&danmaku=0&high_quality=1`;
}

function startSync() {
  stopSync();
  syncTimer = setInterval(syncNow, 250);
}

function stopSync() {
  if (syncTimer) { clearInterval(syncTimer); syncTimer = null; }
}

function syncNow() {
  if (platform === 'bilibili') {
    // Bilibili can't expose currentTime to cross-origin JS; skip highlight sync
    return;
  }
  if (!player || !player.getCurrentTime) return;
  const t = player.getCurrentTime();
  let idx = -1;

  for (let i = 0; i < transcript.length; i++) {
    const { start, duration } = transcript[i];
    if (t >= start && t < start + duration) { idx = i; break; }
    if (i + 1 < transcript.length && t >= start + duration && t < transcript[i + 1].start) {
      idx = i; break;
    }
  }

  if (idx !== currentIndex) {
    currentIndex = idx;
    highlightCard(idx);
  }
}

function highlightCard(idx) {
  document.querySelectorAll('.sentence-card').forEach((card, i) => {
    if (i === idx) {
      card.classList.add('active');
      card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } else {
      card.classList.remove('active');
    }
  });
}

/* ── Load video ── */
async function loadVideo() {
  const url = document.getElementById('videoUrl').value.trim();
  if (!url) return;

  const loadBtn = document.getElementById('loadBtn');
  const loading = document.getElementById('loadingState');
  const vidSec  = document.getElementById('videoSection');
  const tabBar  = document.getElementById('tabBar');
  const list    = document.getElementById('sentencesList');

  loadBtn.disabled = true;
  loadBtn.textContent = '加载中…';
  loading.classList.remove('hidden');
  vidSec.classList.add('hidden');
  tabBar.classList.add('hidden');
  list.innerHTML = '';

  try {
    const res  = await fetch(`/api/transcript?url=${encodeURIComponent(url)}`);
    const data = await res.json();

    if (data.error) { showError(data.error, list); return; }

    transcript = data.transcript;
    platform   = data.platform || 'youtube';

    vidSec.classList.remove('hidden');
    if (platform === 'bilibili') {
      initBilibiliPlayer(data.video_id);
    } else {
      initYouTubePlayer(data.video_id);
    }
    renderCards(list);
    tabBar.classList.remove('hidden');

  } catch {
    showError('网络错误，请检查连接后重试', list);
  } finally {
    loading.classList.add('hidden');
    loadBtn.disabled = false;
    loadBtn.textContent = '加载';
  }
}

function showError(msg, listEl) {
  listEl.innerHTML = `<div class="error-msg">${esc(msg)}</div>`;
}

/* ── Render sentence cards ── */
function renderCards(listEl) {
  listEl.innerHTML = '';

  transcript.forEach((item, idx) => {
    const card = document.createElement('div');
    card.className = 'sentence-card';
    card.dataset.idx = idx;

    card.innerHTML = `
      <div class="card-head">
        <span class="ts">${fmt(item.start)}</span>
        <button class="star-btn" data-idx="${idx}" title="收藏">☆</button>
      </div>
      <div class="en-text">${esc(item.english)}</div>
      <div class="zh-text">${esc(item.chinese) || '<em style="color:#ccc">翻译加载中…</em>'}</div>
      <div class="card-btns">
        <button class="btn-card-listen" data-idx="${idx}">
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02z"/></svg>
          听原音
        </button>
        <button class="btn-card-shadow" data-idx="${idx}">
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 15c1.66 0 3-1.34 3-3V6c0-1.66-1.34-3-3-3S9 4.34 9 6v6c0 1.66 1.34 3 3 3zm5.3-3c0 3-2.54 5.1-5.3 5.1S6.7 15 6.7 12H5c0 3.42 2.72 6.23 6 6.72V22h2v-3.28c3.28-.48 6-3.3 6-6.72h-1.7z"/></svg>
          跟读
        </button>
      </div>`;

    // Click card background → seek
    card.addEventListener('click', e => {
      if (e.target.closest('button')) return;
      seekAndPlay(item.start, item.duration);
    });

    listEl.appendChild(card);
  });

  // Event delegation for card buttons
  listEl.addEventListener('click', e => {
    const listenBtn = e.target.closest('.btn-card-listen');
    const shadowBtn = e.target.closest('.btn-card-shadow');
    const starBtn   = e.target.closest('.star-btn');
    if (listenBtn) { const s = transcript[+listenBtn.dataset.idx]; seekAndPlay(s.start, s.duration); }
    if (shadowBtn) openShadow(+shadowBtn.dataset.idx);
    if (starBtn)   toggleStar(+starBtn.dataset.idx, starBtn);
  });
}

/* Cancel any pending single-sentence timer */
function clearSegmentTimer() {
  if (segmentTimer) { clearTimeout(segmentTimer); segmentTimer = null; }
}

/**
 * Seek to `start` and play.
 * If `duration` is provided, pause automatically after that many seconds.
 */
function seekAndPlay(start, duration) {
  clearSegmentTimer();

  if (platform === 'bilibili') {
    // Reload iframe with new timestamp + autoplay
    const iframe = document.getElementById('bilibiliPlayer');
    iframe.src = bilibiliEmbedUrl(bilibiliVideoId, start, true);
    // Bilibili can't be paused via JS cross-origin reliably;
    // show a visual overlay after the sentence duration instead.
    if (duration > 0) {
      segmentTimer = setTimeout(() => {
        // Try postMessage pause (works on some player versions)
        try {
          iframe.contentWindow.postMessage(
            JSON.stringify({ type: 'pause' }), '*'
          );
        } catch (_) {}
        segmentTimer = null;
      }, (duration + 0.3) * 1000);
    }
    return;
  }

  // YouTube
  if (!player || !player.seekTo) return;
  player.seekTo(start, true);
  player.playVideo();
  if (duration > 0) {
    segmentTimer = setTimeout(() => {
      player.pauseVideo();
      segmentTimer = null;
    }, duration * 1000);
  }
}

function toggleStar(idx, btn) {
  if (favorites.has(idx)) {
    favorites.delete(idx);
    btn.textContent = '☆';
    btn.classList.remove('starred');
  } else {
    favorites.add(idx);
    btn.textContent = '★';
    btn.classList.add('starred');
  }
}

/* ── Shadowing Modal ── */
function openShadow(idx) {
  shadowTarget = transcript[idx];
  document.getElementById('modalEnglish').textContent = shadowTarget.english;
  document.getElementById('modalChinese').textContent = shadowTarget.chinese;
  document.getElementById('resultBox').classList.add('hidden');
  document.getElementById('recordStatus').textContent = '';
  resetRecordBtn();

  // On desktop, pin the overlay to the right column so it stays in that 1/3 area
  const overlay  = document.getElementById('shadowModal');
  const rightCol = document.querySelector('.right-col');
  if (window.innerWidth > 768 && rightCol) {
    const r = rightCol.getBoundingClientRect();
    overlay.style.left   = r.left + 'px';
    overlay.style.width  = r.width + 'px';
    overlay.style.top    = '0';
    overlay.style.height = '100%';
    overlay.classList.add('desktop-modal');
  } else {
    overlay.style.cssText = '';
    overlay.classList.remove('desktop-modal');
  }

  overlay.classList.add('open');
  seekAndPlay(shadowTarget.start, shadowTarget.duration);
}

function closeShadow() {
  const overlay = document.getElementById('shadowModal');
  overlay.classList.remove('open', 'desktop-modal');
  overlay.style.cssText = '';
  stopRecording();
  shadowTarget = null;
}

function listenAgain() {
  if (shadowTarget) seekAndPlay(shadowTarget.start, shadowTarget.duration);
}

/* ── Recording & Speech Recognition ── */

// recordingActive: user's intent — true = keep recording, false = stop & score
let recordingActive = false;
let accumulatedText = '';   // text collected across all auto-restart cycles
let srClass = null;         // cached SR constructor
let autoStopTimer = null;   // fires after MAX_RECORD_SECONDS to auto-stop
let countdownTimer = null;  // updates the status bar every second
const MAX_RECORD_SECONDS = 60;

function resetRecordBtn() {
  const btn = document.getElementById('recordBtn');
  btn.className = 'btn-record';
  btn.innerHTML = `
    <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 15c1.66 0 3-1.34 3-3V6c0-1.66-1.34-3-3-3S9 4.34 9 6v6c0 1.66 1.34 3 3 3zm5.3-3c0 3-2.54 5.1-5.3 5.1S6.7 15 6.7 12H5c0 3.42 2.72 6.23 6 6.72V22h2v-3.28c3.28-.48 6-3.3 6-6.72h-1.7z"/></svg>
    开始跟读`;
}

function killRecognition() {
  // Silence all callbacks then abort so nothing stale fires
  if (recognition) {
    recognition.onstart  = null;
    recognition.onresult = null;
    recognition.onerror  = null;
    recognition.onend    = null;
    try { recognition.abort(); } catch (_) {}
    recognition = null;
  }
}

function clearRecordTimers() {
  if (autoStopTimer)  { clearTimeout(autoStopTimer);   autoStopTimer  = null; }
  if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
}

function toggleRecord() {
  if (isRecording) { stopRecording(); return; }

  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    document.getElementById('recordStatus').textContent = '您的浏览器不支持语音识别，请使用 Chrome 浏览器';
    return;
  }
  srClass = SR;

  const btn    = document.getElementById('recordBtn');
  const status = document.getElementById('recordStatus');

  // Fully kill previous session
  recordingActive = false;
  killRecognition();
  accumulatedText = '';

  // Pause video so it doesn't feed into the mic
  clearSegmentTimer();
  if (platform === 'bilibili') {
    try {
      const iframe = document.getElementById('bilibiliPlayer');
      iframe.contentWindow.postMessage(JSON.stringify({ type: 'pause' }), '*');
    } catch (_) {}
  } else if (player && player.pauseVideo) {
    player.pauseVideo();
  }

  // 3-second countdown
  let count = 3;
  status.textContent = `${count} 秒后开始录音…`;
  btn.disabled = true;

  const cd = setInterval(() => {
    count--;
    if (count > 0) {
      status.textContent = `${count} 秒后开始录音…`;
    } else {
      clearInterval(cd);
      btn.disabled = false;
      recordingActive = true;          // set BEFORE spawning

      // Auto-stop after MAX_RECORD_SECONDS
      clearRecordTimers();
      let remaining = MAX_RECORD_SECONDS;
      autoStopTimer = setTimeout(() => {
        if (recordingActive) stopRecording();
      }, MAX_RECORD_SECONDS * 1000);

      // Countdown display in status bar
      countdownTimer = setInterval(() => {
        remaining--;
        if (remaining <= 0) { clearInterval(countdownTimer); countdownTimer = null; }
        else if (recordingActive) {
          status.textContent = `🎤 录音中… 剩余 ${remaining}s（读完后点停止录音）`;
        }
      }, 1000);

      setTimeout(() => spawnRec(btn, status), 200);
    }
  }, 1000);
}

/**
 * Spawn one SpeechRecognition instance.
 *
 * Chrome's Web Speech API has an internal hard limit of ~10 seconds per
 * session. We cannot prevent it from firing onend. Instead we PROACTIVELY
 * call rec.stop() after 7 seconds (before Chrome's limit), which gives us
 * full control of the restart timing. The gap between stop and the next
 * start is ~100 ms — almost nothing.
 *
 * Text is accumulated across restarts in accumulatedText.
 */
const PROACTIVE_RESTART_MS = 7000;   // restart every 7 s to beat Chrome's ~10 s limit

function spawnRec(btn, status) {
  if (!recordingActive) return;

  const rec = new srClass();
  recognition = rec;
  rec.lang = 'en-US';
  rec.continuous = false;      // false is more reliable for short sessions
  rec.interimResults = true;
  rec.maxAlternatives = 1;

  let proactiveTimer = null;   // fires at 7 s to proactively restart

  rec.onstart = () => {
    isRecording = true;
    btn.className = 'btn-record recording';
    btn.innerHTML = `
      <svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>
      停止录音`;

    // Schedule proactive stop before Chrome's internal timeout
    proactiveTimer = setTimeout(() => {
      if (recordingActive && recognition === rec) {
        try { rec.stop(); } catch (_) {}
        // onend will restart us
      }
    }, PROACTIVE_RESTART_MS);
  };

  rec.onresult = e => {
    if (!recordingActive) return;
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      if (e.results[i].isFinal) {
        accumulatedText += e.results[i][0].transcript + ' ';
      } else {
        interim += e.results[i][0].transcript;
      }
    }
    if (interim) status.textContent = `识别中：${interim}`;
  };

  rec.onerror = e => {
    clearTimeout(proactiveTimer);
    if (e.error === 'no-speech' || e.error === 'aborted') return; // non-fatal
    recordingActive = false;
    isRecording = false;
    clearRecordTimers();
    resetRecordBtn();
    const msgs = {
      'not-allowed':   '请在浏览器设置中允许麦克风权限后重试',
      'network':       '网络错误，语音识别需要联网',
      'audio-capture': '未检测到麦克风，请检查设备',
    };
    status.textContent = msgs[e.error] || `识别出错：${e.error}`;
  };

  rec.onend = () => {
    clearTimeout(proactiveTimer);
    if (recordingActive) {
      // Chrome's audio pipeline can get "stuck" on macOS after the first session
      // ends — subsequent start() calls succeed visually but capture no audio.
      // Fix: briefly acquire then immediately release the mic via getUserMedia to
      // force Chrome to fully reset its internal audio stack, then restart.
      status.textContent = '🔄 重新连接麦克风…';
      navigator.mediaDevices.getUserMedia({ audio: true })
        .then(stream => {
          stream.getTracks().forEach(t => t.stop()); // release immediately
          setTimeout(() => spawnRec(btn, status), 200);
        })
        .catch(() => {
          // getUserMedia failed (permission revoked?) — retry anyway
          setTimeout(() => spawnRec(btn, status), 300);
        });
    } else {
      // User pressed stop (or 60 s timer fired) — finalize and score
      isRecording = false;
      resetRecordBtn();
      const text = accumulatedText.trim();
      if (text) showResult(text);
      else status.textContent = '未识别到内容，请再试一次';
    }
  };

  try {
    rec.start();
  } catch (_) {
    // start() threw (e.g. called too soon) — back off and retry
    if (recordingActive) setTimeout(() => spawnRec(btn, status), 300);
  }
}

function stopRecording() {
  recordingActive = false;          // onend will see this and finalize
  clearRecordTimers();
  if (recognition) {
    try { recognition.stop(); } catch (_) {}
    // Do NOT null callbacks here — onend must fire to show the result
  }
  isRecording = false;
  resetRecordBtn();
}

/* ── Scoring ── */
function normalise(text) {
  return text.toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
}

function lcsMatch(target, user) {
  const m = target.length, n = user.length;
  const dp = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1));

  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = target[i-1] === user[j-1] ? dp[i-1][j-1] + 1 : Math.max(dp[i-1][j], dp[i][j-1]);

  const matched = new Array(m).fill(false);
  let i = m, j = n;
  while (i > 0 && j > 0) {
    if (target[i-1] === user[j-1]) { matched[i-1] = true; i--; j--; }
    else if (dp[i-1][j] >= dp[i][j-1]) i--;
    else j--;
  }
  return matched;
}

function showResult(userText) {
  const targetWords = normalise(shadowTarget.english).split(' ');
  const userWords   = normalise(userText).split(' ');
  const matched     = lcsMatch(targetWords, userWords);

  const correct = matched.filter(Boolean).length;
  const score   = Math.round((correct / targetWords.length) * 100);

  const scoreEl = document.getElementById('scoreText');
  if (score >= 80) {
    scoreEl.className = 'score-text good';
    scoreEl.textContent = `${score} 分  🎉 太棒了！`;
  } else if (score >= 55) {
    scoreEl.className = 'score-text ok';
    scoreEl.textContent = `${score} 分  👍 不错，继续！`;
  } else {
    scoreEl.className = 'score-text poor';
    scoreEl.textContent = `${score} 分  💪 再练练！`;
  }

  document.getElementById('wordComp').innerHTML = targetWords.map((w, i) =>
    `<span class="${matched[i] ? 'w-correct' : 'w-missing'}">${esc(w)}</span>`
  ).join(' ');

  document.getElementById('userSaid').textContent = `你说的：${userText}`;
  document.getElementById('resultBox').classList.remove('hidden');
  document.getElementById('recordStatus').textContent = '';
}

/* ── Speed control (倍速) ── */
function setSpeed(rate) {
  if (player && player.setPlaybackRate) player.setPlaybackRate(rate);
}

/* ── DOM ready ── */
document.addEventListener('DOMContentLoaded', () => {
  // Load button
  document.getElementById('loadBtn').addEventListener('click', loadVideo);
  document.getElementById('videoUrl').addEventListener('keydown', e => {
    if (e.key === 'Enter') loadVideo();
  });

  // Modal controls
  document.getElementById('closeModal').addEventListener('click', closeShadow);
  document.getElementById('listenAgainBtn').addEventListener('click', listenAgain);
  document.getElementById('recordBtn').addEventListener('click', toggleRecord);
  document.getElementById('retryBtn').addEventListener('click', () => {
    document.getElementById('resultBox').classList.add('hidden');
    document.getElementById('recordStatus').textContent = '';
  });

  // Close modal on backdrop tap
  document.getElementById('shadowModal').addEventListener('click', e => {
    if (e.target.id === 'shadowModal') closeShadow();
  });

  // Tab switching (UI only; subtitles tab is the functional one)
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
    });
  });
});

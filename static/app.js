/* ── Practice Scores (per video, localStorage) ── */
let practiceScores = {};   // { sentenceIdx: bestScore }
let currentVideoId = '';

function scoreKey(videoId) { return `scores_${videoId}`; }

function loadScores(videoId) {
  try { return JSON.parse(localStorage.getItem(scoreKey(videoId)) || '{}'); }
  catch { return {}; }
}

function saveScore(idx, score) {
  const best = practiceScores[idx];
  if (best === undefined || score > best) {
    practiceScores[idx] = score;
    localStorage.setItem(scoreKey(currentVideoId), JSON.stringify(practiceScores));
    updateCardBadge(idx, score);
    updateProgress();
  }
}

function updateCardBadge(idx, score) {
  const card = document.querySelector(`.sentence-card[data-idx="${idx}"]`);
  if (!card) return;
  let badge = card.querySelector('.score-badge');
  if (!badge) {
    badge = document.createElement('span');
    card.querySelector('.card-head').appendChild(badge);
  }
  const cls = score >= 80 ? 'good' : score >= 55 ? 'ok' : 'poor';
  badge.className = `score-badge ${cls}`;
  badge.textContent = `${score}分`;
}

function updateProgress() {
  const practiced = Object.keys(practiceScores).length;
  const total     = transcript.length;
  const pct       = total ? Math.round((practiced / total) * 100) : 0;
  const countEl   = document.getElementById('practiceCount');
  const fillEl    = document.getElementById('progressFill');
  if (countEl) countEl.textContent = `已练 ${practiced} / ${total} 句`;
  if (fillEl)  fillEl.style.width  = pct + '%';
}

/* ── Video Favorites (localStorage) ── */
let currentVideoMeta = null;

function loadFavs() {
  try { return JSON.parse(localStorage.getItem('videoFavorites') || '[]'); }
  catch { return []; }
}
function saveFavs(favs) { localStorage.setItem('videoFavorites', JSON.stringify(favs)); }
function isFaved(url) { return loadFavs().some(f => f.url === url); }

function syncFavBtn() {
  const btn = document.getElementById('favBtn');
  if (!btn || !currentVideoMeta) return;
  const faved = isFaved(currentVideoMeta.url);
  btn.textContent = faved ? '♥' : '♡';
  btn.classList.toggle('faved', faved);
  btn.title = faved ? '取消收藏' : '收藏此视频';
}

function toggleFav() {
  if (!currentVideoMeta) return;
  let favs = loadFavs();
  const idx = favs.findIndex(f => f.url === currentVideoMeta.url);
  if (idx >= 0) {
    favs.splice(idx, 1);
    showToast('已移除收藏');
  } else {
    favs.unshift(currentVideoMeta);
    showToast('❤️ 已加入收藏');
  }
  saveFavs(favs);
  syncFavBtn();
  if (document.getElementById('panelFavs')?.classList.contains('open')) renderFavList();
}

/* ══════════════════════════════════════════
   PAGE NAVIGATION (Home ↔ Player)
   ══════════════════════════════════════════ */
function showHome() {
  // Pause video before leaving player page
  clearSegmentTimer();
  stopSync();
  if (platform === 'youtube' && player && player.pauseVideo) {
    try { player.pauseVideo(); } catch (_) {}
  } else if (platform === 'bilibili') {
    try {
      document.getElementById('bilibiliPlayer')
        ?.contentWindow?.postMessage(JSON.stringify({ type: 'pause' }), '*');
    } catch (_) {}
  }

  document.getElementById('homePage').classList.remove('hidden');
  document.getElementById('playerPage').classList.add('hidden');
  document.getElementById('app').className = 'app home-mode';
  document.body.style.overflow = '';
  renderHomeGrid();
  renderRecentSection();
  renderFavHomeSection();
}

function showPlayer() {
  document.getElementById('homePage').classList.add('hidden');
  document.getElementById('playerPage').classList.remove('hidden');
  document.getElementById('app').className = 'app player-mode';
  document.body.style.overflow = 'hidden';
  // Sync topbar title if video already loaded
  if (currentVideoMeta?.title) {
    const t = document.getElementById('topbarTitle');
    if (t) t.textContent = currentVideoMeta.title;
  }
}

/* ── Side Drawer ── */
let activePanel = null;

function openSidePanel(name) {
  // Close previously open panel
  if (activePanel && activePanel !== name) {
    document.getElementById('panel' + cap(activePanel))?.classList.remove('open');
    document.querySelector(`.side-tab[data-panel="${activePanel}"]`)?.classList.remove('active');
  }
  activePanel = name;
  document.getElementById('panel' + cap(name))?.classList.add('open');
  document.querySelector(`.side-tab[data-panel="${name}"]`)?.classList.add('active');
  document.getElementById('drawerBackdrop')?.classList.remove('hidden');

  if (name === 'favs') renderFavList();
}

function closeSidePanel(name) {
  document.getElementById('panel' + cap(name))?.classList.remove('open');
  document.querySelector(`.side-tab[data-panel="${name}"]`)?.classList.remove('active');
  if (activePanel === name) activePanel = null;
  if (!activePanel) document.getElementById('drawerBackdrop')?.classList.add('hidden');
}

function toggleSidePanel(name) {
  const panel = document.getElementById('panel' + cap(name));
  if (panel?.classList.contains('open')) closeSidePanel(name);
  else openSidePanel(name);
}

function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

/* ── Featured Videos (expanded, categorized) ── */
const FEATURED_VIDEOS = [
  // TED演讲
  { url: 'https://www.youtube.com/watch?v=iG9CE55wbtY',
    title: '学校扼杀了创造力吗？',
    author: 'Sir Ken Robinson · TED', cat: 'ted', level: '进阶' },
  { url: 'https://www.youtube.com/watch?v=iCvmsMzlF7o',
    title: '脆弱的力量',
    author: 'Brené Brown · TEDxHouston', cat: 'ted', level: '进阶' },
  { url: 'https://www.youtube.com/watch?v=qp0HIF3SfI4',
    title: '伟大领袖如何激励行动',
    author: 'Simon Sinek · TEDxPugetSound', cat: 'ted', level: '进阶' },
  { url: 'https://www.youtube.com/watch?v=ReRcHdeUG9Y',
    title: '如何拥有更好的对话',
    author: 'Celeste Headlee · TEDxCreativeCoast', cat: 'ted', level: '进阶' },
  { url: 'https://www.youtube.com/watch?v=Ks-_Mh1QhMc',
    title: '你的肢体语言会塑造你是谁',
    author: 'Amy Cuddy · TED', cat: 'ted', level: '中级' },
  { url: 'https://www.youtube.com/watch?v=eIho2S0ZahI',
    title: '如何说话让别人愿意听',
    author: 'Julian Treasure · TED', cat: 'ted', level: '中级' },
  { url: 'https://www.youtube.com/watch?v=fLJsdqxnZb0',
    title: '更好工作的快乐秘诀',
    author: 'Shawn Achor · TED', cat: 'ted', level: '中级' },
  { url: 'https://www.youtube.com/watch?v=rrkrvAUbU9Y',
    title: '动机之谜',
    author: 'Dan Pink · TED', cat: 'ted', level: '中级' },

  // 英语学习
  { url: 'https://www.youtube.com/watch?v=8S0FDjFBj8o',
    title: '6 Minute English',
    author: 'BBC Learning English', cat: 'learn', level: '入门' },
  { url: 'https://www.youtube.com/watch?v=o-Bcl93OnU0',
    title: 'English Conversation Practice',
    author: 'Learn English with TV Series', cat: 'learn', level: '入门' },
  { url: 'https://www.youtube.com/watch?v=LeqjcafMu9o',
    title: 'English Listening & Speaking',
    author: 'EnglishClass101', cat: 'learn', level: '入门' },

  // 生活
  { url: 'https://www.youtube.com/watch?v=H14bBuluwB8',
    title: '睡眠的科学：为什么好好睡觉这么重要',
    author: 'Matt Walker · TED', cat: 'life', level: '中级' },
  { url: 'https://www.youtube.com/watch?v=lmyZMtPVodo',
    title: '如何与压力做朋友',
    author: 'Kelly McGonigal · TED', cat: 'life', level: '中级' },
  { url: 'https://www.youtube.com/watch?v=8jPQjjsBbIc',
    title: '当你知道压力要来时，如何保持冷静',
    author: 'Daniel Levitin · TED', cat: 'life', level: '中级' },

  // 旅行
  // 商务
  { url: 'https://www.youtube.com/watch?v=Unzc731iCUY',
    title: '如何与人交谈：职场沟通技巧',
    author: 'MIT OpenCourseWare', cat: 'biz', level: '进阶' },

  // 科技
  { url: 'https://www.youtube.com/watch?v=UF8uR6Z6KLc',
    title: '乔布斯斯坦福演讲：Stay Hungry, Stay Foolish',
    author: 'Steve Jobs · Stanford 2005', cat: 'sci', level: '中级' },
  { url: 'https://www.youtube.com/watch?v=W3I3kAg2J7w',
    title: '互联网如何改变了世界',
    author: 'Andrew Blum · TED', cat: 'sci', level: '进阶' },
];

/* ── Category config ── */
const CAT_CONFIG = {
  ted:    { label: 'TED演讲',  color: '#E63946' },
  learn:  { label: '英语学习', color: '#0071E3' },
  life:   { label: '生活',     color: '#FF9F0A' },
  travel: { label: '旅行',     color: '#34C759' },
  biz:    { label: '商务',     color: '#AF52DE' },
  sci:    { label: '科技',     color: '#5AC8FA' },
  recent: { label: '最近观看', color: '#6E6E73' },
};

/* ── Recent videos (localStorage) ── */
const RECENT_KEY = 'recentVideos';
function getRecent() {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); } catch { return []; }
}
function addToRecent(meta) {
  let r = getRecent().filter(v => v.url !== meta.url);
  r.unshift({ url: meta.url, title: meta.title, platform: meta.platform,
              video_id: meta.video_id, cat: 'recent', author: '' });
  localStorage.setItem(RECENT_KEY, JSON.stringify(r.slice(0, 6)));
}
function clearRecent() {
  localStorage.removeItem(RECENT_KEY);
  document.getElementById('recentSection')?.classList.add('hidden');
}

/* ── Build a featured card ── */
function makeFeatCard(v) {
  const thumb = ytThumb(v.url);
  const cfg   = CAT_CONFIG[v.cat] || {};
  const badge = cfg.label
    ? `<span class="feat-cat-badge" style="background:${cfg.color}">${cfg.label}</span>`
    : '';
  const src = (v.platform === 'bilibili') ? '📺 Bilibili' : '▶️ YouTube';
  const metaPill = v.level
    ? `<span class="feat-level">${esc(v.level)}</span>`
    : '';
  return `
    <div class="feat-card" data-url="${esc(v.url)}">
      <div class="feat-thumb-wrap">
        <img class="feat-thumb" src="${thumb}" alt="${esc(v.title)}" loading="lazy"
             onerror="this.style.opacity=0" />
        <div class="feat-play-overlay">
          <div class="feat-play-icon">▶</div>
          <span>开始练习</span>
        </div>
        ${badge}
      </div>
      <div class="feat-info">
        <div class="feat-title">${esc(v.title)}</div>
        <div class="feat-meta">
          <span class="feat-author">${esc(v.author || '')}</span>
          <div class="feat-meta-right">
            ${metaPill}
            <span class="feat-source">${src}</span>
          </div>
        </div>
      </div>
    </div>`;
}

/* ── Home grid state ── */
let activeCat = 'all';

function renderHomeGrid() {
  const grid = document.getElementById('featuredGrid');
  if (!grid) return;
  const list = activeCat === 'all'
    ? FEATURED_VIDEOS
    : FEATURED_VIDEOS.filter(v => v.cat === activeCat);
  grid.innerHTML = list.length
    ? list.map(makeFeatCard).join('')
    : '<div class="feat-empty">该分类暂无视频，敬请期待 ✨</div>';
}

function renderRecentSection() {
  const recent = getRecent();
  const sec  = document.getElementById('recentSection');
  const grid = document.getElementById('recentGrid');
  if (!sec || !grid) return;
  if (!recent.length) { sec.classList.add('hidden'); return; }
  sec.classList.remove('hidden');
  grid.innerHTML = recent.map(makeFeatCard).join('');
}

function renderFavHomeSection() {
  const favs = loadFavs();
  const sec  = document.getElementById('favSection');
  const grid = document.getElementById('favHomeGrid');
  if (!sec || !grid) return;
  if (!favs.length) { sec.classList.add('hidden'); return; }
  sec.classList.remove('hidden');
  grid.innerHTML = favs.map(v => makeFeatCard({ ...v, cat: 'recent' })).join('');
}

/* ── Load video from a URL (shared between home & player) ── */
function loadFromUrl(url) {
  if (!url) return;
  document.getElementById('videoUrl').value = url;
  showPlayer();
  loadVideo();
}

function ytThumb(url) {
  const m = url.match(/(?:v=|youtu\.be\/)([^&?#\s]{11})/);
  return m ? `https://img.youtube.com/vi/${m[1]}/mqdefault.jpg` : '';
}

function makeVideoCard(v, attrs = '') {
  return `
    <div class="side-video-card" ${attrs} title="${esc(v.title)}">
      <img class="side-video-thumb" src="${ytThumb(v.url)}" alt="${esc(v.title)}" loading="lazy"
           onerror="this.style.visibility='hidden'" />
      <div class="side-video-info">
        <div class="side-video-title">${esc(v.title)}</div>
        <div class="side-video-tag">${esc(v.tag || (v.platform === 'bilibili' ? 'Bilibili' : 'YouTube'))}</div>
      </div>
    </div>`;
}

function renderFeaturedList() {
  const list = document.getElementById('featuredList');
  if (!list) return;
  list.innerHTML = FEATURED_VIDEOS.map((v, i) => makeVideoCard(v, `data-feat-idx="${i}"`)).join('');
}

function renderFavList() {
  const list = document.getElementById('favList');
  if (!list) return;
  const favs = loadFavs();
  if (!favs.length) {
    list.innerHTML = '<div class="fav-empty">还没有收藏的视频，<br>看完觉得好的点 ♡ 收藏吧～</div>';
    return;
  }
  list.innerHTML = favs.map((v, i) =>
    makeVideoCard(v, `data-fav-idx="${i}"`) .replace('</div>', `<button class="side-remove-btn" data-remove-idx="${i}" title="移除">✕</button></div>`)
  ).join('');
}

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
let loopCount = 1;             // how many times to play sentence before recording
let autoAdvanceTimer = null;
let autoAdvanceInterval = null;
let starredSentences = {};     // { sentenceIdx: true } — persisted per video
let activeFilterChip = 'all';  // 'all' | 'starred' | 'unpracticed' | 'low'

// Audio level meter
let meterStream = null;
let meterCtx    = null;
let meterFrame  = null;

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
  const list    = document.getElementById('sentencesList');

  loadBtn.disabled = true;
  loadBtn.textContent = '加载中…';
  loading.classList.remove('hidden');
  vidSec.classList.add('hidden');
  showSkeletons(list);

  try {
    const res  = await fetch(`/api/transcript?url=${encodeURIComponent(url)}`);
    const data = await res.json();

    if (data.error) { showError(data.error, list); return; }

    transcript    = data.transcript;
    platform      = data.platform || 'youtube';
    currentVideoId = data.video_id;
    practiceScores    = loadScores(data.video_id);
    starredSentences  = loadStars(data.video_id);
    activeFilterChip  = 'all';
    document.querySelectorAll('.chip').forEach(c =>
      c.classList.toggle('active', c.dataset.filter === 'all'));
    document.getElementById('filterChips')?.classList.remove('hidden');

    // Show control bar and reset speed to 1x
    document.getElementById('controlBar').classList.remove('hidden');
    document.querySelectorAll('.speed-btn').forEach(b => b.classList.toggle('active', b.dataset.rate === '1'));
    if (player && player.setPlaybackRate) player.setPlaybackRate(1);
    updateProgress();

    // Save current video meta for the favorite button
    currentVideoMeta = {
      url:      url,
      title:    data.title || data.video_id,
      platform: data.platform || 'youtube',
      video_id: data.video_id,
    };
    document.getElementById('favBtn').classList.remove('hidden');
    syncFavBtn();

    // Hide empty state
    document.getElementById('leftEmpty').classList.add('hidden');
    // Update topbar title to video name
    const topbarTitle = document.getElementById('topbarTitle');
    if (topbarTitle) topbarTitle.textContent = data.title || '语镜';

    // Persist last watched URL + add to recent history
    saveLastUrl(url);
    addToRecent(currentVideoMeta);

    // Close any open side panel when video loads
    if (activePanel) closeSidePanel(activePanel);

    vidSec.classList.remove('hidden');
    if (platform === 'bilibili') {
      initBilibiliPlayer(data.video_id);
    } else {
      initYouTubePlayer(data.video_id);
    }
    renderCards(list);

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

/* ── Skeleton loading cards ── */
function showSkeletons(listEl) {
  listEl.innerHTML = Array.from({ length: 6 }, () => `
    <div class="skeleton-card">
      <div class="skel skel-s" style="margin-bottom:2px"></div>
      <div class="skel skel-l"></div>
      <div class="skel skel-m"></div>
      <div class="skel skel-xs"></div>
    </div>`).join('');
}

/* ── Search filter (delegates to unified applyFilters) ── */
function filterCards() { applyFilters(); }

/* ── Play sentence N times ── */
function playNTimes(n, start, duration, onDone) {
  if (n <= 0) { if (onDone) onDone(); return; }
  seekAndPlay(start, duration);
  setTimeout(() => playNTimes(n - 1, start, duration, onDone), (duration + 0.6) * 1000);
}

/* ── Auto-advance after scoring ── */
function startAutoAdvance() {
  cancelAutoAdvance();
  const sentenceIdx = transcript.indexOf(shadowTarget);
  if (sentenceIdx < 0 || sentenceIdx >= transcript.length - 1) return; // no next
  const bar  = document.getElementById('autoAdvanceBar');
  const fill = document.getElementById('autoAdvanceFill');
  const text = document.getElementById('autoAdvanceText');
  bar.classList.remove('hidden');
  const totalMs = 3000;
  const startTime = Date.now();
  fill.style.width = '100%';
  autoAdvanceInterval = setInterval(() => {
    const elapsed = Date.now() - startTime;
    const remaining = Math.max(0, totalMs - elapsed);
    fill.style.width = ((remaining / totalMs) * 100) + '%';
    text.textContent = `${Math.ceil(remaining / 1000)} 秒后自动下一句`;
    if (elapsed >= totalMs) {
      cancelAutoAdvance();
      goNextSentence();
    }
  }, 50);
}

function cancelAutoAdvance() {
  if (autoAdvanceInterval) { clearInterval(autoAdvanceInterval); autoAdvanceInterval = null; }
  document.getElementById('autoAdvanceBar')?.classList.add('hidden');
}

function goNextSentence() {
  const sentenceIdx = transcript.indexOf(shadowTarget);
  const nextIdx = sentenceIdx + 1;
  if (nextIdx < transcript.length) openShadow(nextIdx);
  else closeShadow();
}

/* ── Confetti ── */
function fireConfetti() {
  let canvas = document.getElementById('confettiCanvas');
  if (!canvas) {
    canvas = document.createElement('canvas');
    canvas.id = 'confettiCanvas';
    document.body.appendChild(canvas);
  }
  canvas.width  = window.innerWidth;
  canvas.height = window.innerHeight;
  const ctx = canvas.getContext('2d');
  const colors = ['#34C759','#0071E3','#FF9F0A','#FF3B30','#AF52DE','#5AC8FA','#FFD60A'];
  const particles = Array.from({ length: 90 }, () => ({
    x:  Math.random() * canvas.width,
    y: -10 - Math.random() * 120,
    vx: (Math.random() - 0.5) * 4,
    vy: 2 + Math.random() * 3.5,
    r: 4 + Math.random() * 5,
    color: colors[Math.floor(Math.random() * colors.length)],
    angle: Math.random() * Math.PI * 2,
    va: (Math.random() - 0.5) * 0.25,
    opacity: 1,
  }));
  let frame;
  const deadline = Date.now() + 4000;
  function animate() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    let alive = false;
    particles.forEach(p => {
      p.x += p.vx; p.y += p.vy; p.vy += 0.07; p.angle += p.va;
      if (p.y < canvas.height + 20) alive = true;
      if (p.y > canvas.height - 80) p.opacity = Math.max(0, p.opacity - 0.025);
      ctx.save();
      ctx.translate(p.x, p.y); ctx.rotate(p.angle);
      ctx.globalAlpha = p.opacity;
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.r / 2, -p.r / 2, p.r, p.r * 1.7);
      ctx.restore();
    });
    if (alive && Date.now() < deadline) {
      frame = requestAnimationFrame(animate);
    } else {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (canvas.parentNode) canvas.remove();
    }
  }
  frame = requestAnimationFrame(animate);
}

/* ── Toast notification ── */
let toastTimer = null;
function showToast(msg, duration = 2000) {
  let el = document.getElementById('appToast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'appToast';
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), duration);
}

/* ── TTS word pronunciation ── */
function speakWord(text, el) {
  if (!window.speechSynthesis) return;
  window.speechSynthesis.cancel();
  const utt = new SpeechSynthesisUtterance(text.replace(/[^a-zA-Z'\-]/g, ''));
  utt.lang = 'en-US';
  utt.rate = 0.82;
  if (el) {
    document.querySelectorAll('.tts-word.speaking').forEach(w => w.classList.remove('speaking'));
    el.classList.add('speaking');
    utt.onend = () => el.classList.remove('speaking');
    utt.onerror = () => el.classList.remove('speaking');
  }
  window.speechSynthesis.speak(utt);
}

/* ── Last session persistence ── */
const LAST_URL_KEY = 'lastVideoUrl';
function saveLastUrl(url) {
  try { localStorage.setItem(LAST_URL_KEY, url); } catch (_) {}
}
function loadLastUrl() {
  try { return localStorage.getItem(LAST_URL_KEY) || ''; } catch (_) { return ''; }
}

/* ── Starred sentences (per video, localStorage) ── */
function starKey(videoId) { return `stars_${videoId}`; }
function loadStars(videoId) {
  try { return JSON.parse(localStorage.getItem(starKey(videoId)) || '{}'); }
  catch { return {}; }
}
function saveStars() {
  localStorage.setItem(starKey(currentVideoId), JSON.stringify(starredSentences));
}

/* ── Unified filter (text search + chip) ── */
function applyFilters() {
  const q = (document.getElementById('searchInput')?.value || '').toLowerCase().trim();
  document.querySelectorAll('.sentence-card').forEach(card => {
    const idx  = +card.dataset.idx;
    const item = transcript[idx];
    if (!item) { card.style.display = 'none'; return; }
    const matchText = !q ||
      item.english.toLowerCase().includes(q) ||
      (item.chinese && item.chinese.toLowerCase().includes(q));
    let matchChip = true;
    if (activeFilterChip === 'starred')     matchChip = !!starredSentences[idx];
    if (activeFilterChip === 'unpracticed') matchChip = practiceScores[idx] === undefined;
    if (activeFilterChip === 'low')         matchChip = practiceScores[idx] !== undefined && practiceScores[idx] < 60;
    card.style.display = (matchText && matchChip) ? '' : 'none';
  });
}

/* ── Audio level meter ── */
async function startMeter() {
  stopMeter();
  try {
    meterStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    meterCtx    = new (window.AudioContext || window.webkitAudioContext)();
    const src   = meterCtx.createMediaStreamSource(meterStream);
    const analyser = meterCtx.createAnalyser();
    analyser.fftSize = 128;
    src.connect(analyser);
    const data = new Uint8Array(analyser.frequencyBinCount);
    const fill = document.getElementById('audioMeterFill');
    const bar  = document.getElementById('audioMeter');
    if (bar) bar.classList.remove('hidden');
    const tick = () => {
      analyser.getByteFrequencyData(data);
      const avg = data.reduce((s, v) => s + v, 0) / data.length;
      const pct = Math.min(100, (avg / 80) * 100);
      if (fill) fill.style.width = pct + '%';
      meterFrame = requestAnimationFrame(tick);
    };
    tick();
  } catch (_) { /* mic already in use or denied — degrade gracefully */ }
}

function stopMeter() {
  if (meterFrame) { cancelAnimationFrame(meterFrame); meterFrame = null; }
  if (meterCtx)   { meterCtx.close().catch(() => {}); meterCtx = null; }
  if (meterStream){ meterStream.getTracks().forEach(t => t.stop()); meterStream = null; }
  const bar = document.getElementById('audioMeter');
  if (bar) {
    document.getElementById('audioMeterFill').style.width = '0%';
    bar.classList.add('hidden');
  }
}

/* ── Modal sentence position + navigation ── */
function updateSentencePos(idx) {
  const pos  = document.getElementById('sentencePos');
  const prev = document.getElementById('prevSentenceBtn');
  const next = document.getElementById('nextSentenceNavBtn');
  if (pos)  pos.textContent = `${idx + 1} / ${transcript.length}`;
  if (prev) prev.disabled = idx <= 0;
  if (next) next.disabled = idx >= transcript.length - 1;
}

/* ── Render sentence cards ── */
function renderCards(listEl) {
  listEl.innerHTML = '';

  transcript.forEach((item, idx) => {
    const card = document.createElement('div');
    card.className = 'sentence-card';
    card.dataset.idx = idx;

    const best = practiceScores[idx];
    const badgeHtml = best !== undefined
      ? `<span class="score-badge ${best >= 80 ? 'good' : best >= 55 ? 'ok' : 'poor'}">${best}分</span>`
      : '';

    card.innerHTML = `
      <div class="card-head">
        <span class="ts"><span class="card-num">${idx + 1}</span>${fmt(item.start)}</span>
        <div style="display:flex;align-items:center;gap:6px">
          ${badgeHtml}
          <button class="star-btn ${starredSentences[idx] ? 'starred' : ''}" data-idx="${idx}" title="收藏">${starredSentences[idx] ? '★' : '☆'}</button>
        </div>
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

    // Stagger entrance animation for the first 20 cards
    if (idx < 20) {
      card.style.animation = `cardEnter .35s ${idx * 40}ms both cubic-bezier(.4,0,.2,1)`;
    }

    card.addEventListener('click', e => {
      if (e.target.closest('button')) return;
      jumpToSentence(idx);
    });

    listEl.appendChild(card);
  });

  // Keyboard hint at bottom
  const hint = document.createElement('div');
  hint.className = 'kbd-hint';
  hint.textContent = '⌨️ 空格播放/暂停 · ← → 切换句子 · S 跟读';
  listEl.appendChild(hint);

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

/* ── Jump to sentence by index ── */
function jumpToSentence(idx) {
  if (idx < 0 || idx >= transcript.length) return;
  currentIndex = idx;
  highlightCard(idx);
  const s = transcript[idx];
  seekAndPlay(s.start, s.duration);
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
  if (starredSentences[idx]) {
    delete starredSentences[idx];
    btn.textContent = '☆';
    btn.classList.remove('starred');
  } else {
    starredSentences[idx] = true;
    btn.textContent = '★';
    btn.classList.add('starred');
  }
  saveStars();
  // Re-apply filters so starred chip updates live
  if (activeFilterChip !== 'all') applyFilters();
}

/* ── Shadowing Modal ── */
function openShadow(idx) {
  shadowTarget = transcript[idx];

  // Render English text with per-word TTS spans
  const words = shadowTarget.english.trim().split(/(\s+)/);
  document.getElementById('modalEnglish').innerHTML = words
    .map(chunk => chunk.match(/^\s+$/)
      ? chunk
      : `<span class="tts-word">${esc(chunk)}</span>`)
    .join('');
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

  updateSentencePos(idx);
  cancelAutoAdvance();
  overlay.classList.add('open');
  playNTimes(loopCount, shadowTarget.start, shadowTarget.duration);
}

function closeShadow() {
  cancelAutoAdvance();
  const overlay = document.getElementById('shadowModal');
  overlay.classList.remove('open', 'desktop-modal');
  overlay.style.cssText = '';
  stopRecording();
  shadowTarget = null;
}

function listenAgain() {
  if (shadowTarget) playNTimes(loopCount, shadowTarget.start, shadowTarget.duration);
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

      startMeter();
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
    stopMeter();
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
  stopMeter();
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

  // Persist score
  const sentenceIdx = transcript.indexOf(shadowTarget);
  if (sentenceIdx >= 0) saveScore(sentenceIdx, score);

  // Celebrate high scores
  if (score >= 80) fireConfetti();

  // Auto-advance countdown
  startAutoAdvance();
}

/* ── Speed control ── */
function setSpeed(rate) {
  if (player && player.setPlaybackRate) player.setPlaybackRate(rate);
  document.querySelectorAll('.speed-btn').forEach(b => {
    b.classList.toggle('active', parseFloat(b.dataset.rate) === rate);
  });
}

/* ── DOM ready ── */
document.addEventListener('DOMContentLoaded', () => {

  // ── Page init: start on home ──
  showHome();

  // ── Home page: URL input ──
  const homeInput = document.getElementById('homeUrlInput');
  const homeBtn   = document.getElementById('homeLoadBtn');
  if (homeBtn)   homeBtn.addEventListener('click',  () => loadFromUrl(homeInput?.value.trim()));
  if (homeInput) homeInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') loadFromUrl(homeInput.value.trim());
  });

  // ── Home page: category tabs ──
  document.getElementById('catTabs')?.addEventListener('click', e => {
    const tab = e.target.closest('.cat-tab');
    if (!tab) return;
    activeCat = tab.dataset.cat;
    document.querySelectorAll('.cat-tab').forEach(t =>
      t.classList.toggle('active', t === tab));
    renderHomeGrid();
  });

  // ── Home page: featured grid click ──
  document.getElementById('featuredGrid')?.addEventListener('click', e => {
    const card = e.target.closest('.feat-card');
    if (card) loadFromUrl(card.dataset.url);
  });

  // ── Home page: recent grid click ──
  document.getElementById('recentGrid')?.addEventListener('click', e => {
    const card = e.target.closest('.feat-card');
    if (card) loadFromUrl(card.dataset.url);
  });

  // ── Home page: fav home grid click ──
  document.getElementById('favHomeGrid')?.addEventListener('click', e => {
    const card = e.target.closest('.feat-card');
    if (card) loadFromUrl(card.dataset.url);
  });

  // ── Home page: clear recent ──
  document.getElementById('clearRecentBtn')?.addEventListener('click', clearRecent);

  // ── Player: back button ──
  document.getElementById('backBtn').addEventListener('click', showHome);

  // ── Side drawer tab buttons ──
  document.querySelectorAll('.side-tab').forEach(btn => {
    btn.addEventListener('click', () => toggleSidePanel(btn.dataset.panel));
  });
  // Close buttons inside panels
  document.querySelectorAll('.side-panel-close').forEach(btn => {
    btn.addEventListener('click', () => closeSidePanel(btn.dataset.panel));
  });
  // Backdrop closes all panels
  document.getElementById('drawerBackdrop')?.addEventListener('click', () => {
    if (activePanel) closeSidePanel(activePanel);
  });

  // Click on favorites cards / remove buttons
  document.getElementById('favList')?.addEventListener('click', e => {
    const removeBtn = e.target.closest('.side-remove-btn');
    if (removeBtn) {
      e.stopPropagation();
      let favs = loadFavs();
      favs.splice(+removeBtn.dataset.removeIdx, 1);
      saveFavs(favs);
      syncFavBtn();
      renderFavList();
      return;
    }
    const card = e.target.closest('[data-fav-idx]');
    if (!card) return;
    const v = loadFavs()[+card.dataset.favIdx];
    if (!v) return;
    document.getElementById('videoUrl').value = v.url;
    closeSidePanel('favs');
    loadVideo();
  });

  // Favorite (heart) button in topbar
  document.getElementById('favBtn').addEventListener('click', toggleFav);

  // Speed buttons
  document.querySelectorAll('.speed-btn').forEach(btn => {
    btn.addEventListener('click', () => setSpeed(parseFloat(btn.dataset.rate)));
  });

  // Keyboard shortcuts
  document.addEventListener('keydown', e => {
    // Don't hijack input fields
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    // Don't hijack when modal is open
    const modalOpen = document.getElementById('shadowModal').classList.contains('open');

    if (!modalOpen) {
      if (e.code === 'Space') {
        e.preventDefault();
        if (transcript.length === 0) return;
        if (platform === 'youtube' && player) {
          const state = player.getPlayerState?.();
          if (state === YT.PlayerState.PLAYING) player.pauseVideo();
          else if (currentIndex >= 0) jumpToSentence(currentIndex);
          else jumpToSentence(0);
        }
      }
      if ((e.key === 'ArrowRight' || e.key === 'l') && transcript.length) {
        e.preventDefault();
        jumpToSentence(Math.min(transcript.length - 1, (currentIndex < 0 ? 0 : currentIndex) + 1));
      }
      if ((e.key === 'ArrowLeft' || e.key === 'j') && transcript.length) {
        e.preventDefault();
        jumpToSentence(Math.max(0, (currentIndex < 0 ? 0 : currentIndex) - 1));
      }
      if (e.key === 's' && transcript.length && currentIndex >= 0) {
        openShadow(currentIndex);
      }
    }
  });

  // Load button (hidden in player, but kept for compatibility)
  document.getElementById('loadBtn')?.addEventListener('click', loadVideo);
  document.getElementById('videoUrl')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') loadVideo();
  });

  // Modal controls
  document.getElementById('closeModal').addEventListener('click', closeShadow);
  document.getElementById('listenAgainBtn').addEventListener('click', listenAgain);
  document.getElementById('recordBtn').addEventListener('click', toggleRecord);
  document.getElementById('retryBtn').addEventListener('click', () => {
    cancelAutoAdvance();
    document.getElementById('resultBox').classList.add('hidden');
    document.getElementById('recordStatus').textContent = '';
  });
  document.getElementById('nextBtn').addEventListener('click', () => {
    cancelAutoAdvance();
    goNextSentence();
  });
  document.getElementById('cancelAdvance').addEventListener('click', cancelAutoAdvance);

  // Loop control buttons
  document.querySelectorAll('.loop-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      loopCount = +btn.dataset.loops;
      document.querySelectorAll('.loop-btn').forEach(b => b.classList.toggle('active', b === btn));
    });
  });

  // Search input (optional — element removed from player page)
  const searchInput = document.getElementById('searchInput');
  const searchClear = document.getElementById('searchClear');
  if (searchInput) {
    searchInput.addEventListener('input', () => {
      searchClear?.classList.toggle('hidden', !searchInput.value);
      applyFilters();
    });
  }
  if (searchClear) {
    searchClear.addEventListener('click', () => {
      if (searchInput) { searchInput.value = ''; }
      searchClear.classList.add('hidden');
      applyFilters();
      searchInput?.focus();
    });
  }

  // Close modal on backdrop tap
  document.getElementById('shadowModal').addEventListener('click', e => {
    if (e.target.id === 'shadowModal') closeShadow();
  });

  // TTS: click a word in the modal to hear its pronunciation
  document.getElementById('modalEnglish').addEventListener('click', e => {
    const word = e.target.closest('.tts-word');
    if (word) speakWord(word.textContent, word);
  });

  // Filter chips
  document.getElementById('filterChips')?.addEventListener('click', e => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    activeFilterChip = chip.dataset.filter;
    document.querySelectorAll('.chip').forEach(c =>
      c.classList.toggle('active', c === chip));
    applyFilters();
  });

  // Modal prev / next navigation buttons
  document.getElementById('prevSentenceBtn').addEventListener('click', () => {
    const idx = transcript.indexOf(shadowTarget);
    if (idx > 0) { cancelAutoAdvance(); openShadow(idx - 1); }
  });
  document.getElementById('nextSentenceNavBtn').addEventListener('click', () => {
    const idx = transcript.indexOf(shadowTarget);
    if (idx < transcript.length - 1) { cancelAutoAdvance(); openShadow(idx + 1); }
  });

  // Modal keyboard shortcuts
  document.addEventListener('keydown', e => {
    const modalOpen = document.getElementById('shadowModal').classList.contains('open');
    if (!modalOpen) return;
    if (e.key === 'Escape') { e.preventDefault(); closeShadow(); return; }
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); toggleRecord(); }
    if (e.key === 'r' || e.key === 'R')     { e.preventDefault(); listenAgain(); }
    if (e.key === 'ArrowRight' || e.key === 'n') {
      e.preventDefault(); cancelAutoAdvance(); goNextSentence();
    }
    if (e.key === 'ArrowLeft' || e.key === 'p') {
      e.preventDefault();
      const prevIdx = transcript.indexOf(shadowTarget) - 1;
      if (prevIdx >= 0) { cancelAutoAdvance(); openShadow(prevIdx); }
    }
  });

  // Restore last watched URL into home input
  const lastUrl = loadLastUrl();
  if (lastUrl) {
    const homeIn = document.getElementById('homeUrlInput');
    if (homeIn) homeIn.value = lastUrl;
    document.getElementById('videoUrl').value = lastUrl;
  }

  // Tab switching (UI only; subtitles tab is the functional one)
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
    });
  });
});

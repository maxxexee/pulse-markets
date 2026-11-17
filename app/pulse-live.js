/**
 * PULSE — Live Data Integration
 * Drop this file next to your HTML, then add before </body>:
 *   <script src="pulse-live.js"></script>
 *
 * To update the API URL, change the line below.
 */

const PULSE_API = 'https://6ba1adab-8441-4534-b1bb-6b4481f77a36-00-1y6v2l0w17wxy.kirk.replit.dev/api/trends';
const REFRESH_MS = 5 * 60 * 1000; // re-fetch every 5 minutes

// ─── Helpers ────────────────────────────────────────────────────────────────

function formatVolume(n) {
  if (!n) return null;
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(0) + 'K';
  return String(n);
}

function timeAgo(iso) {
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'moments';
  if (m < 60) return m + ' min';
  const h = Math.floor(m / 60);
  return h + 'h';
}

function momentumSign(n) {
  if (n > 0) return '+' + n.toFixed(1) + '%';
  if (n < 0) return n.toFixed(1) + '%';
  return '—';
}

function sourceNames(sources) {
  const map = { google: 'Google', reddit: 'Reddit', hackernews: 'Hacker News', wikipedia: 'Wikipedia' };
  return sources.map(s => map[s.source] || s.source);
}

function cardGradient(status, index) {
  const palettes = {
    surging:  ['#061a0e', '#0a2818'],
    trending: ['#060d1c', '#091426'],
    stable:   ['#12091c', '#160c24'],
    fading:   ['#1a0808', '#240e0e'],
  };
  const [a, b] = palettes[status] || palettes.stable;
  const deg = 120 + index * 17;
  return `linear-gradient(${deg}deg, ${a} 0%, ${b} 100%)`;
}

function generateSummary(trend) {
  const platforms = sourceNames(trend.sources);
  const vol = formatVolume(trend.sources[0]?.volume);

  const velocityLine = {
    accelerating: 'momentum is accelerating',
    stable:       'attention is holding steady',
    decelerating: 'interest is beginning to slow',
    new:          'just entered the detection window',
  }[trend.velocityLabel] || 'is being tracked';

  const statusLine = {
    surging:  'High-velocity signal with strong cross-platform confirmation.',
    trending: 'Sustained multi-source attention — an active, established trend.',
    stable:   'Consistent baseline interest. Watching for an acceleration trigger.',
    fading:   'Classic post-peak pattern. Attention tapering — monitor for re-entry.',
  }[trend.status] || '';

  let desc = `${trend.topic} — ${velocityLine}`;
  if (platforms.length > 1) {
    desc += `, detected across ${platforms.join(', ')}`;
  } else {
    desc += ` on ${platforms[0] || 'multiple platforms'}`;
  }
  if (vol) desc += ` (${vol} in raw activity)`;
  desc += `. ${statusLine}`;

  if (trend.preTrend && trend.velocityLabel !== 'new') {
    desc += ` Pulse flagged this as a pre-trend — first detected ${timeAgo(trend.firstSeen)} ago, before mainstream coverage.`;
  }

  return desc;
}

function badgeClass(status) {
  if (status === 'surging') return 'surging';
  if (status === 'fading')  return 'hot';
  return 'trending';
}

function badgeLabel(status) {
  const map = { surging: 'Surging', trending: 'Trending', stable: 'Stable', fading: 'Fading' };
  return map[status] || status;
}

// ─── Ticker ─────────────────────────────────────────────────────────────────

function buildTicker(trends) {
  const track = document.querySelector('.ticker-track');
  if (!track) return;

  const items = trends.slice(0, 16);
  const doubled = [...items, ...items]; // seamless loop

  track.innerHTML = doubled.map(t => {
    const m = t.momentum;
    const dir = m >= 0 ? 'up' : 'down';
    const sign = m >= 0 ? '+' : '';
    return `<span class="ticker-item">
      <span class="trend-tag">${escHtml(t.hashtag)}</span>
      <span class="trend-move ${dir}">${sign}${m.toFixed(1)}%</span>
    </span>`;
  }).join('');
}

// ─── Cards ──────────────────────────────────────────────────────────────────

let liveData = [];

function buildCards(trends) {
  const row = document.getElementById('cardRow');
  if (!row) return;

  liveData = trends;

  row.innerHTML = trends.slice(0, 12).map((t, i) => {
    const m = t.momentum;
    const dir = m >= 0 ? 'up' : 'down';
    const sign = m >= 0 ? '+' : '';
    const bg = cardGradient(t.status, i);
    const category = t.category || sourceNames(t.sources).join(' · ');

    const bgStyle = t.imageUrl
      ? `background-image:url('${escHtml(t.imageUrl)}');background-size:cover;background-position:center top;filter:grayscale(100%)`
      : `background:${bg}`;

    return `<div class="trend-card" data-live-id="${escHtml(t.id)}" style="cursor:pointer">
      <div class="trend-card-bg" style="${bgStyle}"></div>
      <span class="trend-card-move ${dir}">${sign}${m.toFixed(1)}%</span>
      <div class="trend-card-body">
        <span class="trend-card-badge ${badgeClass(t.status)}">
          <span class="badge-dot"></span>${badgeLabel(t.status)}
          ${t.preTrend ? ' · Pre-trend' : ''}
        </span>
        <div class="trend-card-name">${escHtml(shortTitle(t.topic))}</div>
        <div class="trend-card-sub">${escHtml(category)}</div>
      </div>
    </div>`;
  }).join('');

  attachCardClicks();
}

function shortTitle(topic) {
  if (topic.length <= 18) return topic;
  const words = topic.split(' ');
  if (words.length === 1) return topic.slice(0, 18) + '…';
  // break into two lines at middle word
  const mid = Math.ceil(words.length / 2);
  return words.slice(0, mid).join(' ') + '\n' + words.slice(mid).join(' ');
}

// ─── Modal ──────────────────────────────────────────────────────────────────

function openLiveModal(id) {
  const trend = liveData.find(t => t.id === id);
  if (!trend) return;

  const overlay  = document.getElementById('modalOverlay');
  const blur     = document.getElementById('modalImgBlur');
  const sharp    = document.getElementById('modalImgSharp');
  const titleEl  = document.getElementById('modalTitle');
  const moveEl   = document.getElementById('modalMove');
  const volEl    = document.getElementById('modalVolume');
  const capEl    = document.getElementById('modalCap');
  const statusEl = document.getElementById('modalStatus');
  const tagsEl   = document.getElementById('modalTags');
  const descEl   = document.getElementById('modalDesc');

  if (!overlay) return;

  const m = trend.momentum;
  const dir = m >= 0 ? 'up' : 'down';
  const sign = m >= 0 ? '+' : '';

  // gradient background in place of image
  const grad = cardGradient(trend.status, liveData.indexOf(trend));
  if (blur)  { blur.style.backgroundImage  = ''; blur.style.background  = grad; }
  if (sharp) { sharp.style.backgroundImage = ''; sharp.style.background = grad; sharp.classList.add('loaded'); }

  if (titleEl)  titleEl.textContent  = trend.topic;
  if (moveEl)   { moveEl.textContent = `${sign}${m.toFixed(1)}%`; moveEl.className = `modal-move ${dir}`; }

  const vol = trend.sources[0]?.volume;
  if (volEl)    volEl.textContent    = vol ? formatVolume(vol) : '—';
  if (capEl)    capEl.textContent    = trend.sourceCount > 1 ? `${trend.sourceCount} sources` : trend.sources[0]?.source || '—';
  if (statusEl) statusEl.textContent = badgeLabel(trend.status) + (trend.preTrend ? ' · Pre-trend' : '');

  const tags = [
    ...sourceNames(trend.sources),
    badgeLabel(trend.status),
    ...(trend.preTrend ? ['Early Signal'] : []),
  ];
  if (tagsEl) tagsEl.innerHTML = tags.map(tg => `<span class="modal-tag">${escHtml(tg)}</span>`).join('');
  if (descEl) descEl.textContent = trend.description || generateSummary(trend);

  // also wire the modal image when available
  if (trend.imageUrl) {
    if (blur)  { blur.style.background  = ''; blur.style.backgroundImage  = `url('${escHtml(trend.imageUrl)}')`; }
    if (sharp) { sharp.style.background = ''; sharp.style.backgroundImage = `url('${escHtml(trend.imageUrl)}')`; sharp.classList.add('loaded'); }
  }

  // wire source links under the description
  const existingLinks = document.getElementById('modalSourceLinks');
  if (existingLinks) existingLinks.remove();

  const linksHtml = trend.sources.map(s => {
    const label = { google: 'Google Trends', reddit: 'Reddit', hackernews: 'Hacker News', wikipedia: 'Wikipedia' }[s.source] || s.source;
    return `<a href="${escHtml(s.link)}" target="_blank" rel="noopener noreferrer" style="
      display:inline-flex; align-items:center; gap:5px;
      font-family:-apple-system,sans-serif; font-size:0.65rem; font-weight:300;
      letter-spacing:0.1em; text-transform:uppercase;
      color:rgba(255,255,255,0.38); text-decoration:none;
      border:1px solid rgba(255,255,255,0.1); border-radius:4px;
      padding:4px 10px; transition:color 0.2s, border-color 0.2s;
    " onmouseover="this.style.color='rgba(255,255,255,0.8)';this.style.borderColor='rgba(255,255,255,0.25)'"
       onmouseout="this.style.color='rgba(255,255,255,0.38)';this.style.borderColor='rgba(255,255,255,0.1)'">${escHtml(label)} ↗</a>`;
  }).join('');

  const linksWrap = document.createElement('div');
  linksWrap.id = 'modalSourceLinks';
  linksWrap.style.cssText = 'display:flex; gap:8px; flex-wrap:wrap; margin-bottom:20px;';
  linksWrap.innerHTML = linksHtml;

  const actions = document.querySelector('.modal-actions');
  if (actions) actions.before(linksWrap);

  // wire primary button — open best source link
  const primaryBtn = document.querySelector('.modal-btn-primary');
  if (primaryBtn) {
    primaryBtn._pulseHandler && primaryBtn.removeEventListener('click', primaryBtn._pulseHandler);
    primaryBtn._pulseHandler = () => window.open(trend.sources[0]?.link || '#', '_blank', 'noopener');
    primaryBtn.addEventListener('click', primaryBtn._pulseHandler);
  }

  overlay.classList.add('active');
  document.body.classList.add('modal-open');
  document.body.style.overflow = 'hidden';
}

// ─── Drag scroll + card click wiring ────────────────────────────────────────

function attachCardClicks() {
  const row = document.getElementById('cardRow');
  if (!row) return;

  let isDown = false, startX = 0, scrollLeft = 0, didDrag = false;

  row.onmousedown = e => {
    isDown = true; didDrag = false;
    row.style.cursor = 'grabbing';
    startX = e.pageX - row.offsetLeft;
    scrollLeft = row.scrollLeft;
  };
  row.onmouseleave = () => { isDown = false; row.style.cursor = 'grab'; };
  row.onmouseup    = () => { isDown = false; row.style.cursor = 'grab'; };
  row.onmousemove  = e => {
    if (!isDown) return;
    e.preventDefault();
    didDrag = true;
    row.scrollLeft = scrollLeft - (e.pageX - row.offsetLeft - startX) * 1.5;
  };

  row.querySelectorAll('.trend-card[data-live-id]').forEach(card => {
    card.addEventListener('click', () => {
      if (didDrag) return;
      openLiveModal(card.dataset.liveId);
    });
  });
}

// ─── HTML safety ────────────────────────────────────────────────────────────

function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── Fetch + refresh loop ────────────────────────────────────────────────────

async function loadTrends() {
  try {
    const res = await fetch(PULSE_API + '?filter=all');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { trends } = await res.json();
    if (!Array.isArray(trends) || trends.length === 0) return;

    buildTicker(trends);
    buildCards(trends);

    const meta = document.querySelector('.section-meta');
    if (meta) {
      const now = new Date();
      meta.textContent = `Updated ${now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    }
  } catch (err) {
    console.warn('[Pulse] Could not load live trends:', err.message);
  }
}

// ─── Modal close wiring (works with both static and live cards) ──────────────

function wireModalClose() {
  const overlay = document.getElementById('modalOverlay');
  const closeBtn = document.getElementById('modalClose');
  if (!overlay) return;

  function closeModal() {
    overlay.classList.remove('active');
    document.body.classList.remove('modal-open');
    document.body.style.overflow = '';
  }

  if (closeBtn) closeBtn.addEventListener('click', closeModal);
  overlay.addEventListener('click', e => { if (e.target === overlay) closeModal(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });
}

// ─── Boot ────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  wireModalClose();
  loadTrends();
  setInterval(loadTrends, REFRESH_MS);
});

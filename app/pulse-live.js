/**
 * PULSE live data.
 *
 * Fetches the published attention trends beside this page, fills the ticker and
 * the cards, and opens a summary for the card that was chosen. Every number it
 * renders comes from the signed snapshot, so a card never shows an invented
 * figure: a trend the index cannot measure is left out of the response, and a
 * momentum with no reference epoch renders as a dash.
 */

/** Served beside the page: /app/ on the server, app/ on Pages, so one path fits both. */
const PULSE_API = '../api/trends';
const REFRESH_MS = 5 * 60 * 1000;

const SOURCE_LABELS = {
  wikipedia: 'Wikipedia',
  hackernews: 'Hacker News',
};

function formatCount(n) {
  if (typeof n !== 'number') return null;
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return Math.round(n / 1_000) + 'K';
  return String(n);
}

function formatMomentum(m) {
  if (typeof m !== 'number') return { text: 'No reference epoch', dir: '' };
  const dir = m > 0 ? 'up' : m < 0 ? 'down' : '';
  const sign = m > 0 ? '+' : '';
  return { text: `${sign}${m.toFixed(1)}%`, dir };
}

function sourceLabel(name) {
  return SOURCE_LABELS[name] || name;
}

function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function cardGradient(status, index) {
  const palettes = {
    surging: ['#061a0e', '#0a2818'],
    trending: ['#060d1c', '#091426'],
    stable: ['#12091c', '#160c24'],
    fading: ['#1a0808', '#240e0e'],
  };
  const [a, b] = palettes[status] || palettes.stable;
  return `linear-gradient(${120 + index * 17}deg, ${a} 0%, ${b} 100%)`;
}

function badgeClass(status) {
  if (status === 'surging') return 'surging';
  if (status === 'fading') return 'hot';
  return 'trending';
}

function badgeLabel(status) {
  const map = {
    surging: 'Surging',
    trending: 'Trending',
    stable: 'Stable',
    fading: 'Fading',
  };
  return map[status] || status;
}

/**
 * Describes one trend in plain words from the fields the index publishes. It
 * names the comparison window instead of promising a live price.
 */
function generateSummary(trend, header) {
  const parts = [];
  if (trend.discovered && typeof trend.baseline === 'number' && trend.baseline > 0) {
    const multiple = (trend.sources[0].volume / trend.baseline).toFixed(1);
    return (
      `${trend.topic} drew ${formatCount(trend.sources[0].volume)} Wikipedia views on ` +
      `${header.epochDay}, ${multiple}x its ${trend.baselineDays}-day average of ` +
      `${formatCount(trend.baseline)}. The daily ranking surfaced it outside the ` +
      'signed basket, so it is shown for context and not scored into the index.'
    );
  }

  const reference = header.referenceDay
    ? `its ${header.referenceDay} level`
    : 'its earlier level';

  if (typeof trend.momentum === 'number') {
    const direction = trend.momentum > 0 ? 'above' : 'below';
    parts.push(
      `${trend.topic} attention is ${Math.abs(trend.momentum).toFixed(1)}% ` +
        `${direction} ${reference}.`,
    );
  } else {
    parts.push(
      `${trend.topic} is measured in the ${header.epochDay} epoch, ` +
        'with no earlier published epoch to compare it against.',
    );
  }

  const signals = trend.sources.map((source) => {
    const count = formatCount(source.volume);
    return `${sourceLabel(source.source)}${count ? ` (${count})` : ''}`;
  });
  parts.push(`Signal${signals.length === 1 ? '' : 's'}: ${signals.join(', ')}.`);

  if (typeof header.index === 'number') {
    parts.push(
      `The attention index scored ${header.index.toFixed(1)} that day at ` +
        `${(header.coverageRatio * 100).toFixed(0)}% source coverage.`,
    );
  }
  return parts.join(' ');
}

function buildTicker(trends) {
  const track = document.querySelector('.ticker-track');
  if (!track) return;

  const items = trends.slice(0, 16);
  const doubled = [...items, ...items];

  track.innerHTML = doubled
    .map((trend) => {
      const move = formatMomentum(trend.momentum);
      return `<span class="ticker-item">
      <span class="trend-tag">${escHtml(trend.hashtag)}</span>
      <span class="trend-move ${move.dir}">${escHtml(move.text)}</span>
    </span>`;
    })
    .join('');
}

let liveData = [];
let header = { epochDay: null, referenceDay: null, index: null, coverageRatio: 0 };

function titleHtml(topic) {
  if (topic.length <= 18 || !topic.includes(' ')) {
    return escHtml(topic);
  }
  const words = topic.split(' ');
  const mid = Math.ceil(words.length / 2);
  return `${escHtml(words.slice(0, mid).join(' '))}<br/>${escHtml(
    words.slice(mid).join(' '),
  )}`;
}

function buildCards(trends) {
  const row = document.getElementById('cardRow');
  if (!row) return;

  liveData = trends;
  setCardStatus('');
  row.setAttribute('aria-busy', 'false');

  row.innerHTML = trends
    .slice(0, 20)
    .map((trend, index) => {
      const move = formatMomentum(trend.momentum);
      const category = sourceLabel(trend.sources[0]?.source || '');
      const bgStyle = trend.imageUrl
        ? `background-image:url('${escHtml(trend.imageUrl)}');` +
          'background-size:cover;background-position:center top;filter:grayscale(100%)'
        : `background:${cardGradient(trend.status, index)}`;

      return `<div class="trend-card" data-live-id="${escHtml(trend.id)}"
        role="button" tabindex="0"
        aria-label="${escHtml(`${trend.topic}, ${badgeLabel(trend.status)}, ${move.text}`)}">
      <div class="trend-card-bg" style="${bgStyle}"></div>
      <span class="trend-card-move ${move.dir}">${escHtml(move.text)}</span>
      <div class="trend-card-body">
        <span class="trend-card-badge ${badgeClass(trend.status)}">
          <span class="badge-dot"></span>${badgeLabel(trend.status)}
        </span>
        <div class="trend-card-name">${titleHtml(trend.topic)}</div>
        <div class="trend-card-sub">${escHtml(category)}</div>
      </div>
    </div>`;
    })
    .join('');

  wireCardRow();
}

let lastFocus = null;

/** Blurred and sharp layers share one image, or one gradient when none is mapped. */
function paintModalImage(trend, gradient) {
  const blur = document.getElementById('modalImgBlur');
  const sharp = document.getElementById('modalImgSharp');
  const url = trend.imageUrl ? `url('${trend.imageUrl}')` : null;

  for (const layer of [blur, sharp]) {
    if (!layer) continue;
    // The shorthand resets every background property, so it has to go first.
    layer.style.background = url ? '' : gradient;
    layer.style.backgroundImage = url || '';
  }
  if (sharp) sharp.classList.add('loaded');
}

function fillModalStats(trend, move) {
  const titleEl = document.getElementById('modalTitle');
  const moveEl = document.getElementById('modalMove');
  const volumeEl = document.getElementById('modalVolume');
  const sourcesEl = document.getElementById('modalCap');
  const statusEl = document.getElementById('modalStatus');
  const tagsEl = document.getElementById('modalTags');
  const descEl = document.getElementById('modalDesc');

  if (titleEl) titleEl.textContent = trend.topic;
  if (moveEl) {
    moveEl.textContent = move.text;
    moveEl.className = `modal-move ${move.dir}`;
  }

  const loudest = trend.sources.reduce(
    (best, source) => (best === null || source.volume > best.volume ? source : best),
    null,
  );
  if (volumeEl) {
    volumeEl.textContent = loudest
      ? `${formatCount(loudest.volume)} ${sourceLabel(loudest.source)}`
      : 'No measured signal';
  }
  if (sourcesEl) {
    sourcesEl.textContent =
      trend.sourceCount === 1 ? '1 source' : `${trend.sourceCount} sources`;
  }
  if (statusEl) statusEl.textContent = badgeLabel(trend.status);

  const tags = trend.sources.map((source) => sourceLabel(source.source));
  tags.push(badgeLabel(trend.status));
  if (header.epochDay) tags.push(header.epochDay);
  if (tagsEl) {
    tagsEl.innerHTML = tags
      .map((tag) => `<span class="modal-tag">${escHtml(tag)}</span>`)
      .join('');
  }
  if (descEl) descEl.textContent = generateSummary(trend, header);
}

/** One link per signal, so a reader can check the number that moved the card. */
function renderSourceLinks(trend) {
  const existing = document.getElementById('modalSourceLinks');
  if (existing) existing.remove();

  const links = document.createElement('div');
  links.id = 'modalSourceLinks';
  links.className = 'modal-source-links';
  links.innerHTML = trend.sources
    .map(
      (source) =>
        `<a class="modal-source-link" href="${escHtml(source.link)}"` +
        ' target="_blank" rel="noopener noreferrer">' +
        `${escHtml(sourceLabel(source.source))} signal</a>`,
    )
    .join('');

  const actions = document.querySelector('.modal-actions');
  if (actions) actions.before(links);

  const primaryBtn = document.querySelector('.modal-btn-primary');
  if (primaryBtn) {
    primaryBtn.onclick = () => {
      const first = trend.sources[0];
      if (first) window.open(first.link, '_blank', 'noopener');
    };
  }
}

function openLiveModal(id, trigger) {
  const trend = liveData.find((entry) => entry.id === id);
  const overlay = document.getElementById('modalOverlay');
  if (!trend || !overlay) return;

  const move = formatMomentum(trend.momentum);
  paintModalImage(trend, cardGradient(trend.status, liveData.indexOf(trend)));
  fillModalStats(trend, move);
  renderSourceLinks(trend);

  lastFocus = trigger || document.activeElement;
  overlay.classList.add('active');
  overlay.setAttribute('aria-hidden', 'false');
  document.body.classList.add('modal-open');
  document.body.style.overflow = 'hidden';

  const closeBtn = document.getElementById('modalClose');
  (closeBtn || overlay).focus();
}

function closeModal() {
  const overlay = document.getElementById('modalOverlay');
  if (!overlay || !overlay.classList.contains('active')) return;
  overlay.classList.remove('active');
  overlay.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('modal-open');
  document.body.style.overflow = '';
  if (lastFocus && document.contains(lastFocus)) lastFocus.focus();
  lastFocus = null;
}

/** Keeps Tab inside the open modal, and closes it on Escape. */
function onModalKeydown(event) {
  const overlay = document.getElementById('modalOverlay');
  if (!overlay || !overlay.classList.contains('active')) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    closeModal();
    return;
  }
  if (event.key !== 'Tab') return;

  const focusable = overlay.querySelectorAll(
    'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
  );
  if (focusable.length === 0) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

/** Clicking a card opens its summary; horizontal drag scrolls the row instead. */
function wireCardRow() {
  const row = document.getElementById('cardRow');
  if (!row) return;

  let isDown = false;
  let startX = 0;
  let scrollLeft = 0;
  let didDrag = false;

  row.onmousedown = (event) => {
    isDown = true;
    didDrag = false;
    row.style.cursor = 'grabbing';
    startX = event.pageX - row.offsetLeft;
    scrollLeft = row.scrollLeft;
  };
  row.onmouseleave = () => {
    isDown = false;
    row.style.cursor = 'grab';
  };
  row.onmouseup = () => {
    isDown = false;
    row.style.cursor = 'grab';
  };
  row.onmousemove = (event) => {
    if (!isDown) return;
    event.preventDefault();
    didDrag = true;
    row.scrollLeft = scrollLeft - (event.pageX - row.offsetLeft - startX) * 1.5;
  };

  row.querySelectorAll('.trend-card[data-live-id]').forEach((card) => {
    card.addEventListener('click', () => {
      if (didDrag) return;
      openLiveModal(card.dataset.liveId, card);
    });
    card.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      openLiveModal(card.dataset.liveId, card);
    });
  });
}

/** One line under the row: what is loading, what is missing, or nothing. */
function setCardStatus(text) {
  const status = document.getElementById('cardStatus');
  if (!status) return;
  status.textContent = text;
  status.hidden = text === '';
}

function setMeta(text) {
  const meta = document.querySelector('.section-meta');
  if (meta) meta.textContent = text;
}

async function loadTrends() {
  try {
    const response = await fetch(`${PULSE_API}?filter=all`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    const trends = Array.isArray(payload.trends) ? payload.trends : [];
    if (trends.length === 0) {
      setMeta('No published epoch');
      setCardStatus('No epoch has been published yet, so there is nothing to trend.');
      document.getElementById('cardRow')?.setAttribute('aria-busy', 'false');
      return;
    }

    header = {
      epochDay: payload.epochDay,
      referenceDay: payload.referenceDay,
      index: typeof payload.index === 'number' ? payload.index : null,
      coverageRatio: typeof payload.coverageRatio === 'number' ? payload.coverageRatio : 0,
    };

    buildTicker(trends);
    buildCards(trends);
    setMeta(`Epoch ${payload.epochDay}`);
  } catch (error) {
    console.warn('[Pulse] Could not load published trends:', error.message);
    if (liveData.length === 0) {
      setMeta('Feed unavailable');
      setCardStatus(
        'The published trends could not be loaded right now. Every epoch is still ' +
          'published and signed; reload to try again.',
      );
      document.getElementById('cardRow')?.setAttribute('aria-busy', 'false');
    }
  }
}

function wireModalClose() {
  const overlay = document.getElementById('modalOverlay');
  if (!overlay) return;
  overlay.setAttribute('aria-hidden', 'true');

  const closeBtn = document.getElementById('modalClose');
  if (closeBtn) closeBtn.addEventListener('click', closeModal);
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) closeModal();
  });
  document.addEventListener('keydown', onModalKeydown);
}

document.addEventListener('DOMContentLoaded', () => {
  wireModalClose();
  loadTrends();
  setInterval(loadTrends, REFRESH_MS);
});

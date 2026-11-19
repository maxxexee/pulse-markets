/**
 * Fills the sign-in plate with a field of dots that carries the PULSE wordmark.
 *
 * Dots sit on a grid across the whole card. Their brightness comes from a slow
 * moving noise field mixed with fixed per-dot speckle, and the cells inside the
 * letterforms are pushed to the top of the range, so the word reads out of the
 * grain rather than sitting on top of it. The noise drifting is what makes the
 * field shimmer.
 *
 * Every frame is drawn in a handful of alpha buckets, one fill each, because a
 * full card of individually stroked circles is too slow to animate.
 *
 * A reduced-motion reader gets the same field, frozen.
 */

const WORD = 'PULSE';
const GRID_PX = 5; // dot spacing, CSS px
const DOT_RADIUS_PX = 1.1; // dot radius, CSS px
const WORD_WIDTH_SHARE = 0.86; // share of the card width the wordmark spans
const FRAME_MS = 80; // about 12 fps, enough for a shimmer
const ALPHA_STEPS = 8; // brightness buckets, one path and fill each
const GRAIN_BASE = 0.075; // faintest the field ever gets
const GRAIN_SWING = 0.045; // how far the noise moves it
const SPECKLE_SHARE = 0.45; // share of variation that is fixed, not drifting
const WORD_ALPHA = 0.95;
const DOT_FILL = 'rgb(232, 228, 220)';
const FONT_STACK = "-apple-system, 'SF Pro Display', BlinkMacSystemFont, sans-serif";
const TAU = Math.PI * 2;

/** Font size that makes WORD span WORD_WIDTH_SHARE of the card width. */
function fitFontSize(context, width) {
  context.font = `700 100px ${FONT_STACK}`;
  const measured = context.measureText(WORD).width;
  if (measured === 0) return 100;
  return (width * WORD_WIDTH_SHARE * 100) / measured;
}

/** Rasterises the word once and keeps its per-cell coverage, 0 to 1. */
function readWordMask(width, height, step) {
  const cols = Math.ceil(width / step) + 1;
  const rows = Math.ceil(height / step) + 1;
  const coverage = new Float32Array(cols * rows);

  const scratch = document.createElement('canvas');
  scratch.width = width;
  scratch.height = height;
  const glyphs = scratch.getContext('2d');
  if (!glyphs) return { coverage, cols, rows };

  glyphs.font = `700 ${fitFontSize(glyphs, width)}px ${FONT_STACK}`;
  glyphs.fillStyle = '#000000';
  glyphs.textAlign = 'center';
  glyphs.textBaseline = 'middle';
  glyphs.fillText(WORD, width / 2, height / 2);

  const pixels = glyphs.getImageData(0, 0, width, height).data;
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const x = Math.min(width - 1, col * step);
      const y = Math.min(height - 1, row * step);
      coverage[row * cols + col] = pixels[(y * width + x) * 4 + 3] / 255;
    }
  }
  return { coverage, cols, rows };
}

/** Grid, word mask and speckle for one canvas size. */
function prepareGrid(width, height, step) {
  const mask = readWordMask(width, height, step);
  const speckle = new Float32Array(mask.cols * mask.rows);
  for (let cell = 0; cell < speckle.length; cell += 1) {
    const noise = Math.sin(cell * 12.9898) * 43758.5453;
    speckle[cell] = noise - Math.floor(noise);
  }
  return { coverage: mask.coverage, cols: mask.cols, rows: mask.rows, speckle };
}

/** Slow drift: three waves with long wavelengths, mixed to 0..1. */
function grainAt(x, y, seconds) {
  const a = Math.sin(x * 0.016 + seconds);
  const b = Math.cos(y * 0.021 - seconds * 0.8);
  const c = Math.sin((x - y) * 0.012 + seconds * 1.3);
  return 0.5 + 0.5 * (0.55 * a * b + 0.45 * c);
}

/** Sorts one frame of dots into brightness buckets by cell index. */
function collectDots(grid, buckets, step, seconds) {
  const { coverage, cols, rows, speckle } = grid;
  for (let row = 0; row < rows; row += 1) {
    const y = row * step;
    for (let col = 0; col < cols; col += 1) {
      const cell = row * cols + col;
      const grain = grainAt(col * step, y, seconds);
      const dot = grain * (1 - SPECKLE_SHARE) + (speckle[cell] ?? 0.5) * SPECKLE_SHARE;
      const word = coverage[cell] ?? 0;
      const field = GRAIN_BASE + GRAIN_SWING * dot;
      const alpha = word > 0.05 ? Math.max(field, WORD_ALPHA * word * (0.45 + 0.55 * dot)) : field;
      if (alpha < 0.03) continue;
      buckets[Math.min(ALPHA_STEPS - 1, Math.floor(alpha * ALPHA_STEPS))].push(col * step, y);
    }
  }
}

/** Paints the bucketed points, one fill per brightness level. */
function fillBuckets(context, buckets, radius) {
  for (let index = 0; index < ALPHA_STEPS; index += 1) {
    const points = buckets[index];
    if (points.length === 0) continue;
    context.globalAlpha = (index + 0.5) / ALPHA_STEPS;
    context.beginPath();
    for (let point = 0; point < points.length; point += 2) {
      context.moveTo(points[point] + radius, points[point + 1]);
      context.arc(points[point], points[point + 1], radius, 0, TAU);
    }
    context.fill();
  }
  context.globalAlpha = 1;
}

function createField(canvas) {
  const context = canvas.getContext('2d');
  if (!context) return null;

  const buckets = Array.from({ length: ALPHA_STEPS }, () => []);
  let grid = null;
  let step = GRID_PX;
  let radius = DOT_RADIUS_PX;
  let width = 0;
  let height = 0;

  /** Rebuilds the grid and the word mask, but only when the card changed size. */
  function resize() {
    const box = canvas.getBoundingClientRect();
    if (box.width < 1 || box.height < 1) return false;

    const scale = Math.min(window.devicePixelRatio || 1, 2);
    const nextWidth = Math.round(box.width * scale);
    const nextHeight = Math.round(box.height * scale);
    if (nextWidth === width && nextHeight === height) return true;

    width = nextWidth;
    height = nextHeight;
    canvas.width = width;
    canvas.height = height;
    step = Math.max(4, Math.round(GRID_PX * scale));
    radius = DOT_RADIUS_PX * scale;
    grid = prepareGrid(width, height, step);
    context.fillStyle = DOT_FILL;
    return true;
  }

  function draw(seconds) {
    if (grid === null) return;
    context.clearRect(0, 0, width, height);
    for (const bucket of buckets) bucket.length = 0;
    collectDots(grid, buckets, step, seconds);
    fillBuckets(context, buckets, radius);
  }

  return { resize, draw };
}

function start() {
  const canvas = document.getElementById('wordmark');
  if (!canvas) return;

  const field = createField(canvas);
  if (!field) return;

  function paint(seconds) {
    if (field.resize()) field.draw(seconds);
  }

  paint(0);
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    window.addEventListener('resize', () => paint(0), { passive: true });
    return;
  }

  let lastFrame = 0;
  function tick(now) {
    if (now - lastFrame >= FRAME_MS) {
      lastFrame = now;
      paint(now / 1000);
    }
    window.requestAnimationFrame(tick);
  }
  window.requestAnimationFrame(tick);
}

start();

/**
 * Fills the sign-in plate with a field of dots that carries the PULSE wordmark.
 *
 * Dots sit on a grid across the whole card. Each dot holds one brightness for a
 * few hundred milliseconds, then steps to a new one, so the field crackles like
 * a field of stars instead of breathing as a single surface. The cells inside the
 * letterforms sit at the top of the range, so the word reads out of the grain
 * rather than sitting on top of it.
 *
 * Brightness also eases off towards the top edge, which keeps the eye on the
 * word in the middle and stops the card reading as a flat texture.
 *
 * Every frame is drawn in a set of alpha buckets, one fill each, because a full
 * card of individually stroked dots is too slow to animate.
 *
 * A reduced-motion reader gets the same field, frozen.
 */

const WORD = 'PULSE';
const GRID_PX = 5; // dot spacing, CSS px
const DOT_SIZE_PX = 2; // dot edge, CSS px
const WORD_WIDTH_SHARE = 0.72; // share of the card width the wordmark spans
const FRAME_MS = 95; // about 10 fps, enough for the stepping to read as motion
const ALPHA_STEPS = 32; // brightness buckets, one path and fill each
const TICKS_PER_SECOND = 2.5; // how often a dot picks a new brightness
const GRAIN_LOW = 0.035; // dimmest a grain dot gets
const GRAIN_HIGH = 0.32; // brightest a grain dot gets
const WORD_LOW = 0.9; // dimmest a letter dot gets
const WORD_HIGH = 1; // brightest a letter dot gets
const WORD_TICKS = 0.6; // letters change rarely, so the word stays solid
const TOP_FADE = 0.3; // share of the normal level kept at the very top
const FADE_SHARE = 0.6; // fraction of the height the fade takes to lift
const DOT_FILL = 'rgb(232, 228, 220)';
const FONT_STACK = "-apple-system, 'SF Pro Display', BlinkMacSystemFont, sans-serif";

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

  /* Shrinking the word to one pixel per cell averages each cell, so a stroke
     that crosses half a cell lands at half strength instead of vanishing. */
  const cells = document.createElement('canvas');
  cells.width = cols;
  cells.height = rows;
  const sampler = cells.getContext('2d');
  if (!sampler) return { coverage, cols, rows };
  sampler.imageSmoothingEnabled = true;
  sampler.drawImage(scratch, 0, 0, cols, rows);
  const pixels = sampler.getImageData(0, 0, cols, rows).data;

  for (let cell = 0; cell < coverage.length; cell += 1) {
    const raw = pixels[cell * 4 + 3] / 255;
    const t = Math.min(1, Math.max(0, (raw - 0.25) / 0.4));
    coverage[cell] = t * t * (3 - 2 * t);
  }
  return { coverage, cols, rows };
}

/**
 * Grid, word mask and per-dot phase for one canvas size.
 *
 * The phase is fixed per cell and offsets that dot's clock, so dots change on
 * their own beats rather than the whole field switching at once.
 */
function prepareGrid(width, height, step) {
  const mask = readWordMask(width, height, step);
  const phase = new Float32Array(mask.cols * mask.rows);
  for (let cell = 0; cell < phase.length; cell += 1) {
    const noise = Math.sin(cell * 12.9898) * 43758.5453;
    phase[cell] = noise - Math.floor(noise);
  }
  return { coverage: mask.coverage, cols: mask.cols, rows: mask.rows, phase };
}

/** Stateless per-dot, per-tick value in 0..1. Same inputs always agree. */
function hashAt(cell, tick) {
  let h = Math.imul(cell + 1, 374761393) + Math.imul(tick + 1, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

/**
 * Brightness for one cell at one moment.
 *
 * Field dots run on a fast clock so the grain crackles; letter dots run on a
 * slow one over a narrower range, so the word holds its shape while the field
 * moves around it.
 */
function dotAlpha(cell, phase, word, fade, seconds) {
  const level = hashAt(cell, Math.floor(seconds * TICKS_PER_SECOND + phase * 40));
  if (word <= 0.05) return (GRAIN_LOW + (GRAIN_HIGH - GRAIN_LOW) * level) * fade;
  const slow = hashAt(cell, Math.floor(seconds * WORD_TICKS + phase * 40) + 7919);
  return Math.max((GRAIN_LOW + (GRAIN_HIGH - GRAIN_LOW) * level) * fade,
    (WORD_LOW + (WORD_HIGH - WORD_LOW) * slow) * word);
}

/**
 * Sorts one frame of dots into brightness buckets by cell index.
 *
 * A dot's level is a function of its cell and its clock tick, so it snaps to a
 * new value every few hundred milliseconds and holds it in between.
 */
function collectDots(grid, buckets, step, seconds) {
  const { coverage, cols, rows, phase } = grid;
  const fadeHeight = rows * step * FADE_SHARE;
  for (let row = 0; row < rows; row += 1) {
    const y = row * step;
    const fade = TOP_FADE + (1 - TOP_FADE) * Math.min(1, y / fadeHeight);
    for (let col = 0; col < cols; col += 1) {
      const cell = row * cols + col;
      const alpha = dotAlpha(cell, phase[cell] ?? 0.5, coverage[cell] ?? 0, fade, seconds);
      if (alpha < 0.008) continue;
      buckets[Math.min(ALPHA_STEPS - 1, Math.floor(alpha * ALPHA_STEPS))].push(col * step, y);
    }
  }
}

/**
 * Paints the bucketed points, one pass per brightness level.
 *
 * Dots are squares: at this size a 2px square is indistinguishable from a
 * circle, and fillRect costs a fraction of a stroked arc, which is the
 * difference between a smooth field and a warm laptop.
 */
function fillBuckets(context, buckets, size) {
  const half = size / 2;
  for (let index = 0; index < ALPHA_STEPS; index += 1) {
    const points = buckets[index];
    if (points.length === 0) continue;
    context.globalAlpha = (index + 0.5) / ALPHA_STEPS;
    for (let point = 0; point < points.length; point += 2) {
      context.fillRect(points[point] - half, points[point + 1] - half, size, size);
    }
  }
  context.globalAlpha = 1;
}

function createField(canvas) {
  const context = canvas.getContext('2d');
  if (!context) return null;

  const buckets = Array.from({ length: ALPHA_STEPS }, () => []);
  let grid = null;
  let step = GRID_PX;
  let size = DOT_SIZE_PX;
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
    size = DOT_SIZE_PX * scale;
    grid = prepareGrid(width, height, step);
    context.fillStyle = DOT_FILL;
    return true;
  }

  function draw(seconds) {
    if (grid === null) return;
    context.clearRect(0, 0, width, height);
    for (const bucket of buckets) bucket.length = 0;
    collectDots(grid, buckets, step, seconds);
    fillBuckets(context, buckets, size);
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

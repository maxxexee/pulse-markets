/**
 * Draws the PULSE wordmark as a field of dots.
 *
 * The sign-in page's left plate ends in a halftone wordmark that dissolves
 * upward, so the panel closes on the brand instead of a hard edge. The glyphs
 * are rasterised once to a scratch canvas and sampled on a grid, so the dots
 * follow the letterforms at any panel size instead of being placed by hand.
 *
 * Static on purpose: no animation loop, so it costs one paint.
 */

const WORD = 'PULSE';
const GRID_PX = 4; // sample spacing, CSS px
const DOT_RADIUS_PX = 1.05; // dot radius, CSS px
const FILL_SHARE = 0.94; // share of the panel width the wordmark spans
const BASELINE_SHARE = 0.9; // text baseline, as a share of canvas height
const DOT_FILL = 'rgba(232, 228, 220, 0.42)';
const FONT_STACK = "-apple-system, 'SF Pro Display', BlinkMacSystemFont, sans-serif";

/** Font size that makes WORD span FILL_SHARE of the canvas width. */
function fitFontSize(context, width) {
  context.font = `700 100px ${FONT_STACK}`;
  const measured = context.measureText(WORD).width;
  if (measured === 0) return 100;
  return (width * FILL_SHARE * 100) / measured;
}

function draw(canvas) {
  const rect = canvas.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) return;

  const scale = window.devicePixelRatio || 1;
  const width = Math.round(rect.width * scale);
  const height = Math.round(rect.height * scale);
  canvas.width = width;
  canvas.height = height;

  const context = canvas.getContext('2d');
  if (!context) return;

  const scratch = document.createElement('canvas');
  scratch.width = width;
  scratch.height = height;
  const glyphs = scratch.getContext('2d');
  if (!glyphs) return;

  glyphs.font = `700 ${fitFontSize(glyphs, width)}px ${FONT_STACK}`;
  glyphs.fillStyle = '#000000';
  glyphs.textAlign = 'center';
  glyphs.textBaseline = 'alphabetic';
  glyphs.fillText(WORD, width / 2, height * BASELINE_SHARE);

  const coverage = glyphs.getImageData(0, 0, width, height).data;
  const step = Math.max(3, Math.round(GRID_PX * scale));
  const radius = DOT_RADIUS_PX * scale;
  context.fillStyle = DOT_FILL;

  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      // Alpha of the sampled glyph pixel: inside the letterform or outside it.
      if (coverage[(y * width + x) * 4 + 3] < 128) continue;
      context.beginPath();
      context.arc(x, y, radius, 0, Math.PI * 2);
      context.fill();
    }
  }
}

function render() {
  const canvas = document.getElementById('wordmark');
  if (canvas) draw(canvas);
}

render();
window.addEventListener('resize', render, { passive: true });
// Fonts can land after first paint and change every measured width.
document.fonts?.ready.then(render);

/**
 * The strip above the footer: greys laid out on a coarse canvas grid, then
 * scaled up by CSS so every cell reads as a hard pixel. It stays still under
 * reduced motion and stops drawing while the footer is offscreen.
 */
(function () {
  const TONES = [
    'rgba(255,255,255,0.07)',
    'rgba(255,255,255,0.14)',
    'rgba(255,255,255,0.24)',
    'rgba(255,255,255,0.38)',
  ];

  function hash(x, y) {
    const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
    return s - Math.floor(s);
  }

  /** Smooth value noise, so the field never repeats across the width. */
  function noise(x, y) {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const xf = x - xi;
    const yf = y - yi;
    const u = xf * xf * (3 - 2 * xf);
    const v = yf * yf * (3 - 2 * yf);
    const top = hash(xi, yi) * (1 - u) + hash(xi + 1, yi) * u;
    const bottom = hash(xi, yi + 1) * (1 - u) + hash(xi + 1, yi + 1) * u;
    return top * (1 - v) + bottom * v;
  }

  function start() {
    const canvas = document.getElementById('footerField');
    const ctx = canvas && canvas.getContext ? canvas.getContext('2d') : null;
    if (!ctx) return;

    const W = canvas.width;
    const H = canvas.height;

    function draw(t) {
      ctx.clearRect(0, 0, W, H);
      for (let y = 0; y < H; y += 1) {
        for (let x = 0; x < W; x += 1) {
          const n =
            noise(x / 26 + t * 0.35, y / 16 - t * 0.2) * 0.62 +
            noise(x / 9 - t * 0.5, y / 7 + t * 0.3) * 0.38;
          // thin and dark at the top, dense toward the footer rule
          const value = n * (0.55 + 0.45 * (y / (H - 1)));
          if (value < 0.38) continue;
          const tone = value < 0.46 ? 0 : value < 0.58 ? 1 : value < 0.7 ? 2 : 3;
          ctx.fillStyle = TONES[tone];
          ctx.fillRect(x, y, 1, 1);
        }
      }
    }

    draw(0);
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    let visible = false;
    let last = 0;
    function loop(now) {
      requestAnimationFrame(loop);
      if (!visible || now - last < 90) return;
      last = now;
      draw(now / 900);
    }
    requestAnimationFrame(loop);

    if (typeof IntersectionObserver === 'function') {
      const observer = new IntersectionObserver(([entry]) => {
        visible = entry.isIntersecting;
      });
      observer.observe(canvas);
    } else {
      visible = true;
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();

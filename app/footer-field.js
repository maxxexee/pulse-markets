/**
 * The strip above the footer. A fullscreen WebGL fragment shader draws domain
 * warped fbm into a 3px halftone grid, so it reads as pixelated smoke rather
 * than a repeating texture. Density is zero at the top edge and full at the
 * bottom, so the field resolves into the rule above the footer content.
 *
 * Palette is a black ground with a three step grey ramp. Grey rather than hue
 * because the ramp has to read as one field, not three coloured bands, and
 * because the page has no accent colour anywhere else.
 *
 * The canvas is sized in CSS pixels with no device pixel ratio, which is what
 * keeps every cell visible and blocky. Without WebGL the canvas stays black.
 */
(function () {
  const VERTEX = 'attribute vec2 p; void main(){ gl_Position = vec4(p, 0.0, 1.0); }';

  const FRAGMENT = `
precision highp float;
uniform vec2 uRes;
uniform float uTime;
uniform vec3 uBg, uC0, uC1, uC2;

const float CELL = 3.0;
const float DOT = 2.0;
/* smoke features are sized in page pixels, not per element, so every surface matches */
const float SMOKE_SCALE = 400.0;

float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 p){
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) { v += a * noise(p); p = p * 2.02 + vec2(1.7, 9.2); a *= 0.5; }
  return v;
}
float bayer2(vec2 a){ a = floor(a); return fract(a.x / 2.0 + a.y * a.y * 0.75); }
/* ordered-dither threshold, (0.5 .. 15.5) / 16: never 0, so a density of nearly nothing draws no dots */
float bayer4(vec2 a){ return bayer2(0.5 * a) * 0.25 + bayer2(a) + 0.5 / 16.0; }

/* domain-warped fbm, roughly 0.2 to 0.8; px in page pixels, time in seconds */
float smokeField(vec2 px, float time){
  vec2 uv = px / SMOKE_SCALE;
  float t = time * 0.03;
  vec2 q = vec2(fbm(uv * 1.3 + vec2(0.0, t)), fbm(uv * 1.3 + vec2(5.2, 1.3) - t * 0.8));
  return fbm(uv * 1.3 + 2.4 * q + vec2(1.7, 9.2) + t * 0.4);
}
/* 1 on the 2px dot inside each 3px cell, 0 in the gap */
float dotMask(vec2 fragCoord){
  vec2 inCell = mod(fragCoord, CELL);
  return step(inCell.x, DOT - 0.5) * step(inCell.y, DOT - 0.5);
}

void main(){
  vec2 cell = floor(gl_FragCoord.xy / CELL);
  vec2 c = cell * CELL + CELL * 0.5;
  float up = c.y / uRes.y;                      // 0 at the bottom edge, 1 at the top
  float f = smokeField(c, uTime);
  // vertical gradient, empty at the top edge and full at the bottom. The smoke pushes the fade edge
  // up and down by almost half the band, so the skyline undulates instead of starting on one row;
  // a hard fade over the top 40% guarantees nothing touches the canvas edge, and a little per-cell
  // grain stops the sparsest dots from lining up on the Bayer grid.
  float down = 1.0 - up;
  float edge = clamp(down + (f - 0.5) * 0.9, 0.0, 1.0);
  float dens = pow(edge, 2.0) * 1.1 * smoothstep(0.0, 0.4, down) + (hash(cell * 1.7) - 0.5) * 0.05;
  vec3 col = uBg;
  if (dotMask(gl_FragCoord.xy) > 0.5 && dens > bayer4(cell)) {
    float p = c.x / uRes.x * 2.0;
    float i = floor(p) + (fract(p) > bayer4(cell + vec2(2.0, 1.0)) ? 1.0 : 0.0);
    col = i < 0.5 ? uC0 : i < 1.5 ? uC1 : uC2;
  }
  gl_FragColor = vec4(col, 1.0);
}
`;

  /* one ramp, three steps. The ground stays near black so the dots carry all contrast */
  const BG = [0x08 / 255, 0x08 / 255, 0x08 / 255];
  const C0 = [0x2b / 255, 0x2b / 255, 0x2b / 255];
  const C1 = [0x44 / 255, 0x44 / 255, 0x44 / 255];
  const C2 = [0x6b / 255, 0x6b / 255, 0x6b / 255];

  function compile(gl, type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    return shader;
  }

  function start() {
    const canvas = document.getElementById('footerField');
    const gl = canvas && canvas.getContext ? canvas.getContext('webgl', {
      antialias: false,
      premultipliedAlpha: false,
    }) : null;
    if (!gl) return;

    const program = gl.createProgram();
    gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERTEX));
    gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAGMENT));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.warn('[Pulse] Footer field shader failed to link:', gl.getProgramInfoLog(program));
      return;
    }
    gl.useProgram(program);

    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(program, 'p');
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);

    const uRes = gl.getUniformLocation(program, 'uRes');
    const uTime = gl.getUniformLocation(program, 'uTime');
    gl.uniform3fv(gl.getUniformLocation(program, 'uBg'), BG);
    gl.uniform3fv(gl.getUniformLocation(program, 'uC0'), C0);
    gl.uniform3fv(gl.getUniformLocation(program, 'uC1'), C1);
    gl.uniform3fv(gl.getUniformLocation(program, 'uC2'), C2);

    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const origin = performance.now();

    function paint(now) {
      gl.uniform1f(uTime, still ? 0 : (now - origin) / 1000);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    let frame = 0;
    let visible = false;
    function loop(now) {
      frame = 0;
      paint(now);
      if (visible) frame = requestAnimationFrame(loop);
    }

    new ResizeObserver(() => {
      const rect = canvas.getBoundingClientRect();
      canvas.width = Math.max(1, Math.round(rect.width));
      canvas.height = Math.max(1, Math.round(rect.height));
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.uniform2f(uRes, canvas.width, canvas.height);
      paint(performance.now());
    }).observe(canvas);

    new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      if (visible && !still && !frame) frame = requestAnimationFrame(loop);
    }).observe(canvas);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();

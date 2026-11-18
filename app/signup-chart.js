/**
 * The artwork beside the sign-up form.
 *
 * Draws the published index from /api/index/history, so the panel shows a signed
 * number rather than a stock image. A failed read leaves the empty state; the
 * chart never falls back to a made-up line.
 */

const HISTORY_API = '../api/index/history';
const HISTORY_TIMEOUT_MS = 8000;

/** Keeps the line clear of the chip above it and the readout below it. */
const CHART_INSET = { top: 92, right: 26, bottom: 108, left: 26 };

const SERIES_LABEL_SIZE = 11;
const NEWEST_LABEL = 'Newest';
const OLDEST_LABEL = 'Oldest';

function token(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function sizeCanvas(canvas) {
  const ratio = window.devicePixelRatio || 1;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  const context = canvas.getContext('2d');
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  return { context, width, height };
}

function plotArea(width, height) {
  return {
    left: CHART_INSET.left,
    right: width - CHART_INSET.right,
    top: CHART_INSET.top,
    bottom: height - CHART_INSET.bottom,
  };
}

function pointsFor(series, area) {
  const values = series.map((entry) => entry.index);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min;
  const width = area.right - area.left;
  return series.map((entry, index) => ({
    x: area.left + (width * index) / (series.length - 1),
    // A flat series sits on the middle line instead of dividing by zero.
    y: span === 0
      ? (area.top + area.bottom) / 2
      : area.bottom - ((entry.index - min) / span) * (area.bottom - area.top),
  }));
}

function drawRules(context, area) {
  context.strokeStyle = token('--border');
  context.lineWidth = 1;
  for (const step of [0, 0.5, 1]) {
    const y = Math.round(area.top + (area.bottom - area.top) * step) + 0.5;
    context.beginPath();
    context.moveTo(area.left, y);
    context.lineTo(area.right, y);
    context.stroke();
  }
}

function drawArea(context, points, area) {
  const gradient = context.createLinearGradient(0, area.top, 0, area.bottom);
  gradient.addColorStop(0, 'rgba(110, 231, 154, 0.16)');
  gradient.addColorStop(1, 'rgba(110, 231, 154, 0)');
  context.beginPath();
  context.moveTo(points[0].x, area.bottom);
  for (const point of points) context.lineTo(point.x, point.y);
  context.lineTo(points[points.length - 1].x, area.bottom);
  context.closePath();
  context.fillStyle = gradient;
  context.fill();
}

function drawSeries(context, points) {
  context.beginPath();
  points.forEach((point, index) => {
    if (index === 0) context.moveTo(point.x, point.y);
    else context.lineTo(point.x, point.y);
  });
  context.strokeStyle = token('--text');
  context.lineWidth = 1.5;
  context.lineJoin = 'round';
  context.stroke();
}

/** The newest epoch gets a dot, so the eye lands where the readout points. */
function drawNewestMarker(context, point) {
  context.beginPath();
  context.arc(point.x, point.y, 3, 0, Math.PI * 2);
  context.fillStyle = token('--live');
  context.fill();

  context.beginPath();
  context.arc(point.x, point.y, 7, 0, Math.PI * 2);
  context.strokeStyle = 'rgba(110, 231, 154, 0.3)';
  context.lineWidth = 1;
  context.stroke();
}

function drawLabels(context, area) {
  context.fillStyle = token('--faint');
  context.font = `${SERIES_LABEL_SIZE}px -apple-system, BlinkMacSystemFont, sans-serif`;
  context.textBaseline = 'middle';
  const y = area.bottom + 16;
  context.fillText(OLDEST_LABEL, area.left, y);
  context.fillText(NEWEST_LABEL, area.right - context.measureText(NEWEST_LABEL).width, y);
}

function renderChart(series) {
  const canvas = document.getElementById('artChart');
  if (!canvas) return;
  const { context, width, height } = sizeCanvas(canvas);
  if (width === 0 || height === 0) return;

  context.clearRect(0, 0, width, height);
  const area = plotArea(width, height);
  drawRules(context, area);
  if (series.length < 2) return;

  const points = pointsFor(series, area);
  drawArea(context, points, area);
  drawSeries(context, points);
  drawNewestMarker(context, points[points.length - 1]);
  drawLabels(context, area);
}

function updateReadout(series) {
  const value = document.getElementById('artValue');
  const caption = document.getElementById('artCaption');
  if (!value || !caption) return;

  if (series.length === 0) {
    value.textContent = 'No epoch';
    caption.textContent = 'Nothing published yet';
    return;
  }

  const latest = series[series.length - 1];
  const coverage = Math.round((latest.coverageRatio || 0) * 100);
  value.textContent = latest.index.toFixed(1);
  caption.textContent = `Epoch ${latest.day} · ${coverage}% coverage`;
}

/** Reads the published history and keeps only rows the chart can plot. */
async function loadIndex() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HISTORY_TIMEOUT_MS);
  try {
    const response = await fetch(HISTORY_API, { signal: controller.signal, cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    const days = Array.isArray(payload.days) ? payload.days : [];
    return days.filter(
      (entry) => typeof entry.index === 'number' && typeof entry.day === 'string',
    );
  } catch (error) {
    console.warn('[Pulse] Could not load the published index:', error.message);
    return [];
  } finally {
    clearTimeout(timer);
  }
}

function startChart() {
  let series = [];
  let frame = 0;
  const redraw = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => renderChart(series));
  };

  loadIndex().then((rows) => {
    series = rows;
    updateReadout(series);
    renderChart(series);
  });
  window.addEventListener('resize', redraw);
}

document.addEventListener('DOMContentLoaded', startChart);

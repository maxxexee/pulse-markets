/**
 * Opens the landing page in headless Chrome, clicks a live trend card, and prints
 * what the modal shows. Needs the index server running, for example:
 *
 *   node src/cli.ts serve --port 8089
 *   PAGE_URL=http://127.0.0.1:8089/app/ node ../ops/verify-cards.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PAGE_URL = process.env.PAGE_URL || 'http://127.0.0.1:8089/app/';
const PORT = Number(process.env.CDP_PORT || 9333);
const CHROME =
  process.env.CHROME_PATH ||
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const profile = mkdtempSync(join(tmpdir(), 'pulse-cdp-'));
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--disable-gpu',
    '--window-size=1440,2400',
    PAGE_URL,
  ],
  { stdio: 'ignore' },
);

async function listTargets() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  return res.json();
}

let target = null;
for (let attempt = 0; attempt < 60; attempt += 1) {
  try {
    const targets = await listTargets();
    target = targets.find((entry) => entry.type === 'page' && entry.url.startsWith(PAGE_URL.slice(0, 21)));
    if (target) break;
  } catch {
    // Devtools not listening yet.
  }
  await new Promise((resolve) => setTimeout(resolve, 250));
}
if (!target) {
  chrome.kill();
  throw new Error('Chrome did not expose the page target');
}

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});

let nextId = 0;
const pending = new Map();
const consoleErrors = [];
ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (message.method === 'Runtime.exceptionThrown') {
    const details = message.params.exceptionDetails;
    consoleErrors.push(details.exception?.description || details.text);
  }
  if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
    consoleErrors.push(message.params.args.map((arg) => arg.value ?? arg.description).join(' '));
  }
  if (message.id && pending.has(message.id)) {
    pending.get(message.id)(message);
    pending.delete(message.id);
  }
};

function send(method, params = {}) {
  const id = ++nextId;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve) => pending.set(id, resolve));
}

async function evaluate(expression) {
  const reply = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (reply.result?.exceptionDetails) {
    throw new Error(reply.result.exceptionDetails.exception?.description || expression);
  }
  return reply.result?.result?.value;
}

await send('Runtime.enable');
await send('Page.enable');

// Wait for the sample row to be replaced by cards from the published epoch.
let cardCount = 0;
for (let attempt = 0; attempt < 60; attempt += 1) {
  cardCount = await evaluate("document.querySelectorAll('.trend-card[data-live-id]').length");
  if (cardCount > 0) break;
  await new Promise((resolve) => setTimeout(resolve, 250));
}

const report = {
  url: await evaluate('location.href'),
  meta: await evaluate("document.querySelector('.section-meta')?.textContent"),
  cardCount,
};

report.firstCard = await evaluate(`(() => {
  const card = document.querySelector('.trend-card[data-live-id]');
  if (!card) return null;
  return {
    id: card.dataset.liveId,
    role: card.getAttribute('role'),
    tabindex: card.getAttribute('tabindex'),
    ariaLabel: card.getAttribute('aria-label'),
    move: card.querySelector('.trend-card-move')?.textContent,
    name: card.querySelector('.trend-card-name')?.textContent.replace(/\\s+/g, ' ').trim(),
    image: card.querySelector('.trend-card-bg')?.style.backgroundImage,
  };
})()`);

report.imageCard = await evaluate(`(() => {
  const card = [...document.querySelectorAll('.trend-card[data-live-id]')]
    .find((node) => node.querySelector('.trend-card-bg')?.style.backgroundImage.startsWith('url('));
  if (!card) return null;
  const bg = card.querySelector('.trend-card-bg').style.backgroundImage;
  const url = bg
    .slice(bg.indexOf('url(') + 4, bg.lastIndexOf(')'))
    .replace(/^["']|["']$/g, '');
  return {
    id: card.dataset.liveId,
    url,
    loaded: performance.getEntriesByName(new URL(url, location.href).href).length > 0,
  };
})()`);

await evaluate("document.querySelector('.trend-card[data-live-id]').click()");
await new Promise((resolve) => setTimeout(resolve, 300));

report.modal = await evaluate(`(() => {
  const overlay = document.getElementById('modalOverlay');
  return {
    open: overlay.classList.contains('active'),
    ariaHidden: overlay.getAttribute('aria-hidden'),
    role: overlay.getAttribute('role'),
    ariaModal: overlay.getAttribute('aria-modal'),
    title: document.getElementById('modalTitle').textContent,
    move: document.getElementById('modalMove').textContent,
    volume: document.getElementById('modalVolume').textContent,
    sources: document.getElementById('modalCap').textContent,
    status: document.getElementById('modalStatus').textContent,
    tags: [...document.querySelectorAll('#modalTags .modal-tag')].map((n) => n.textContent),
    desc: document.getElementById('modalDesc').textContent,
    links: [...document.querySelectorAll('#modalSourceLinks a')].map((a) => [a.textContent, a.href]),
    focus: document.activeElement?.id || document.activeElement?.className,
    bodyOverflow: document.body.style.overflow,
  };
})()`);

// Escape closes it and gives focus back to the card.
for (const type of ['keyDown', 'keyUp']) {
  await send('Input.dispatchKeyEvent', {
    type,
    key: 'Escape',
    code: 'Escape',
    windowsVirtualKeyCode: 27,
  });
}
await new Promise((resolve) => setTimeout(resolve, 200));

report.afterEscape = await evaluate(`(() => {
  const overlay = document.getElementById('modalOverlay');
  return {
    open: overlay.classList.contains('active'),
    ariaHidden: overlay.getAttribute('aria-hidden'),
    focusIsCard: Boolean(document.activeElement?.classList.contains('trend-card')),
    overflowCleared: document.body.style.overflow === '',
  };
})()`);

// Enter opens the second card from the keyboard, and focus comes back on close.
report.keyboardOpen = await evaluate(`(() => {
  const card = document.querySelectorAll('.trend-card[data-live-id]')[1];
  if (!card) return false;
  card.focus();
  card.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  return document.getElementById('modalOverlay').classList.contains('active');
})()`);

report.consoleErrors = consoleErrors;
console.log(JSON.stringify(report, null, 2));

ws.close();
chrome.kill();
try {
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
} catch {
  // A straggling Chrome thread still holds a file; the temp dir is disposable.
}

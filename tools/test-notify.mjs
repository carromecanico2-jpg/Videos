#!/usr/bin/env node
/**
 * Headless verification against local static server + mock webhook.
 */
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer-core';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const OUT = join(__dirname, '../../out');
const SITE_PORT = 8791;
const MOCK_PORT = 8765;
const MOCK_URL = `http://127.0.0.1:${MOCK_PORT}/webhook`;
const MOCK_KEY = 'test-secret-key-not-real';

mkdirSync(OUT, { recursive: true });

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg',
  '.png': 'image/png',
};

function startStatic() {
  const server = createServer((req, res) => {
    let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (path.endsWith('/')) path += 'index.html';
    const file = join(ROOT, path.replace(/^\//, ''));
    if (!file.startsWith(ROOT) || !existsSync(file)) {
      res.writeHead(404); res.end('missing'); return;
    }
    const ext = extname(file);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(readFileSync(file));
  });
  return new Promise((resolve) => {
    server.listen(SITE_PORT, '127.0.0.1', () => resolve(server));
  });
}

function startMock() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(__dirname, 'mock-webhook.mjs'), String(MOCK_PORT)], {
      env: { ...process.env, MOCK_OUT: join(OUT, 'mock-webhook-log.json') },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let ready = false;
    const onData = (buf) => {
      const s = buf.toString();
      process.stdout.write(s);
      if (!ready && s.includes('[mock-webhook]')) {
        ready = true;
        resolve(child);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', (b) => process.stderr.write(b));
    child.on('exit', (c) => {
      if (!ready) reject(new Error('mock exited ' + c));
    });
    setTimeout(() => { if (!ready) { ready = true; resolve(child); } }, 1500);
  });
}

async function getEvents() {
  const r = await fetch(`http://127.0.0.1:${MOCK_PORT}/events`);
  return (await r.json()).events || [];
}
async function resetEvents() {
  await fetch(`http://127.0.0.1:${MOCK_PORT}/reset`, { method: 'POST' });
}

async function main() {
  const mock = await startMock();
  const staticServer = await startStatic();
  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome',
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=1280,900'],
    defaultViewport: { width: 1280, height: 900 },
  });

  const results = { ok: true, checks: [] };
  const check = (name, cond, detail) => {
    results.checks.push({ name, ok: !!cond, detail });
    if (!cond) results.ok = false;
    console.log(cond ? '✓' : '✗', name, detail || '');
  };

  try {
    await resetEvents();
    const page = await browser.newPage();
    page.setDefaultTimeout(20000);

    // --- Settings connection ---
    await page.goto(`http://127.0.0.1:${SITE_PORT}/#/settings`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('#connUrl');

    // Clear any prior state
    await page.evaluate(() => {
      localStorage.clear();
    });
    await page.reload({ waitUntil: 'networkidle0' });
    await page.waitForSelector('#connUrl');

    await page.type('#connUrl', MOCK_URL);
    await page.type('#connKey', MOCK_KEY);
    await page.click('#btnSaveConn');
    await new Promise((r) => setTimeout(r, 400));
    await page.click('#btnTestConn');
    await new Promise((r) => setTimeout(r, 1200));

    let events = await getEvents();
    check('test event received', events.some((e) => e.body?.action === 'test'), `n=${events.length}`);
    check('test has Authorization', events.some((e) => e.authorization === `Bearer ${MOCK_KEY}`));

    await page.screenshot({ path: join(OUT, 'settings_connection.png'), fullPage: true });

    // Seed a prior approval in localStorage BEFORE connecting flush (simulate Ernesto's prior click)
    await resetEvents();
    await page.evaluate(() => {
      const approvals = {
        'mary-cooper:cuts': {
          status: 'aprobado',
          action: 'approve',
          notes: '',
          at: 'previo',
        },
      };
      localStorage.setItem('zepfilms-edit-panel-approvals-v2', JSON.stringify(approvals));
      // Also put an outbox-less state; enqueue happens on save/test
      localStorage.setItem('zepfilms-webhook-outbox-v1', JSON.stringify([]));
    });

    // Re-save + test to trigger enqueuePriorApprovals + flush
    await page.click('#btnSaveConn');
    await new Promise((r) => setTimeout(r, 500));
    await page.click('#btnTestConn');
    await new Promise((r) => setTimeout(r, 1500));

    events = await getEvents();
    const prior = events.filter((e) => e.body?.action === 'aprobar' && e.body?.step_id === 'cuts');
    check('outbox resend prior cuts approval', prior.length >= 1, `prior=${prior.length} total=${events.length}`);

    // --- Dashboard approve flow ---
    await resetEvents();
    // Reset approvals so we can click Aprobar again; keep webhook settings
    await page.evaluate(() => {
      localStorage.removeItem('zepfilms-edit-panel-approvals-v2');
      localStorage.removeItem('zepfilms-edit-panel-local-steps-v1');
      localStorage.setItem('zepfilms-webhook-outbox-v1', JSON.stringify([]));
      // Seed review decisions
      localStorage.setItem('mary-cooper-audio-review-v2', JSON.stringify({
        version: 2,
        decisions: { s1: 'borrar', r1: 'dejar' },
        keepTake: {},
        savedAt: new Date().toISOString(),
      }));
    });

    await page.goto(`http://127.0.0.1:${SITE_PORT}/#/p/mary-cooper`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('[data-step="cuts"] [data-act="approve"]');
    await page.click('[data-step="cuts"] [data-act="approve"]');
    await new Promise((r) => setTimeout(r, 1500));

    events = await getEvents();
    const approve = events.find((e) => e.body?.action === 'aprobar' && e.body?.step_id === 'cuts');
    check('approve POST received', !!approve, JSON.stringify(approve?.body?.action));
    check('approve payload shape', !!(approve && approve.body.project_slug === 'mary-cooper' && approve.body.timestamp && approve.body.action === 'aprobar'));
    check('approve has cuts payload', !!(approve?.body?.cuts));
    check('approve Authorization Bearer', approve?.authorization === `Bearer ${MOCK_KEY}`);

    // UI states
    const badgeCuts = await page.$eval('.step[data-step-id="cuts"] .status-badge', (el) => el.textContent.trim());
    const badgeNext = await page.$eval('.step[data-step-id="clean_audio"] .status-badge', (el) => el.textContent.trim());
    check('cuts badge Aprobado', /Aprobado/i.test(badgeCuts), badgeCuts);
    check('next badge En proceso', /En proceso|En progreso/i.test(badgeNext), badgeNext);

    const toastText = await page.evaluate(() => document.getElementById('toast')?.textContent || '');
    check('success toast Spanish', /Aprobado/.test(toastText) && /ZepFilms/.test(toastText) && !/copia y pega/i.test(toastText), toastText);

    await page.screenshot({ path: join(OUT, 'dashboard_approved.png'), fullPage: true });

    // Undo notifies
    const undoBtn = await page.$('.toast-undo');
    if (undoBtn) {
      await undoBtn.click();
      await new Promise((r) => setTimeout(r, 1000));
      events = await getEvents();
      check('undo notify', events.some((e) => e.body?.action === 'deshacer'));
    } else {
      check('undo notify', false, 'no undo button');
    }

    // Disconnect prompt
    await page.evaluate(() => {
      localStorage.setItem('zepfilms-webhook-settings-v1', JSON.stringify({ url: '', key: '', proxyUrl: '' }));
      localStorage.removeItem('zepfilms-edit-panel-approvals-v2');
      localStorage.removeItem('zepfilms-edit-panel-local-steps-v1');
    });
    await page.goto(`http://127.0.0.1:${SITE_PORT}/#/p/mary-cooper`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('[data-step="cuts"] [data-act="approve"]');
    await resetEvents();
    await page.click('[data-step="cuts"] [data-act="approve"]');
    await new Promise((r) => setTimeout(r, 1000));
    const toast2 = await page.evaluate(() => document.getElementById('toast')?.textContent || '');
    const connectModal = await page.$eval('#modalConnect', (el) => !el.hidden).catch(() => false);
    check('not-connected prompt', /Conecta|Settings|cola/i.test(toast2) || connectModal, toast2);
    events = await getEvents();
    check('no POST when disconnected', events.length === 0, `n=${events.length}`);
    // Outbox should have the event
    const outbox = await page.evaluate(() => JSON.parse(localStorage.getItem('zepfilms-webhook-outbox-v1') || '[]'));
    check('outbox queued while disconnected', outbox.length >= 1, `outbox=${outbox.length}`);

    writeFileSync(join(OUT, 'notify-test-results.json'), JSON.stringify(results, null, 2));
    console.log('\nRESULT', results.ok ? 'PASS' : 'FAIL');
    process.exitCode = results.ok ? 0 : 1;
  } catch (e) {
    console.error(e);
    results.ok = false;
    results.error = String(e.stack || e);
    writeFileSync(join(OUT, 'notify-test-results.json'), JSON.stringify(results, null, 2));
    process.exitCode = 1;
  } finally {
    await browser.close().catch(() => {});
    staticServer.close();
    mock.kill('SIGTERM');
  }
}

main();

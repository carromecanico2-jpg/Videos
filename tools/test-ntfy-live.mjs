#!/usr/bin/env node
/**
 * Headless: open live GitHub Pages, seed prior cuts approval, trigger test + boot flush,
 * then poll ntfy topic for our events.
 */
import puppeteer from 'puppeteer-core';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, '../../out');
mkdirSync(OUT, { recursive: true });

const TOPIC = 'zepfilms-panel-5947e6bd6cb6e863';
const LIVE = 'https://carromecanico2-jpg.github.io/Videos/';
const RUN_ID = `run-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

async function pollNtfy(sinceSec = 120) {
  const url = `https://ntfy.sh/${TOPIC}/json?poll=1&since=${sinceSec}s`;
  const res = await fetch(url);
  const text = await res.text();
  const events = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row.event && row.event !== 'message') continue;
      let body = row.message;
      try { body = JSON.parse(row.message); } catch { /* keep string */ }
      events.push({ id: row.id, time: row.time, body, raw: row.message });
    } catch { /* skip */ }
  }
  return events;
}

async function main() {
  // Record baseline time
  const sinceBefore = Math.floor(Date.now() / 1000) - 5;

  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome',
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=1280,900'],
    defaultViewport: { width: 1280, height: 900 },
  });

  const results = { ok: true, runId: RUN_ID, checks: [], events: [] };
  const check = (name, cond, detail) => {
    results.checks.push({ name, ok: !!cond, detail });
    if (!cond) results.ok = false;
    console.log(cond ? '✓' : '✗', name, detail || '');
  };

  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(30000);

    // Load live site first (cache-bust)
    await page.goto(`${LIVE}?t=${Date.now()}#/settings`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('#btnTestConn, #connStatusPill', { timeout: 20000 });

    // Seed prior cuts approval + clear sent/outbox so boot sends exactly once this session
    await page.evaluate((runId) => {
      localStorage.setItem('zepfilms-edit-panel-approvals-v2', JSON.stringify({
        'mary-cooper:cuts': {
          status: 'aprobado',
          action: 'approve',
          notes: `prior-seed ${runId}`,
          at: new Date().toISOString(),
        },
      }));
      localStorage.setItem('mary-cooper-audio-review-v2', JSON.stringify({
        version: 2,
        decisions: { demo_sil: 'borrar', demo_ret: 'dejar', demo_p: 'pendiente' },
        keepTake: {},
        savedAt: new Date().toISOString(),
      }));
      localStorage.removeItem('zepfilms-ntfy-sent-v1');
      localStorage.setItem('zepfilms-webhook-outbox-v1', JSON.stringify([]));
    }, RUN_ID);

    // Reload so bootNotify runs with seeded approvals
    await page.goto(`${LIVE}?t=${Date.now()}#/settings`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('#btnTestConn');
    await new Promise((r) => setTimeout(r, 2500)); // allow boot flush

    // Click Probar conexión with unique note via evaluate override
    await page.evaluate((runId) => {
      return window.ZepNotify.notify({
        action: 'test',
        note: `live-headless-test ${runId}`,
        extra: { runId, ping: true },
      });
    }, RUN_ID);

    await new Promise((r) => setTimeout(r, 1500));
    await page.screenshot({ path: join(OUT, 'settings_connection.png'), fullPage: true });

    // Also exercise approve UI path if cuts still approvable
    await page.goto(`${LIVE}?t=${Date.now()}#/p/mary-cooper`, { waitUntil: 'networkidle0' });
    await new Promise((r) => setTimeout(r, 1500));
    const hasApprove = await page.$('[data-step="cuts"] [data-act="approve"]');
    if (hasApprove) {
      // Clear local approval so button shows, then approve again with run tag
      await page.evaluate(() => {
        localStorage.removeItem('zepfilms-edit-panel-approvals-v2');
        localStorage.removeItem('zepfilms-edit-panel-local-steps-v1');
      });
      await page.reload({ waitUntil: 'networkidle0' });
      await page.waitForSelector('[data-step="cuts"] [data-act="approve"]');
      await page.click('[data-step="cuts"] [data-act="approve"]');
      await new Promise((r) => setTimeout(r, 2000));
    }
    await page.screenshot({ path: join(OUT, 'dashboard_approved.png'), fullPage: true });

    // Poll ntfy for recent messages
    await new Promise((r) => setTimeout(r, 2000));
    const url = `https://ntfy.sh/${TOPIC}/json?poll=1&since=all`;
    const res = await fetch(url);
    const text = await res.text();
    const all = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line);
        if (row.event && row.event !== 'message') continue;
        let body = row.message;
        try { body = JSON.parse(row.message); } catch {}
        all.push({ id: row.id, time: row.time, body });
      } catch {}
    }
    results.events = all.filter((e) => {
      const b = e.body;
      if (!b || typeof b !== 'object') return false;
      // recent: last 3 minutes
      const ts = Date.parse(b.timestamp || '') || (e.time * 1000);
      return Date.now() - ts < 3 * 60 * 1000;
    });

    const testHit = results.events.find((e) => e.body?.action === 'test' && String(e.body?.note || '').includes(RUN_ID));
    check('live test POST arrived on topic', !!testHit, testHit ? testHit.id : 'missing');

    const prior = results.events.filter((e) => e.body?.action === 'aprobar' && e.body?.step_id === 'cuts');
    check('cuts approval delivered', prior.length >= 1, `count=${prior.length}`);

    if (prior[0]) {
      const cuts = prior[0].body.cuts || {};
      const dc = cuts.decision_counts || {};
      const decisions = cuts.decisions || {};
      const summary = {
        action: prior[0].body.action,
        project: prior[0].body.project_slug,
        prior_local: !!prior[0].body.prior_local,
        decision_counts: dc,
        decisions_keys: Object.keys(decisions).length,
        keep_ranges: Array.isArray(cuts.keep_ranges) ? cuts.keep_ranges.length : null,
        note: prior[0].body.note,
      };
      results.cutsPayloadSummary = summary;
      check('cuts payload has decisions', Object.keys(decisions).length > 0 || dc.borrar != null, JSON.stringify(summary));
      console.log('CUTS_SUMMARY', JSON.stringify(summary));
    }

    // Settings UI status
    await page.goto(`${LIVE}?t=${Date.now()}#/settings`, { waitUntil: 'networkidle0' });
    const statusText = await page.$eval('#connStatusLabel', (el) => el.textContent).catch(() => '');
    check('settings shows activa', /activa/i.test(statusText), statusText);
    const hasUrlField = await page.$('#connUrl');
    check('no URL field', !hasUrlField);

    // Confirm notify.js on live is ntfy version
    const notifySrc = await fetch(`${LIVE}js/notify.js?t=${Date.now()}`).then((r) => r.text());
    check('live notify uses ntfy', /ntfy\.sh\/zepfilms-panel-5947e6bd6cb6e863/.test(notifySrc) && !/Authorization: Bearer/.test(notifySrc.split('ntfy')[0].slice(0, 200) + 'ntfy'));

    writeFileSync(join(OUT, 'ntfy-live-test.json'), JSON.stringify(results, null, 2));
    console.log('\nRESULT', results.ok ? 'PASS' : 'FAIL');
    process.exitCode = results.ok ? 0 : 1;
  } catch (e) {
    console.error(e);
    results.ok = false;
    results.error = String(e.stack || e);
    writeFileSync(join(OUT, 'ntfy-live-test.json'), JSON.stringify(results, null, 2));
    process.exitCode = 1;
  } finally {
    await browser.close().catch(() => {});
  }
}

main();

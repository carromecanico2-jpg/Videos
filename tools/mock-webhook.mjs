#!/usr/bin/env node
/**
 * Local mock webhook + optional CORS relay for headless tests.
 * Usage: node tools/mock-webhook.mjs [port]
 */
import http from 'node:http';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || process.argv[2] || 8765);
const received = [];
const OUT = process.env.MOCK_OUT || join(__dirname, '../../out/mock-webhook-log.json');

function save() {
  try {
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, JSON.stringify(received, null, 2));
  } catch (e) {
    console.error('save failed', e);
  }
}

function send(res, status, obj, extraHeaders = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Automation-Key, X-Webhook-Secret, X-Cursor-Webhook-Secret',
    'Access-Control-Max-Age': '7200',
    ...extraHeaders,
  });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Automation-Key, X-Webhook-Secret, X-Cursor-Webhook-Secret',
      'Access-Control-Max-Age': '7200',
    });
    res.end();
    return;
  }

  if (req.method === 'GET' && url.pathname === '/health') {
    send(res, 200, { ok: true, received: received.length });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/events') {
    send(res, 200, { events: received });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/reset') {
    received.length = 0;
    save();
    send(res, 200, { ok: true });
    return;
  }

  // CORS relay: forwards to target URL with Authorization
  if (req.method === 'POST' && url.pathname === '/proxy') {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    let payload;
    try {
      payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    } catch {
      send(res, 400, { error: 'invalid json' });
      return;
    }
    const target = payload.url;
    const auth = payload.authorization || payload.headers?.Authorization;
    const body = payload.body ?? {};
    if (!target) {
      send(res, 400, { error: 'missing url' });
      return;
    }
    try {
      const r = await fetch(target, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: auth || '',
          ...(payload.headers || {}),
        },
        body: JSON.stringify(body),
      });
      const text = await r.text();
      send(res, 200, { ok: r.ok, status: r.status, body: text.slice(0, 500) });
    } catch (e) {
      send(res, 502, { error: String(e.message || e) });
    }
    return;
  }

  if (req.method === 'POST' && (url.pathname === '/' || url.pathname === '/webhook')) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString('utf8');
    let body = null;
    try { body = JSON.parse(raw || '{}'); } catch { body = { raw }; }
    const entry = {
      at: new Date().toISOString(),
      path: url.pathname,
      authorization: req.headers['authorization'] || null,
      xAutomationKey: req.headers['x-automation-key'] || null,
      xWebhookSecret: req.headers['x-webhook-secret'] || null,
      body,
    };
    received.push(entry);
    save();
    console.log('[mock] event', body?.action, body?.project_slug || body?.project, 'auth=', !!entry.authorization);
    send(res, 200, { success: true, mock: true, n: received.length });
    return;
  }

  send(res, 404, { error: 'not found' });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock-webhook] http://127.0.0.1:${PORT}/webhook`);
  console.log(`[mock-webhook] proxy  http://127.0.0.1:${PORT}/proxy`);
  console.log(`[mock-webhook] events -> ${OUT}`);
});

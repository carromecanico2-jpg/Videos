/**
 * ZepFilms notify — webhook + outbox (localStorage only; never commit secrets).
 *
 * Auth research (2026-11-03):
 * - Grok Bot / Cursor routines docs: send key as `Authorization: Bearer <key>`.
 *   Source: https://cursor.com/help/grok-bot/routines.md
 * - Cursor Automations docs + make-bot-ui skill also send `X-Automation-Key: <key>`.
 * - Server requires the Authorization header (body/query alone → 401
 *   "Missing Authorization header. Use Authorization: Bearer <key>.").
 * - CORS: OPTIONS from github.io does NOT get Access-Control-Allow-Origin
 *   (only https://cursor.com does). Browser POSTs from GitHub Pages are blocked
 *   before the request is sent when Authorization is present.
 * - Fallback: retry without extra headers; then try a CORS proxy if configured;
 *   then opaque no-cors (cannot attach Authorization — will not wake Cursor);
 *   events stay in the outbox until a CORS-capable endpoint accepts them.
 */
(function (global) {
  const SETTINGS_KEY = 'zepfilms-webhook-settings-v1';
  const OUTBOX_KEY = 'zepfilms-webhook-outbox-v1';
  const STATUS_KEY = 'zepfilms-webhook-status-v1';
  const LOCAL_STEPS_KEY = 'zepfilms-edit-panel-local-steps-v1';
  const APPROVALS_KEY = 'zepfilms-edit-panel-approvals-v1';
  const APPROVALS_KEY_V2 = 'zepfilms-edit-panel-approvals-v2';
  const REVIEW_STORAGE_BY_SLUG = {
    'mary-cooper': 'mary-cooper-audio-review-v2',
  };

  function loadJSON(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return fallback;
      return JSON.parse(raw) || fallback;
    } catch {
      return fallback;
    }
  }
  function saveJSON(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
  }

  function getSettings() {
    const s = loadJSON(SETTINGS_KEY, {});
    return {
      url: String(s.url || '').trim(),
      key: String(s.key || '').trim(),
      proxyUrl: String(s.proxyUrl || '').trim(),
    };
  }
  function saveSettings( partial ) {
    const cur = getSettings();
    const next = {
      url: partial.url != null ? String(partial.url).trim() : cur.url,
      key: partial.key != null ? String(partial.key).trim() : cur.key,
      proxyUrl: partial.proxyUrl != null ? String(partial.proxyUrl).trim() : cur.proxyUrl,
    };
    saveJSON(SETTINGS_KEY, next);
    return next;
  }

  function getStatus() {
    return loadJSON(STATUS_KEY, { state: 'disconnected', message: '', at: null, mode: null });
  }
  function setStatus(state, message, extra = {}) {
    const row = {
      state, // connected | disconnected | error
      message: message || '',
      at: new Date().toISOString(),
      mode: extra.mode || null,
    };
    saveJSON(STATUS_KEY, row);
    try {
      global.dispatchEvent(new CustomEvent('zepfilms-webhook-status', { detail: row }));
    } catch (_) { /* ignore */ }
    return row;
  }

  function getOutbox() {
    const list = loadJSON(OUTBOX_KEY, []);
    return Array.isArray(list) ? list : [];
  }
  function saveOutbox(list) {
    saveJSON(OUTBOX_KEY, list.slice(-100));
  }
  function enqueueOutbox(event) {
    const list = getOutbox();
    const row = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      queuedAt: new Date().toISOString(),
      event,
    };
    list.push(row);
    saveOutbox(list);
    return row;
  }

  function normalizeBearer(key) {
    const k = String(key || '').trim().replace(/[\r\n]+/g, '');
    if (!k) return '';
    return /^Bearer\s+/i.test(k) ? k : `Bearer ${k}`;
  }
  function stripBearer(key) {
    return String(key || '').trim().replace(/[\r\n]+/g, '').replace(/^Bearer\s+/i, '');
  }

  function isConfigured(settings = getSettings()) {
    return !!(settings.url && settings.key);
  }

  function limaTimestamp() {
    return new Date().toLocaleString('es-PE', { timeZone: 'America/Lima' });
  }

  /** Local step overrides used until projects.json catches up. */
  function loadLocalSteps() {
    return loadJSON(LOCAL_STEPS_KEY, {});
  }
  function saveLocalSteps(data) {
    saveJSON(LOCAL_STEPS_KEY, data);
  }
  function setLocalStepStatus(projectId, stepId, status) {
    const data = loadLocalSteps();
    const key = `${projectId}:${stepId}`;
    data[key] = { status, at: new Date().toISOString() };
    saveLocalSteps(data);
    return data[key];
  }
  function clearLocalStepStatus(projectId, stepId) {
    const data = loadLocalSteps();
    delete data[`${projectId}:${stepId}`];
    saveLocalSteps(data);
  }
  function getLocalStepStatus(projectId, stepId) {
    return loadLocalSteps()[`${projectId}:${stepId}`] || null;
  }

  function mergeRanges(ranges) {
    const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const c of sorted) {
      if (!merged.length || c[0] > merged[merged.length - 1][1] + 0.001) merged.push([...c]);
      else merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], c[1]);
    }
    return merged;
  }

  function computeKeepRangesFromReview(proposalsData, reviewState) {
    if (!proposalsData || !reviewState) return null;
    const decisions = reviewState.decisions || {};
    const keepTake = reviewState.keepTake || {};
    const groups = proposalsData.groups || {};
    const proposals = proposalsData.proposals || [];
    const duration = proposalsData.duration || 0;

    function recommendedTakeId(g) {
      if (!g) return null;
      if (g.recommended_take_id) return g.recommended_take_id;
      const rec = (g.takes || []).find((t) => t.recommended);
      if (rec) return rec.id;
      const last = (g.takes || []).find((t) => t.kind === 'last') || (g.takes || [])[(g.takes || []).length - 1];
      return last ? last.id : null;
    }
    function applies(p) {
      return decisions[p.id] !== 'dejar';
    }

    const cuts = [];
    for (const p of proposals) {
      if (!applies(p)) continue;
      if (p.type === 'silence') {
        const keep = (p.meta && p.meta.keep_duration) || 0.3;
        const a = p.start + keep;
        if (a < p.end - 0.01) cuts.push([a, p.end]);
      } else if (p.type === 'retake') {
        const g = groups[p.group_id];
        if (!g || !g.takes?.length) {
          cuts.push([p.start, p.end]);
          continue;
        }
        const take =
          g.takes.find((t) => t.id === keepTake[g.id]) ||
          g.takes.find((t) => t.id === recommendedTakeId(g)) ||
          g.takes[g.takes.length - 1];
        const spanStart = Math.min(...g.takes.map((t) => t.start));
        const spanEnd = Math.max(...g.takes.map((t) => t.end));
        if (take.start > spanStart + 0.01) cuts.push([spanStart, take.start]);
        if (take.end < spanEnd - 0.01) cuts.push([take.end, spanEnd]);
      }
    }
    const mergedCuts = mergeRanges(cuts);
    const keep = [];
    let cursor = 0;
    for (const [a, b] of mergedCuts) {
      if (a > cursor + 0.01) keep.push([cursor, a]);
      cursor = Math.max(cursor, b);
    }
    if (cursor < duration - 0.01) keep.push([cursor, duration]);
    return keep.map(([a, b]) => ({
      start: Math.round(a * 1000) / 1000,
      end: Math.round(b * 1000) / 1000,
    }));
  }

  async function buildCutsPayload(projectSlug) {
    const storageKey = REVIEW_STORAGE_BY_SLUG[projectSlug] || `${projectSlug}-audio-review-v2`;
    const reviewState = loadJSON(storageKey, null);
    if (!reviewState) {
      return { available: false, storageKey, decisions: null, keepTake: null, keep_ranges: null };
    }
    const decisions = reviewState.decisions || {};
    const keepTake = reviewState.keepTake || {};
    const perProposal = Object.keys(decisions).map((id) => ({
      id,
      decision: decisions[id], // borrar | dejar | pendiente
      keep_take: null,
    }));

    let keep_ranges = null;
    let proposalsMeta = null;
    const candidates = [
      `revision/${projectSlug}/data/proposals.json`,
      `./data/proposals.json`,
      `data/proposals.json`,
    ];
    for (const path of candidates) {
      try {
        const res = await fetch(`${path}?t=${Date.now()}`, { cache: 'no-store' });
        if (!res.ok) continue;
        const data = await res.json();
        proposalsMeta = {
          total: (data.proposals || []).length,
          duration: data.duration || null,
        };
        // Attach keep_take per proposal when group known
        const groups = data.groups || {};
        for (const row of perProposal) {
          const p = (data.proposals || []).find((x) => x.id === row.id);
          if (p?.group_id) row.keep_take = keepTake[p.group_id] || null;
        }
        keep_ranges = computeKeepRangesFromReview(data, reviewState);
        break;
      } catch (_) { /* try next */ }
    }

    return {
      available: true,
      storageKey,
      savedAt: reviewState.savedAt || null,
      decisions,
      keepTake,
      per_proposal: perProposal,
      keep_ranges,
      proposals: proposalsMeta,
    };
  }

  function buildEvent({ projectSlug, stepId, action, note, cuts, extra }) {
    const payload = {
      source: 'zepfilms-edit-panel',
      project: projectSlug || null,
      project_slug: projectSlug || null,
      step: stepId || null,
      step_id: stepId || null,
      action, // aprobar | pedir_cambios | deshacer | guardar_decisiones | test
      note: note || '',
      timestamp: new Date().toISOString(),
      timestamp_lima: limaTimestamp(),
    };
    if (cuts) payload.cuts = cuts;
    if (extra && typeof extra === 'object') Object.assign(payload, extra);
    return payload;
  }

  function corsErrorMessage(err) {
    const msg = String(err && err.message || err || '');
    return /failed to fetch|networkerror|cors|load failed|typeerror/i.test(msg);
  }

  async function postDirect(url, key, body, { includeExtraHeaders = true } = {}) {
    const headers = {
      'Content-Type': 'application/json',
      Authorization: normalizeBearer(key),
    };
    if (includeExtraHeaders) {
      // Documented by make-bot-ui skill; may break preflight on strict allow-lists.
      headers['X-Automation-Key'] = stripBearer(key);
      headers['X-Webhook-Secret'] = stripBearer(key);
    }
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      mode: 'cors',
      credentials: 'omit',
    });
    const text = await res.text().catch(() => '');
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { ok: res.ok, status: res.status, text, json, mode: includeExtraHeaders ? 'cors+extras' : 'cors' };
  }

  async function postViaProxy(proxyUrl, targetUrl, key, body) {
    const res = await fetch(proxyUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: targetUrl,
        authorization: normalizeBearer(key),
        headers: {
          Authorization: normalizeBearer(key),
          'X-Automation-Key': stripBearer(key),
          'Content-Type': 'application/json',
        },
        body,
      }),
      mode: 'cors',
      credentials: 'omit',
    });
    const text = await res.text().catch(() => '');
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { ok: res.ok, status: res.status, text, json, mode: 'proxy' };
  }

  /**
   * Last-resort opaque POST. Browser strips Authorization — Cursor will 401.
   * Kept so non-Cursor mock endpoints without auth can still receive events.
   */
  async function postOpaque(url, body) {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify(body),
      mode: 'no-cors',
      keepalive: true,
    });
    return { ok: true, status: 0, text: '', json: null, mode: 'no-cors-opaque', opaque: true };
  }

  async function deliverOnce(event, settings = getSettings()) {
    if (!settings.url) {
      return { ok: false, reason: 'disconnected', message: 'Falta la URL del webhook' };
    }
    if (!settings.key && !settings.proxyUrl) {
      // Allow keyless only if talking to a local mock via proxy or open mock
    }
    if (!settings.key) {
      return { ok: false, reason: 'disconnected', message: 'Falta la clave del webhook' };
    }

    // 1) Direct CORS with full headers
    try {
      const r = await postDirect(settings.url, settings.key, event, { includeExtraHeaders: true });
      if (r.ok) return { ok: true, ...r };
      // Auth/server error (reachable — not CORS)
      return {
        ok: false,
        reason: 'http',
        message: `HTTP ${r.status}: ${(r.text || '').slice(0, 180)}`,
        ...r,
      };
    } catch (err1) {
      // 2) Retry without extra headers (Authorization + Content-Type only)
      try {
        const r2 = await postDirect(settings.url, settings.key, event, { includeExtraHeaders: false });
        if (r2.ok) return { ok: true, ...r2 };
        return {
          ok: false,
          reason: 'http',
          message: `HTTP ${r2.status}: ${(r2.text || '').slice(0, 180)}`,
          ...r2,
        };
      } catch (err2) {
        // 3) Optional CORS proxy
        if (settings.proxyUrl) {
          try {
            const r3 = await postViaProxy(settings.proxyUrl, settings.url, settings.key, event);
            if (r3.ok) return { ok: true, ...r3 };
            return {
              ok: false,
              reason: 'proxy_http',
              message: `Proxy HTTP ${r3.status}: ${(r3.text || '').slice(0, 180)}`,
              ...r3,
            };
          } catch (err3) {
            return {
              ok: false,
              reason: 'cors',
              message:
                'El navegador bloqueó la petición (CORS). Cursor solo permite el origen cursor.com; desde GitHub Pages hace falta un proxy CORS. ' +
                String(err3.message || err3),
              corsBlocked: true,
            };
          }
        }

        // 4) Opaque no-cors (does not send Authorization — Cursor will not wake)
        try {
          const r4 = await postOpaque(settings.url, {
            ...event,
            _note:
              'Entrega opaca (no-cors): el navegador no envía Authorization. Cursor requiere Bearer y no despertará con este modo.',
          });
          return {
            ok: false,
            reason: 'cors',
            corsBlocked: true,
            opaqueAttempted: true,
            message:
              'CORS bloqueó la entrega autenticada. Se intentó un POST opaco, pero sin encabezado Authorization Cursor no inicia la rutina. Configura un proxy CORS o un endpoint que permita este origen.',
            ...r4,
          };
        } catch (err4) {
          return {
            ok: false,
            reason: corsErrorMessage(err2) ? 'cors' : 'network',
            corsBlocked: corsErrorMessage(err2),
            message: String(err2.message || err2),
          };
        }
      }
    }
  }

  async function flushOutbox(settings = getSettings()) {
    if (!isConfigured(settings)) return { sent: 0, left: getOutbox().length };
    const list = getOutbox();
    if (!list.length) return { sent: 0, left: 0 };
    const remain = [];
    let sent = 0;
    for (const row of list) {
      const result = await deliverOnce(row.event, settings);
      if (result.ok) sent += 1;
      else remain.push(row);
    }
    saveOutbox(remain);
    return { sent, left: remain.length };
  }

  /**
   * Main entry: build payload, try deliver, queue on failure.
   * @returns {Promise<{ok:boolean, queued?:boolean, connected?:boolean, message?:string, result?:any, event?:any}>}
   */
  async function notify( partial ) {
    const settings = getSettings();
    const action = partial.action;
    const projectSlug = partial.projectSlug || partial.project || null;
    const stepId = partial.stepId || partial.step || null;
    const note = partial.note || '';

    let cuts = partial.cuts || null;
    if (!cuts && projectSlug && (stepId === 'cuts' || action === 'guardar_decisiones' || action === 'aprobar')) {
      if (stepId === 'cuts' || action === 'guardar_decisiones' || (action === 'aprobar' && stepId === 'cuts')) {
        try {
          cuts = await buildCutsPayload(projectSlug);
        } catch (_) {
          cuts = null;
        }
      }
    }

    const event = buildEvent({
      projectSlug,
      stepId,
      action,
      note,
      cuts,
      extra: partial.extra,
    });

    if (!isConfigured(settings)) {
      enqueueOutbox(event);
      setStatus('disconnected', 'Sin conectar — el evento quedó en cola. Abre Settings para conectar con ZepFilms.');
      return {
        ok: false,
        queued: true,
        connected: false,
        needSettings: true,
        message: 'Sin conectar. Configura el webhook en Settings.',
        event,
      };
    }

    const result = await deliverOnce(event, settings);
    if (result.ok) {
      setStatus('connected', 'Conectado', { mode: result.mode });
      // Flush any backlog after a successful send
      try { await flushOutbox(settings); } catch (_) { /* ignore */ }
      return { ok: true, connected: true, result, event, message: 'Enviado' };
    }

    enqueueOutbox(event);
    if (result.reason === 'disconnected') {
      setStatus('disconnected', result.message || 'Sin conectar');
    } else if (result.corsBlocked || result.reason === 'cors') {
      setStatus(
        'error',
        result.message ||
          'Error CORS: el navegador bloqueó el POST al webhook de Cursor. Evento en cola.',
        { mode: result.mode }
      );
    } else {
      setStatus('error', result.message || 'Error al notificar', { mode: result.mode });
    }
    return {
      ok: false,
      queued: true,
      connected: isConfigured(settings),
      result,
      event,
      message: result.message,
      corsBlocked: !!result.corsBlocked,
    };
  }

  async function testConnection() {
    const settings = getSettings();
    if (!settings.url || !settings.key) {
      setStatus('disconnected', 'Completa la URL y la clave');
      return { ok: false, message: 'Completa la URL del webhook y la clave' };
    }
    const event = buildEvent({
      projectSlug: null,
      stepId: null,
      action: 'test',
      note: 'Prueba de conexión desde el Panel de edición',
      extra: { ping: true },
    });
    const result = await deliverOnce(event, settings);
    if (result.ok) {
      setStatus('connected', 'Conectado — prueba OK', { mode: result.mode });
      try { await flushOutbox(settings); } catch (_) { /* ignore */ }
      return { ok: true, message: 'Conexión OK. ZepFilms recibió la prueba.', result };
    }
    if (result.corsBlocked || result.reason === 'cors') {
      setStatus('error', result.message || 'Error CORS', { mode: result.mode });
      return {
        ok: false,
        corsBlocked: true,
        message:
          'Error CORS: Cursor no permite este origen en el navegador. Usa un proxy CORS o un mock local. Los eventos se guardan en cola.',
        result,
      };
    }
    setStatus('error', result.message || 'Error', { mode: result.mode });
    return { ok: false, message: result.message || 'No se pudo conectar', result };
  }

  /** On boot: if configured, flush outbox (includes prior approvals). */
  async function bootNotify() {
    const settings = getSettings();
    if (!isConfigured(settings)) {
      if (!getStatus().state || getStatus().state === 'connected') {
        setStatus('disconnected', 'Sin conectar');
      }
      return { flushed: false };
    }
    const flushed = await flushOutbox(settings);
    if (flushed.sent > 0) {
      setStatus('connected', `Conectado — reenviados ${flushed.sent} de la cola`, { mode: 'flush' });
    }
    return { flushed: true, ...flushed };
  }

  // Seed outbox from an already-approved local step (e.g. cuts aprobado before webhook existed)
  async function enqueuePriorApprovals(projectList) {
    const approvals = loadJSON(APPROVALS_KEY_V2, loadJSON(APPROVALS_KEY, {}));
    const outbox = getOutbox();
    const existingSig = new Set(
      outbox.map((r) => `${r.event?.project_slug}|${r.event?.step_id}|${r.event?.action}`)
    );
    let added = 0;
    for (const project of projectList || []) {
      for (const step of project.pipeline || []) {
        const key = `${project.id}:${step.id}`;
        const local = approvals[key];
        if (!local) continue;
        if (local.status !== 'aprobado' && local.status !== 'cambios_pedidos') continue;
        // Prefer projects.json if it already advanced
        if (step.status === 'aprobado' && local.status === 'aprobado') continue;
        const action = local.status === 'aprobado' ? 'aprobar' : 'pedir_cambios';
        const sig = `${project.slug}|${step.id}|${action}`;
        if (existingSig.has(sig)) continue;
        let cuts = null;
        if (step.id === 'cuts') {
          try { cuts = await buildCutsPayload(project.slug); } catch (_) { cuts = null; }
        }
        enqueueOutbox(
          buildEvent({
            projectSlug: project.slug,
            stepId: step.id,
            action,
            note: local.notes || local.message || 'Reenvío de aprobación local previa',
            cuts,
            extra: { prior_local: true, approved_at: local.at || null },
          })
        );
        existingSig.add(sig);
        added += 1;
      }
    }
    return added;
  }

  const api = {
    SETTINGS_KEY,
    OUTBOX_KEY,
    LOCAL_STEPS_KEY,
    getSettings,
    saveSettings,
    getStatus,
    setStatus,
    isConfigured,
    getOutbox,
    notify,
    testConnection,
    bootNotify,
    flushOutbox,
    buildCutsPayload,
    enqueuePriorApprovals,
    setLocalStepStatus,
    getLocalStepStatus,
    clearLocalStepStatus,
    loadLocalSteps,
    limaTimestamp,
  };

  global.ZepNotify = api;
})(typeof window !== 'undefined' ? window : globalThis);

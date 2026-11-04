/**
 * ZepFilms notify — delivers panel events via ntfy.sh (no account, CORS-open).
 *
 * Topic is hardcoded (delivery channel only). Payload is the same JSON as before.
 * POST uses a plain body (no Authorization / no application/json Content-Type) so
 * the browser can skip preflight; ntfy.sh also answers OPTIONS with ACAO *.
 */
(function (global) {
  const NTFY_TOPIC = 'zepfilms-panel-5947e6bd6cb6e863';
  const NTFY_URL = `https://ntfy.sh/${NTFY_TOPIC}`;

  const OUTBOX_KEY = 'zepfilms-webhook-outbox-v1';
  const STATUS_KEY = 'zepfilms-ntfy-status-v1';
  const SENT_KEY = 'zepfilms-ntfy-sent-v1'; // dedupe prior approvals (exactly once)
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

  function getStatus() {
    return loadJSON(STATUS_KEY, { state: 'connected', message: 'Conexión con ZepFilms: activa ✓', at: null, mode: null });
  }
  function setStatus(state, message, extra = {}) {
    const row = {
      state, // connected | error
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

  function getSentMap() {
    return loadJSON(SENT_KEY, {});
  }
  function markSent(sig) {
    const m = getSentMap();
    m[sig] = new Date().toISOString();
    saveJSON(SENT_KEY, m);
  }
  function wasSent(sig) {
    return !!getSentMap()[sig];
  }

  function limaTimestamp() {
    return new Date().toLocaleString('es-PE', { timeZone: 'America/Lima' });
  }

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
      decision: decisions[id],
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
        for (const row of perProposal) {
          const p = (data.proposals || []).find((x) => x.id === row.id);
          if (p?.group_id) row.keep_take = keepTake[p.group_id] || null;
        }
        keep_ranges = computeKeepRangesFromReview(data, reviewState);
        break;
      } catch (_) { /* try next */ }
    }

    const counts = { borrar: 0, dejar: 0, pendiente: 0 };
    for (const d of Object.values(decisions)) {
      if (counts[d] != null) counts[d] += 1;
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
      decision_counts: counts,
    };
  }

  function buildEvent({ projectSlug, stepId, action, note, cuts, extra }) {
    const payload = {
      source: 'zepfilms-edit-panel',
      project: projectSlug || null,
      project_slug: projectSlug || null,
      step: stepId || null,
      step_id: stepId || null,
      action,
      note: note || '',
      timestamp: new Date().toISOString(),
      timestamp_lima: limaTimestamp(),
    };
    if (cuts) payload.cuts = cuts;
    if (extra && typeof extra === 'object') Object.assign(payload, extra);
    return payload;
  }

  /**
   * Plain POST to ntfy — body is the JSON string (message).
   * No custom headers → simple request, no preflight required.
   * ntfy also allows CORS with ACAO * if a preflight ever happens.
   */
  async function deliverOnce(event) {
    const body = JSON.stringify(event);
    try {
      const res = await fetch(NTFY_URL, {
        method: 'POST',
        body,
        mode: 'cors',
        credentials: 'omit',
        // Intentionally no Content-Type: application/json (avoids preflight).
        // text/plain is safelisted if the UA sets one; omitting is fine too.
      });
      const text = await res.text().catch(() => '');
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch { json = null; }
      if (res.ok) {
        return { ok: true, status: res.status, text, json, mode: 'ntfy' };
      }
      return {
        ok: false,
        reason: 'http',
        status: res.status,
        message: `HTTP ${res.status}: ${text.slice(0, 180)}`,
        text,
        json,
        mode: 'ntfy',
      };
    } catch (err) {
      return {
        ok: false,
        reason: 'network',
        message: String(err && err.message || err),
        mode: 'ntfy',
      };
    }
  }

  async function flushOutbox() {
    const list = getOutbox();
    if (!list.length) return { sent: 0, left: 0 };
    const remain = [];
    let sent = 0;
    for (const row of list) {
      const result = await deliverOnce(row.event);
      if (result.ok) {
        sent += 1;
        if (row.event?.action && row.event?.project_slug && row.event?.step_id) {
          markSent(`${row.event.project_slug}|${row.event.step_id}|${row.event.action}`);
        }
      } else {
        remain.push(row);
      }
    }
    saveOutbox(remain);
    return { sent, left: remain.length };
  }

  async function notify(partial) {
    const action = partial.action;
    const projectSlug = partial.projectSlug || partial.project || null;
    const stepId = partial.stepId || partial.step || null;
    const note = partial.note || '';

    let cuts = partial.cuts || null;
    if (!cuts && projectSlug && (stepId === 'cuts' || action === 'guardar_decisiones' || (action === 'aprobar' && stepId === 'cuts'))) {
      try {
        cuts = await buildCutsPayload(projectSlug);
      } catch (_) {
        cuts = null;
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

    const result = await deliverOnce(event);
    if (result.ok) {
      setStatus('connected', 'Conexión con ZepFilms: activa ✓', { mode: 'ntfy' });
      if (action && projectSlug && stepId) {
        markSent(`${projectSlug}|${stepId}|${action}`);
      }
      try { await flushOutbox(); } catch (_) { /* ignore */ }
      return { ok: true, connected: true, result, event, message: 'Enviado' };
    }

    enqueueOutbox(event);
    setStatus('error', result.message || 'Error al notificar — evento en cola', { mode: 'ntfy' });
    return {
      ok: false,
      queued: true,
      connected: true,
      result,
      event,
      message: result.message,
    };
  }

  async function testConnection() {
    const event = buildEvent({
      projectSlug: null,
      stepId: null,
      action: 'test',
      note: 'Prueba de conexión desde el Panel de edición',
      extra: { ping: true },
    });
    const result = await deliverOnce(event);
    if (result.ok) {
      setStatus('connected', 'Conexión con ZepFilms: activa ✓', { mode: 'ntfy' });
      try { await flushOutbox(); } catch (_) { /* ignore */ }
      return { ok: true, message: 'Prueba enviada ✓', result, event };
    }
    setStatus('error', result.message || 'Error', { mode: 'ntfy' });
    return { ok: false, message: result.message || 'No se pudo enviar la prueba', result, event };
  }

  /** Enqueue prior local approvals exactly once, then flush. */
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
        if (step.status === 'aprobado' && local.status === 'aprobado') continue;
        const action = local.status === 'aprobado' ? 'aprobar' : 'pedir_cambios';
        const sig = `${project.slug}|${step.id}|${action}`;
        if (wasSent(sig) || existingSig.has(sig)) continue;
        let cuts = null;
        if (step.id === 'cuts') {
          try { cuts = await buildCutsPayload(project.slug); } catch (_) { cuts = null; }
        }
        enqueueOutbox(
          buildEvent({
            projectSlug: project.slug,
            stepId: step.id,
            action,
            note: local.notes || 'Reenvío de aprobación local previa',
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

  async function bootNotify(projectList) {
    setStatus('connected', 'Conexión con ZepFilms: activa ✓', { mode: 'ntfy' });
    let added = 0;
    try {
      added = await enqueuePriorApprovals(projectList || []);
    } catch (_) { /* ignore */ }
    const flushed = await flushOutbox();
    return { added, ...flushed };
  }

  // Always "configured" — no user secrets
  function isConfigured() {
    return true;
  }

  const api = {
    NTFY_TOPIC,
    NTFY_URL,
    OUTBOX_KEY,
    LOCAL_STEPS_KEY,
    isConfigured,
    getStatus,
    setStatus,
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

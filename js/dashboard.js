const APPROVALS_KEY = 'zepfilms-edit-panel-approvals-v2';
const DRAFTS_KEY = 'zepfilms-edit-panel-drafts-v1';
const STATUS_LABEL = {
  pendiente: 'Pendiente',
  en_progreso: 'En progreso',
  en_proceso: 'En proceso',
  esperando_aprobacion: 'Esperando tu aprobación',
  aprobado: 'Aprobado',
  cambios_pedidos: 'Cambios pedidos',
  borrador: 'Borrador',
};

const STEP_ORDER = ['upload', 'cuts', 'clean_audio', 'edit', 'packaging', 'publish'];
const POLL_MS = 60000;

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

let DATA = { projects: [], drive: null };
let STYLE = null;
let CURRENT = { view: 'home', slug: null };
let LAST_UNDO = null;
let POLL_TIMER = null;

function toast(msg, { undo, action } = {}) {
  const el = $('#toast');
  el.innerHTML = '';
  const span = document.createElement('span');
  span.textContent = msg;
  el.appendChild(span);
  if (undo) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'toast-undo';
    btn.textContent = 'Deshacer';
    btn.addEventListener('click', () => {
      undo();
      el.classList.remove('show');
    });
    el.appendChild(btn);
  }
  if (action) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'toast-action';
    btn.textContent = action.label;
    btn.addEventListener('click', () => {
      action.onClick();
      el.classList.remove('show');
    });
    el.appendChild(btn);
  }
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), undo || action ? 7000 : 3200);
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

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

function loadApprovals() { return loadJSON(APPROVALS_KEY, {}); }
function saveApprovals(data) { saveJSON(APPROVALS_KEY, data); }
function loadDrafts() { return loadJSON(DRAFTS_KEY, []); }
function saveDrafts(list) { saveJSON(DRAFTS_KEY, list); }

function statusClass(status) {
  return `status-${status || 'pendiente'}`;
}
function statusDot(status) {
  if (status === 'aprobado') return 'ok';
  if (status === 'esperando_aprobacion' || status === 'en_progreso' || status === 'en_proceso' || status === 'cambios_pedidos') return 'warn';
  if (status === 'borrador') return 'draft';
  return '';
}

function approvalKey(projectId, stepId) {
  return `${projectId}:${stepId}`;
}

function stepRank(status) {
  const order = {
    pendiente: 0,
    borrador: 0,
    en_progreso: 1,
    en_proceso: 1,
    esperando_aprobacion: 2,
    cambios_pedidos: 2,
    aprobado: 3,
  };
  return order[status] ?? 0;
}

/**
 * Prefer projects.json when it shows a later/equal remote status.
 * Local overrides apply only while remote has not caught up.
 */
function effectiveStepStatus(project, step) {
  const remote = step.status || 'pendiente';
  const localApproval = loadApprovals()[approvalKey(project.id, step.id)];
  const localStep = window.ZepNotify?.getLocalStepStatus?.(project.id, step.id);

  let local = null;
  if (localApproval?.status === 'aprobado' || localApproval?.status === 'cambios_pedidos') {
    local = localApproval.status;
  } else if (localStep?.status) {
    local = localStep.status;
  }

  if (!local) return remote;
  if (stepRank(remote) >= stepRank(local) && remote !== 'pendiente') {
    // Remote caught up or surpassed — drop stale local override for this step
    if (stepRank(remote) > stepRank(local) || remote === local) {
      return remote;
    }
  }
  if (remote === 'aprobado') return 'aprobado';
  return local;
}

function progressOf(project) {
  const pipeline = project.pipeline || [];
  const total = pipeline.length || 1;
  const done = pipeline.filter((s) => effectiveStepStatus(project, s) === 'aprobado').length;
  return { done, total, pct: Math.round((done / total) * 100) };
}

function stepNeedsMedia(step) {
  return step.id === 'clean_audio' || step.id === 'edit';
}
function stepHasRequiredMedia(project, step) {
  if (step.id === 'clean_audio') return !!project.media?.cleanedAudio;
  if (step.id === 'edit') return !!project.media?.videoPreview;
  return true;
}
function canApproveStep(project, step) {
  if (!step.approvable) return false;
  if (effectiveStepStatus(project, step) === 'aprobado' && step.status === 'aprobado') return false;
  if (step.status === 'aprobado') return false;
  if (stepNeedsMedia(step) && !stepHasRequiredMedia(project, step)) return false;
  return true;
}

function nextStepAfter(project, stepId) {
  const pipeline = project.pipeline || [];
  const idx = pipeline.findIndex((s) => s.id === stepId);
  if (idx < 0 || idx >= pipeline.length - 1) return null;
  return pipeline[idx + 1];
}

function allProjects() {
  const remote = (DATA.projects || []).map((p) => ({ ...p, source: 'remote' }));
  const drafts = loadDrafts().map((p) => ({ ...p, source: 'draft', status: 'borrador' }));
  return [...remote, ...drafts];
}
function findProject(slug) {
  return allProjects().find((p) => p.slug === slug || p.id === slug) || null;
}

function parseRoute() {
  const raw = (location.hash || '#/').replace(/^#/, '');
  const parts = raw.split('/').filter(Boolean);
  if (!parts.length) return { view: 'home', slug: null };
  if (parts[0] === 'settings' || parts[0] === 'ayuda' || parts[0] === 'help' || parts[0] === 'style' || parts[0] === 'guia') {
    return { view: 'settings', slug: null };
  }
  if (parts[0] === 'p' && parts[1]) return { view: 'project', slug: parts[1] };
  return { view: 'home', slug: null };
}

function setSidebarOpen(open) {
  $('#sidebar').classList.toggle('open', open);
  $('#sidebarBackdrop').hidden = !open;
}

function mediaBlock(label, path, kind) {
  if (!path) {
    return `<div class="media-slot"><span class="pending-label">${escapeHtml(label)} — pendiente</span><div>Aún no hay archivo. Se muestra cuando se defina la ruta en <code>data/projects.json</code>.</div></div>`;
  }
  if (kind === 'audio') {
    return `<div class="media-slot"><span class="pending-label">${escapeHtml(label)}</span><audio controls preload="metadata" src="${escapeHtml(path)}"></audio></div>`;
  }
  return `<div class="media-slot"><span class="pending-label">${escapeHtml(label)}</span><video controls preload="metadata" src="${escapeHtml(path)}"></video></div>`;
}

function showConnectPrompt() {
  const modal = $('#modalConnect');
  if (modal) modal.hidden = false;
  else {
    toast('Conecta ZepFilms en Settings', {
      action: {
        label: 'Ir a Settings',
        onClick: () => { location.hash = '#/settings'; },
      },
    });
  }
}
function closeConnect() {
  const modal = $('#modalConnect');
  if (modal) modal.hidden = true;
}

function mapAction(kind) {
  if (kind === 'approve') return 'aprobar';
  if (kind === 'changes') return 'pedir_cambios';
  if (kind === 'undo') return 'deshacer';
  return kind;
}

async function applyStepDecision(project, step, kind, notes = '') {
  const key = approvalKey(project.id, step.id);
  const approvals = loadApprovals();
  const prev = approvals[key] ? { ...approvals[key] } : null;
  const prevLocalNext = (() => {
    const n = nextStepAfter(project, step.id);
    return n ? window.ZepNotify?.getLocalStepStatus?.(project.id, n.id) : null;
  })();

  const status = kind === 'approve' ? 'aprobado' : 'cambios_pedidos';
  approvals[key] = {
    status,
    action: kind,
    notes: notes.trim(),
    at: new Date().toLocaleString('es-PE', { timeZone: 'America/Lima' }),
  };
  saveApprovals(approvals);

  // Persist local badge overrides: this step approved, next in progress
  window.ZepNotify?.setLocalStepStatus?.(project.id, step.id, status);
  let next = null;
  if (kind === 'approve') {
    next = nextStepAfter(project, step.id);
    if (next && (next.status === 'pendiente' || !next.status)) {
      window.ZepNotify?.setLocalStepStatus?.(project.id, next.id, 'en_proceso');
    }
  }

  LAST_UNDO = {
    key,
    prev,
    prevLocalNext,
    nextStepId: next?.id || null,
    projectSlug: project.slug,
    projectId: project.id,
    stepId: step.id,
    kind,
  };

  const action = mapAction(kind);
  const notifyResult = await window.ZepNotify.notify({
    projectSlug: project.slug,
    stepId: step.id,
    action,
    note: notes.trim(),
  });

  const connected = window.ZepNotify.isConfigured();

  if (notifyResult.ok) {
    const msg = kind === 'approve'
      ? 'Aprobado ✓. ZepFilms ya está trabajando en el siguiente paso.'
      : 'Cambios pedidos ✓. ZepFilms ya fue notificado.';
    toast(msg, {
      undo: () => undoLastDecision(),
    });
  } else if (!connected || notifyResult.needSettings) {
    toast('Guardado. Conecta ZepFilms para que el flujo continúe solo.', {
      undo: () => undoLastDecision(),
      action: {
        label: 'Conectar',
        onClick: () => { location.hash = '#/settings'; },
      },
    });
    showConnectPrompt();
  } else if (notifyResult.corsBlocked) {
    toast('Guardado en cola. Hay un bloqueo CORS hacia Cursor — revisa Settings.', {
      undo: () => undoLastDecision(),
      action: {
        label: 'Settings',
        onClick: () => { location.hash = '#/settings'; },
      },
    });
  } else {
    toast(kind === 'approve'
      ? 'Aprobado ✓. Aviso en cola — se reenviará al conectar.'
      : 'Cambios pedidos ✓. Aviso en cola.', {
      undo: () => undoLastDecision(),
    });
  }

  render();
}

async function undoLastDecision() {
  if (!LAST_UNDO) return;
  const { key, prev, projectId, projectSlug, stepId, nextStepId, prevLocalNext } = LAST_UNDO;
  const a = loadApprovals();
  if (prev) a[key] = prev;
  else delete a[key];
  saveApprovals(a);

  if (prev) {
    window.ZepNotify?.setLocalStepStatus?.(projectId, stepId, prev.status);
  } else {
    window.ZepNotify?.clearLocalStepStatus?.(projectId, stepId);
  }
  if (nextStepId) {
    if (prevLocalNext) window.ZepNotify?.setLocalStepStatus?.(projectId, nextStepId, prevLocalNext.status);
    else window.ZepNotify?.clearLocalStepStatus?.(projectId, nextStepId);
  }

  await window.ZepNotify.notify({
    projectSlug,
    stepId,
    action: 'deshacer',
    note: 'El usuario deshizo la última decisión en el panel',
  });

  LAST_UNDO = null;
  toast('Deshecho');
  if (CURRENT.view === 'project' && CURRENT.slug === projectSlug) {
    renderProject(findProject(projectSlug));
  }
  renderNav();
}

function renderStep(project, step, index) {
  const status = effectiveStepStatus(project, step);
  const label = STATUS_LABEL[status] || STATUS_LABEL.pendiente;
  const key = approvalKey(project.id, step.id);
  const saved = loadApprovals()[key];
  const blockedMedia = step.approvable && stepNeedsMedia(step) && !stepHasRequiredMedia(project, step);
  const showActions = step.approvable && project.source !== 'draft' && step.status !== 'aprobado' && status !== 'aprobado';

  let meta = '';
  if (step.id === 'cuts' && project.review) {
    const c = project.review.counts || {};
    meta = `<div class="step-meta">
      <span class="chip-count"><strong>${c.total ?? '—'}</strong> prop.</span>
      <span class="chip-count"><strong>${c.silence ?? '—'}</strong> sil.</span>
      <span class="chip-count"><strong>${c.retake ?? '—'}</strong> ret.</span>
    </div>`;
  }

  let media = '';
  if (step.id === 'clean_audio') media = mediaBlock('Audio limpio', project.media?.cleanedAudio, 'audio');
  else if (step.id === 'edit') {
    media = mediaBlock('Vista previa', project.media?.videoPreview, 'video');
    if (project.drive?.folderUrl) {
      media += `<a class="drive-mini" href="${escapeHtml(project.drive.folderUrl)}" target="_blank" rel="noopener">📁 Abrir en Drive</a>`;
    }
  } else if (step.id === 'packaging') {
    const p = project.packaging || {};
    const bits = [
      ['Miniatura', p.thumbnail],
      ['Título', p.title],
      ['Descripción', p.description],
      ['Etiquetas', Array.isArray(p.tags) ? p.tags.join(', ') : p.tags],
    ];
    media = `<div class="media-slot">${bits.map(([k, v]) =>
      `<div><strong>${escapeHtml(k)}:</strong> ${v ? escapeHtml(v) : '<em>pendiente</em>'}</div>`
    ).join('')}</div>`;
  } else if (step.id === 'publish') {
    const p = project.publish || {};
    media = `<div class="media-slot">
      <div><strong>Visibilidad:</strong> ${p.visibility ? escapeHtml(p.visibility) : '<em>pendiente</em>'}</div>
      <div><strong>Programado:</strong> ${p.scheduledAt ? escapeHtml(p.scheduledAt) : '<em>pendiente</em>'}</div>
      <div><strong>URL:</strong> ${p.youtubeUrl ? `<a href="${escapeHtml(p.youtubeUrl)}" target="_blank" rel="noopener">enlace</a>` : '<em>pendiente</em>'}</div>
    </div>`;
  }

  const savedBits = [];
  if (saved?.action && step.status !== 'aprobado' && status !== step.status) {
    savedBits.push(`<div class="step-saved">Guardado local: <strong>${escapeHtml(STATUS_LABEL[saved.status] || saved.action)}</strong></div>`);
  }

  const footParts = [];
  if (step.id === 'cuts' && step.link) {
    footParts.push(`<a class="btn btn-primary btn-sm" href="${escapeHtml(step.link)}">Abrir revisión</a>`);
  }
  if (showActions) {
    const disabled = blockedMedia ? 'disabled' : '';
    const title = blockedMedia ? 'title="Disponible cuando haya archivo"' : '';
    footParts.push(`
      <div class="actions" data-step-actions="${escapeHtml(key)}" data-project="${escapeHtml(project.id)}" data-step="${escapeHtml(step.id)}">
        <button type="button" class="btn btn-primary btn-sm" data-act="approve" ${disabled} ${title}>Aprobar</button>
        <button type="button" class="btn btn-warn btn-sm" data-act="ask-changes">Pedir cambios</button>
        <div class="change-box" data-change-box>
          <textarea placeholder="Describe qué quieres cambiar…"></textarea>
          <div class="change-actions">
            <button type="button" class="btn btn-primary btn-sm" data-act="send-changes">Enviar</button>
            <button type="button" class="btn btn-ghost btn-sm" data-act="cancel-changes">Cancelar</button>
          </div>
        </div>
      </div>`);
  }

  return `
    <li class="step is-${escapeHtml(status)}" data-step-id="${escapeHtml(step.id)}">
      <div class="step-card-body">
        <div class="step-card-head">
          <span class="step-num">${index + 1}</span>
          <span class="status-badge ${statusClass(status)}">${escapeHtml(label)}</span>
        </div>
        <h4 class="step-card-title">${escapeHtml(step.title)}</h4>
        ${step.detail ? `<p class="step-detail">${escapeHtml(step.detail)}</p>` : ''}
        ${meta}
        ${media}
        ${savedBits.join('')}
      </div>
      <div class="step-card-foot">
        ${footParts.join('') || '<span class="foot-spacer"></span>'}
      </div>
    </li>`;
}

function bindApprovals(project) {
  $$('[data-step-actions]').forEach((wrap) => {
    const stepId = wrap.getAttribute('data-step');
    const step = (project.pipeline || []).find((s) => s.id === stepId);
    if (!step) return;
    const box = $('[data-change-box]', wrap);
    const ta = $('textarea', box);

    wrap.addEventListener('click', async (ev) => {
      const btn = ev.target.closest('[data-act]');
      if (!btn || btn.disabled) return;
      const act = btn.dataset.act;
      if (act === 'ask-changes') {
        box.classList.add('open');
        ta.focus();
        return;
      }
      if (act === 'cancel-changes') {
        box.classList.remove('open');
        return;
      }
      if (act === 'approve') {
        if (!canApproveStep(project, step)) {
          toast('Disponible cuando haya archivo');
          return;
        }
        btn.disabled = true;
        try {
          await applyStepDecision(project, step, 'approve');
        } finally {
          /* render rebuilds */
        }
        return;
      }
      if (act === 'send-changes') {
        const notes = ta.value || '';
        if (!notes.trim()) {
          toast('Escribe qué cambios necesitas');
          ta.focus();
          return;
        }
        btn.disabled = true;
        await applyStepDecision(project, step, 'changes', notes);
      }
    });
  });
}

function renderNav() {
  const root = $('#projectNav');
  const list = allProjects();
  root.innerHTML = list.length
    ? list.map((p) => {
      const active = CURRENT.view === 'project' && CURRENT.slug === p.slug ? 'active' : '';
      const sub = p.source === 'draft' ? 'Borrador local' : (p.subtitle || '');
      return `<a class="nav-item ${active}" href="#/p/${escapeHtml(p.slug)}">
        <span class="dot ${statusDot(p.status)}"></span>
        <span class="nav-text">${escapeHtml(p.title)}
          ${sub ? `<span class="nav-sub">${escapeHtml(sub)}</span>` : ''}
        </span>
      </a>`;
    }).join('')
    : `<div class="empty" style="padding:8px;font-size:0.8rem">Sin proyectos</div>`;

  $$('.sidebar .nav-item[data-nav="settings"]').forEach((el) => {
    el.classList.toggle('active', CURRENT.view === 'settings');
  });

  const drive = DATA.drive?.rootUrl;
  const navDrive = $('#navDrive');
  if (navDrive) {
    if (drive) {
      navDrive.href = drive;
      navDrive.removeAttribute('aria-disabled');
    } else {
      navDrive.href = '#';
      navDrive.onclick = (e) => {
        e.preventDefault();
        toast('Carpeta Drive aún no configurada');
      };
    }
  }
}

function renderHome() {
  $('#topbarTitle').textContent = 'Inicio';
  const list = allProjects();
  const cards = list.map((p) => {
    const st = STATUS_LABEL[p.status] || p.status;
    const { done, total, pct } = progressOf(p);
    const draftBadge = p.source === 'draft'
      ? `<span class="status-badge status-borrador">Borrador</span>`
      : `<span class="status-badge ${statusClass(p.status)}">${escapeHtml(st)}</span>`;
    return `<a class="card card-link" href="#/p/${escapeHtml(p.slug)}">
      <div style="display:flex;justify-content:space-between;gap:8px;align-items:flex-start">
        <div>
          <h3>${escapeHtml(p.title)}</h3>
          <p class="sub">${escapeHtml(p.subtitle || (p.source === 'draft' ? 'Borrador local' : ''))}</p>
        </div>
        ${draftBadge}
      </div>
      ${p.pipeline?.length ? `<div style="margin-top:12px" class="progress-track"><div class="progress-fill" style="width:${pct}%"></div></div>
      <p class="progress-label" style="margin:6px 0 0">${done}/${total} · ${pct}%</p>` : `<p class="sub" style="margin-top:12px">Borrador — aún no está en el flujo oficial</p>`}
    </a>`;
  }).join('');

  $('#app').innerHTML = `
    <header class="hero">
      <h1>Tus proyectos</h1>
      <p>Elige un proyecto en el menú o crea uno nuevo. Al aprobar, ZepFilms recibe el aviso y continúa el siguiente paso.</p>
    </header>
    <div class="section-title"><h2>Proyectos</h2><span>${list.length}</span></div>
    <div class="grid grid-projects">${cards || '<div class="card empty">No hay proyectos. Pulsa “+ Nuevo proyecto”.</div>'}</div>
    <p class="footer-note">Sitio estático · Aprobaciones en localStorage · Webhook en tu navegador</p>`;
}

function renderDraftActions(project) {
  return `
    <div class="card" style="margin-bottom:16px">
      <h3>Borrador local</h3>
      <p class="sub">Este proyecto aún no está en <code>projects.json</code>. Envíalo a ZepFilms para cargarlo al panel oficial.</p>
      <div class="card-actions">
        <button type="button" class="btn btn-primary" id="btnSendDraft">Enviar a ZepFilms</button>
        <button type="button" class="btn btn-danger-outline" id="btnDeleteDraft">Eliminar borrador</button>
      </div>
      <div class="media-slot" style="margin-top:12px">
        <div><strong>Canal:</strong> ${escapeHtml(project.channel || '—')}</div>
        <div><strong>Tema:</strong> ${escapeHtml(project.theme || '—')}</div>
        <div><strong>Audio:</strong> ${project.audioUrl ? `<a href="${escapeHtml(project.audioUrl)}" target="_blank" rel="noopener">${escapeHtml(project.audioUrl)}</a>` : '<em>pendiente</em>'}</div>
        <div><strong>Guion:</strong> ${project.script ? 'pegado' : '<em>pendiente (opcional)</em>'}</div>
        <div><strong>Título YT:</strong> ${project.ytTitle ? escapeHtml(project.ytTitle) : '<em>pendiente</em>'}</div>
      </div>
    </div>`;
}

function renderProject(project) {
  $('#topbarTitle').textContent = project.title;
  if (project.source === 'draft') {
    $('#app').innerHTML = `
      <div class="project-head">
        <div>
          <h1>${escapeHtml(project.title)}</h1>
          <p class="sub">${escapeHtml(project.subtitle || project.channel || 'Borrador local')}</p>
        </div>
        <div class="project-head-right">
          <span class="status-badge status-borrador">Borrador</span>
        </div>
      </div>
      ${renderDraftActions(project)}`;
    $('#btnSendDraft')?.addEventListener('click', () => sendDraft(project));
    $('#btnDeleteDraft')?.addEventListener('click', () => deleteDraft(project.slug));
    return;
  }

  const { done, total, pct } = progressOf(project);
  const st = STATUS_LABEL[project.status] || project.status;
  const driveUrl = project.drive?.folderUrl || '';
  const drivePill = driveUrl
    ? `<a class="pill-link drive-pill" href="${escapeHtml(driveUrl)}" target="_blank" rel="noopener" title="Abrir carpeta del proyecto en Drive">
         <span aria-hidden="true">📁</span> Abrir Drive
       </a>`
    : '';

  $('#app').innerHTML = `
    <div class="project-head">
      <div>
        <h1>${escapeHtml(project.title)}</h1>
        <p class="sub">${escapeHtml(project.subtitle || '')}</p>
      </div>
      <div class="project-head-right">
        <span class="status-badge ${statusClass(project.status)}">${escapeHtml(st)}</span>
        ${drivePill}
      </div>
    </div>
    <div class="progress-track"><div class="progress-fill" style="width:${pct}%"></div></div>
    <p class="progress-label">${done} de ${total} pasos aprobados · ${pct}%</p>
    <ol class="steps">
      ${(project.pipeline || []).map((s, i) => renderStep(project, s, i)).join('')}
    </ol>`;
  bindApprovals(project);
}

function connStatusView() {
  const st = window.ZepNotify?.getStatus?.() || { state: 'disconnected', message: '' };
  const settings = window.ZepNotify?.getSettings?.() || {};
  const configured = !!(settings.url && settings.key);
  let state = st.state || 'disconnected';
  if (!configured) state = 'disconnected';
  const label =
    state === 'connected' ? 'Conectado' :
    state === 'error' ? 'Error' : 'Sin conectar';
  const cls =
    state === 'connected' ? 'is-connected' :
    state === 'error' ? 'is-error' : 'is-disconnected';
  const outbox = window.ZepNotify?.getOutbox?.() || [];
  const extra = outbox.length ? ` · ${outbox.length} en cola` : '';
  const msg = st.message ? escapeHtml(st.message) : (configured ? 'Listo para enviar eventos' : 'Pega la URL y la clave del panel de rutinas de ZepFilms');
  return { label, cls, msg, extra, settings, state, outboxCount: outbox.length };
}

function renderSettings() {
  $('#topbarTitle').textContent = 'Settings';
  const howto = (STYLE?.sections || []).find((s) => s.id === 'howto');
  const other = (STYLE?.sections || []).filter((s) => s.id !== 'howto');
  const styleBlocks = other.map((sec) => `
    <div class="style-block">
      <h3>${escapeHtml(sec.title)}</h3>
      <ul>${(sec.items || []).map((it) => `<li>${escapeHtml(it)}</li>`).join('')}</ul>
    </div>`).join('');

  const cv = connStatusView();

  $('#app').innerHTML = `
    <header class="hero">
      <h1>Settings</h1>
      <p>Conexión con ZepFilms, cómo empezar un video y la guía de estilo.</p>
    </header>

    <section class="card conn-card" id="connCard">
      <h3>Conexión con ZepFilms</h3>
      <p class="sub">La URL y la clave viven solo en tu navegador (localStorage). Nunca se suben al repositorio.</p>
      <div class="conn-status ${cv.cls}" id="connStatusPill">
        <span class="dot" aria-hidden="true"></span>
        <span id="connStatusLabel">${escapeHtml(cv.label)}${escapeHtml(cv.extra)}</span>
      </div>
      <div class="conn-fields">
        <label>URL del webhook
          <input id="connUrl" type="url" autocomplete="off" spellcheck="false"
            placeholder="https://api2.cursor.sh/automations/webhook/…"
            value="${escapeHtml(cv.settings.url || '')}" />
        </label>
        <label>Clave
          <input id="connKey" type="password" autocomplete="off" spellcheck="false"
            placeholder="Pega la clave (Bearer se añade solo)"
            value="${escapeHtml(cv.settings.key || '')}" />
          <span class="hint">Se envía como <code>Authorization: Bearer …</code> (y también como <code>X-Automation-Key</code>).</span>
        </label>
        <label>Proxy CORS (opcional)
          <input id="connProxy" type="url" autocomplete="off" spellcheck="false"
            placeholder="https://tu-proxy.ejemplo/forward"
            value="${escapeHtml(cv.settings.proxyUrl || '')}" />
          <span class="hint">Solo si el navegador bloquea CORS hacia Cursor. El proxy debe reenviar el encabezado Authorization.</span>
        </label>
      </div>
      <div class="conn-actions">
        <button type="button" class="btn btn-primary" id="btnSaveConn">Guardar</button>
        <button type="button" class="btn" id="btnTestConn">Probar conexión</button>
        <button type="button" class="btn btn-ghost" id="btnClearConn">Borrar</button>
      </div>
      <p class="conn-msg" id="connMsg">${cv.msg}</p>
    </section>

    <section class="card" style="margin-bottom:16px">
      <h3>Nuevo video — cómo empezar</h3>
      <p class="sub">Manda el audio por el chat o crea un borrador aquí.</p>
      <div class="howto-box">
        En el chat, manda el <strong>audio</strong> (enlace de Drive). El <strong>guion</strong> es opcional y ayuda a detectar retomas.
        También puedes usar <strong>+ Nuevo proyecto</strong> para armar un borrador.
      </div>
      <ol style="margin:0;padding-left:1.2rem;color:var(--muted);font-size:0.9rem">
        ${(howto?.items || []).map((it) => `<li style="margin:6px 0">${escapeHtml(it)}</li>`).join('')}
      </ol>
    </section>
    <section class="card">
      <h3>${escapeHtml(STYLE?.title || 'Estilo de edición')}</h3>
      <p class="sub">${escapeHtml(STYLE?.subtitle || '')}</p>
      <div class="style-list" style="margin-top:12px">${styleBlocks || '<p class="sub">No se pudo cargar data/style.json</p>'}</div>
    </section>`;

  $('#btnSaveConn')?.addEventListener('click', async () => {
    const url = $('#connUrl')?.value || '';
    const key = $('#connKey')?.value || '';
    const proxyUrl = $('#connProxy')?.value || '';
    window.ZepNotify.saveSettings({ url, key, proxyUrl });
    if (url && key) {
      window.ZepNotify.setStatus('disconnected', 'Guardado — pulsa Probar conexión');
      toast('Conexión guardada en este navegador');
      const added = await window.ZepNotify.enqueuePriorApprovals(DATA.projects || []);
      const flushed = await window.ZepNotify.flushOutbox();
      if (added || flushed.sent) {
        toast(`Cola: ${added} previos · reenviados ${flushed.sent}`);
      }
    } else {
      window.ZepNotify.setStatus('disconnected', 'Sin conectar');
      toast('Guardado (incompleto)');
    }
    refreshConnPill();
  });

  $('#btnTestConn')?.addEventListener('click', async () => {
    // Save fields first
    window.ZepNotify.saveSettings({
      url: $('#connUrl')?.value || '',
      key: $('#connKey')?.value || '',
      proxyUrl: $('#connProxy')?.value || '',
    });
    const btn = $('#btnTestConn');
    if (btn) btn.disabled = true;
    try {
      await window.ZepNotify.enqueuePriorApprovals(DATA.projects || []);
      const res = await window.ZepNotify.testConnection();
      if (res.ok) toast('Conectado ✓. ZepFilms recibió la prueba.');
      else if (res.corsBlocked) toast('Error CORS — mira el mensaje en la tarjeta');
      else toast(res.message || 'No se pudo conectar');
    } finally {
      if (btn) btn.disabled = false;
      refreshConnPill();
    }
  });

  $('#btnClearConn')?.addEventListener('click', () => {
    window.ZepNotify.saveSettings({ url: '', key: '', proxyUrl: '' });
    window.ZepNotify.setStatus('disconnected', 'Sin conectar');
    if ($('#connUrl')) $('#connUrl').value = '';
    if ($('#connKey')) $('#connKey').value = '';
    if ($('#connProxy')) $('#connProxy').value = '';
    toast('Conexión borrada de este navegador');
    refreshConnPill();
  });
}

function refreshConnPill() {
  const pill = $('#connStatusPill');
  const label = $('#connStatusLabel');
  const msg = $('#connMsg');
  if (!pill) return;
  const cv = connStatusView();
  pill.className = `conn-status ${cv.cls}`;
  if (label) label.textContent = `${cv.label}${cv.extra}`;
  if (msg) msg.textContent = cv.msg.replace(/&[^;]+;/g, '');
}

async function sendDraft(project) {
  const note = [
    `Nombre: ${project.title}`,
    `Tema/serie: ${project.theme || '(sin tema)'}`,
    `Canal: ${project.channel || '(sin canal)'}`,
    `Audio (Drive): ${project.audioUrl || '(pendiente)'}`,
    `Guion: ${project.script ? 'incluido' : '(pendiente — opcional)'}`,
    `Título YT: ${project.ytTitle || '(pendiente)'}`,
  ].join('\n');

  if (!window.ZepNotify.isConfigured()) {
    showConnectPrompt();
    toast('Conecta ZepFilms para enviar el borrador', {
      action: { label: 'Settings', onClick: () => { location.hash = '#/settings'; } },
    });
    return;
  }
  const res = await window.ZepNotify.notify({
    projectSlug: project.slug,
    stepId: 'upload',
    action: 'aprobar',
    note,
    extra: {
      draft: true,
      title: project.title,
      theme: project.theme,
      channel: project.channel,
      audioUrl: project.audioUrl,
      script: project.script,
      ytTitle: project.ytTitle,
    },
  });
  if (res.ok) toast('Borrador enviado a ZepFilms ✓');
  else toast(res.message || 'Aviso en cola');
}

function deleteDraft(slug) {
  saveDrafts(loadDrafts().filter((d) => d.slug !== slug));
  toast('Borrador eliminado');
  location.hash = '#/';
  render();
}

function slugify(text) {
  return String(text || 'proyecto')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48) || `proyecto-${Date.now()}`;
}

function openModal() {
  $('#modalNew').hidden = false;
  $('#formNew').reset();
  setTimeout(() => $('#formNew [name="title"]')?.focus(), 50);
}
function closeModal() { $('#modalNew').hidden = true; }
function openHelp() { $('#modalHelp').hidden = false; }
function closeHelp() { $('#modalHelp').hidden = true; }

function createDraft(form) {
  const fd = new FormData(form);
  const title = String(fd.get('title') || '').trim();
  if (!title) { toast('Pon un nombre al video'); return; }
  let slug = slugify(title);
  const existing = new Set(allProjects().map((p) => p.slug));
  if (existing.has(slug)) slug = `${slug}-${Date.now().toString(36)}`;
  const draft = {
    id: slug,
    slug,
    title,
    theme: String(fd.get('theme') || '').trim(),
    channel: String(fd.get('channel') || 'Canal nuevo'),
    subtitle: String(fd.get('channel') || 'Canal nuevo'),
    audioUrl: String(fd.get('audioUrl') || '').trim(),
    script: String(fd.get('script') || '').trim(),
    ytTitle: String(fd.get('ytTitle') || '').trim(),
    status: 'borrador',
    createdAt: new Date().toISOString(),
    pipeline: [],
  };
  const drafts = loadDrafts();
  drafts.push(draft);
  saveDrafts(drafts);
  closeModal();
  toast('Borrador creado');
  location.hash = `#/p/${slug}`;
  render();
}

function render() {
  CURRENT = parseRoute();
  renderNav();
  setSidebarOpen(false);
  if (CURRENT.view === 'settings') { renderSettings(); return; }
  if (CURRENT.view === 'project') {
    const project = findProject(CURRENT.slug);
    if (!project) {
      $('#app').innerHTML = `<div class="card empty">Proyecto no encontrado. <a href="#/">Volver al inicio</a></div>`;
      $('#topbarTitle').textContent = 'No encontrado';
      return;
    }
    renderProject(project);
    return;
  }
  renderHome();
}

async function fetchProjects({ bust = false } = {}) {
  const q = bust ? `?t=${Date.now()}` : `?v=6`;
  const [projRes, styleRes] = await Promise.all([
    fetch(`data/projects.json${q}`, { cache: 'no-store' }),
    fetch(`data/style.json?v=1`, { cache: bust ? 'no-store' : 'default' }),
  ]);
  if (projRes.ok) DATA = await projRes.json();
  if (styleRes.ok) STYLE = await styleRes.json();
}

function startPolling() {
  clearInterval(POLL_TIMER);
  POLL_TIMER = setInterval(async () => {
    try {
      const prev = JSON.stringify(DATA.projects || []);
      await fetchProjects({ bust: true });
      const next = JSON.stringify(DATA.projects || []);
      if (prev !== next) render();
    } catch (e) {
      console.warn('poll projects.json failed', e);
    }
  }, POLL_MS);
}

async function boot() {
  try {
    await fetchProjects({ bust: true });
  } catch (e) {
    console.error(e);
  }

  // Seed outbox with prior local approvals (e.g. cuts already aprobado), then flush if connected
  try {
    await window.ZepNotify.enqueuePriorApprovals(DATA.projects || []);
    await window.ZepNotify.bootNotify();
  } catch (e) {
    console.warn(e);
  }

  $('#btnNewProject').addEventListener('click', openModal);
  $('#btnMenu').addEventListener('click', () => setSidebarOpen(true));
  $('#sidebarBackdrop').addEventListener('click', () => setSidebarOpen(false));
  $$('[data-close-modal]').forEach((el) => el.addEventListener('click', closeModal));
  $('#btnHelp')?.addEventListener('click', openHelp);
  $$('[data-close-help]').forEach((el) => el.addEventListener('click', closeHelp));
  $$('[data-close-connect]').forEach((el) => el.addEventListener('click', closeConnect));
  $('#btnGoSettings')?.addEventListener('click', () => { closeConnect(); });
  $('#formNew').addEventListener('submit', (ev) => {
    ev.preventDefault();
    createDraft(ev.target);
  });
  window.addEventListener('hashchange', render);
  window.addEventListener('zepfilms-webhook-status', () => {
    if (CURRENT.view === 'settings') refreshConnPill();
  });
  if (!location.hash) location.hash = '#/';
  render();
  startPolling();
}

boot();

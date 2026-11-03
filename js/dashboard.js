const APPROVALS_KEY = 'zepfilms-edit-panel-approvals-v2';
const DRAFTS_KEY = 'zepfilms-edit-panel-drafts-v1';
const STATUS_LABEL = {
  pendiente: 'Pendiente',
  en_progreso: 'En progreso',
  esperando_aprobacion: 'Esperando tu aprobación',
  aprobado: 'Aprobado',
  cambios_pedidos: 'Cambios pedidos',
  borrador: 'Borrador',
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

let DATA = { projects: [], drive: null };
let STYLE = null;
let CURRENT = { view: 'home', slug: null };
let LAST_UNDO = null;

function toast(msg, { undo } = {}) {
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
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), undo ? 6000 : 2600);
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

async function copyText(text) {
  // 1) Clipboard API
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return { ok: true, method: 'clipboard' };
    }
  } catch (_) { /* fall through */ }

  // 2) execCommand fallback
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    ta.style.top = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    ta.setSelectionRange(0, ta.value.length);
    const ok = document.execCommand('copy');
    ta.remove();
    if (ok) return { ok: true, method: 'execCommand' };
  } catch (_) { /* fall through */ }

  // 3) Modal with selected text
  showCopyModal(text);
  return { ok: false, method: 'modal' };
}

function showCopyModal(text) {
  const modal = $('#modalCopy');
  const ta = $('#copyFallbackText');
  ta.value = text;
  modal.hidden = false;
  setTimeout(() => {
    ta.focus();
    ta.select();
  }, 30);
}

function statusClass(status) {
  return `status-${status || 'pendiente'}`;
}
function statusDot(status) {
  if (status === 'aprobado') return 'ok';
  if (status === 'esperando_aprobacion' || status === 'en_progreso' || status === 'cambios_pedidos') return 'warn';
  if (status === 'borrador') return 'draft';
  return '';
}

function approvalKey(projectId, stepId) {
  return `${projectId}:${stepId}`;
}

/** Effective step status: JSON aprobado wins; else local override; else JSON. */
function effectiveStepStatus(project, step) {
  if (step.status === 'aprobado') return 'aprobado';
  const local = loadApprovals()[approvalKey(project.id, step.id)];
  if (local?.status === 'aprobado' || local?.status === 'cambios_pedidos') return local.status;
  return step.status || 'pendiente';
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
  if (step.status === 'aprobado') return false;
  if (stepNeedsMedia(step) && !stepHasRequiredMedia(project, step)) return false;
  return true;
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

function buildApprovalMessage(project, step, kind, notes) {
  const when = new Date().toLocaleString('es-PE', { timeZone: 'America/Lima' });
  const lines = [
    `Panel de edición — ${project.title}`,
    `Paso: ${step.title}`,
    `Acción: ${kind === 'approve' ? 'APROBAR' : 'PEDIR CAMBIOS'}`,
    `Fecha (America/Lima): ${when}`,
  ];
  if (kind === 'changes') lines.push(`Cambios pedidos: ${notes.trim() || '(sin detalle)'}`);
  else lines.push('Listo para continuar con el siguiente paso.');
  if (step.id === 'cuts' && project.review?.counts) {
    const c = project.review.counts;
    lines.push(`Propuestas: ${c.total} (silencios ${c.silence}, retomas ${c.retake})`);
  }
  if (project.drive?.folderUrl) lines.push(`Drive del proyecto: ${project.drive.folderUrl}`);
  return lines.join('\n');
}

async function applyStepDecision(project, step, kind, notes = '') {
  const key = approvalKey(project.id, step.id);
  const approvals = loadApprovals();
  const prev = approvals[key] ? { ...approvals[key] } : null;
  const status = kind === 'approve' ? 'aprobado' : 'cambios_pedidos';
  const msg = buildApprovalMessage(project, step, kind, notes);
  approvals[key] = {
    status,
    action: kind,
    notes: notes.trim(),
    message: msg,
    at: new Date().toLocaleString('es-PE', { timeZone: 'America/Lima' }),
  };
  saveApprovals(approvals);

  LAST_UNDO = {
    key,
    prev,
    projectSlug: project.slug,
  };

  const copy = await copyText(msg);
  const toastMsg = kind === 'approve'
    ? (copy.ok
      ? 'Paso aprobado ✓ — ya le avisé a ZepFilms: copia y pega en el chat'
      : 'Paso aprobado ✓ — copia el mensaje del cuadro')
    : (copy.ok
      ? 'Cambios pedidos ✓ — pega el mensaje en el chat con ZepFilms'
      : 'Cambios pedidos ✓ — copia el mensaje del cuadro');

  toast(toastMsg, {
    undo: () => {
      const a = loadApprovals();
      if (LAST_UNDO?.prev) a[LAST_UNDO.key] = LAST_UNDO.prev;
      else delete a[LAST_UNDO.key];
      saveApprovals(a);
      toast('Deshecho');
      if (CURRENT.view === 'project' && CURRENT.slug === project.slug) {
        renderProject(findProject(project.slug));
      }
      renderNav();
    },
  });

  // Re-render project view so pills/progress update immediately
  render();
}

function renderStep(project, step, index) {
  const status = effectiveStepStatus(project, step);
  const label = STATUS_LABEL[status] || STATUS_LABEL.pendiente;
  const key = approvalKey(project.id, step.id);
  const saved = loadApprovals()[key];
  const approvable = canApproveStep(project, step);
  const blockedMedia = step.approvable && stepNeedsMedia(step) && !stepHasRequiredMedia(project, step);

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
  if (saved?.action && step.status !== 'aprobado') {
    savedBits.push(`<div class="step-saved">Guardado local: <strong>${escapeHtml(STATUS_LABEL[saved.status] || saved.action)}</strong></div>`);
  }

  const footParts = [];
  if (step.id === 'cuts' && step.link) {
    footParts.push(`<a class="btn btn-primary btn-sm" href="${escapeHtml(step.link)}">Abrir revisión</a>`);
  }
  if (step.approvable && project.source !== 'draft' && step.status !== 'aprobado') {
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
          // render() rebuilds DOM
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
      const sub = p.source === 'draft' ? 'Borrador — envíalo a ZepFilms' : (p.subtitle || '');
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
      navDrive.addEventListener('click', (e) => {
        e.preventDefault();
        toast('Carpeta Drive aún no configurada');
      }, { once: true });
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
      <p>Elige un proyecto en el menú o crea uno nuevo. Los borradores viven en tu navegador hasta que los envíes a ZepFilms.</p>
    </header>
    <div class="section-title"><h2>Proyectos</h2><span>${list.length}</span></div>
    <div class="grid grid-projects">${cards || '<div class="card empty">No hay proyectos. Pulsa “+ Nuevo proyecto”.</div>'}</div>
    <p class="footer-note">Sitio estático · Aprobaciones y borradores en localStorage</p>`;
}

function renderDraftActions(project) {
  return `
    <div class="card" style="margin-bottom:16px">
      <h3>Borrador local</h3>
      <p class="sub">Este proyecto aún no está en <code>projects.json</code>. Envíalo a ZepFilms para que lo carguemos al panel oficial.</p>
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

function renderSettings() {
  $('#topbarTitle').textContent = 'Settings';
  const howto = (STYLE?.sections || []).find((s) => s.id === 'howto');
  const other = (STYLE?.sections || []).filter((s) => s.id !== 'howto');
  const styleBlocks = other.map((sec) => `
    <div class="style-block">
      <h3>${escapeHtml(sec.title)}</h3>
      <ul>${(sec.items || []).map((it) => `<li>${escapeHtml(it)}</li>`).join('')}</ul>
    </div>`).join('');

  $('#app').innerHTML = `
    <header class="hero">
      <h1>Settings</h1>
      <p>Cómo empezar un video y la guía de estilo de edición.</p>
    </header>
    <section class="card" style="margin-bottom:16px">
      <h3>Nuevo video — cómo empezar</h3>
      <p class="sub">Sin formularios raros: lo mandas por el chat.</p>
      <div class="howto-box">
        En el chat, manda el <strong>audio</strong> (enlace de Drive). El <strong>guion</strong> es opcional y ayuda a detectar retomas.
        También puedes usar <strong>+ Nuevo proyecto</strong> para armar un borrador y copiarlo.
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
}

async function sendDraft(project) {
  const when = new Date().toLocaleString('es-PE', { timeZone: 'America/Lima' });
  const msg = [
    'Nuevo proyecto (borrador del Panel de edición)',
    `Nombre: ${project.title}`,
    `Tema/serie: ${project.theme || '(sin tema)'}`,
    `Canal: ${project.channel || '(sin canal)'}`,
    `Audio (Drive): ${project.audioUrl || '(pendiente)'}`,
    `Guion: ${project.script ? project.script : '(pendiente — opcional)'}`,
    `Título YT: ${project.ytTitle || '(pendiente)'}`,
    `Fecha (America/Lima): ${when}`,
  ].join('\n');
  const copy = await copyText(msg);
  toast(copy.ok ? 'Copiado — pégalo en el chat con ZepFilms' : 'Copia el mensaje del cuadro');
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
function closeCopy() { $('#modalCopy').hidden = true; }

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

async function boot() {
  try {
    const [projRes, styleRes] = await Promise.all([
      fetch('data/projects.json?v=5'),
      fetch('data/style.json?v=1'),
    ]);
    if (projRes.ok) DATA = await projRes.json();
    if (styleRes.ok) STYLE = await styleRes.json();
  } catch (e) {
    console.error(e);
  }

  $('#btnNewProject').addEventListener('click', openModal);
  $('#btnMenu').addEventListener('click', () => setSidebarOpen(true));
  $('#sidebarBackdrop').addEventListener('click', () => setSidebarOpen(false));
  $$('[data-close-modal]').forEach((el) => el.addEventListener('click', closeModal));
  $('#btnHelp')?.addEventListener('click', openHelp);
  $$('[data-close-help]').forEach((el) => el.addEventListener('click', closeHelp));
  $$('[data-close-copy]').forEach((el) => el.addEventListener('click', closeCopy));
  $('#btnSelectCopy')?.addEventListener('click', () => {
    const ta = $('#copyFallbackText');
    ta.focus();
    ta.select();
  });
  $('#formNew').addEventListener('submit', (ev) => {
    ev.preventDefault();
    createDraft(ev.target);
  });
  window.addEventListener('hashchange', render);
  if (!location.hash) location.hash = '#/';
  render();
}

boot();

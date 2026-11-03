const STORAGE_KEY = 'zepfilms-edit-panel-approvals-v1';
const STATUS_LABEL = {
  pendiente: 'Pendiente',
  en_progreso: 'En progreso',
  esperando_aprobacion: 'Esperando tu aprobación',
  aprobado: 'Aprobado',
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), 2200);
}

function loadApprovals() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') || {};
  } catch {
    return {};
  }
}

function saveApprovals(data) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast('Copiado — pégalo en el chat con ZepFilms');
}

function statusClass(status) {
  const s = status || 'pendiente';
  return `status-${s}`;
}

function progressOf(pipeline) {
  const total = pipeline.length || 1;
  const done = pipeline.filter((s) => s.status === 'aprobado').length;
  return { done, total, pct: Math.round((done / total) * 100) };
}

function buildApprovalMessage(project, step, kind, notes) {
  const when = new Date().toLocaleString('es-PE', { timeZone: 'America/Lima' });
  const lines = [
    `Panel de edición — ${project.title}`,
    `Paso: ${step.title}`,
    `Acción: ${kind === 'approve' ? 'APROBAR' : 'PEDIR CAMBIOS'}`,
    `Fecha (America/Lima): ${when}`,
  ];
  if (kind === 'changes') {
    lines.push(`Cambios pedidos: ${notes.trim() || '(sin detalle)'}`);
  } else {
    lines.push('Listo para continuar con el siguiente paso.');
  }
  if (step.id === 'cuts' && project.review?.counts) {
    const c = project.review.counts;
    lines.push(`Propuestas: ${c.total} (silencios ${c.silence}, retomas ${c.retake})`);
  }
  return lines.join('\n');
}

function renderStyle(style) {
  const root = $('#styleCard');
  if (!style) {
    root.innerHTML = '<p class="lede">Sin guía de estilo en projects.json.</p>';
    return;
  }
  root.innerHTML = `
    <h2>${escapeHtml(style.title || 'Estilo de edición')}</h2>
    <p class="lede">Reglas reales del canal ZEPFILMS aplicadas al nuevo canal.</p>
    <ul class="style-list">
      <li><span class="k">Ritmo</span><span class="v">${escapeHtml(style.cutsPerMin)} · ${escapeHtml(style.shotLength)}</span></li>
      <li><span class="k">Loudness</span><span class="v">${escapeHtml(style.lufs)}</span></li>
      <li><span class="k">Resolución</span><span class="v">${escapeHtml(style.minResolution)}</span></li>
      <li><span class="k">SFX</span><span class="v">${escapeHtml(style.sfx)}</span></li>
      ${(style.notes || []).map((n) => `<li><span class="k">Nota</span><span class="v">${escapeHtml(n)}</span></li>`).join('')}
    </ul>
  `;
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

function renderStep(project, step, index, approvals) {
  const status = step.status || 'pendiente';
  const label = STATUS_LABEL[status] || STATUS_LABEL.pendiente;
  const key = `${project.id}:${step.id}`;
  const saved = approvals[key];

  let meta = '';
  if (step.id === 'cuts' && project.review) {
    const c = project.review.counts || {};
    meta = `
      <div class="step-meta">
        <span class="chip-count"><strong>${c.total ?? '—'}</strong> propuestas</span>
        <span class="chip-count"><strong>${c.silence ?? '—'}</strong> silencios</span>
        <span class="chip-count"><strong>${c.retake ?? '—'}</strong> retomas</span>
        ${step.link ? `<a class="btn-link" href="${escapeHtml(step.link)}">Abrir revisión de cortes →</a>` : ''}
      </div>`;
  }

  let media = '';
  if (step.id === 'clean_audio') {
    media = mediaBlock('Audio limpio', project.media?.cleanedAudio, 'audio');
  } else if (step.id === 'edit') {
    media = mediaBlock('Vista previa de video', project.media?.videoPreview, 'video');
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
      <div><strong>URL:</strong> ${p.youtubeUrl ? `<a href="${escapeHtml(p.youtubeUrl)}" target="_blank" rel="noopener">${escapeHtml(p.youtubeUrl)}</a>` : '<em>pendiente</em>'}</div>
    </div>`;
  }

  let actions = '';
  if (step.approvable) {
    const savedNote = saved?.notes ? `<div class="step-detail">Última nota guardada: ${escapeHtml(saved.notes)}</div>` : '';
    const savedAct = saved?.action
      ? `<div class="step-detail">Última acción local: <strong>${escapeHtml(saved.action === 'approve' ? 'Aprobar' : 'Pedir cambios')}</strong> (${escapeHtml(saved.at || '')})</div>`
      : '';
    actions = `
      <div class="actions" data-step-actions="${escapeHtml(key)}">
        <button type="button" class="btn btn-ok" data-act="approve">Aprobar</button>
        <button type="button" class="btn btn-warn" data-act="ask-changes">Pedir cambios</button>
        <div class="change-box" data-change-box>
          <textarea placeholder="Describe qué quieres cambiar…"></textarea>
          <div class="change-actions">
            <button type="button" class="btn btn-primary" data-act="send-changes">Copiar pedido de cambios</button>
            <button type="button" class="btn btn-ghost" data-act="cancel-changes">Cancelar</button>
          </div>
        </div>
      </div>
      ${savedAct}${savedNote}`;
  }

  return `
    <li class="step is-${escapeHtml(status)}" data-step-id="${escapeHtml(step.id)}">
      <div class="step-top">
        <div class="step-title">
          <span class="step-num">${index + 1}</span>
          <span>${escapeHtml(step.title)}</span>
        </div>
        <span class="status-badge ${statusClass(status)}">${escapeHtml(label)}</span>
      </div>
      ${step.detail ? `<p class="step-detail">${escapeHtml(step.detail)}</p>` : ''}
      ${meta}
      ${media}
      ${actions}
    </li>`;
}

function bindApprovals(project) {
  $$('[data-step-actions]').forEach((wrap) => {
    const key = wrap.getAttribute('data-step-actions');
    const stepId = key.split(':')[1];
    const step = project.pipeline.find((s) => s.id === stepId);
    const box = $('[data-change-box]', wrap);
    const ta = $('textarea', box);

    wrap.addEventListener('click', async (ev) => {
      const btn = ev.target.closest('[data-act]');
      if (!btn) return;
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
      if (act === 'approve' || act === 'send-changes') {
        const kind = act === 'approve' ? 'approve' : 'changes';
        const notes = kind === 'changes' ? (ta.value || '') : '';
        if (kind === 'changes' && !notes.trim()) {
          toast('Escribe qué cambios necesitas');
          ta.focus();
          return;
        }
        const msg = buildApprovalMessage(project, step, kind, notes);
        const approvals = loadApprovals();
        approvals[key] = {
          action: kind,
          notes: notes.trim(),
          message: msg,
          at: new Date().toLocaleString('es-PE', { timeZone: 'America/Lima' }),
        };
        saveApprovals(approvals);
        await copyText(msg);
        if (kind === 'changes') box.classList.remove('open');
      }
    });
  });
}

function renderProject(project, approvals) {
  const { done, total, pct } = progressOf(project.pipeline || []);
  const status = project.status || 'pendiente';
  return `
    <article class="card project-card" id="project-${escapeHtml(project.slug)}">
      <div class="project-head">
        <div>
          <h3>${escapeHtml(project.title)}</h3>
          <p class="sub">${escapeHtml(project.subtitle || '')}</p>
        </div>
        <span class="status-badge ${statusClass(status)}">${escapeHtml(STATUS_LABEL[status] || status)}</span>
      </div>
      <div class="progress-track" aria-hidden="true"><div class="progress-fill" style="width:${pct}%"></div></div>
      <p class="progress-label">${done} de ${total} pasos aprobados · ${pct}%</p>
      <ol class="steps">
        ${(project.pipeline || []).map((s, i) => renderStep(project, s, i, approvals)).join('')}
      </ol>
    </article>`;
}

function renderProjects(data) {
  const root = $('#projects');
  const approvals = loadApprovals();
  const list = data.projects || [];
  if (!list.length) {
    root.innerHTML = '<div class="card empty">No hay proyectos en <code>data/projects.json</code>.</div>';
    return;
  }
  root.innerHTML = list.map((p) => renderProject(p, approvals)).join('');
  // Bind for first/current project cards
  list.forEach((p) => bindApprovals(p));
}

async function boot() {
  let data;
  try {
    const res = await fetch('data/projects.json?v=2');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    data = await res.json();
  } catch (e) {
    $('#projects').innerHTML = `<div class="card empty">No se pudo cargar data/projects.json: ${escapeHtml(e.message)}</div>`;
    return;
  }
  renderStyle(data.style);
  renderProjects(data);
  const n = (data.projects || []).length;
  $('#projectCount').textContent = `${n} proyecto${n === 1 ? '' : 's'}`;
}

boot();

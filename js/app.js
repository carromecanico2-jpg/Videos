import WaveSurfer from './wavesurfer.esm.js';
import RegionsPlugin from './regions.esm.js';

const STORAGE_KEY = 'mary-cooper-audio-review-v2';
const PAD = 2.0;

const $ = (id) => document.getElementById(id);
const statusEl = $('status');
const listEl = $('list');
const toastEl = $('toast');

let DATA = null;
let wavesurfer = null;
let regionPlugin = null;
let regionById = new Map();
let decisions = {}; // id -> 'borrar' | 'dejar' | 'pendiente'
let keepTake = {}; // groupId -> takeId
let playMode = null;
let stopAt = null;
let previewQueue = [];
let previewActive = false;
let filterMode = 'all';
let activeId = null;

function fmt(t) {
  if (!Number.isFinite(t) || t < 0) t = 0;
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => toastEl.classList.remove('show'), 1800);
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function saveState() {
  const payload = { version: 2, decisions, keepTake, savedAt: new Date().toISOString() };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  updateCounts();
}

function recommendedTakeId(g) {
  if (!g) return null;
  if (g.recommended_take_id) return g.recommended_take_id;
  const rec = (g.takes || []).find((t) => t.recommended);
  if (rec) return rec.id;
  const last = (g.takes || []).find((t) => t.kind === 'last') || (g.takes || [])[(g.takes || []).length - 1];
  return last ? last.id : null;
}

function initDefaults() {
  const saved = loadState();
  decisions = {};
  keepTake = {};
  for (const p of DATA.proposals) {
    const prev = saved?.decisions?.[p.id];
    decisions[p.id] = prev === 'borrar' || prev === 'dejar' || prev === 'pendiente' ? prev : 'pendiente';
  }
  for (const [gid, g] of Object.entries(DATA.groups || {})) {
    if (saved?.keepTake?.[gid] && (g.takes || []).some((t) => t.id === saved.keepTake[gid])) {
      keepTake[gid] = saved.keepTake[gid];
    } else {
      keepTake[gid] = recommendedTakeId(g);
    }
  }
}

function groupForProposal(p) {
  if (!p.group_id) return null;
  return DATA.groups[p.group_id] || null;
}

function computeCuts() {
  const cuts = [];
  for (const p of DATA.proposals) {
    if (decisions[p.id] !== 'borrar') continue;
    if (p.type === 'silence') {
      const keep = (p.meta && p.meta.keep_duration) || 0;
      const a = p.start + keep;
      if (a < p.end - 0.01) cuts.push([a, p.end]);
    } else if (p.type === 'retake') {
      const g = groupForProposal(p);
      if (!g) {
        cuts.push([p.start, p.end]);
        continue;
      }
      const take = g.takes.find((t) => t.id === keepTake[g.id]) || g.takes[g.takes.length - 1];
      const spanStart = Math.min(...g.takes.map((t) => t.start));
      const spanEnd = Math.max(...g.takes.map((t) => t.end));
      if (take.start > spanStart + 0.01) cuts.push([spanStart, take.start]);
      if (take.end < spanEnd - 0.01) cuts.push([take.end, spanEnd]);
    }
  }
  cuts.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const c of cuts) {
    if (!merged.length || c[0] > merged[merged.length - 1][1] + 0.001) merged.push([...c]);
    else merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], c[1]);
  }
  return merged;
}

function complementKeep(cuts, duration) {
  const keep = [];
  let cursor = 0;
  for (const [a, b] of cuts) {
    if (a > cursor + 0.01) keep.push([cursor, a]);
    cursor = Math.max(cursor, b);
  }
  if (cursor < duration - 0.01) keep.push([cursor, duration]);
  return keep;
}

function cutForProposal(p) {
  if (decisions[p.id] !== 'borrar') return null;
  if (p.type === 'silence') {
    const keep = (p.meta && p.meta.keep_duration) || 0;
    return [p.start + keep, p.end];
  }
  const g = groupForProposal(p);
  if (!g) return [p.start, p.end];
  const take = g.takes.find((t) => t.id === keepTake[g.id]) || g.takes[g.takes.length - 1];
  const spanStart = Math.min(...g.takes.map((t) => t.start));
  const spanEnd = Math.max(...g.takes.map((t) => t.end));
  return { spanStart, spanEnd, keepStart: take.start, keepEnd: take.end };
}

function regionColor(p) {
  const d = decisions[p.id];
  if (d === 'dejar') return 'rgba(62, 207, 142, 0.32)';
  if (d === 'pendiente') {
    if (p.type === 'retake') return 'rgba(226, 85, 85, 0.18)';
    return 'rgba(224, 184, 58, 0.18)';
  }
  if (p.type === 'retake') return 'rgba(226, 85, 85, 0.45)';
  return 'rgba(224, 184, 58, 0.42)';
}

function regionBounds(p) {
  if (p.type === 'retake') {
    const g = groupForProposal(p);
    if (g && decisions[p.id] === 'borrar') {
      const take = g.takes.find((t) => t.id === keepTake[g.id]) || g.takes[g.takes.length - 1];
      const spanStart = Math.min(...g.takes.map((t) => t.start));
      const spanEnd = Math.max(...g.takes.map((t) => t.end));
      if (take.kind === 'last' || take.start >= p.start) {
        return { start: spanStart, end: take.start > spanStart ? take.start : p.end };
      }
      return { start: take.end, end: spanEnd };
    }
    if (g) {
      return {
        start: Math.min(...g.takes.map((t) => t.start)),
        end: Math.max(...g.takes.map((t) => t.end)),
      };
    }
  }
  return { start: p.start, end: p.end };
}

function rebuildRegions() {
  if (!regionPlugin) return;
  regionPlugin.clearRegions();
  regionById.clear();
  for (const p of DATA.proposals) {
    const { start, end } = regionBounds(p);
    if (!(end > start)) continue;
    const r = regionPlugin.addRegion({
      id: p.id,
      start,
      end,
      color: regionColor(p),
      drag: false,
      resize: false,
      content: p.label,
    });
    regionById.set(p.id, r);
  }
}

function sortedProposals() {
  return [...DATA.proposals].sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
}

function filteredProposals() {
  return sortedProposals().filter((p) => {
    if (filterMode === 'all') return true;
    if (filterMode === 'retake') return p.type === 'retake';
    if (filterMode === 'silence') return p.type === 'silence';
    if (filterMode === 'pendiente') return decisions[p.id] === 'pendiente';
    return true;
  });
}

function scrollToItem(id) {
  activeId = id;
  const el = document.querySelector(`[data-id="${id}"]`);
  if (!el) return;
  document.querySelectorAll('.row.active').forEach((n) => n.classList.remove('active'));
  el.classList.add('active');
  el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function stopSpecialPlayback() {
  playMode = null;
  stopAt = null;
  previewQueue = [];
  previewActive = false;
  const pa = $('previewAll');
  if (pa) pa.checked = false;
}

async function hardStop() {
  stopSpecialPlayback();
  if (wavesurfer) {
    wavesurfer.pause();
    try { wavesurfer.setTime(wavesurfer.getCurrentTime()); } catch {}
  }
  updatePlayBtn();
}

function updatePlayBtn() {
  const playing = wavesurfer && wavesurfer.isPlaying();
  $('btnPlay').textContent = playing ? '⏸' : '▶';
}

function playRange(start, end) {
  stopSpecialPlayback();
  playMode = 'segment';
  stopAt = end;
  wavesurfer.setTime(Math.max(0, start));
  wavesurfer.play();
  updatePlayBtn();
}

function playEscuchar(p) {
  const { start, end } = regionBounds(p);
  const a = Math.max(0, start - PAD);
  const b = Math.min(wavesurfer.getDuration(), end + PAD);
  playRange(a, b);
  scrollToItem(p.id);
}

function playTake(t) {
  playRange(Math.max(0, t.start - 0.15), Math.min(wavesurfer.getDuration(), t.end + 0.15));
}

function playAsiQueda(p) {
  const dur = wavesurfer.getDuration();
  const ctxA = Math.max(0, p.start - PAD);
  let ctxB = Math.min(dur, p.end + PAD);
  const segs = [];

  if (p.type === 'silence') {
    const keep = (p.meta && p.meta.keep_duration) || 0;
    const cutStart = p.start + keep;
    const cutEnd = p.end;
    if (decisions[p.id] === 'dejar' || decisions[p.id] === 'pendiente') {
      segs.push([ctxA, ctxB]);
    } else {
      if (cutStart > ctxA) segs.push([ctxA, cutStart]);
      const after = Math.min(dur, cutEnd);
      if (ctxB > after) segs.push([after, ctxB]);
    }
  } else {
    const info = cutForProposal(p);
    const g = groupForProposal(p);
    const spanStart = g ? Math.min(...g.takes.map((t) => t.start)) : p.start;
    const spanEnd = g ? Math.max(...g.takes.map((t) => t.end)) : p.end;
    ctxB = Math.min(dur, spanEnd + PAD);
    if (decisions[p.id] !== 'borrar' || !info) {
      segs.push([Math.max(0, spanStart - PAD), ctxB]);
    } else {
      const pre = Math.max(0, spanStart - PAD);
      const cuts = [];
      if (info.keepStart > spanStart + 0.01) cuts.push([spanStart, info.keepStart]);
      if (info.keepEnd < spanEnd - 0.01) cuts.push([info.keepEnd, spanEnd]);
      const windowKeep = complementKeep(cuts, dur).filter(([a, b]) => b > pre && a < ctxB);
      for (const [a, b] of windowKeep) segs.push([Math.max(a, pre), Math.min(b, ctxB)]);
      if (!segs.length) segs.push([info.keepStart, info.keepEnd]);
    }
  }

  stopSpecialPlayback();
  playMode = 'preview';
  previewQueue = segs.filter(([a, b]) => b - a > 0.05);
  previewActive = true;
  playNextPreviewSeg();
  scrollToItem(p.id);
}

function playNextPreviewSeg() {
  if (!previewQueue.length) {
    previewActive = false;
    playMode = null;
    wavesurfer.pause();
    updatePlayBtn();
    return;
  }
  const [a, b] = previewQueue.shift();
  stopAt = b;
  playMode = 'preview';
  wavesurfer.setTime(a);
  wavesurfer.play();
  updatePlayBtn();
}

function startFullPreview() {
  const cuts = computeCuts();
  const keep = complementKeep(cuts, wavesurfer.getDuration());
  stopSpecialPlayback();
  $('previewAll').checked = true;
  playMode = 'preview';
  previewActive = true;
  previewQueue = keep.filter(([a, b]) => b - a > 0.05);
  if (!previewQueue.length) {
    toast('No queda audio para reproducir');
    return;
  }
  playNextPreviewSeg();
}

function onTimeUpdate(t) {
  const dur = wavesurfer.getDuration() || DATA.duration;
  $('timeLabel').textContent = `${fmt(t)} / ${fmt(dur)}`;
  if (stopAt != null && t >= stopAt - 0.03) {
    if (playMode === 'preview' && previewActive) {
      wavesurfer.pause();
      playNextPreviewSeg();
    } else {
      wavesurfer.pause();
      stopAt = null;
      playMode = null;
      updatePlayBtn();
    }
  }
}

function setDecision(id, value) {
  if (decisions[id] === value) decisions[id] = 'pendiente';
  else decisions[id] = value;
  saveState();
  rebuildRegions();
  renderList();
  scrollToItem(id);
}

function updateCounts() {
  let borrar = 0, dejar = 0, pendiente = 0;
  for (const p of DATA.proposals) {
    const d = decisions[p.id];
    if (d === 'borrar') borrar++;
    else if (d === 'dejar') dejar++;
    else pendiente++;
  }
  const cutSec = computeCuts().reduce((acc, [a, b]) => acc + (b - a), 0);
  $('counts').innerHTML =
    `<strong>${borrar}</strong> borrar · <strong>${dejar}</strong> dejar · <strong>${pendiente}</strong> pendiente · ~${fmt(cutSec)} a quitar`;
}

function shortLabel(p) {
  const text = (p.text || '').replace(/\s+/g, ' ').trim();
  const reason = (p.reason || '').replace(/\s+/g, ' ').trim();
  if (p.type === 'silence') return reason || text || '[silencio]';
  return text || reason || p.label;
}

function renderList() {
  const items = filteredProposals();
  $('listCount').textContent = `${items.length} / ${DATA.proposals.length}`;
  listEl.innerHTML = '';

  for (const p of items) {
    const decision = decisions[p.id] || 'pendiente';
    const g = groupForProposal(p);
    const el = document.createElement('article');
    el.className = `row ${decision}`;
    if (activeId === p.id) el.classList.add('active');
    el.dataset.id = p.id;

    let takesHtml = '';
    if (g && g.takes && g.takes.length) {
      const recReason = g.recommended_reason || '';
      takesHtml = `<div class="takes">${g.takes
        .map((t) => {
          const checked = keepTake[g.id] === t.id ? 'checked' : '';
          const sel = keepTake[g.id] === t.id ? 'selected' : '';
          const rec = t.recommended ? `<span class="rec-tag">Recomendada</span>` : '';
          const reason = t.recommended
            ? escapeHtml(t.reason_es || recReason || '')
            : escapeHtml(t.reason_es || '');
          const score = typeof t.score === 'number' ? ` · ${Math.round(t.score)}` : '';
          return `<label class="take-chip ${sel}">
            <input type="radio" name="take-${g.id}" value="${t.id}" ${checked} data-gid="${g.id}" />
            ${rec}
            <span class="t-meta">${escapeHtml(t.take_label || t.id)} · ${fmt(t.start)}–${fmt(t.end)}${score}</span>
            <span class="t-reason">${reason}</span>
            <button type="button" class="btn btn-icon" data-act="take-listen" data-take="${t.id}" title="Escuchar toma">▶</button>
          </label>`;
        })
        .join('')}</div>`;
    }

    el.innerHTML = `
      <span class="badge ${p.type}">${escapeHtml(p.label)}</span>
      <span class="badge-time">${fmt(p.start)}–${fmt(p.end)}</span>
      <div class="row-main">
        <div class="row-text">${escapeHtml(shortLabel(p))}</div>
        ${p.type === 'retake' && g?.recommended_reason ? `<div class="row-sub">${escapeHtml(g.recommended_reason)}</div>` : (p.reason && p.type === 'silence' ? '' : '')}
      </div>
      <div class="row-actions">
        <span class="state-dot" title="${decision}"></span>
        <button type="button" class="btn btn-icon" data-act="listen" title="Escuchar">▶</button>
        <button type="button" class="btn btn-icon" data-act="preview" title="Así queda">✓▶</button>
        <div class="seg">
          <button type="button" class="btn btn-borrar ${decision === 'borrar' ? 'selected' : ''}" data-act="borrar">Borrar</button>
          <button type="button" class="btn btn-dejar ${decision === 'dejar' ? 'selected' : ''}" data-act="dejar">Dejar</button>
        </div>
      </div>
      ${takesHtml}
    `;

    el.addEventListener('click', (ev) => {
      const takeBtn = ev.target.closest('[data-act="take-listen"]');
      if (takeBtn) {
        ev.preventDefault();
        ev.stopPropagation();
        const tid = takeBtn.dataset.take;
        const take = g?.takes?.find((t) => t.id === tid);
        if (take) playTake(take);
        return;
      }
      const btn = ev.target.closest('[data-act]');
      if (btn) {
        const act = btn.dataset.act;
        if (act === 'listen') playEscuchar(p);
        else if (act === 'preview') playAsiQueda(p);
        else if (act === 'borrar') setDecision(p.id, 'borrar');
        else if (act === 'dejar') setDecision(p.id, 'dejar');
        return;
      }
      const radio = ev.target.closest('input[type="radio"][data-gid]');
      if (radio) {
        keepTake[radio.dataset.gid] = radio.value;
        saveState();
        rebuildRegions();
        renderList();
        scrollToItem(p.id);
        return;
      }
      // row click -> seek
      scrollToItem(p.id);
      if (wavesurfer) {
        wavesurfer.setTime(Math.max(0, p.start));
        $('timeLabel').textContent = `${fmt(p.start)} / ${fmt(wavesurfer.getDuration() || DATA.duration)}`;
      }
    });

    listEl.appendChild(el);
  }
}

function buildCopyText() {
  const lines = [];
  const borrar = [], dejar = [], pendiente = [], takeNotes = [];
  for (const p of sortedProposals()) {
    const d = decisions[p.id];
    if (d === 'borrar') borrar.push(p.label);
    else if (d === 'dejar') dejar.push(p.label);
    else pendiente.push(p.label);
    if (p.type === 'retake') {
      const g = groupForProposal(p);
      if (!g) continue;
      const take = g.takes.find((t) => t.id === keepTake[g.id]);
      const rec = recommendedTakeId(g);
      if (take && take.id !== rec) {
        takeNotes.push(`${p.label} quedarse con ${take.take_label || take.id}`);
      }
    }
  }
  lines.push('Borrar: ' + (borrar.join(', ') || '(ninguno)'));
  lines.push('Dejar: ' + (dejar.join(', ') || '(ninguno)'));
  lines.push('Pendiente: ' + (pendiente.join(', ') || '(ninguno)'));
  if (takeNotes.length) lines.push(takeNotes.join(' | '));
  return lines.join(' | ');
}

function downloadDecisions() {
  const payload = {
    savedAt: new Date().toISOString(),
    decisions,
    keepTake,
    summary: buildCopyText(),
    detail: sortedProposals().map((p) => ({
      id: p.id,
      label: p.label,
      type: p.type,
      decision: decisions[p.id],
      keep_take: p.group_id ? keepTake[p.group_id] : null,
      recommended_take: p.group_id ? recommendedTakeId(DATA.groups[p.group_id]) : null,
      start: p.start,
      end: p.end,
    })),
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'decisiones.json';
  a.click();
  URL.revokeObjectURL(a.href);
  toast('Descarga iniciada');
}

async function copyDecisions() {
  const text = buildCopyText();
  try {
    await navigator.clipboard.writeText(text);
    toast('Decisiones copiadas');
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    toast('Decisiones copiadas');
  }
}

function bulkSet(predicate, value) {
  let n = 0;
  for (const p of DATA.proposals) {
    if (predicate(p)) {
      decisions[p.id] = value;
      n++;
    }
  }
  saveState();
  rebuildRegions();
  renderList();
  toast(`${n} marcados como ${value}`);
}

async function boot() {
  try {
    const res = await fetch('data/proposals.json');
    if (!res.ok) throw new Error('No se pudo cargar data/proposals.json');
    DATA = await res.json();
  } catch (e) {
    statusEl.className = 'error';
    statusEl.textContent = 'Error cargando propuestas: ' + e.message;
    return;
  }

  initDefaults();

  regionPlugin = RegionsPlugin.create();
  wavesurfer = WaveSurfer.create({
    container: '#waveform',
    waveColor: '#3a4658',
    progressColor: '#5b9dff',
    cursorColor: '#ffffff',
    cursorWidth: 2,
    barWidth: 2,
    barGap: 1,
    barRadius: 2,
    height: 64,
    normalize: true,
    url: DATA.audio || 'audio.mp3',
    plugins: [regionPlugin],
  });

  wavesurfer.on('ready', () => {
    statusEl.style.display = 'none';
    rebuildRegions();
    renderList();
    updateCounts();
    $('timeLabel').textContent = `0:00 / ${fmt(wavesurfer.getDuration())}`;
  });

  wavesurfer.on('error', (err) => {
    statusEl.className = 'error';
    statusEl.style.display = 'block';
    statusEl.textContent = 'Error de audio: ' + (err?.message || err);
  });

  wavesurfer.on('audioprocess', onTimeUpdate);
  wavesurfer.on('timeupdate', onTimeUpdate);
  wavesurfer.on('play', updatePlayBtn);
  wavesurfer.on('pause', updatePlayBtn);
  wavesurfer.on('finish', () => {
    if (playMode === 'preview' && previewActive) playNextPreviewSeg();
    else {
      stopSpecialPlayback();
      updatePlayBtn();
    }
  });

  regionPlugin.on('region-clicked', (region, e) => {
    e.stopPropagation();
    scrollToItem(region.id);
    const p = DATA.proposals.find((x) => x.id === region.id);
    if (p) playEscuchar(p);
  });

  $('btnPlay').addEventListener('click', () => {
    if (!wavesurfer) return;
    if (wavesurfer.isPlaying()) {
      wavesurfer.pause();
      if (playMode === 'preview') {
        previewActive = false;
        previewQueue = [];
        playMode = null;
        stopAt = null;
        $('previewAll').checked = false;
      }
    } else {
      playMode = null;
      stopAt = null;
      previewActive = false;
      $('previewAll').checked = false;
      wavesurfer.play();
    }
    updatePlayBtn();
  });

  $('btnStop').addEventListener('click', () => {
    hardStop();
    if (wavesurfer) wavesurfer.setTime(0);
  });

  $('previewAll').addEventListener('change', (e) => {
    if (e.target.checked) startFullPreview();
    else hardStop();
  });

  $('btnCopy').addEventListener('click', copyDecisions);
  $('btnDownload').addEventListener('click', downloadDecisions);

  document.querySelectorAll('.filters .chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      document.querySelectorAll('.filters .chip').forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');
      filterMode = chip.dataset.filter;
      renderList();
    });
  });

  $('btnBulkSilence').addEventListener('click', () => {
    bulkSet((p) => p.type === 'silence', 'borrar');
  });
  $('btnBulkDejar').addEventListener('click', () => {
    bulkSet(() => true, 'dejar');
  });
}

boot();

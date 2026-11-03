import WaveSurfer from './wavesurfer.esm.js';
import RegionsPlugin from './regions.esm.js';

const STORAGE_KEY = 'mary-cooper-audio-review-v1';
const PAD = 2.0;

const $ = (id) => document.getElementById(id);
const statusEl = $('status');
const listEl = $('list');
const toastEl = $('toast');

let DATA = null;
let wavesurfer = null;
let regionPlugin = null;
let regionById = new Map();
let decisions = {}; // id -> 'borrar' | 'dejar'
let keepTake = {}; // groupId -> takeId
let playMode = null; // null | 'segment' | 'preview'
let stopAt = null;
let previewQueue = [];
let previewActive = false;

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

function defaultDecision(p) {
  return p.default_decision === 'reject' ? 'dejar' : 'borrar';
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
  const payload = { version: 1, decisions, keepTake, savedAt: new Date().toISOString() };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  updateCounts();
}

function initDefaults() {
  const saved = loadState();
  decisions = {};
  keepTake = {};
  for (const p of DATA.proposals) {
    decisions[p.id] = saved?.decisions?.[p.id] || defaultDecision(p);
  }
  for (const [gid, g] of Object.entries(DATA.groups || {})) {
    if (saved?.keepTake?.[gid]) {
      keepTake[gid] = saved.keepTake[gid];
    } else {
      const last = g.takes.find((t) => t.kind === 'last') || g.takes[g.takes.length - 1];
      keepTake[gid] = last.id;
    }
  }
}

function groupForProposal(p) {
  if (!p.group_id) return null;
  return DATA.groups[p.group_id] || null;
}

/** Ranges to skip when applying current decisions */
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
    if (!merged.length || c[0] > merged[merged.length - 1][1] + 0.001) {
      merged.push([...c]);
    } else {
      merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], c[1]);
    }
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
  // For "así queda" preview around this item: skip non-kept parts in the group span
  return { spanStart, spanEnd, keepStart: take.start, keepEnd: take.end };
}

function regionColor(p) {
  const leave = decisions[p.id] === 'dejar';
  if (leave) return 'rgba(62, 207, 142, 0.28)';
  if (p.type === 'retake') return 'rgba(226, 85, 85, 0.42)';
  return 'rgba(224, 184, 58, 0.40)';
}

function regionBounds(p) {
  if (p.type === 'retake') {
    const g = groupForProposal(p);
    if (g && decisions[p.id] === 'borrar') {
      const take = g.takes.find((t) => t.id === keepTake[g.id]) || g.takes[g.takes.length - 1];
      const spanStart = Math.min(...g.takes.map((t) => t.start));
      const spanEnd = Math.max(...g.takes.map((t) => t.end));
      // Show the parts that will be removed as the region (prefer earlier block)
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

function scrollToItem(id) {
  const el = document.querySelector(`[data-id="${id}"]`);
  if (!el) return;
  document.querySelectorAll('.item.active').forEach((n) => n.classList.remove('active'));
  el.classList.add('active');
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function stopSpecialPlayback() {
  playMode = null;
  stopAt = null;
  previewQueue = [];
  previewActive = false;
  $('previewAll').checked = false;
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

function playAsiQueda(p) {
  const dur = wavesurfer.getDuration();
  const ctxA = Math.max(0, p.start - PAD);
  let ctxB = Math.min(dur, p.end + PAD);
  const segs = [];

  if (p.type === 'silence') {
    const keep = (p.meta && p.meta.keep_duration) || 0;
    const cutStart = p.start + keep;
    const cutEnd = p.end;
    if (decisions[p.id] === 'dejar') {
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
    if (decisions[p.id] === 'dejar' || !info) {
      segs.push([Math.max(0, spanStart - PAD), ctxB]);
    } else {
      const pre = Math.max(0, spanStart - PAD);
      if (info.keepStart > pre) {
        // play pre-context up to cut, then keep take, then after
        if (info.keepStart > pre && spanStart > pre) {
          // from context to start of deleted? Actually: play [pre, keepStart) skips deleted before keep
          // if keep is last: [pre, spanStart) then jump — wait spanStart == first take start.
          // Better: play [pre, cut1start) + [keepStart, keepEnd] + [cut2end, ctxB]
        }
      }
      const cuts = [];
      if (info.keepStart > spanStart + 0.01) cuts.push([spanStart, info.keepStart]);
      if (info.keepEnd < spanEnd - 0.01) cuts.push([info.keepEnd, spanEnd]);
      const windowKeep = complementKeep(cuts, dur).filter(([a, b]) => b > pre && a < ctxB);
      for (const [a, b] of windowKeep) {
        segs.push([Math.max(a, pre), Math.min(b, ctxB)]);
      }
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

function renderList() {
  const items = sortedProposals();
  $('listCount').textContent = `${items.length} partes`;
  listEl.innerHTML = '';
  for (const p of items) {
    const decision = decisions[p.id];
    const g = groupForProposal(p);
    const el = document.createElement('article');
    el.className = `item ${decision === 'dejar' ? 'dejar' : ''}`;
    el.dataset.id = p.id;

    const timeLabel = `${fmt(p.start)} – ${fmt(p.end)}`;
    let takesHtml = '';
    if (g && g.takes && g.takes.length) {
      takesHtml = `<div class="takes"><h3>¿Cuál toma conservar? (por defecto la última)</h3>${g.takes
        .map((t, i) => {
          const checked = keepTake[g.id] === t.id ? 'checked' : '';
          const sel = keepTake[g.id] === t.id ? 'selected' : '';
          const label = t.kind === 'last' ? `Toma ${i + 1} (última)` : `Toma ${i + 1}`;
          return `<label class="take-opt ${sel}">
            <input type="radio" name="take-${g.id}" value="${t.id}" ${checked} data-gid="${g.id}" />
            <span><div class="t-meta">${label} · ${fmt(t.start)}–${fmt(t.end)}</div>
            <div class="t-text">${escapeHtml(t.text || '')}</div></span>
          </label>`;
        })
        .join('')}</div>`;
    }

    el.innerHTML = `
      <div class="item-top">
        <span class="badge ${p.type}">${p.label}</span>
        <span class="badge time">${timeLabel}</span>
      </div>
      <div class="item-text">${escapeHtml(p.text || '')}</div>
      <div class="item-reason">${escapeHtml(p.reason || '')}</div>
      ${takesHtml}
      <div class="actions">
        <button type="button" class="btn" data-act="listen">▶ Escuchar</button>
        <button type="button" class="btn" data-act="preview">▶ Así queda</button>
      </div>
      <div class="decide">
        <button type="button" class="btn btn-borrar ${decision === 'borrar' ? 'selected' : ''}" data-act="borrar">Borrar</button>
        <button type="button" class="btn btn-dejar ${decision === 'dejar' ? 'selected' : ''}" data-act="dejar">Dejar</button>
      </div>
    `;

    el.addEventListener('click', (ev) => {
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
        return;
      }
    });

    listEl.appendChild(el);
  }
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function setDecision(id, value) {
  decisions[id] = value;
  saveState();
  rebuildRegions();
  // Update just this card classes/buttons without full re-render if possible — full is fine
  renderList();
  scrollToItem(id);
}

function updateCounts() {
  let borrar = 0;
  let dejar = 0;
  for (const p of DATA.proposals) {
    if (decisions[p.id] === 'borrar') borrar++;
    else dejar++;
  }
  const cutSec = computeCuts().reduce((acc, [a, b]) => acc + (b - a), 0);
  $('counts').innerHTML = `<strong>${borrar}</strong> borrar · <strong>${dejar}</strong> dejar · ~${fmt(cutSec)} a quitar`;
}

function buildCopyText() {
  const dejarIds = [];
  const takeNotes = [];
  for (const p of sortedProposals()) {
    if (decisions[p.id] === 'dejar') dejarIds.push(p.label);
    if (p.type === 'retake' && decisions[p.id] === 'borrar') {
      const g = groupForProposal(p);
      if (!g) continue;
      const idx = g.takes.findIndex((t) => t.id === keepTake[g.id]);
      const last = g.takes[g.takes.length - 1];
      if (keepTake[g.id] !== last.id) {
        takeNotes.push(`${p.label} quedarse con toma ${idx + 1}`);
      }
    }
  }
  const parts = [];
  if (dejarIds.length) parts.push('Dejar: ' + dejarIds.join(', '));
  else parts.push('Dejar: (ninguno)');
  if (takeNotes.length) parts.push(takeNotes.join(' | '));
  return parts.join(' | ');
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
    height: 128,
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
      // resume normal play from cursor
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
}

boot();


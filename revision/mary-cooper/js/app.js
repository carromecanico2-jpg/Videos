import WaveSurfer from './wavesurfer.esm.js';
import RegionsPlugin from './regions.esm.js';

const STORAGE_KEY = 'mary-cooper-audio-review-v2';
const PAD = 2.0;
const SKIP_LOOKAHEAD = 0.03; // 30 ms

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
let playMode = null; // null | 'segment' | 'preview'
let stopAt = null;
let previewActive = false;
let filterMode = 'all';
let activeId = null;
let skipRaf = null;
let lastKeepRanges = [];
let skipping = false;
let audioReady = false;
let peaksData = null;

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
  // If preview is running, refresh skip map immediately (e.g. take picker change)
  if (previewActive) lastKeepRanges = computeFinalKeepRanges();
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

/** Proposal is applied unless user explicitly chose Dejar. Pending = apply proposal. */
function appliesProposal(p) {
  return decisions[p.id] !== 'dejar';
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

function computeCuts() {
  const cuts = [];
  for (const p of DATA.proposals) {
    if (!appliesProposal(p)) continue;
    if (p.type === 'silence') {
      const keep = (p.meta && p.meta.keep_duration) || 0.3;
      const a = p.start + keep;
      if (a < p.end - 0.01) cuts.push([a, p.end]);
    } else if (p.type === 'retake') {
      const g = groupForProposal(p);
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
  return mergeRanges(cuts);
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

/** Single source of truth for preview + export. */
function computeFinalKeepRanges(duration) {
  const dur = duration ?? (wavesurfer?.getDuration?.() || DATA?.duration || 0);
  const cuts = computeCuts();
  return complementKeep(cuts, dur);
}

function cutForProposal(p) {
  if (!appliesProposal(p)) return null;
  if (p.type === 'silence') {
    const keep = (p.meta && p.meta.keep_duration) || 0.3;
    return [p.start + keep, p.end];
  }
  const g = groupForProposal(p);
  if (!g) return [p.start, p.end];
  const take =
    g.takes.find((t) => t.id === keepTake[g.id]) ||
    g.takes.find((t) => t.id === recommendedTakeId(g)) ||
    g.takes[g.takes.length - 1];
  const spanStart = Math.min(...g.takes.map((t) => t.start));
  const spanEnd = Math.max(...g.takes.map((t) => t.end));
  return { spanStart, spanEnd, keepStart: take.start, keepEnd: take.end };
}

function regionColor(p) {
  const d = decisions[p.id];
  if (d === 'dejar') return 'rgba(62, 207, 142, 0.32)';
  if (d === 'pendiente') {
    if (p.type === 'retake') return 'rgba(226, 85, 85, 0.22)';
    return 'rgba(224, 184, 58, 0.22)';
  }
  if (p.type === 'retake') return 'rgba(226, 85, 85, 0.45)';
  return 'rgba(224, 184, 58, 0.42)';
}

function regionBounds(p) {
  if (p.type === 'retake') {
    const g = groupForProposal(p);
    if (g && appliesProposal(p)) {
      const take =
        g.takes.find((t) => t.id === keepTake[g.id]) ||
        g.takes.find((t) => t.id === recommendedTakeId(g)) ||
        g.takes[g.takes.length - 1];
      const spanStart = Math.min(...g.takes.map((t) => t.start));
      const spanEnd = Math.max(...g.takes.map((t) => t.end));
      // Show removed parts as region (prefer block before kept take)
      if (take.start > spanStart + 0.05) return { start: spanStart, end: take.start };
      if (take.end < spanEnd - 0.05) return { start: take.end, end: spanEnd };
      return { start: spanStart, end: spanEnd };
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

function getMedia() {
  try { return wavesurfer?.getMediaElement?.() || null; } catch { return null; }
}

function resetVolume() {
  const m = getMedia();
  if (m) m.volume = 1;
  try { wavesurfer?.setVolume?.(1); } catch {}
}

function fadeJump(toTime) {
  const m = getMedia();
  skipping = true;
  const restore = () => {
    if (m) m.volume = 1;
    try { wavesurfer?.setVolume?.(1); } catch {}
    skipping = false;
  };
  try {
    if (m) {
      const start = m.volume || 1;
      m.volume = Math.max(0.05, start * 0.15);
    }
  } catch {}
  try { wavesurfer.setTime(toTime); } catch {}
  // Failsafe: always restore volume shortly after seek
  setTimeout(restore, 45);
}

function nextKeepStart(t, keepRanges) {
  for (const [a, b] of keepRanges) {
    if (t < a - 0.001) return a;
    if (t >= a - 0.001 && t < b - 0.001) return null; // already in keep
  }
  return null; // past end
}

function findCutContaining(t, cuts) {
  for (const [a, b] of cuts) {
    if (t >= a - SKIP_LOOKAHEAD && t < b - 0.001) return [a, b];
  }
  return null;
}

function stopSkipLoop() {
  if (skipRaf) {
    cancelAnimationFrame(skipRaf);
    skipRaf = null;
  }
}

function startSkipLoop() {
  stopSkipLoop();
  const tick = () => {
    skipRaf = requestAnimationFrame(tick);
    if (!previewActive || !wavesurfer || skipping) return;
    if (!wavesurfer.isPlaying()) return;
    const t = wavesurfer.getCurrentTime();
    const dur = wavesurfer.getDuration() || DATA.duration;
    const keep = lastKeepRanges.length ? lastKeepRanges : computeFinalKeepRanges(dur);
    const cuts = computeCuts();

    // Approaching / inside a cut → jump to cut end (next keep)
    const cut = findCutContaining(t, cuts);
    if (cut) {
      const [, cutEnd] = cut;
      const dest = nextKeepStart(cutEnd - 0.001, keep);
      const jumpTo = dest != null ? dest : cutEnd;
      if (jumpTo > t + 0.005 && jumpTo < dur - 0.01) {
        fadeJump(jumpTo);
      } else if (jumpTo >= dur - 0.01 || dest == null) {
        wavesurfer.pause();
        previewActive = false;
        playMode = null;
        $('previewAll').checked = false;
        updatePlayBtn();
      }
      return;
    }

    // Local segment stop (Así queda window)
    if (stopAt != null && t >= stopAt - 0.03) {
      wavesurfer.pause();
      stopAt = null;
      if (playMode === 'preview' && $('previewAll')?.checked) {
        // continue full preview — should not hit this often with skip loop
      } else {
        previewActive = false;
        playMode = null;
        updatePlayBtn();
      }
    }
  };
  skipRaf = requestAnimationFrame(tick);
}

function stopSpecialPlayback() {
  playMode = null;
  stopAt = null;
  previewActive = false;
  stopSkipLoop();
  const pa = $('previewAll');
  if (pa) pa.checked = false;
}

async function hardStop() {
  stopSpecialPlayback();
  if (wavesurfer) {
    wavesurfer.pause();
    try { wavesurfer.setTime(wavesurfer.getCurrentTime()); } catch {}
  }
  resetVolume();
  setPlayWaiting(false);
  updatePlayBtn();
}

function updatePlayBtn() {
  const playing = wavesurfer && wavesurfer.isPlaying();
  $('btnPlay').textContent = playing ? '⏸' : '▶';
}

function playRange(start, end, { preview = false } = {}) {
  if (!preview) stopSpecialPlayback();
  playMode = preview ? 'preview' : 'segment';
  stopAt = end;
  resetVolume();
  safePlay(Math.max(0, start));
}

function playEscuchar(p) {
  const g = groupForProposal(p);
  const start = g ? Math.min(...g.takes.map((t) => t.start)) : p.start;
  const end = g ? Math.max(...g.takes.map((t) => t.end)) : p.end;
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
  const g = groupForProposal(p);
  const spanStart = g ? Math.min(...g.takes.map((t) => t.start)) : p.start;
  const spanEnd = g ? Math.max(...g.takes.map((t) => t.end)) : p.end;
  const ctxA = Math.max(0, spanStart - PAD);
  const ctxB = Math.min(dur, spanEnd + PAD);

  // Use global final keep ranges clipped to context — same rules as export
  const keepAll = computeFinalKeepRanges(dur);
  const segs = keepAll
    .map(([a, b]) => [Math.max(a, ctxA), Math.min(b, ctxB)])
    .filter(([a, b]) => b - a > 0.05);

  lastKeepRanges = keepAll;
  stopSpecialPlayback();
  $('previewAll').checked = false;
  previewActive = true;
  playMode = 'preview';
  stopAt = ctxB;
  startSkipLoop();
  if (!segs.length) {
    toast('Nada que escuchar con la propuesta actual');
    previewActive = false;
    return;
  }
  resetVolume();
  safePlay(segs[0][0]);
  scrollToItem(p.id);
}

function startFullPreview(fromTime) {
  const dur = wavesurfer.getDuration();
  lastKeepRanges = computeFinalKeepRanges(dur);
  if (!lastKeepRanges.length) {
    toast('No queda audio para reproducir');
    return;
  }
  stopSkipLoop();
  playMode = 'preview';
  previewActive = true;
  stopAt = null;
  $('previewAll').checked = true;
  startSkipLoop();

  let t0 = fromTime != null ? fromTime : wavesurfer.getCurrentTime();
  // If starting inside a cut, jump to next keep
  const cuts = computeCuts();
  const hit = findCutContaining(t0, cuts);
  if (hit) t0 = hit[1];
  const next = nextKeepStart(t0 - 0.001, lastKeepRanges);
  // if t0 already in keep, nextKeepStart returns null — keep t0
  let start = t0;
  if (next != null && (hit || !lastKeepRanges.some(([a, b]) => t0 >= a && t0 < b))) {
    start = next;
  }
  // Prefer starting near playhead if in keep; else first keep
  if (!lastKeepRanges.some(([a, b]) => start >= a - 0.01 && start < b)) {
    start = lastKeepRanges[0][0];
  }
  resetVolume();
  // Caller (checkbox/button) awaits safePlay; still set time here
  wavesurfer.setTime(start);
  updatePlayBtn();
}

function onTimeUpdate(t) {
  const dur = wavesurfer.getDuration() || DATA.duration;
  const keepDur = lastKeepRanges.length
    ? lastKeepRanges.reduce((acc, [a, b]) => acc + (b - a), 0)
    : computeFinalKeepRanges(dur).reduce((acc, [a, b]) => acc + (b - a), 0);
  // Show source time; final estimate in counts
  $('timeLabel').textContent = `${fmt(t)} / ${fmt(dur)}`;
  if (playMode === 'segment' && stopAt != null && t >= stopAt - 0.03) {
    wavesurfer.pause();
    stopAt = null;
    playMode = null;
    updatePlayBtn();
  }
  void keepDur;
}

function setDecision(id, value) {
  if (decisions[id] === value) decisions[id] = 'pendiente';
  else decisions[id] = value;
  saveState();
  rebuildRegions();
  renderList();
  scrollToItem(id);
  if (previewActive && $('previewAll')?.checked) {
    lastKeepRanges = computeFinalKeepRanges();
  }
}

function updateCounts() {
  let borrar = 0, dejar = 0, pendiente = 0;
  for (const p of DATA.proposals) {
    const d = decisions[p.id];
    if (d === 'borrar') borrar++;
    else if (d === 'dejar') dejar++;
    else pendiente++;
  }
  const dur = wavesurfer?.getDuration?.() || DATA.duration || 0;
  const keep = computeFinalKeepRanges(dur);
  const keepSec = keep.reduce((acc, [a, b]) => acc + (b - a), 0);
  const cutSec = Math.max(0, dur - keepSec);
  $('counts').innerHTML =
    `<strong>${borrar}</strong> borrar · <strong>${dejar}</strong> dejar · <strong>${pendiente}</strong> pendiente · ~${fmt(cutSec)} a quitar · final ~${fmt(keepSec)}`;
}

function shortLabel(p) {
  const text = (p.text || '').replace(/\s+/g, ' ').trim();
  const reason = (p.reason || '').replace(/\s+/g, ' ').trim();
  if (p.type === 'silence') return reason || text || '[silencio]';
  return text || reason || p.label;
}

function pendingHint(p) {
  if (decisions[p.id] !== 'pendiente') return '';
  if (p.type === 'silence') return 'se aplicará la propuesta (acortar)';
  return 'se aplicará la propuesta (solo toma elegida)';
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

    const hint = pendingHint(p);
    const subBits = [];
    if (p.type === 'retake' && g?.recommended_reason) subBits.push(escapeHtml(g.recommended_reason));
    if (hint) subBits.push(`<span class="apply-hint">${escapeHtml(hint)}</span>`);

    el.innerHTML = `
      <span class="badge ${p.type}">${escapeHtml(p.label)}</span>
      <span class="badge-time">${fmt(p.start)}–${fmt(p.end)}</span>
      <div class="row-main">
        <div class="row-text">${escapeHtml(shortLabel(p))}</div>
        ${subBits.length ? `<div class="row-sub">${subBits.join(' · ')}</div>` : ''}
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
        if (previewActive) {
          lastKeepRanges = computeFinalKeepRanges();
          toast('Toma actualizada en la vista previa');
        }
        return;
      }
      scrollToItem(p.id);
      if (wavesurfer) {
        let t = Math.max(0, p.start);
        if (previewActive) {
          const cuts = computeCuts();
          const hit = findCutContaining(t, cuts);
          if (hit) t = hit[1];
        }
        wavesurfer.setTime(t);
        $('timeLabel').textContent = `${fmt(t)} / ${fmt(wavesurfer.getDuration() || DATA.duration)}`;
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
    if (p.type === 'retake' && appliesProposal(p)) {
      const g = groupForProposal(p);
      if (!g) continue;
      const take = g.takes.find((t) => t.id === keepTake[g.id]);
      if (take) takeNotes.push(`${p.label} conservar ${take.take_label || take.id}`);
    }
  }
  const dur = wavesurfer?.getDuration?.() || DATA.duration;
  const keep = computeFinalKeepRanges(dur);
  const keepSec = keep.reduce((acc, [a, b]) => acc + (b - a), 0);
  lines.push('Borrar: ' + (borrar.join(', ') || '(ninguno)'));
  lines.push('Dejar: ' + (dejar.join(', ') || '(ninguno)'));
  lines.push('Pendiente(=propuesta): ' + (pendiente.join(', ') || '(ninguno)'));
  lines.push(`Duración final ~${fmt(keepSec)}`);
  if (takeNotes.length) lines.push(takeNotes.join(' | '));
  return lines.join(' | ');
}

function downloadDecisions() {
  const dur = wavesurfer?.getDuration?.() || DATA.duration;
  const keep_ranges = computeFinalKeepRanges(dur).map(([a, b]) => ({
    start: Math.round(a * 1000) / 1000,
    end: Math.round(b * 1000) / 1000,
  }));
  const total_duration = keep_ranges.reduce((acc, r) => acc + (r.end - r.start), 0);
  const payload = {
    savedAt: new Date().toISOString(),
    decisions,
    keepTake,
    summary: buildCopyText(),
    source_duration: dur,
    total_duration: Math.round(total_duration * 1000) / 1000,
    keep_ranges,
    cuts: computeCuts().map(([a, b]) => ({
      start: Math.round(a * 1000) / 1000,
      end: Math.round(b * 1000) / 1000,
    })),
    note: 'Pendiente aplica la propuesta (retoma=toma elegida; silencio=acortar). Solo Dejar conserva todo.',
    detail: sortedProposals().map((p) => ({
      id: p.id,
      label: p.label,
      type: p.type,
      decision: decisions[p.id],
      applies_proposal: appliesProposal(p),
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


function setLoader(pct, text) {
  const loader = $('audioLoader');
  const bar = $('loaderBar');
  const txt = $('loaderText');
  const card = document.querySelector('.player-card');
  if (loader) loader.hidden = false;
  if (card) { card.classList.add('is-loading'); card.classList.remove('is-ready'); }
  if (bar && pct != null) bar.style.width = `${Math.max(0, Math.min(100, pct))}%`;
  if (txt && text) txt.textContent = text;
}

function setAudioReady(ok) {
  audioReady = !!ok;
  const card = document.querySelector('.player-card');
  const loader = $('audioLoader');
  ['btnPlay','btnStop','previewAll'].forEach((id) => {
    const el = $(id);
    if (el) el.disabled = !ok;
  });
  if (ok) {
    if (loader) loader.hidden = true;
    if (card) { card.classList.remove('is-loading'); card.classList.add('is-ready'); }
    resetVolume();
  }
}

function setPlayWaiting(on) {
  const btn = $('btnPlay');
  if (!btn) return;
  btn.classList.toggle('is-waiting', !!on);
  const spin = btn.querySelector('.btn-spin');
  const label = btn.querySelector('.btn-label');
  if (spin) spin.hidden = !on;
  if (label) label.hidden = !!on;
}

async function safePlay(fromTime) {
  if (!wavesurfer || !audioReady) {
    toast('El audio aún se está cargando…');
    return false;
  }
  setPlayWaiting(true);
  resetVolume();
  try {
    if (fromTime != null) wavesurfer.setTime(Math.max(0, fromTime));
    const media = getMedia();
    if (media) {
      media.muted = false;
      media.volume = 1;
    }
    await wavesurfer.play();
    // Confirm audible progress; if stuck, retry once
    await new Promise((r) => setTimeout(r, 120));
    if (!wavesurfer.isPlaying()) {
      await wavesurfer.play();
    }
    return true;
  } catch (e) {
    console.error(e);
    toast('No se pudo reproducir: ' + (e?.message || e));
    return false;
  } finally {
    setPlayWaiting(false);
    updatePlayBtn();
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

  setLoader(0, 'Cargando audio… 0%');
  setAudioReady(false);

  // Optional precomputed peaks for instant waveform
  try {
    const pr = await fetch('data/peaks.json');
    if (pr.ok) peaksData = await pr.json();
  } catch {}

  const wsOpts = {
    container: '#waveform',
    waveColor: '#c4c2be',
    progressColor: '#050505',
    cursorColor: '#1a1d23',
    cursorWidth: 2,
    barWidth: 2,
    barGap: 1,
    barRadius: 2,
    height: 64,
    normalize: true,
    url: DATA.audio || 'audio.mp3',
    plugins: [regionPlugin],
  };
  if (peaksData?.peaks && peaksData?.duration) {
    wsOpts.peaks = peaksData.peaks;
    wsOpts.duration = peaksData.duration;
  }

  wavesurfer = WaveSurfer.create(wsOpts);
  try {
    const media = wavesurfer.getMediaElement();
    if (media) {
      media.preload = 'auto';
      media.crossOrigin = 'anonymous';
    }
  } catch {}

  wavesurfer.on('loading', (pct) => {
    const p = Number(pct) || 0;
    setLoader(p, `Cargando audio… ${Math.round(p)}%`);
  });

  wavesurfer.on('ready', () => {
    statusEl.style.display = 'none';
    setLoader(100, 'Audio listo');
    setAudioReady(true);
    rebuildRegions();
    renderList();
    updateCounts();
    $('timeLabel').textContent = `0:00 / ${fmt(wavesurfer.getDuration())}`;
    resetVolume();
    window.__review = {
      get ws() { return wavesurfer; },
      computeCuts, computeFinalKeepRanges, appliesProposal,
      get decisions() { return decisions; },
      get keepTake() { return keepTake; },
      setKeepTake(gid, tid) {
        keepTake[gid] = tid;
        saveState();
        rebuildRegions();
        if (previewActive) lastKeepRanges = computeFinalKeepRanges();
      },
      get previewActive() { return previewActive; },
      get audioReady() { return audioReady; },
      startFullPreview, playAsiQueda, safePlay, resetVolume, getMedia,
    };
  });

  wavesurfer.on('error', (err) => {
    setAudioReady(false);
    setLoader(0, 'Error cargando audio');
    statusEl.className = 'error';
    statusEl.style.display = 'block';
    statusEl.textContent = 'Error de audio: ' + (err?.message || err);
    const txt = $('loaderText');
    if (txt) txt.textContent = 'Error al cargar el audio. Recarga la página.';
  });

  wavesurfer.on('audioprocess', onTimeUpdate);
  wavesurfer.on('timeupdate', onTimeUpdate);
  wavesurfer.on('play', () => { setPlayWaiting(false); updatePlayBtn(); resetVolume(); });
  wavesurfer.on('pause', () => { setPlayWaiting(false); updatePlayBtn(); });
  wavesurfer.on('finish', () => {
    if (previewActive) {
      previewActive = false;
      playMode = null;
      $('previewAll').checked = false;
      stopSkipLoop();
    }
    setPlayWaiting(false);
    updatePlayBtn();
    resetVolume();
  });

  wavesurfer.on('interaction', () => {
    if (!previewActive) return;
    const t = wavesurfer.getCurrentTime();
    const cuts = computeCuts();
    const hit = findCutContaining(t, cuts);
    if (hit) fadeJump(hit[1]);
  });

  regionPlugin.on('region-clicked', (region, e) => {
    e.stopPropagation();
    scrollToItem(region.id);
    const p = DATA.proposals.find((x) => x.id === region.id);
    if (p) playEscuchar(p);
  });

  $('btnPlay').addEventListener('click', async () => {
    if (!wavesurfer) return;
    resetVolume();
    if (wavesurfer.isPlaying()) {
      wavesurfer.pause();
      updatePlayBtn();
      return;
    }
    if (!audioReady) {
      toast('Espera a que termine de cargar el audio…');
      return;
    }
    if ($('previewAll')?.checked) {
      startFullPreview(wavesurfer.getCurrentTime());
      await safePlay();
    } else {
      playMode = null;
      stopAt = null;
      previewActive = false;
      stopSkipLoop();
      await safePlay();
    }
  });

  $('btnStop').addEventListener('click', () => {
    hardStop();
    if (wavesurfer) wavesurfer.setTime(0);
  });

  $('previewAll').addEventListener('change', async (e) => {
    resetVolume();
    if (e.target.checked) {
      if (!audioReady) {
        e.target.checked = false;
        toast('Espera a que termine de cargar el audio…');
        return;
      }
      startFullPreview(0);
      await safePlay();
    } else {
      hardStop();
    }
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

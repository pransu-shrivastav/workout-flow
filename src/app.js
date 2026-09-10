/**
 * Workout Flow v2.1 — main application module.
 *
 * New in this version:
 *  - Muscle-group colour bands on exercise cards
 *  - Undo toast after complete / skip
 *  - Replace exercise mid-workout (searchable picker)
 *  - Personal records section in History
 *  - Archive behaviour for exercises (hide without deleting)
 *  - Set-level rest timer, add/remove sets, elapsed timer
 *  - End-of-workout review modal, wake lock, PWA install button
 */

import {
  initState, saveState, getState, getSaveStatus, onSaveStatus,
  normalize, phase, completedCount, skippedCount,
  latestCompletedSet, latestCompletedExercise,
  latestCompletedSessionForExercise, personalRecord,
  makeDraft, makeSeedTemplates,
} from './state.js';
import { idbActive, lastWriteOk, lastWriteTime } from './storage.js';
import { unlockAudio, alertComplete } from './audio.js';

// ─── DOM helpers ──────────────────────────────────────────────────────────────

const $  = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = v =>
  String(v ?? '').replace(/[&<>"]/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtTime = s => {
  const m = Math.floor(s / 60), sec = s % 60;
  return `${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
};

// ─── Runtime state ────────────────────────────────────────────────────────────

let _restTimerId    = null;
let _elapsedId      = null;
let _wakeLock       = null;
let _installPrompt  = null;
let _undoTimeout    = null;
let _timerPaused    = false;
let _timerPausedAt  = 0;
let _timerTotal     = 0;   // total seconds for the current timer (for ring calc)
let _calYear        = null;
let _calMonth       = null;

// ─── Calorie estimation ───────────────────────────────────────────────────────

/**
 * Estimate calories burned using MET × weight × duration.
 * MET is scaled by average RPE of completed sets.
 * Returns null if weight is unknown.
 */
function estimateCalories(session, weightKg) {
  if (!weightKg || weightKg <= 0) return null;

  const completedRpes = [];
  Object.values(session.exercises || {}).forEach(ex => {
    if (ex.status === 'completed') {
      (ex.sets || []).filter(s => s.done && s.rpe).forEach(s => completedRpes.push(s.rpe));
    }
  });

  const avgRpe = completedRpes.length
    ? completedRpes.reduce((a, b) => a + b, 0) / completedRpes.length
    : 7;

  // MET values for resistance training by intensity
  let met;
  if (avgRpe <= 5)      met = 3.5;
  else if (avgRpe <= 7) met = 5.0;
  else if (avgRpe <= 9) met = 6.5;
  else                  met = 8.0;

  const startMs = new Date(session.date).getTime();
  const endMs   = new Date(session.completedAt || session.date).getTime();
  const hours   = Math.max(0.1, (endMs - startMs) / 3_600_000);

  return Math.round(met * weightKg * hours);
}

// ─── Muscle-group helper ──────────────────────────────────────────────────────

function getMuscleGroup(exercise) {
  const text = `${exercise.muscles || ''} ${exercise.tags || ''} ${exercise.name || ''}`.toLowerCase();
  if (/quad|glute|hamstring|lunge|squat|rdl|split squat|deadlift|hinge|leg/.test(text)) return 'legs';
  if (/chest|tricep|press|push.up|floor press|bench/.test(text)) return 'push';
  if (/back|bicep|lat|row|pull.up|chin|pulldown|deadhang/.test(text)) return 'pull';
  if (/core|oblique|ab|pallof|deadbug|plank|anti.rot/.test(text)) return 'core';
  if (/shoulder|delt|face pull|overhead/.test(text)) return 'shoulder';
  return 'general';
}

// ─── Navigation ───────────────────────────────────────────────────────────────

function show(viewId, persist = true) {
  const st = getState();
  st.lastView = viewId;
  $$('.view').forEach(x => x.classList.toggle('on', x.id === viewId));
  $$('.nav button').forEach(x => x.classList.toggle('on', x.dataset.view === viewId));
  if (viewId === 'workout') renderWorkout();
  if (viewId === 'history') renderHistory();
  if (viewId === 'more')    renderEditor();
  if (persist) saveState().then(updateSaveStatus);
  scrollTo(0, 0);
}

// ─── Save-status header ───────────────────────────────────────────────────────

function updateSaveStatus() {
  const el = $('#saveStatus');
  if (!el) return;
  const status = getSaveStatus();
  const st = getState();
  if (status === 'saving') {
    el.textContent = 'Saving…'; el.className = 'saved';
  } else if (status === 'saved') {
    const t = st?.lastSaved ? new Date(st.lastSaved).toLocaleTimeString() : '';
    el.textContent = `Saved on device at ${t}`; el.className = 'saved ok';
  } else if (status === 'failed') {
    el.textContent = 'Save failed — export a backup now'; el.className = 'saved err';
  } else if (status === 'unavailable') {
    el.textContent = 'Storage unavailable — data may not persist'; el.className = 'saved err';
  }
}

// ─── Storage diagnostic card ──────────────────────────────────────────────────

function renderStorageCard() {
  const el = $('#storageCard');
  if (!el) return;
  if (!idbActive) {
    el.className = 'card stop';
    el.innerHTML = `<b>Storage unavailable</b>
      <div style="font-size:13px;margin-top:4px">Data may not persist.
        <button class="btn danger" id="emergencyExport" style="margin-top:6px;padding:6px 10px;min-height:34px;font-size:12px">Export backup now</button>
      </div>`;
    $('#emergencyExport')?.addEventListener('click', exportData);
    return;
  }
  if (lastWriteTime === null) {
    el.className = 'storage-badge';
    el.innerHTML = `<span>⏳</span> IndexedDB active · initialising…`;
    return;
  }
  if (!lastWriteOk) {
    el.className = 'card stop';
    el.innerHTML = `<b>Save failed</b>
      <div style="font-size:13px;margin-top:4px">Last write unsuccessful.
        <button class="btn danger" id="emergencyExport" style="margin-top:6px;padding:6px 10px;min-height:34px;font-size:12px">Export backup now</button>
      </div>`;
    $('#emergencyExport')?.addEventListener('click', exportData);
    return;
  }
  // Healthy — show as compact badge
  el.className = 'storage-badge';
  el.innerHTML = `<span style="color:var(--green)">✓</span> Saved at ${lastWriteTime.toLocaleTimeString()}`;
}

// ─── Theme ────────────────────────────────────────────────────────────────────

function applyTheme() {
  const st = getState();
  const t = st.theme === 'system'
    ? (matchMedia('(prefers-color-scheme:dark)').matches ? 'dark' : 'light')
    : st.theme;
  document.documentElement.dataset.theme = t;
}

// ─── Home view ────────────────────────────────────────────────────────────────

function renderHome() {
  const st = getState();
  $('#week').textContent  = st.week;
  $('#phase').textContent = phase(st.week);

  for (const id of ['startTemplate', 'editTemplate']) {
    const sel = $('#' + id);
    if (!sel) continue;
    const prev = sel.value;
    sel.innerHTML = Object.keys(st.templates)
      .map(k => `<option value="${esc(k)}">${esc(k)}</option>`).join('');
    if (st.templates[prev]) sel.value = prev;
  }

  const lenSel = $('#length');
  if (lenSel && st.lastDuration) lenSel.value = String(st.lastDuration);

  const now    = Date.now();
  const recent = st.sessions.filter(s => now - new Date(s.completedAt || s.date) < 7 * 864e5);
  const days7  = st.days.filter(d => now - new Date(d.date) < 7 * 864e5);
  $('#weekSessions').textContent   = recent.length;
  $('#avgSteps').textContent       = days7.length
    ? Math.round(days7.reduce((a, b) => a + (b.steps || 0), 0) / days7.length) : 0;
  $('#completedTotal').textContent = st.sessions.reduce((a, b) => a + completedCount(b), 0);

  // Resume workout card
  const resumeCard = $('#resumeCard');
  if (resumeCard) {
    if (st.draft) {
      const d       = st.draft;
      const curId   = d.order[d.index];
      const exName  = (st.templates[d.template] || []).find(e => e.id === curId)?.name || curId || '—';
      const elapsed = Math.floor((Date.now() - new Date(d.date).getTime()) / 60000);
      resumeCard.classList.remove('hidden');
      resumeCard.innerHTML = `
        <div class="between" style="align-items:center">
          <div>
            <div style="font-size:11px;font-weight:700;color:rgba(255,255,255,.6);text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px">Active workout</div>
            <h3 style="margin:0;color:#fff">Workout ${esc(d.template)}</h3>
            <div style="font-size:13px;color:rgba(255,255,255,.7);margin-top:3px">
              Exercise ${d.index + 1} of ${d.order.length} · ${elapsed} min elapsed
            </div>
            <div style="font-size:13px;color:rgba(255,255,255,.85);margin-top:1px;font-weight:600">${esc(exName)}</div>
          </div>
          <button id="resumeWorkoutBtn" class="btn" style="background:rgba(255,255,255,.2);color:#fff;border:1px solid rgba(255,255,255,.3);flex-shrink:0">
            Resume →
          </button>
        </div>`;
      resumeCard.querySelector('#resumeWorkoutBtn').addEventListener('click', () => show('workout'));
    } else {
      resumeCard.classList.add('hidden');
    }
  }

  // Disable Delete button for seed templates
  const deleteBtn = $('#deleteTemplate');
  if (deleteBtn) {
    const currentTmpl = $('#editTemplate')?.value;
    deleteBtn.disabled = Object.keys(makeSeedTemplates()).includes(currentTmpl);
  }

  renderStorageCard();
}

// ─── Elapsed workout timer ────────────────────────────────────────────────────

function startElapsedTimer() {
  if (_elapsedId) return;
  _elapsedId = setInterval(() => {
    const st = getState();
    if (!st?.draft) { stopElapsedTimer(); return; }
    const secs = Math.floor((Date.now() - new Date(st.draft.date).getTime()) / 1000);
    const el = $('#elapsedTime');
    if (el) el.textContent = fmtTime(secs);
  }, 1000);
}

function stopElapsedTimer() {
  clearInterval(_elapsedId); _elapsedId = null;
  const el = $('#elapsedTime'); if (el) el.textContent = '00:00';
}

// ─── Wake lock ────────────────────────────────────────────────────────────────

async function requestWakeLock() {
  try { if ('wakeLock' in navigator) _wakeLock = await navigator.wakeLock.request('screen'); }
  catch { /* not supported */ }
}
function releaseWakeLock() { _wakeLock?.release().catch(() => {}); _wakeLock = null; }

// ─── Undo toast ───────────────────────────────────────────────────────────────

function showUndoToast(message, undoFn) {
  clearTimeout(_undoTimeout);
  document.querySelector('.undo-toast')?.remove();

  const toast = document.createElement('div');
  toast.className = 'undo-toast';

  const span = document.createElement('span');
  span.textContent = message;

  const btn = document.createElement('button');
  btn.className = 'btn';
  btn.style.cssText = 'padding:4px 12px;min-height:30px;font-size:12px;background:rgba(255,255,255,.18);color:#fff;border:1px solid rgba(255,255,255,.25)';
  btn.textContent = 'Undo';
  btn.addEventListener('click', () => {
    clearTimeout(_undoTimeout);
    toast.remove();
    undoFn();
  });

  toast.appendChild(span);
  toast.appendChild(btn);
  document.body.appendChild(toast);

  _undoTimeout = setTimeout(() => toast.remove(), 5000);
}

// ─── Workout flow ─────────────────────────────────────────────────────────────

function currentExercise() {
  const st = getState();
  if (!st.draft) return null;
  const id  = st.draft.order[st.draft.index];
  if (!id) return null;
  const e   = (st.templates[st.draft.template] || []).find(x => x.id === id);
  const log = st.draft.exercises[id];
  return (e && log) ? { id, e, log } : null;
}

function renderWorkout() {
  const st = getState();
  const d  = st.draft;
  const actionBar = $('#workoutActionBar');

  if (!d) {
    $('#flowTitle').textContent  = 'No active workout';
    $('#flowStep').textContent   = 'Start a workout from Home.';
    $('#exerciseCard').innerHTML = '';
    actionBar?.classList.add('hidden');
    stopRestTimer(); stopElapsedTimer();
    return;
  }

  startElapsedTimer();

  if (d.index >= d.order.length) {
    $('#flowTitle').textContent = `Workout ${d.template} — done!`;
    $('#flowStep').textContent  = `All ${d.order.length} exercises finished`;
    $('#flowBar').style.width   = '100%';
    $('#exerciseCard').innerHTML =
      `<div class="card notice"><b>All exercises finished.</b> Press <em>Finish</em> to review and save.</div>`;
    actionBar?.classList.remove('hidden');
    $('#completeExercise').classList.add('hidden');
    $('#skipExercise').classList.add('hidden');
    return;
  }

  $('#completeExercise').classList.remove('hidden');
  $('#skipExercise').classList.remove('hidden');
  actionBar?.classList.remove('hidden');

  const cur = currentExercise();
  if (!cur) {
    d.exercises[d.order[d.index]] = { status: 'not_attempted', sets: [] };
    d.index++;
    renderWorkout();
    return;
  }

  const { id, e, log } = cur;
  const group = getMuscleGroup(e);

  $('#flowTitle').textContent = `Workout ${d.template}`;
  $('#flowStep').textContent  = `Exercise ${d.index + 1} of ${d.order.length} · ${phase(d.week)}`;
  $('#flowBar').style.width   = (d.index / d.order.length * 100) + '%';

  // Previous performance with provenance label
  const prevSession = latestCompletedSessionForExercise(st, d.template, id);
  const prevEx      = prevSession?.exercises?.[id];
  const prevDate    = prevSession?.completedAt
    ? new Date(prevSession.completedAt).toLocaleDateString(undefined, { month:'short', day:'numeric' })
    : null;

  let prevHTML = '';
  if (prevEx?.sets?.length) {
    prevHTML = `<div class="prev-label">${prevDate ? `From ${prevDate}` : 'Last session'}</div>` +
      prevEx.sets.map((s, i) =>
        `Set ${i + 1}: <b>${s.reps}</b> reps${s.load ? ` · ${esc(s.load)}` : ''} @ RPE <b>${s.rpe}</b>`
      ).join('<br>');
  } else {
    prevHTML = '<div class="prev-label">No history — template defaults prefilled</div>';
  }

  const isPullup    = id === 'pullup' || (e.tags || '').includes('pull-up');
  const pullupBadge = isPullup ? `<span class="pill pullup-pill">🏋 Pull-up block</span>` : '';

  const card = document.createElement('div');
  card.className = 'card ex-card';
  card.dataset.group = group;
  card.innerHTML = `
    <div class="between" style="margin-bottom:6px">
      <h2 style="margin:0;font-size:17px">${esc(e.name)}</h2>
      <button class="btn ghost" id="replaceBtn" style="padding:5px 10px;min-height:32px;font-size:12px">Replace</button>
    </div>
    <div style="margin-bottom:8px">
      <span class="pill">${esc(e.equip)}</span>
      <span class="pill">${log.sets.length} sets · ${e.rest}s rest</span>
      ${pullupBadge}
    </div>
    ${e.instructions
      ? `<details style="margin-bottom:8px">
           <summary style="font-size:12px;color:var(--muted);cursor:pointer;user-select:none">
             <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-right:4px"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
             Instructions
           </summary>
           <div class="instructions">${esc(e.instructions)}</div>
         </details>`
      : ''}
    <div class="previous">${prevHTML}</div>
    <div id="setsHost"></div>
    <div class="set-controls">
      <button class="btn ghost" id="addSetBtn">+ Set</button>
      <button class="btn danger" id="removeSetBtn">− Set</button>
    </div>`;

  $('#exerciseCard').replaceChildren(card);

  const setsHost = card.querySelector('#setsHost');
  renderSets(setsHost, id, e, log);

  card.querySelector('#replaceBtn').addEventListener('click', () => openReplacePicker());

  card.querySelector('#addSetBtn').addEventListener('click', () => {
    const last = log.sets[log.sets.length - 1];
    log.sets.push({
      reps: last?.reps ?? e.defaultReps ?? 10,
      load: last?.load ?? e.equip ?? '',
      rpe:  last?.rpe  ?? e.defaultRpe  ?? 7,
      done: false,
    });
    renderSets(setsHost, id, e, log);
    saveState(false);
  });

  card.querySelector('#removeSetBtn').addEventListener('click', () => {
    if (log.sets.length <= 1) return;
    log.sets.pop();
    renderSets(setsHost, id, e, log);
    saveState(false);
  });
}

function renderSets(host, exId, e, log) {
  host.innerHTML = '';
  log.sets.forEach((s, i) => {
    const card = document.createElement('div');
    card.className = 'set-card' + (s.done ? ' done' : '');

    if (s.done) {
      // Collapsed summary — tap Edit to reopen
      card.innerHTML = `
        <div class="set-card-summary">
          <div class="set-card-check">✓</div>
          <div class="set-card-summary-text">
            Set ${i + 1} — <b>${s.reps}</b> reps${s.load ? ` · ${esc(s.load)}` : ''} · RPE <b>${s.rpe}</b>
          </div>
          <button class="set-edit-btn">Edit</button>
        </div>`;
      card.querySelector('.set-edit-btn').addEventListener('click', () => {
        s.done = false;
        renderSets(host, exId, e, log);
        saveState(false);
      });
    } else {
      // Expanded input form with large "Mark done" button
      card.innerHTML = `
        <div class="set-card-header">
          <span class="set-card-num">Set ${i + 1}</span>
          <button class="set-done-btn">Mark done ✓</button>
        </div>
        <div class="set-card-inputs">
          <div class="set-field">
            <label>Reps</label>
            <input type="number" inputmode="numeric" min="0" value="${s.reps}">
          </div>
          <div class="set-field">
            <label>Load</label>
            <input value="${esc(s.load)}">
          </div>
          <div class="set-field">
            <label>RPE</label>
            <input type="number" inputmode="numeric" min="1" max="10" value="${s.rpe}">
          </div>
        </div>`;

      const [repsIn, loadIn, rpeIn] = card.querySelectorAll('input');
      const doneBtn = card.querySelector('.set-done-btn');

      const write = () => {
        s.reps = Number(repsIn.value) || e.defaultReps || 10;
        s.load = loadIn.value;
        s.rpe  = Number(rpeIn.value) || e.defaultRpe || 7;
        saveState(false);
      };

      [repsIn, loadIn, rpeIn].forEach(inp => inp.addEventListener('change', write));

      doneBtn.addEventListener('click', () => {
        // Capture current values before collapsing
        s.reps = Number(repsIn.value) || e.defaultReps || 10;
        s.load = loadIn.value;
        s.rpe  = Number(rpeIn.value) || e.defaultRpe || 7;
        s.done = true;
        startRestTimer(e.rest, e.name, i + 1);
        renderSets(host, exId, e, log);
        saveState(false);
      });
    }

    host.appendChild(card);
  });
}

function advanceExercise(status) {
  const st  = getState();
  const cur = currentExercise();
  if (!cur) return;
  const { id, e, log } = cur;

  if (status === 'completed' && !log.sets.some(s => s.done)) {
    alert('Complete at least one set first, or choose Skip.');
    return;
  }

  // Save snapshot for undo
  const savedIndex  = st.draft.index;
  const savedStatus = log.status;
  const savedDone   = log.sets.map(s => s.done);

  log.status = status;
  if (status === 'skipped') log.sets.forEach(s => { s.done = false; });

  st.draft.index++;
  saveState().then(updateSaveStatus);
  renderWorkout();

  // Show undo toast
  const label = status === 'completed' ? 'Exercise completed' : 'Exercise skipped';
  showUndoToast(label, () => {
    // Restore
    st.draft.index = savedIndex;
    log.status = savedStatus;
    log.sets.forEach((s, i) => { s.done = savedDone[i]; });
    stopRestTimer();
    saveState().then(updateSaveStatus);
    renderWorkout();
  });
}

// ─── Replace exercise picker ──────────────────────────────────────────────────

function openReplacePicker() {
  const st = getState();
  const d  = st.draft;
  if (!d) return;
  const cur = currentExercise();
  if (!cur) return;
  const curId = cur.id;

  // Collect all non-archived exercises from all templates (deduplicated)
  const seen = new Set([curId]);
  const allExercises = [];
  for (const [tmplKey, exercises] of Object.entries(st.templates)) {
    for (const e of exercises) {
      if (!e.archived && !seen.has(e.id)) {
        seen.add(e.id);
        allExercises.push({ ...e, _template: tmplKey });
      }
    }
  }

  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  modal.innerHTML = `
    <div class="modal-box">
      <div class="between" style="margin-bottom:12px">
        <h3 style="margin:0">Replace exercise</h3>
        <button class="btn ghost" id="closeReplace" style="padding:6px 10px;min-height:36px">✕</button>
      </div>
      <input type="search" id="replaceSearch" placeholder="Search exercises…" style="margin-bottom:8px">
      <div id="replaceList" style="max-height:55vh;overflow-y:auto"></div>
    </div>`;
  document.body.appendChild(modal);

  const renderList = (q = '') => {
    const host = modal.querySelector('#replaceList');
    const filtered = allExercises.filter(e =>
      `${e.name} ${e.equip} ${e.tags || ''}`.toLowerCase().includes(q.toLowerCase())
    ).slice(0, 30);

    if (!filtered.length) {
      host.innerHTML = '<div class="empty">No exercises found.</div>';
      return;
    }

    host.innerHTML = filtered.map(e => `
      <div class="row between" data-replace-id="${esc(e.id)}" data-replace-tmpl="${esc(e._template)}">
        <div>
          <b style="font-size:14px">${esc(e.name)}</b>
          <div style="font-size:12px;color:var(--muted)">${esc(e.equip)}</div>
        </div>
        <button class="btn ghost" style="padding:6px 10px;min-height:36px;font-size:12px;flex-shrink:0">Select</button>
      </div>`).join('');

    host.querySelectorAll('[data-replace-id]').forEach(row => {
      row.querySelector('button').addEventListener('click', () => {
        const newId   = row.dataset.replaceId;
        const newTmpl = row.dataset.replaceTmpl;
        const newEx   = st.templates[newTmpl]?.find(e => e.id === newId);
        if (!newEx) return;

        const idx   = d.index;
        const oldId = d.order[idx];
        d.order[idx] = newId;
        delete d.exercises[oldId];

        const setCount = st.week === 1 ? Math.min(2, newEx.sets) : newEx.sets;
        d.exercises[newId] = {
          status: 'pending',
          sets: Array.from({ length: setCount }, (_, i) => {
            const prev = latestCompletedSet(st, d.template, newId, i);
            return {
              reps: prev?.reps ?? newEx.defaultReps ?? 10,
              load: prev?.load ?? newEx.equip ?? '',
              rpe:  prev?.rpe  ?? newEx.defaultRpe  ?? 7,
              done: false,
            };
          }),
        };

        saveState().then(updateSaveStatus);
        renderWorkout();
        modal.remove();
      });
    });
  };

  renderList();
  modal.querySelector('#replaceSearch').addEventListener('input', e => renderList(e.target.value));
  modal.querySelector('#closeReplace').addEventListener('click', () => modal.remove());
}

// ─── Workout finish ───────────────────────────────────────────────────────────

function showWorkoutReview() {
  const st = getState();
  const d  = st.draft;
  if (!d) return;

  const completed    = d.order.filter(id => d.exercises[id]?.status === 'completed');
  const skipped      = d.order.filter(id => d.exercises[id]?.status === 'skipped');
  const notAttempted = d.order.filter(id =>
    d.exercises[id]?.status === 'pending' || d.exercises[id]?.status === 'not_attempted');
  const totalSets    = completed.reduce((acc, id) =>
    acc + (d.exercises[id]?.sets || []).filter(s => s.done).length, 0);
  const elapsedMin   = Math.round((Date.now() - new Date(d.date).getTime()) / 60000);

  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  modal.innerHTML = `
    <div class="modal-box">
      <h3>🏁 Workout complete</h3>
      <div style="font-size:13px;color:var(--muted);margin-bottom:12px">
        Workout ${esc(d.template)} · Week ${d.week} · ${elapsedMin} min
      </div>
      <div class="review-grid">
        <div class="review-item"><b>${completed.length}</b><span>Completed</span></div>
        <div class="review-item"><b>${totalSets}</b><span>Sets done</span></div>
        <div class="review-item"><b>${skipped.length}</b><span>Skipped</span></div>
      </div>
      ${notAttempted.length
        ? `<div style="font-size:12px;color:var(--muted);margin-bottom:10px">
             ${notAttempted.length} exercise${notAttempted.length > 1 ? 's' : ''} not reached
           </div>` : ''}
      <label>Workout notes</label>
      <textarea id="reviewNotes" rows="3" placeholder="How did it go? Any PRs or notes…">${esc(d.notes || '')}</textarea>
      <div class="buttons" style="margin-top:14px">
        <button class="btn green full" id="confirmSave">Save workout</button>
        <button class="btn ghost full"  id="cancelReview">Keep editing</button>
      </div>
    </div>`;
  document.body.appendChild(modal);

  modal.querySelector('#confirmSave').addEventListener('click', () => {
    d.notes = modal.querySelector('#reviewNotes').value;
    modal.remove();
    _commitFinish();
  });
  modal.querySelector('#cancelReview').addEventListener('click', () => modal.remove());
}

function finishWorkout() {
  const st = getState();
  const d  = st.draft;
  if (!d) return;
  const hasCompleted = Object.values(d.exercises).some(x => x.status === 'completed');
  if (!hasCompleted && !confirm('No exercises were completed. Save this workout anyway?')) return;
  for (let i = d.index; i < d.order.length; i++) {
    const x = d.exercises[d.order[i]];
    if (x && x.status === 'pending') x.status = 'not_attempted';
  }
  showWorkoutReview();
}

function _commitFinish() {
  const st = getState();
  const d  = st.draft;
  if (!d) return;
  d.completedAt = new Date().toISOString();
  d.status      = 'completed';
  st.sessions.push(d);
  st.draft = null;
  stopRestTimer(); stopElapsedTimer(); releaseWakeLock();
  $('#workoutActionBar')?.classList.add('hidden');
  saveState().then(updateSaveStatus);
  show('history');
}

function discardWorkout() {
  if (!confirm('Discard the active workout? All progress will be lost.')) return;
  const st = getState();
  st.draft = null;
  stopRestTimer(); stopElapsedTimer(); releaseWakeLock();
  $('#workoutActionBar')?.classList.add('hidden');
  saveState().then(updateSaveStatus);
  show('home');
}

// ─── Circular rest timer ─────────────────────────────────────────────────────

const RING_R          = 85;
const RING_CIRCUMF    = 2 * Math.PI * RING_R; // ≈ 534

function _updateRing(remaining) {
  const prog = $('#timerRingProg');
  const dot  = $('#timerRingDot');
  if (!prog || !dot) return;

  const fraction = _timerTotal > 0 ? remaining / _timerTotal : 0;
  const offset   = RING_CIRCUMF * (1 - fraction);
  prog.style.strokeDashoffset = offset;

  // The SVG is rotated -90° via CSS so the arc starts at 12 o'clock visually.
  // In SVG coordinates the arc starts at 3 o'clock (angle 0).
  // The dot must follow the arc end-point in SVG coordinates.
  const angle = fraction * 2 * Math.PI;   // clockwise from 3 o'clock in SVG space
  const cx    = 100 + RING_R * Math.cos(angle);
  const cy    = 100 + RING_R * Math.sin(angle);
  dot.setAttribute('cx', cx.toFixed(2));
  dot.setAttribute('cy', cy.toFixed(2));
}

function startRestTimer(seconds, exerciseName, setNum) {
  const st = getState();
  if (!st.draft) return;
  _timerTotal  = seconds;
  _timerPaused = false;
  st.draft.timerEndsAt   = Date.now() + seconds * 1000;
  st.draft._timerContext = `After ${esc(exerciseName)} set ${setNum}`;
  clearInterval(_restTimerId);
  $('#timer').classList.add('on');
  _updateRing(seconds);
  tickRestTimer();
  _restTimerId = setInterval(tickRestTimer, 250);
}

function stopRestTimer() {
  clearInterval(_restTimerId); _restTimerId = null;
  _timerPaused = false;
  $('#timer').classList.remove('on');
  const pauseBtn = $('#timerPause');
  if (pauseBtn) pauseBtn.textContent = '⏸';
  const st = getState();
  if (st?.draft) { st.draft.timerEndsAt = null; st.draft._timerContext = null; }
}

function tickRestTimer() {
  if (_timerPaused) return;
  const st     = getState();
  const endsAt = st?.draft?.timerEndsAt;
  if (!endsAt) { stopRestTimer(); return; }
  const remaining = Math.max(0, Math.ceil((endsAt - Date.now()) / 1000));
  $('#timerText').textContent = fmtTime(remaining);
  $('#timerSub').textContent  = st.draft._timerContext || '';
  _updateRing(remaining);
  if (remaining === 0) {
    clearInterval(_restTimerId); _restTimerId = null;
    $('#timer').classList.remove('on');
    if (st.draft) { st.draft.timerEndsAt = null; st.draft._timerContext = null; }
    alertComplete(st.audioEnabled, st.vibrationEnabled);
  }
}

function restoreRestTimer() {
  const st = getState();
  if (!st?.draft?.timerEndsAt) return;
  const remaining = st.draft.timerEndsAt - Date.now();
  if (remaining <= 0) {
    st.draft.timerEndsAt = null; st.draft._timerContext = null;
    $('#timerText').textContent = 'Done';
    $('#timerSub').textContent  = 'Rest period ended';
    $('#timer').classList.add('on');
    setTimeout(() => $('#timer').classList.remove('on'), 2500);
    return;
  }
  clearInterval(_restTimerId);
  $('#timer').classList.add('on');
  tickRestTimer();
  _restTimerId = setInterval(tickRestTimer, 250);
}

// ─── Daily log ────────────────────────────────────────────────────────────────

function renderDailyList() {
  const st   = getState();
  const host = $('#dailyList');
  if (!host) return;
  const rows = st.days.slice(-14).reverse();
  if (!rows.length) {
    host.innerHTML = '<div class="empty"><span class="empty-icon">📅</span>No daily logs yet.</div>';
    return;
  }
  host.innerHTML = rows.map(d => {
    const idx   = st.days.indexOf(d);
    const parts = [
      d.steps     ? `${d.steps} steps`          : '',
      d.weight    ? `${d.weight} kg`             : '',
      d.sleep     ? `${d.sleep} h sleep`         : '',
      d.cardioMin ? `${d.cardioMin} min cardio`  : '',
    ].filter(Boolean).join(' · ');
    return `
      <div class="row between">
        <div>
          <b>${d.date}</b>
          <div style="font-size:12px;color:var(--muted)">${parts || 'No data'}</div>
          ${d.notes ? `<div style="font-size:11px;color:var(--muted);margin-top:2px">${esc(d.notes)}</div>` : ''}
        </div>
        <div style="display:flex;gap:6px">
          <button class="btn ghost" data-edit-day="${idx}" style="padding:6px 10px;min-height:36px;font-size:12px">Edit</button>
          <button class="btn danger" data-del-day="${idx}" style="padding:6px 10px;min-height:36px;font-size:12px">✕</button>
        </div>
      </div>`;
  }).join('');

  host.querySelectorAll('[data-del-day]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (confirm('Delete this daily log?')) {
        st.days.splice(Number(btn.dataset.delDay), 1);
        saveState().then(updateSaveStatus);
        renderDailyList(); renderCharts();
      }
    });
  });
  host.querySelectorAll('[data-edit-day]').forEach(btn => {
    btn.addEventListener('click', () => openDayEditor(Number(btn.dataset.editDay)));
  });
}

function openDayEditor(idx) {
  const st = getState();
  const d  = st.days[idx];
  if (!d) return;
  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  modal.innerHTML = `
    <div class="modal-box">
      <div class="between"><h3>Edit daily log</h3>
        <button class="btn ghost" id="closeDayModal">✕</button></div>
      <div class="grid2">
        <div><label>Date</label><input type="date" id="eDayDate" value="${d.date}"></div>
        <div><label>Weight (kg)</label><input type="number" inputmode="decimal" step=".1" id="eDayWeight" value="${d.weight || ''}"></div>
        <div><label>Steps</label><input type="number" inputmode="numeric" id="eDaySteps" value="${d.steps || ''}"></div>
        <div><label>Sleep (h)</label><input type="number" inputmode="decimal" step=".25" id="eDaySleep" value="${d.sleep || ''}"></div>
        <div><label>Cardio (min)</label><input type="number" inputmode="numeric" id="eDayCardio" value="${d.cardioMin || ''}"></div>
        <div><label>Cardio RPE</label><input type="number" inputmode="numeric" min="1" max="10" id="eDayCardioRpe" value="${d.cardioRpe || ''}"></div>
      </div>
      <label>Notes</label>
      <textarea id="eDayNotes" rows="2">${esc(d.notes || '')}</textarea>
      <div class="buttons" style="margin-top:12px">
        <button class="btn primary" id="saveDayEdit">Save</button>
        <button class="btn ghost"   id="closeDayModal2">Cancel</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
  const close = () => modal.remove();
  modal.querySelector('#closeDayModal').addEventListener('click', close);
  modal.querySelector('#closeDayModal2').addEventListener('click', close);
  modal.querySelector('#saveDayEdit').addEventListener('click', () => {
    const newDate = modal.querySelector('#eDayDate').value;
    if (!newDate) return;
    const updated = {
      date:      newDate,
      weight:    Number(modal.querySelector('#eDayWeight').value)    || 0,
      steps:     Number(modal.querySelector('#eDaySteps').value)     || 0,
      sleep:     Number(modal.querySelector('#eDaySleep').value)     || 0,
      cardioMin: Number(modal.querySelector('#eDayCardio').value)    || 0,
      cardioRpe: Number(modal.querySelector('#eDayCardioRpe').value) || 0,
      notes:     modal.querySelector('#eDayNotes').value             || '',
      updatedAt: new Date().toISOString(),
    };
    st.days.splice(idx, 1);
    const existing = st.days.findIndex(x => x.date === newDate);
    if (existing >= 0) st.days[existing] = updated; else st.days.push(updated);
    st.days.sort((a, b) => a.date.localeCompare(b.date));
    saveState().then(updateSaveStatus);
    renderDailyList(); renderCharts(); close();
  });
}

function saveDaily() {
  const st   = getState();
  const date = $('#dayDate').value;
  if (!date) return;
  const entry = {
    date,
    steps:     Number($('#daySteps').value)     || 0,
    weight:    Number($('#dayWeight').value)    || 0,
    sleep:     Number($('#daySleep').value)     || 0,
    cardioMin: Number($('#dayCardio').value)    || 0,
    cardioRpe: Number($('#dayCardioRpe').value) || 0,
    notes:     $('#dayNotes').value             || '',
    updatedAt: new Date().toISOString(),
  };
  const idx = st.days.findIndex(d => d.date === date);
  if (idx >= 0) st.days[idx] = entry; else st.days.push(entry);
  st.days.sort((a, b) => a.date.localeCompare(b.date));
  ['#daySteps','#dayWeight','#daySleep','#dayCardio','#dayCardioRpe'].forEach(id => {
    const el = $(id); if (el) el.value = '';
  });
  const notesEl = $('#dayNotes'); if (notesEl) notesEl.value = '';
  saveState().then(updateSaveStatus);
  renderDailyList(); renderCharts();
}

// ─── Personal records ─────────────────────────────────────────────────────────

function renderPersonalRecords() {
  const st   = getState();
  const host = $('#recordsList');
  if (!host) return;

  const exerciseIds = new Set();
  st.sessions.forEach(s =>
    Object.entries(s.exercises || {}).forEach(([id, ex]) => {
      if (ex.status === 'completed') exerciseIds.add(id);
    })
  );

  if (!exerciseIds.size) {
    host.innerHTML = '<div class="empty"><span class="empty-icon">🏆</span>Complete workouts to see your records.</div>';
    return;
  }

  const records = [...exerciseIds].map(id => {
    let name = id;
    for (const tmpl of Object.values(st.templates)) {
      const found = tmpl.find(e => e.id === id);
      if (found) { name = found.name; break; }
    }
    return { id, name, pr: personalRecord(st, id) };
  }).filter(r => r.pr).sort((a, b) => a.name.localeCompare(b.name));

  if (!records.length) {
    host.innerHTML = '<div class="empty">No records yet.</div>';
    return;
  }

  host.innerHTML = records.map(r => `
    <div class="pr-row">
      <div class="pr-icon">🏆</div>
      <div style="flex:1;min-width:0">
        <b style="font-size:14px">${esc(r.name)}</b>
        <div style="font-size:12px;color:var(--muted)">
          ${r.pr.total} total reps · ${new Date(r.pr.date).toLocaleDateString()}
        </div>
      </div>
      <span class="pill pr-pill">${r.pr.total} reps</span>
    </div>`).join('');
}

// ─── History view ─────────────────────────────────────────────────────────────

function renderHistory() {
  const st = getState();
  $('#historySummary').innerHTML =
    `<b>${st.sessions.length} saved workouts.</b> Skipped and not-attempted exercises are excluded from totals.`;

  renderCalendar();
  renderPersonalRecords();
  renderCharts();

  const host = $('#sessionList');
  if (!host) return;
  if (!st.sessions.length) {
    host.innerHTML = '<div class="empty"><span class="empty-icon">📊</span>No workouts saved yet.</div>';
    return;
  }

  host.innerHTML = [...st.sessions].reverse().map((s, ri) => {
    const i    = st.sessions.length - 1 - ri;
    const date = s.completedAt
      ? new Date(s.completedAt).toLocaleDateString()
      : new Date(s.date).toLocaleDateString();
    const totalSets = Object.values(s.exercises || {})
      .filter(x => x.status === 'completed')
      .reduce((a, ex) => a + (ex.sets || []).filter(s => s.done).length, 0);
    return `
      <div class="row between">
        <div>
          <b>${date} · Workout ${esc(s.template)}</b>
          <div style="font-size:12px;color:var(--muted)">
            Week ${s.week} · ${completedCount(s)} exercises · ${totalSets} sets
            ${skippedCount(s) ? ` · ${skippedCount(s)} skipped` : ''}
          </div>
          ${s.notes ? `<div style="font-size:11px;color:var(--muted);margin-top:2px">${esc(s.notes)}</div>` : ''}
        </div>
        <div class="buttons" style="margin:0">
          <button class="btn ghost" data-edit-session="${i}" style="padding:6px 10px;min-height:36px;font-size:12px">Edit</button>
          <button class="btn danger" data-del-session="${i}" style="padding:6px 10px;min-height:36px;font-size:12px">✕</button>
        </div>
      </div>`;
  }).join('');

  host.querySelectorAll('[data-del-session]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (confirm('Delete this workout?')) {
        st.sessions.splice(Number(btn.dataset.delSession), 1);
        saveState().then(updateSaveStatus); renderHistory();
      }
    });
  });
  host.querySelectorAll('[data-edit-session]').forEach(btn => {
    btn.addEventListener('click', () => openSessionEditor(Number(btn.dataset.editSession)));
  });
}

function openSessionEditor(idx) {
  const st = getState();
  const s  = st.sessions[idx];
  if (!s) return;
  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  modal.innerHTML = `
    <div class="modal-box">
      <div class="between"><h3>Edit workout</h3>
        <button class="btn ghost" id="closeModal">✕</button></div>
      <label>Date</label>
      <input type="date" id="editDate" value="${(s.completedAt || s.date).slice(0, 10)}">
      <label>Notes</label>
      <textarea id="editNotes" rows="2">${esc(s.notes || '')}</textarea>
      <div id="editExercises"></div>
      <div class="buttons" style="margin-top:12px">
        <button class="btn primary" id="saveSession">Save changes</button>
        <button class="btn ghost"   id="closeModal2">Cancel</button>
      </div>
    </div>`;
  document.body.appendChild(modal);

  const exHost = modal.querySelector('#editExercises');
  Object.entries(s.exercises).forEach(([exId, exData]) => {
    if (exData.status !== 'completed') return;
    const section = document.createElement('div');
    section.className = 'editor';
    section.innerHTML = `<b style="font-size:13px">${esc(exId)}</b>`;
    exData.sets.forEach((set, j) => {
      const row = document.createElement('div');
      row.className = 'set';
      row.innerHTML = `
        <div class="setno">${j + 1}</div>
        <div><small>Reps</small><input type="number" inputmode="numeric" value="${set.reps}"></div>
        <div><small>Load</small><input value="${esc(set.load || '')}"></div>
        <div><small>RPE</small><input type="number" inputmode="numeric" min="1" max="10" value="${set.rpe}"></div>
        <div></div>`;
      section.appendChild(row);
      const [rIn, lIn, rpeIn] = row.querySelectorAll('input');
      rIn.addEventListener('change',   () => { set.reps = Number(rIn.value)   || set.reps; });
      lIn.addEventListener('change',   () => { set.load = lIn.value; });
      rpeIn.addEventListener('change', () => { set.rpe  = Number(rpeIn.value) || set.rpe; });
    });
    exHost.appendChild(section);
  });

  const close = () => modal.remove();
  modal.querySelector('#closeModal').addEventListener('click', close);
  modal.querySelector('#closeModal2').addEventListener('click', close);
  modal.querySelector('#saveSession').addEventListener('click', () => {
    const dateVal = modal.querySelector('#editDate').value;
    if (dateVal) s.completedAt = dateVal + 'T12:00:00';
    s.notes = modal.querySelector('#editNotes').value;
    saveState().then(updateSaveStatus); renderHistory(); close();
  });
}

// ─── Charts ───────────────────────────────────────────────────────────────────

function svgChart(el, data, color, label) {
  if (!el) return;
  if (!data.length) {
    el.innerHTML = '<div class="empty"><span class="empty-icon">📈</span>No data yet.</div>';
    return;
  }
  const W = 600, H = 160, P = 22;
  const max = Math.max(1, ...data.map(d => d.v));
  const x   = i => P + i * (W - 2 * P) / Math.max(1, data.length - 1);
  const y   = v => H - P - (v / max) * (H - 2 * P);
  const pts = data.map((d, i) => `${x(i)},${y(d.v)}`).join(' ');
  // Grid lines
  const gridLines = [0.25, 0.5, 0.75, 1].map(f =>
    `<line x1="${P}" y1="${y(max * f)}" x2="${W - P}" y2="${y(max * f)}" stroke="var(--line)" stroke-width="1"/>`
  ).join('');
  el.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)}">
      ${gridLines}
      <polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>
      <polyline points="${pts} ${W - P},${H - P} ${P},${H - P}" fill="${color}" fill-opacity=".08" stroke="none"/>
      ${data.map((d, i) => `
        <circle cx="${x(i)}" cy="${y(d.v)}" r="4" fill="${color}" stroke="var(--card)" stroke-width="2">
          <title>${esc(d.l)}: ${d.v}</title>
        </circle>`).join('')}
    </svg>`;
}

function renderCharts() {
  const st = getState();
  svgChart($('#weightChart'),
    st.days.filter(d => d.weight).map(d => ({ l: d.date, v: d.weight })).slice(-30),
    '#3b82f6', 'Body weight');
  svgChart($('#stepsChart'),
    st.days.filter(d => d.steps).map(d => ({ l: d.date, v: d.steps })).slice(-30),
    '#10b981', 'Daily steps');
  svgChart($('#strengthChart'),
    st.sessions.map(s => ({
      l: new Date(s.completedAt || s.date).toLocaleDateString(),
      v: completedCount(s),
    })).slice(-20), '#8b5cf6', 'Exercises per session');

  const pullupData = st.sessions
    .filter(s => s.exercises?.pullup?.status === 'completed')
    .map(s => ({
      l: new Date(s.completedAt || s.date).toLocaleDateString(),
      v: (s.exercises.pullup.sets || []).filter(x => x.done).reduce((a, b) => a + (b.reps || 0), 0),
    })).filter(d => d.v > 0).slice(-20);
  svgChart($('#pullupChart'), pullupData, '#f97316', 'Pull-up volume');

  renderExerciseChart();
}

function renderExerciseChart() {
  const st  = getState();
  const sel = $('#exerciseChartSelect');
  if (!sel) return;

  const exerciseIds = new Set();
  st.sessions.forEach(s =>
    Object.entries(s.exercises || {}).forEach(([id, ex]) => {
      if (ex.status === 'completed') exerciseIds.add(id);
    })
  );

  const prev = sel.value;
  sel.innerHTML = '<option value="">— select exercise —</option>' +
    [...exerciseIds].map(id => {
      let name = id;
      for (const tmpl of Object.values(st.templates)) {
        const found = tmpl.find(e => e.id === id);
        if (found) { name = found.name; break; }
      }
      return `<option value="${esc(id)}">${esc(name)}</option>`;
    }).join('');
  if (exerciseIds.has(prev)) sel.value = prev;

  const exId    = sel.value;
  const chartEl = $('#exerciseChartCanvas');
  if (!chartEl) return;
  if (!exId) { chartEl.innerHTML = '<div class="empty"><span class="empty-icon">📈</span>Select an exercise above.</div>'; return; }

  const data = st.sessions
    .filter(s => s.exercises?.[exId]?.status === 'completed')
    .map(s => ({
      l: new Date(s.completedAt || s.date).toLocaleDateString(),
      v: (s.exercises[exId].sets || []).filter(x => x.done).reduce((a, b) => a + (b.reps || 0), 0),
    })).filter(d => d.v > 0).slice(-20);

  svgChart(chartEl, data, '#ef4444', `${exId} — total reps`);
}

// ─── Template / exercise editor ───────────────────────────────────────────────

function renderEditor() {
  const st           = getState();
  const t            = $('#editTemplate')?.value;
  const q            = ($('#search')?.value || '').toLowerCase();
  const showArchived = $('#showArchived')?.checked || false;
  const host         = $('#editorList');
  if (!host || !t) return;

  host.innerHTML = '';
  const exercises = st.templates[t] || [];

  exercises.forEach((e, i) => {
    if (e.archived && !showArchived) return;
    const searchStr = `${e.name} ${e.equip} ${e.tags || ''} ${e.muscles || ''}`.toLowerCase();
    if (q && !searchStr.includes(q)) return;

    const row = document.createElement('div');
    row.className = 'editor';
    if (e.archived) row.style.opacity = '0.55';

    row.innerHTML = `
      <details>
        <summary>
          <svg class="chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>
          <span class="editor-name">${esc(e.name)}</span>
          <span class="pill" style="font-size:10px">${esc(e.equip)}</span>
          ${e.archived ? '<span class="pill amber" style="font-size:10px">Archived</span>' : ''}
        </summary>
        <div class="grid2" style="margin-top:8px">
          <div><label>Name</label><input class="f-name" value="${esc(e.name)}"></div>
          <div><label>Equipment</label><input class="f-equip" value="${esc(e.equip)}"></div>
          <div><label>Default reps</label><input class="f-reps" type="number" inputmode="numeric" value="${e.defaultReps}"></div>
          <div><label>Default RPE</label><input class="f-rpe" type="number" inputmode="numeric" value="${e.defaultRpe}"></div>
          <div><label>Sets</label><input class="f-sets" type="number" inputmode="numeric" value="${e.sets}"></div>
          <div><label>Rest (seconds)</label><input class="f-rest" type="number" inputmode="numeric" value="${e.rest}"></div>
          <div><label>Primary muscles</label><input class="f-muscles" value="${esc(e.muscles || '')}"></div>
          <div><label>Search tags</label><input class="f-tags" value="${esc(e.tags || '')}"></div>
        </div>
        <div><label>Instructions</label><textarea class="f-instr" rows="2">${esc(e.instructions || '')}</textarea></div>
        <div><label>Progression</label><textarea class="f-prog" rows="2">${esc(e.progression || '')}</textarea></div>
        <div class="buttons">
          <button class="btn green saveEx">Save</button>
          <button class="btn ghost moveUp"   ${i === 0 ? 'disabled' : ''}>↑</button>
          <button class="btn ghost moveDown" ${i === exercises.length - 1 ? 'disabled' : ''}>↓</button>
          <button class="btn amber archiveEx">${e.archived ? 'Unarchive' : 'Archive'}</button>
          <button class="btn danger deleteEx">Delete</button>
        </div>
      </details>`;

    host.appendChild(row);

    row.querySelector('.saveEx').addEventListener('click', async () => {
      Object.assign(e, {
        name:         row.querySelector('.f-name').value,
        equip:        row.querySelector('.f-equip').value,
        defaultReps:  Number(row.querySelector('.f-reps').value)    || 10,
        defaultRpe:   Number(row.querySelector('.f-rpe').value)     || 7,
        sets:         Number(row.querySelector('.f-sets').value)    || 2,
        rest:         Number(row.querySelector('.f-rest').value)    || 60,
        muscles:      row.querySelector('.f-muscles').value,
        tags:         row.querySelector('.f-tags').value,
        instructions: row.querySelector('.f-instr').value,
        progression:  row.querySelector('.f-prog').value,
      });
      await saveState(); updateSaveStatus(); renderEditor();
    });

    row.querySelector('.archiveEx').addEventListener('click', () => {
      e.archived = !e.archived;
      saveState().then(updateSaveStatus); renderEditor();
    });

    row.querySelector('.deleteEx').addEventListener('click', () => {
      if (confirm(`Delete "${e.name}"?`)) {
        st.templates[t].splice(i, 1);
        saveState().then(updateSaveStatus); renderEditor();
      }
    });

    row.querySelector('.moveUp').addEventListener('click', () => {
      if (i > 0) {
        [st.templates[t][i - 1], st.templates[t][i]] = [st.templates[t][i], st.templates[t][i - 1]];
        saveState().then(updateSaveStatus); renderEditor();
      }
    });

    row.querySelector('.moveDown').addEventListener('click', () => {
      if (i < exercises.length - 1) {
        [st.templates[t][i], st.templates[t][i + 1]] = [st.templates[t][i + 1], st.templates[t][i]];
        saveState().then(updateSaveStatus); renderEditor();
      }
    });
  });
}

// ─── Backup / restore ─────────────────────────────────────────────────────────

async function exportData() {
  const st   = getState();
  const text = JSON.stringify({ ...st, _exportedAt: new Date().toISOString(), _appVersion: '2.1' }, null, 2);
  const name = `workout-backup-${new Date().toISOString().slice(0, 10)}.json`;
  const file = new File([text], name, { type: 'application/json' });

  try {
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], title: 'Workout backup' });
      $('#backupStatus').textContent = 'Backup shared.'; return;
    }
  } catch (e) { if (e.name === 'AbortError') return; }

  try {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(file); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(a.href);
    $('#backupStatus').textContent = 'Download started. Check your Downloads folder.'; return;
  } catch { /* blocked */ }

  $('#backupText').value = text;
  $('#copyFallback').classList.add('on');
  $('#backupStatus').textContent = 'Download blocked. Copy the text below.';
}

function importData(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const parsed = JSON.parse(reader.result);
      if (!parsed.templates || !Array.isArray(parsed.sessions)) throw new Error('Invalid schema');
      const summary = `${Object.keys(parsed.templates).length} templates, ${parsed.sessions.length} sessions, ${(parsed.days || []).length} daily logs`;
      if (!confirm(`Import backup?\n\n${summary}\n\nThis will replace all current data.`)) return;
      const st = getState();
      Object.assign(st, normalize(parsed));
      saveState().then(updateSaveStatus); renderAll();
      $('#backupStatus').textContent = 'Backup restored successfully.';
    } catch (err) {
      $('#backupStatus').textContent = `Import failed: ${err.message}`;
    }
    $('#backupFile').value = '';
  };
  reader.readAsText(file);
}

// ─── Activity calendar ────────────────────────────────────────────────────────

function renderCalendar() {
  const st   = getState();
  const host = $('#calendarContainer');
  if (!host) return;

  const now   = new Date();
  const year  = _calYear  ?? now.getFullYear();
  const month = _calMonth ?? now.getMonth();

  // Build activity map: date → { workouts, logs }
  const actMap = {};
  st.sessions.forEach(s => {
    const d = (s.completedAt || s.date).slice(0, 10);
    if (!actMap[d]) actMap[d] = { workouts: [], logs: [] };
    actMap[d].workouts.push(s);
  });
  st.days.forEach(d => {
    if (!actMap[d.date]) actMap[d.date] = { workouts: [], logs: [] };
    actMap[d.date].logs.push(d);
  });

  const firstDay = new Date(year, month, 1);
  const lastDay  = new Date(year, month + 1, 0);
  const today    = new Date().toISOString().slice(0, 10);
  const monthName = firstDay.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

  let html = `
    <div class="cal-header">
      <button class="btn ghost" id="calPrev" style="padding:6px 10px;min-height:36px">‹</button>
      <span style="font-weight:700;font-size:15px">${monthName}</span>
      <button class="btn ghost" id="calNext" style="padding:6px 10px;min-height:36px">›</button>
    </div>
    <div class="cal-grid">
      ${['Su','Mo','Tu','We','Th','Fr','Sa'].map(d => `<div class="cal-dow">${d}</div>`).join('')}`;

  // Empty cells before first day
  for (let i = 0; i < firstDay.getDay(); i++) {
    html += `<div class="cal-cell empty"></div>`;
  }

  for (let day = 1; day <= lastDay.getDate(); day++) {
    const dateStr = `${year}-${String(month + 1).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
    const act     = actMap[dateStr];
    const isToday = dateStr === today;
    const hasW    = act?.workouts?.length > 0;
    const hasL    = act?.logs?.length > 0;

    html += `
      <div class="cal-cell${isToday ? ' today' : ''}${hasW ? ' has-workout' : ''}"
           data-cal-date="${dateStr}">
        <span class="cal-day-num">${day}</span>
        <div class="cal-dots">
          ${hasW ? '<span class="cal-dot workout"></span>' : ''}
          ${hasL && !hasW ? '<span class="cal-dot log"></span>' : ''}
        </div>
      </div>`;
  }
  html += `</div>`;
  host.innerHTML = html;

  host.querySelectorAll('[data-cal-date]').forEach(cell => {
    cell.addEventListener('click', () => openDayDetail(cell.dataset.calDate));
  });
  host.querySelector('#calPrev')?.addEventListener('click', () => {
    let m = month - 1, y = year;
    if (m < 0) { m = 11; y--; }
    _calMonth = m; _calYear = y; renderCalendar();
  });
  host.querySelector('#calNext')?.addEventListener('click', () => {
    let m = month + 1, y = year;
    if (m > 11) { m = 0; y++; }
    _calMonth = m; _calYear = y; renderCalendar();
  });
}

function openDayDetail(dateStr) {
  const st = getState();
  const workouts = st.sessions.filter(s => (s.completedAt || s.date).slice(0, 10) === dateStr);
  const log      = st.days.find(d => d.date === dateStr);

  const modal = document.createElement('div');
  modal.className = 'modal-overlay';

  let content = `<div class="modal-box">
    <div class="between" style="margin-bottom:12px">
      <h3 style="margin:0">${new Date(dateStr + 'T12:00:00').toLocaleDateString(undefined, { weekday:'long', month:'long', day:'numeric' })}</h3>
      <button class="btn ghost" id="closeDayDetail" style="padding:6px 10px;min-height:36px">✕</button>
    </div>`;

  if (workouts.length) {
    workouts.forEach(s => {
      const totalSets = Object.values(s.exercises || {})
        .filter(x => x.status === 'completed')
        .reduce((a, ex) => a + (ex.sets || []).filter(s => s.done).length, 0);
      const kcal = estimateCalories(s, st.weightKg);
      content += `
        <div style="background:var(--card2);border:1px solid var(--line);border-radius:var(--radius-s);padding:12px;margin-bottom:8px">
          <div style="font-weight:700;font-size:14px">💪 Workout ${esc(s.template)}</div>
          <div style="font-size:12px;color:var(--muted);margin-top:4px">
            ${completedCount(s)} exercises · ${totalSets} sets
            ${kcal ? ` · ~${kcal} kcal` : ''}
          </div>
          ${s.notes ? `<div style="font-size:12px;color:var(--muted);margin-top:4px">${esc(s.notes)}</div>` : ''}
        </div>`;
    });
  }

  if (log) {
    const parts = [
      log.weight    ? `${log.weight} kg`            : '',
      log.steps     ? `${log.steps} steps`           : '',
      log.sleep     ? `${log.sleep} h sleep`         : '',
      log.cardioMin ? `${log.cardioMin} min cardio`  : '',
    ].filter(Boolean);
    content += `
      <div style="background:var(--card2);border:1px solid var(--line);border-radius:var(--radius-s);padding:12px;margin-bottom:8px">
        <div style="font-weight:700;font-size:14px">📊 Daily log</div>
        <div style="font-size:12px;color:var(--muted);margin-top:4px">${parts.join(' · ') || 'No data'}</div>
        ${log.notes ? `<div style="font-size:12px;color:var(--muted);margin-top:4px">${esc(log.notes)}</div>` : ''}
      </div>`;
  }

  if (!workouts.length && !log) {
    content += `<div class="empty">No activity on this day.</div>`;
  }

  content += `</div>`;
  modal.innerHTML = content;
  document.body.appendChild(modal);
  modal.querySelector('#closeDayDetail').addEventListener('click', () => modal.remove());
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
}

// ─── Full re-render ───────────────────────────────────────────────────────────

function renderAll() {
  applyTheme(); updateSaveStatus(); renderHome();
  renderDailyList(); renderHistory(); renderEditor();
  renderCalendar();
  const st = getState();
  $('#theme').value              = st.theme;
  $('#audioEnabled').checked     = st.audioEnabled;
  $('#vibrationEnabled').checked = st.vibrationEnabled;
  // Profile fields
  if (st.weightKg)   { const el = $('#settingWeight');    if (el) el.value = st.weightKg; }
  if (st.heightCm)   { const el = $('#settingHeight');    if (el) el.value = st.heightCm; }
  if (st.sex)        { const el = $('#settingSex');       if (el) el.value = st.sex; }
  if (st.birthYear)  { const el = $('#settingBirthYear'); if (el) el.value = st.birthYear; }
}

// ─── Event wiring ─────────────────────────────────────────────────────────────

function wireEvents() {
  $$('.nav button').forEach(b =>
    b.addEventListener('click', () => { unlockAudio(); show(b.dataset.view); })
  );

  $('#weekMinus').addEventListener('click', () => {
    const st = getState(); st.week = Math.max(1, st.week - 1);
    saveState().then(updateSaveStatus); renderHome();
  });
  $('#weekPlus').addEventListener('click', () => {
    const st = getState(); st.week++;
    saveState().then(updateSaveStatus); renderHome();
  });
  $('#startWorkout').addEventListener('click', () => {
    unlockAudio();
    const st = getState();
    const tmpl = $('#startTemplate').value;
    const dur  = Number($('#length').value);
    st.lastDuration = dur;
    st.draft = makeDraft(st, tmpl, dur);
    saveState().then(updateSaveStatus);
    requestWakeLock();
    show('workout');
  });

  $('#completeExercise').addEventListener('click', () => advanceExercise('completed'));
  $('#skipExercise').addEventListener('click',    () => advanceExercise('skipped'));
  $('#finishEarly').addEventListener('click',     finishWorkout);
  $('#discard').addEventListener('click',         discardWorkout);
  $('#pauseWorkout').addEventListener('click',    () => show('home'));

  // Circular timer controls
  $('#addTimer').addEventListener('click', () => {
    const st = getState();
    if (st.draft?.timerEndsAt) { st.draft.timerEndsAt += 15_000; _timerTotal += 15; }
  });
  $('#timerMinus').addEventListener('click', () => {
    const st = getState();
    if (st.draft?.timerEndsAt) {
      st.draft.timerEndsAt = Math.max(Date.now() + 1000, st.draft.timerEndsAt - 15_000);
      _timerTotal = Math.max(15, _timerTotal - 15);
    }
  });
  $('#timerPause').addEventListener('click', () => {
    const st = getState();
    if (!st.draft?.timerEndsAt) return;
    if (_timerPaused) {
      // Resume: shift endsAt forward by paused duration
      const pausedDuration = Date.now() - _timerPausedAt;
      st.draft.timerEndsAt += pausedDuration;
      _timerPaused = false;
      $('#timerPause').textContent = '⏸';
    } else {
      _timerPaused = true;
      _timerPausedAt = Date.now();
      $('#timerPause').textContent = '▶';
    }
  });
  $('#skipTimer').addEventListener('click', () => { stopRestTimer(); saveState(false); });

  $('#dayDate').value = new Date().toISOString().slice(0, 10);
  $('#saveDaily').addEventListener('click', saveDaily);

  $('#addPast').addEventListener('click', () => {
    const st   = getState();
    const keys = Object.keys(st.templates);
    const tmpl = (prompt(`Template (${keys.join(', ')})`, keys[0]) || '').toUpperCase();
    if (!st.templates[tmpl]) return;
    st.draft = makeDraft(st, tmpl, 999);
    saveState().then(updateSaveStatus); show('workout');
  });

  $('#editTemplate').addEventListener('change', () => {
    renderEditor();
    // Update Delete button disabled state when template changes
    const deleteBtn = $('#deleteTemplate');
    if (deleteBtn) {
      deleteBtn.disabled = Object.keys(makeSeedTemplates()).includes($('#editTemplate').value);
    }
  });
  $('#search').addEventListener('input', renderEditor);
  $('#showArchived').addEventListener('change', renderEditor);

  $('#addExercise').addEventListener('click', async () => {
    const st = getState();
    const t  = $('#editTemplate').value;
    st.templates[t].push({
      id: 'custom_' + Date.now(), name: 'New exercise', equip: 'Bodyweight',
      defaultReps: 10, defaultRpe: 7, sets: 3, rest: 60,
      tags: '', muscles: '', instructions: '', progression: '', archived: false,
    });
    await saveState(); updateSaveStatus();
    $('#search').value = ''; renderEditor();
  });

  $('#addTemplate').addEventListener('click', () => {
    const name = prompt('New template name (e.g. D or Push):');
    if (!name) return;
    const key = name.trim().toUpperCase().slice(0, 4);
    const st  = getState();
    if (st.templates[key]) { alert('Template already exists.'); return; }
    st.templates[key] = [];
    saveState().then(updateSaveStatus); renderHome(); renderEditor();
  });

  $('#renameTemplate').addEventListener('click', () => {
    const st  = getState();
    const old = $('#editTemplate').value;
    const nw  = prompt(`Rename template "${old}" to:`, old);
    if (!nw || nw === old) return;
    const key = nw.trim().toUpperCase().slice(0, 4);
    if (st.templates[key]) { alert('Template already exists.'); return; }
    st.templates[key] = st.templates[old];
    delete st.templates[old];
    saveState().then(updateSaveStatus); renderHome(); renderEditor();
  });

  $('#duplicateTemplate').addEventListener('click', () => {
    const st  = getState();
    const src = $('#editTemplate').value;
    const nw  = prompt(`Duplicate "${src}" as:`, src + '2');
    if (!nw) return;
    const key = nw.trim().toUpperCase().slice(0, 4);
    if (st.templates[key]) { alert('Template already exists.'); return; }
    st.templates[key] = structuredClone(st.templates[src]);
    saveState().then(updateSaveStatus); renderHome(); renderEditor();
  });

  $('#deleteTemplate').addEventListener('click', () => {
    const st  = getState();
    const key = $('#editTemplate').value;
    if (Object.keys(makeSeedTemplates()).includes(key)) {
      alert('Seed templates A, B, C cannot be deleted.'); return;
    }
    if (!confirm(`Delete template "${key}" and all its exercises?`)) return;
    delete st.templates[key];
    saveState().then(updateSaveStatus); renderHome(); renderEditor();
  });

  $('#saveSettings').addEventListener('click', () => {
    const st = getState();
    st.theme            = $('#theme').value;
    st.audioEnabled     = $('#audioEnabled').checked;
    st.vibrationEnabled = $('#vibrationEnabled').checked;
    // Profile
    const w = Number($('#settingWeight')?.value);
    const h = Number($('#settingHeight')?.value);
    const by = Number($('#settingBirthYear')?.value);
    if (w > 0) st.weightKg  = w;
    if (h > 0) st.heightCm  = h;
    st.sex       = $('#settingSex')?.value || 'male';
    if (by > 1900 && by < 2100) st.birthYear = by;
    applyTheme(); saveState().then(updateSaveStatus);
  });

  $('#exportBackup').addEventListener('click', exportData);
  $('#importBackup').addEventListener('click', () => $('#backupFile').click());
  $('#backupFile').addEventListener('change', e => importData(e.target.files[0]));
  $('#copyBackup').addEventListener('click', () =>
    navigator.clipboard.writeText($('#backupText').value).catch(() => {})
  );
  $('#eraseData').addEventListener('click', () => {
    if (!confirm('Erase ALL workout data? This cannot be undone.')) return;
    const st = getState();
    Object.assign(st, normalize(null));
    saveState().then(updateSaveStatus); show('home'); renderAll();
  });

  $('#exerciseChartSelect')?.addEventListener('change', renderExerciseChart);

  // History view: re-render calendar when navigating to history
  // (already handled by show() calling renderHistory() which calls renderCalendar())
  $('#swUpdateBtn')?.addEventListener('click', async () => {
    const registration = await navigator.serviceWorker?.getRegistration();
    if (!registration?.waiting) {
      window.location.reload();
      return;
    }

    // Persist the active draft before activating the new application shell.
    await saveState();
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloading) return;
      reloading = true;
      window.location.reload();
    });
    registration.waiting.postMessage({ type: 'SKIP_WAITING' });
  });

  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault(); _installPrompt = e;
    $('#installBtn')?.classList.remove('hidden');
  });
  $('#installBtn')?.addEventListener('click', async () => {
    if (!_installPrompt) return;
    _installPrompt.prompt();
    const result = await _installPrompt.userChoice;
    if (result.outcome === 'accepted') { _installPrompt = null; $('#installBtn')?.classList.add('hidden'); }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && getState()?.draft) requestWakeLock();
  });
}

// ─── Service worker ───────────────────────────────────────────────────────────

async function registerSW() {
  if (!('serviceWorker' in navigator) || !location.protocol.startsWith('http')) return;

  const isLocalDevelopment =
    location.hostname === 'localhost' ||
    location.hostname === '127.0.0.1';

  if (isLocalDevelopment) {
    // Never let a PWA cache hide source changes during local development.
    const registrations = await navigator.serviceWorker.getRegistrations();
    await Promise.all(registrations.map(registration => registration.unregister()));
    if ('caches' in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map(key => caches.delete(key)));
    }
    return;
  }

  navigator.serviceWorker.register('./service-worker.js').then(registration => {
    const showUpdate = () => {
      if (registration.waiting && navigator.serviceWorker.controller) {
        $('#swUpdateBanner')?.classList.remove('hidden');
      }
    };

    showUpdate();
    registration.addEventListener('updatefound', () => {
      const worker = registration.installing;
      worker?.addEventListener('statechange', () => {
        if (worker.state === 'installed') showUpdate();
      });
    });

    // Check for a new worker whenever the hosted app is opened.
    registration.update().catch(() => {});
  }).catch(() => {});
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

async function boot() {
  await initState();
  onSaveStatus(() => { updateSaveStatus(); renderStorageCard(); });
  wireEvents();
  renderAll();
  const st = getState();
  if (st.draft) {
    show('workout', false);
    restoreRestTimer();
    startElapsedTimer();
    requestWakeLock();
  } else {
    show(st.lastView || 'home', false);
  }
  registerSW();
}

boot();

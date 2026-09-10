/**
 * State management — versioned application state, normalization, and
 * persistence helpers. All mutations go through saveState() so IndexedDB
 * is always the source of truth.
 */

import { dbGet, dbSet, lsGet, lsSet, idbActive, lastWriteOk, lastWriteTime } from './storage.js';

export const SCHEMA_VERSION = 2;

// ─── Seed templates ───────────────────────────────────────────────────────────

const SEED = {
  A: [
    { id: 'goblet',  name: 'Goblet squat',       equip: '1 × 15 kg DB',          defaultReps: 10, defaultRpe: 7, sets: 3, rest: 90,  tags: 'quads glutes',        muscles: 'quads glutes',           instructions: 'Hold DB at chest, squat deep, drive through heels.',          progression: 'Add 2.5 kg when all sets hit target reps at RPE ≤7.' },
    { id: 'floor',   name: 'DB floor press',      equip: 'Controlled DB load',     defaultReps: 10, defaultRpe: 7, sets: 3, rest: 90,  tags: 'chest triceps',       muscles: 'chest triceps',          instructions: 'Lie on floor, press DBs from chest, control descent.',         progression: 'Add 1 kg per DB when all sets complete at RPE ≤7.' },
    { id: 'row',     name: 'One-arm DB row',       equip: '1 × 15 kg DB',          defaultReps: 10, defaultRpe: 7, sets: 3, rest: 60,  tags: 'back biceps',         muscles: 'back biceps',            instructions: 'Brace on bench, pull DB to hip, squeeze at top.',              progression: 'Add 2.5 kg when all sets complete at RPE ≤7.' },
    { id: 'lunge',   name: 'Reverse lunge',        equip: 'Bodyweight or DB',       defaultReps:  8, defaultRpe: 7, sets: 3, rest: 75,  tags: 'quads glutes',        muscles: 'quads glutes',           instructions: 'Step back, lower knee near floor, drive front foot.',          progression: 'Add load or reps when movement is controlled.' },
    { id: 'face',    name: 'Band face pull',        equip: 'Tube',                   defaultReps: 15, defaultRpe: 7, sets: 2, rest: 45,  tags: 'rear delts',          muscles: 'rear delts rotator cuff',instructions: 'Pull band to face, elbows high, external rotate.',             progression: 'Increase band resistance or reps.' },
    { id: 'deadbug', name: 'Dead bug',              equip: 'Bodyweight',             defaultReps:  8, defaultRpe: 7, sets: 2, rest: 45,  tags: 'core',                muscles: 'core',                   instructions: 'Extend opposite arm/leg, keep lower back flat.',               progression: 'Add pause at extension or use light DB.' },
  ],
  B: [
    { id: 'rdl',     name: 'DB Romanian deadlift', equip: '2 × 15 kg DB',          defaultReps: 10, defaultRpe: 7, sets: 3, rest: 90,  tags: 'hamstrings glutes',   muscles: 'hamstrings glutes',      instructions: 'Hinge at hips, DBs close to legs, feel hamstring stretch.',    progression: 'Add 2.5 kg per DB when all sets complete at RPE ≤7.' },
    { id: 'press',   name: 'Half-kneeling press',  equip: '1 × 7.5 kg or band',    defaultReps: 10, defaultRpe: 7, sets: 3, rest: 60,  tags: 'shoulders',           muscles: 'shoulders triceps',      instructions: 'Kneel on one knee, press overhead, brace core.',               progression: 'Add 1 kg or increase band resistance.' },
    { id: 'pullup',  name: 'Pull-up skill block',  equip: 'Bar + band',             defaultReps:  1, defaultRpe: 7, sets: 3, rest: 120, tags: 'back biceps pull-up', muscles: 'lats biceps',            instructions: 'Dead hang, depress scapula, pull chest to bar.',               progression: 'Reduce band assistance or add clean reps.' },
    { id: 'split',   name: 'Split squat',           equip: 'Bodyweight or DB',       defaultReps:  8, defaultRpe: 7, sets: 3, rest: 75,  tags: 'quads glutes',        muscles: 'quads glutes',           instructions: 'Front foot flat, lower back knee near floor.',                 progression: 'Add load when movement is controlled.' },
    { id: 'pallof',  name: 'Pallof press',          equip: 'Tube',                   defaultReps: 10, defaultRpe: 7, sets: 2, rest: 45,  tags: 'core anti-rotation',  muscles: 'core obliques',          instructions: 'Press band away from anchor, resist rotation.',                progression: 'Increase band resistance or hold duration.' },
  ],
  C: [
    { id: 'brdl',     name: 'B-stance RDL',          equip: '1–2 × 15 kg DB',       defaultReps:  8, defaultRpe: 7, sets: 3, rest: 75,  tags: 'hamstrings',          muscles: 'hamstrings glutes',      instructions: 'One leg primary, other as kickstand, hinge at hip.',           progression: 'Add load when balance and form are solid.' },
    { id: 'pushup',   name: 'Push-up',                equip: 'Bodyweight or band',    defaultReps:  8, defaultRpe: 7, sets: 3, rest: 75,  tags: 'chest',               muscles: 'chest triceps shoulders',instructions: 'Straight body, lower chest to floor, full extension.',         progression: 'Add reps, elevate feet, or add band resistance.' },
    { id: 'brow',     name: 'Band row',               equip: 'Tube',                  defaultReps: 12, defaultRpe: 7, sets: 3, rest: 60,  tags: 'back',                muscles: 'back biceps',            instructions: 'Anchor band, row elbows back, squeeze shoulder blades.',       progression: 'Increase band resistance or add pause.' },
    { id: 'unileg',   name: 'Bulgarian split squat',  equip: 'Bodyweight or DB',      defaultReps:  8, defaultRpe: 7, sets: 2, rest: 60,  tags: 'quads',               muscles: 'quads glutes',           instructions: 'Rear foot elevated, lower front knee over toes.',              progression: 'Add load or reps when movement is controlled.' },
    { id: 'pulldown', name: 'Band lat pulldown',      equip: 'High anchor',           defaultReps: 12, defaultRpe: 7, sets: 3, rest: 60,  tags: 'lats',                muscles: 'lats biceps',            instructions: 'Anchor band high, pull elbows to sides, squeeze lats.',        progression: 'Increase band resistance or add pause at bottom.' },
  ],
};

export function makeSeedTemplates() {
  return Object.fromEntries(
    Object.entries(SEED).map(([k, arr]) => [k, arr.map(e => ({ ...e }))])
  );
}

// ─── Base state ───────────────────────────────────────────────────────────────

export const BASE_STATE = {
  schemaVersion: SCHEMA_VERSION,
  week: 1,
  nextTemplate: 'A',
  theme: 'system',
  audioEnabled: true,
  vibrationEnabled: true,
  lastDuration: 999,
  lastSaved: null,
  deviceId: null,
  // User profile (for calorie estimation)
  weightKg: null,
  heightCm: null,
  sex: 'male',       // 'male' | 'female'
  birthYear: null,
  templates: null,   // populated by normalize()
  sessions: [],
  days: [],
  pullupRecords: [],
  draft: null,
  lastView: 'home',
};

// ─── Normalization ────────────────────────────────────────────────────────────

/**
 * Merge raw persisted data with defaults.
 * User-edited templates always win over seed defaults.
 * Missing seed templates are added back.
 */
export function normalize(raw) {
  if (!raw) {
    const s = structuredClone(BASE_STATE);
    s.templates = makeSeedTemplates();
    s.deviceId = _newDeviceId();
    return s;
  }

  const state = { ...structuredClone(BASE_STATE), ...raw };
  state.schemaVersion = SCHEMA_VERSION;

  if (!state.deviceId) state.deviceId = _newDeviceId();

  // Smart template merge: user templates win; add any missing seed templates
  const seed = makeSeedTemplates();
  const user = raw.templates || {};
  state.templates = { ...seed };
  for (const [key, exercises] of Object.entries(user)) {
    if (Array.isArray(exercises)) state.templates[key] = exercises;
  }

  if (!Array.isArray(state.sessions))      state.sessions      = [];
  if (!Array.isArray(state.days))          state.days          = [];
  if (!Array.isArray(state.pullupRecords)) state.pullupRecords = [];

  return state;
}

function _newDeviceId() {
  return 'dev_' + Math.random().toString(36).slice(2, 10);
}

// ─── Phase / week helpers ─────────────────────────────────────────────────────

export function phase(w) {
  if (w === 1) return 'Return week · reduced volume';
  if (w === 2) return 'Rebuild week · RPE 7';
  const n = ((w - 3) % 5) + 1;
  const b = Math.floor((w - 3) / 5) + 1;
  return n === 5 ? `Block ${b}, Recovery week` : `Block ${b}, Build week ${n}`;
}

export function phaseShort(w) {
  if (w === 1) return 'Return';
  if (w === 2) return 'Rebuild';
  const n = ((w - 3) % 5) + 1;
  const b = Math.floor((w - 3) / 5) + 1;
  return n === 5 ? `Blk ${b} Rec` : `Blk ${b} Bld ${n}`;
}

// ─── Session helpers ──────────────────────────────────────────────────────────

export function completedCount(session) {
  return Object.values(session.exercises || {}).filter(x => x.status === 'completed').length;
}

export function skippedCount(session) {
  return Object.values(session.exercises || {}).filter(x => x.status === 'skipped').length;
}

/**
 * Return the set data from the most recent completed occurrence of exerciseId
 * in templateKey. Falls back to the last available set if setIndex is out of
 * range. Returns null if no completed history exists.
 */
export function latestCompletedSet(state, templateKey, exerciseId, setIndex) {
  for (let i = state.sessions.length - 1; i >= 0; i--) {
    const s = state.sessions[i];
    if (s.template === templateKey && s.exercises?.[exerciseId]?.status === 'completed') {
      const sets = s.exercises[exerciseId].sets || [];
      if (!sets.length) continue;
      return sets[setIndex] ?? sets[sets.length - 1];
    }
  }
  return null;
}

export function latestCompletedExercise(state, templateKey, exerciseId) {
  for (let i = state.sessions.length - 1; i >= 0; i--) {
    const s = state.sessions[i];
    if (s.template === templateKey && s.exercises?.[exerciseId]?.status === 'completed') {
      return s.exercises[exerciseId];
    }
  }
  return null;
}

/** Returns the full session object for the most recent completed occurrence. */
export function latestCompletedSessionForExercise(state, templateKey, exerciseId) {
  for (let i = state.sessions.length - 1; i >= 0; i--) {
    const s = state.sessions[i];
    if (s.template === templateKey && s.exercises?.[exerciseId]?.status === 'completed') {
      return s;
    }
  }
  return null;
}

/** Personal record: highest total reps in a single session for an exercise. */
export function personalRecord(state, exerciseId) {
  let best = null;
  for (const s of state.sessions) {
    const ex = s.exercises?.[exerciseId];
    if (ex?.status !== 'completed') continue;
    const total = (ex.sets || []).filter(x => x.done).reduce((a, b) => a + (b.reps || 0), 0);
    if (best === null || total > best.total) {
      best = { total, date: s.completedAt || s.date, session: s };
    }
  }
  return best;
}

// ─── Draft creation ───────────────────────────────────────────────────────────

export function makeDraft(state, templateKey, maxCount) {
  const template = state.templates[templateKey];
  if (!template) return null;

  const list = maxCount >= 999 ? template : template.slice(0, maxCount);
  const now  = Date.now();

  const draft = {
    id:          now,
    template:    templateKey,
    date:        new Date(now).toISOString(),
    week:        state.week,
    index:       0,
    order:       list.map(e => e.id),
    exercises:   {},
    timerEndsAt: null,
    status:      'active',
  };

  for (const e of list) {
    const setCount = state.week === 1 ? Math.min(2, e.sets) : e.sets;
    draft.exercises[e.id] = {
      status: 'pending',
      sets: Array.from({ length: setCount }, (_, i) => {
        const prev = latestCompletedSet(state, templateKey, e.id, i);
        return {
          reps: prev?.reps ?? e.defaultReps ?? 10,
          load: prev?.load ?? e.equip ?? '',
          rpe:  prev?.rpe  ?? e.defaultRpe  ?? 7,
          done: false,
        };
      }),
    };
  }

  return draft;
}

// ─── Singleton state + persistence ───────────────────────────────────────────

let _state = null;
let _saveStatus = 'idle'; // 'idle' | 'saving' | 'saved' | 'failed' | 'unavailable'
const _statusListeners = new Set();

export function getState()      { return _state; }
export function getSaveStatus() { return _saveStatus; }

export function onSaveStatus(fn) {
  _statusListeners.add(fn);
  return () => _statusListeners.delete(fn);
}

function _emitStatus(s) {
  _saveStatus = s;
  _statusListeners.forEach(fn => fn(s, _state?.lastSaved));
}

export async function initState() {
  const idbRaw = await dbGet();
  const lsRaw  = lsGet();

  let idbParsed = null;
  let lsParsed  = null;

  if (idbRaw) { try { idbParsed = JSON.parse(idbRaw); } catch { /* corrupt */ } }
  if (lsRaw)  { try { lsParsed  = JSON.parse(lsRaw);  } catch { /* corrupt */ } }

  // Use whichever copy is newer
  let raw = null;
  if (idbParsed && lsParsed) {
    raw = new Date(idbParsed.lastSaved || 0) >= new Date(lsParsed.lastSaved || 0)
      ? idbParsed : lsParsed;
  } else {
    raw = idbParsed || lsParsed;
  }

  _state = normalize(raw);

  // Migrate LocalStorage-only data into IndexedDB
  if (!idbRaw && lsRaw) {
    await saveState(false);
  }

  _emitStatus(idbActive ? 'saved' : 'unavailable');
  return _state;
}

/**
 * Persist current state. Pass notify=true to fire status listeners twice
 * (saving → saved/failed) so the header updates immediately.
 *
 * Note: dbSet() catches its own errors internally and sets lastWriteOk.
 * We check lastWriteOk after the await to determine success/failure.
 */
export async function saveState(notify = true) {
  if (!_state) return;

  if (notify) _emitStatus('saving');

  _state.lastSaved = new Date().toISOString();
  const raw = JSON.stringify(_state);

  // Boot hint in LocalStorage
  lsSet(raw);

  // Primary write to IndexedDB (dbSet resolves even on error; check lastWriteOk)
  await dbSet(raw);

  if (notify) {
    _emitStatus(lastWriteOk ? 'saved' : 'failed');
  }
}

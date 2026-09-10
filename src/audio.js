/**
 * Audio and vibration utilities.
 * Web Audio API is unlocked on the first user gesture to satisfy
 * mobile-browser autoplay policies.
 */

let _ctx = null;

/** Call once inside any user-gesture handler to unlock the AudioContext. */
export function unlockAudio() {
  try {
    _ctx = _ctx || new (window.AudioContext || window.webkitAudioContext)();
    if (_ctx.state === 'suspended') _ctx.resume();
  } catch { /* no audio support */ }
}

/**
 * Play a short two-note completion tone (660 Hz → 880 Hz).
 * Respects the audioEnabled flag passed in.
 */
export function playTone(audioEnabled = true) {
  if (!audioEnabled) return;
  try {
    unlockAudio();
    if (!_ctx) return;
    [[0, 660], [0.17, 880]].forEach(([t, freq]) => {
      const osc = _ctx.createOscillator();
      const gain = _ctx.createGain();
      osc.connect(gain);
      gain.connect(_ctx.destination);
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.08, _ctx.currentTime + t);
      gain.gain.exponentialRampToValueAtTime(0.001, _ctx.currentTime + t + 0.14);
      osc.start(_ctx.currentTime + t);
      osc.stop(_ctx.currentTime + t + 0.15);
    });
  } catch { /* audio unavailable */ }
}

/**
 * Vibrate the device if supported and enabled.
 * Pattern: two short pulses.
 */
export function vibrate(vibrationEnabled = true) {
  if (!vibrationEnabled) return;
  try { navigator.vibrate?.([80, 60, 80]); } catch { /* not supported */ }
}

/** Play tone and vibrate together (rest-timer completion). */
export function alertComplete(audioEnabled = true, vibrationEnabled = true) {
  playTone(audioEnabled);
  vibrate(vibrationEnabled);
}
// A short two-note sound for something that needs a caller's attention.
//
// Made with the Web Audio API, so there is no sound file to load. Browsers only
// let a page make sound after the person has clicked or typed on it once, so
// the first click anywhere in DRM unlocks it (see unlockChimeOnFirstTouch).
// Can be switched off from the bell; the choice is kept in this browser.

let ctx: AudioContext | null = null;
const KEY = "drm-sound";

function audio(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AC) return null;
  if (!ctx) {
    try {
      ctx = new AC();
    } catch {
      return null;
    }
  }
  return ctx;
}

export function soundOn(): boolean {
  try {
    return localStorage.getItem(KEY) !== "off";
  } catch {
    return true;
  }
}

export function setSoundOn(on: boolean) {
  try {
    localStorage.setItem(KEY, on ? "on" : "off");
  } catch {
    /* kept for this visit only */
  }
}

/** Call once: the first click or key press anywhere lets DRM make sound. */
export function unlockChimeOnFirstTouch() {
  if (typeof window === "undefined") return () => undefined;
  const unlock = () => {
    const a = audio();
    if (a && a.state === "suspended") void a.resume().catch(() => undefined);
  };
  window.addEventListener("pointerdown", unlock);
  window.addEventListener("keydown", unlock);
  return () => {
    window.removeEventListener("pointerdown", unlock);
    window.removeEventListener("keydown", unlock);
  };
}

/** "urgent" (a payment failed): three quick notes. "info": two softer ones. */
export function chime(kind: "urgent" | "info" = "info") {
  if (!soundOn()) return;
  const a = audio();
  if (!a) return;
  if (a.state === "suspended") void a.resume().catch(() => undefined);
  const notes = kind === "urgent" ? [880, 1175, 1480] : [784, 1047];
  const start = a.currentTime + 0.02;
  notes.forEach((hz, i) => {
    const t = start + i * 0.16;
    const osc = a.createOscillator();
    const gain = a.createGain();
    osc.type = "sine";
    osc.frequency.value = hz;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(kind === "urgent" ? 0.25 : 0.16, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
    osc.connect(gain).connect(a.destination);
    osc.start(t);
    osc.stop(t + 0.32);
  });
}

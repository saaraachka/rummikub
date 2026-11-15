// Haptics for phones. Feature-detected; never throws.
//   Android and others: navigator.vibrate(pattern)
//   iOS Safari 17.4+:   no vibrate(), but toggling an <input type="checkbox" switch>
//                       through its <label> triggers the system "tick" haptic.
//                       One tick per click, so patterns become a few timed clicks.
//                       iOS may only honor this inside a user gesture, so treat any
//                       haptic outside a tap (like "your turn") as a bonus.
//   Anywhere else: silently does nothing.

export const PATTERNS = {
  tick: [12],
  double: [25, 70, 25],
  triple: [30, 60, 30, 60, 30],
  turn: [80, 90, 80, 90, 220],
};

const memoryStorage = () => {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) };
};

export function createHaptics({
  storageKey = 'haptics',
  storage = safeLocalStorage(),
  nav = globalThis.navigator,
  doc = globalThis.document,
} = {}) {
  let enabled = true;
  try {
    enabled = storage.getItem(storageKey) !== 'off';
  } catch {}

  const canVibrate = !!nav && typeof nav.vibrate === 'function';
  let label = null; // lazily created iOS switch

  function iosSwitchLabel() {
    if (label !== null) return label || null;
    label = false;
    try {
      if (!doc?.createElement) return null;
      const input = doc.createElement('input');
      input.type = 'checkbox';
      input.setAttribute('switch', '');
      if (input.switch !== true) return null; // only Safari 17.4+ knows the switch attribute
      input.id = `haptic-switch-${Math.random().toString(36).slice(2)}`;
      const l = doc.createElement('label');
      l.htmlFor = input.id;
      for (const el of [input, l]) {
        el.setAttribute('aria-hidden', 'true');
        el.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0;pointer-events:none;';
      }
      doc.body.append(input, l);
      label = l;
    } catch {
      label = false;
    }
    return label || null;
  }

  return {
    /** What this device can do: 'vibrate' | 'ios-switch' | 'none'. */
    get support() {
      if (canVibrate) return 'vibrate';
      return iosSwitchLabel() ? 'ios-switch' : 'none';
    },
    get enabled() { return enabled; },
    setEnabled(on) {
      enabled = !!on;
      try { storage.setItem(storageKey, enabled ? 'on' : 'off'); } catch {}
    },
    /** Fire a named pattern from PATTERNS (or a raw vibrate pattern). Returns true if attempted. */
    fire(pattern) {
      if (!enabled) return false;
      const p = Array.isArray(pattern) ? pattern : PATTERNS[pattern];
      if (!p) return false;
      try {
        if (canVibrate) return nav.vibrate(p) !== false;
        const l = iosSwitchLabel();
        if (!l) return false;
        // One click per "on" segment of the pattern, spaced like the pattern.
        let t = 0;
        p.forEach((ms, i) => {
          if (i % 2 === 0) {
            if (t === 0) l.click();
            else setTimeout(() => { try { l.click(); } catch {} }, t);
          }
          t += ms;
        });
        return true;
      } catch {
        return false;
      }
    },
  };
}

function safeLocalStorage() {
  try {
    const s = globalThis.localStorage;
    s.getItem('x');
    return s;
  } catch {
    return memoryStorage();
  }
}

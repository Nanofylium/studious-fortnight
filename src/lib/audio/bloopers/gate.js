// The Bloopers room is locked with a passphrase. Only a PBKDF2 hash of it is
// in the code (public repo), so reading the source does not reveal it. A new
// passphrase: `node scripts/bloopers-senha.mjs "nova frase"` and put the
// line it prints in VITE_BLOOPERS_GATE (.env.local or the host's settings).
const DEFAULT_GATE = '3dc8629d57dfa2812eb3e57be563e7c2:3f4cb1eb3d8e2d58a1412918ed46fa1fc6d62d1353a434526af649b55104817d';
const ITERATIONS = 600000;

export const gateValue = () => import.meta.env?.VITE_BLOOPERS_GATE || DEFAULT_GATE;

// Case, spaces and dashes don't matter when typing it.
export const normalizePass = (s) => String(s || '').toUpperCase().replace(/[\s_]+/g, '').replace(/-+/g, '-').trim();

const hex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
const unhex = (s) => Uint8Array.from(s.match(/../g) || [], (h) => parseInt(h, 16));

export async function hashPass(pass, saltHex, iterations = ITERATIONS) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(normalizePass(pass)), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: unhex(saltHex), iterations }, key, 256);
  return hex(bits);
}

export async function checkPass(pass, gate = gateValue()) {
  const [salt, want] = String(gate).split(':');
  if (!salt || !want || !pass) return false;
  const got = await hashPass(pass, salt);
  // Constant-time compare.
  let diff = got.length ^ want.length;
  for (let i = 0; i < Math.min(got.length, want.length); i++) diff |= got.charCodeAt(i) ^ want.charCodeAt(i);
  return diff === 0;
}

const KEY = 'forja.bastidores';

// Unlocked for this browser tab only; closing the tab locks it again.
export function isUnlocked() {
  try {
    return sessionStorage.getItem(KEY) === gateValue();
  } catch {
    return false;
  }
}

export function setUnlocked(on) {
  try {
    if (on) sessionStorage.setItem(KEY, gateValue());
    else sessionStorage.removeItem(KEY);
  } catch {
    // Private mode: stays unlocked only while the page is open.
  }
}

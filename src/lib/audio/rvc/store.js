// The voice model and the two base networks, kept in this computer's
// IndexedDB so they are picked once. Nothing leaves the machine.
const DB = 'forja-rvc';
const STORE = 'files';
export const KINDS = ['voice', 'hubert', 'rmvpe'];

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(mode, fn) {
  const db = await open();
  try {
    return await new Promise((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const req = fn(t.objectStore(STORE));
      t.oncomplete = () => resolve(req?.result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  } finally {
    db.close();
  }
}

// Which network a file is, from its name: rmvpe*.onnx and hubert*/contentvec*
// are the base networks, any other .onnx is the voice.
export function kindOf(name) {
  const n = name.toLowerCase();
  if (!n.endsWith('.onnx')) return null;
  if (n.includes('rmvpe')) return 'rmvpe';
  if (n.includes('hubert') || n.includes('contentvec')) return 'hubert';
  return 'voice';
}

// Kept as a Blob: stored out of line, so the 360 MB base networks fit
// (an ArrayBuffer value is capped near 130 MB in Chromium).
export async function saveModelFile(kind, file) {
  const data = new Blob([file], { type: 'application/octet-stream' });
  await tx('readwrite', (s) => s.put({ name: file.name, size: file.size, data }, kind));
}

// { voice: { name, size }, ... } of what is stored, without the data.
export async function listModelFiles() {
  const out = {};
  for (const k of KINDS) {
    const v = await tx('readonly', (s) => s.get(k)).catch(() => null);
    if (v) out[k] = { name: v.name, size: v.size };
  }
  return out;
}

export async function loadModelFiles() {
  const out = {};
  for (const k of KINDS) {
    const v = await tx('readonly', (s) => s.get(k));
    if (!v) throw new Error(`falta o arquivo ${k}`);
    out[k] = await v.data.arrayBuffer();
  }
  return out;
}

export async function clearModelFiles() {
  await tx('readwrite', (s) => s.clear());
}

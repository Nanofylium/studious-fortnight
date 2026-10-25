// Downloads the stem-separation model (SCNet, MIT-licensed weights) into
// public/models/, checked against the SHA-256 the library pins, so a build
// ships it and separates offline. Used by the desktop workflow.
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { models, REVISIONS } from '@audio/neural-separate';

const name = 'scnet';
const { file, repo, sha256 } = models[name];
const dir = new URL(`../public/models/${name}/`, import.meta.url);
const target = new URL(file, dir);
const hash = (b) => createHash('sha256').update(b).digest('hex');

if (existsSync(target) && hash(readFileSync(target)) === sha256) {
  console.log(`${file}: already here`);
} else {
  const url = `https://huggingface.co/${repo}/resolve/${REVISIONS[name]}/${file}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (hash(bytes) !== sha256) throw new Error(`${file}: SHA-256 mismatch`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(target, bytes);
  console.log(`${file}: ${(bytes.length / 1e6).toFixed(1)} MB`);
}

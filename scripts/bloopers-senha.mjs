// Prints the VITE_BLOOPERS_GATE value for a new Bloopers passphrase.
// Usage: node scripts/bloopers-senha.mjs "sua frase secreta"
import { randomBytes } from 'node:crypto';
import { hashPass } from '../src/lib/audio/bloopers/gate.js';

const pass = process.argv.slice(2).join(' ');
if (pass.length < 12) {
  console.error('Use uma frase com pelo menos 12 caracteres.');
  process.exit(1);
}
const salt = randomBytes(16).toString('hex');
console.log(`VITE_BLOOPERS_GATE=${salt}:${await hashPass(pass, salt)}`);

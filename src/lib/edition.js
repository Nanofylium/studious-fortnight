// Which build this is. "public" is the installer offered on the artist's
// website: the owner-only tools are left out of it entirely (not just hidden),
// so they cannot be dug out of the installed files. Any other build is the
// full one, where those tools stay locked behind the owner's passphrase.
// Set at build time (vite.config.js); a constant, so the bundler drops the
// owner code from the public build.
export const PUBLIC_EDITION = import.meta.env.VITE_EDITION === 'public';

// Stands in for the owner-only modules in the public build (vite.config.js),
// so their code never reaches the installer.
export default function OwnerStub() {
  return null;
}

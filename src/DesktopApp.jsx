import { Toaster } from '@/components/ui/toaster';
import Studio from '@/pages/Studio';

// Desktop build: no accounts and no backend, just the studio.
export default function DesktopApp() {
  return (
    <>
      <Studio />
      <Toaster />
    </>
  );
}

import React, { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { checkPass } from '@/lib/audio/bloopers/gate';

// Passphrase prompt for the hidden room. It names nothing: to anyone who
// stumbles on it, it is just a locked door.
export default function BloopersGate({ open, onOpenChange, onUnlock }) {
  const [pass, setPass] = useState('');
  const [checking, setChecking] = useState(false);
  const [wrong, setWrong] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setChecking(true);
    setWrong(false);
    const ok = await checkPass(pass).catch(() => false);
    setChecking(false);
    if (ok) {
      setPass('');
      onUnlock();
    } else {
      setWrong(true);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) {
          setPass('');
          setWrong(false);
        }
        onOpenChange(v);
      }}
    >
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="font-heading text-[13px] uppercase tracking-[0.18em]">Acesso</DialogTitle>
          <DialogDescription className="text-[11px]">Digite a senha.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-3">
          <Input
            type="password"
            autoComplete="off"
            autoFocus
            value={pass}
            onChange={(e) => setPass(e.target.value)}
            aria-label="Senha"
          />
          {wrong && <p className="text-[11px] text-destructive">Senha incorreta.</p>}
          <Button type="submit" className="h-9 w-full text-[12px]" disabled={!pass || checking}>
            {checking ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Entrar'}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

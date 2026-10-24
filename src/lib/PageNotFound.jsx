import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';

export default function PageNotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 px-4 text-center">
      <p className="font-heading text-[12px] uppercase tracking-[0.2em] text-muted-foreground">404</p>
      <h1 className="font-heading text-2xl font-semibold">Página não encontrada</h1>
      <p className="max-w-sm text-sm text-muted-foreground">O endereço que você abriu não existe neste app.</p>
      <Button asChild>
        <Link to="/">Voltar ao estúdio</Link>
      </Button>
    </div>
  );
}

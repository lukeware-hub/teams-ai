import type { SpecsAttemptView } from '../api.js';

const norm = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 70);
const VERDICT: Record<string, string> = { approved: 'aprovou', rejected: 'reprovou', failed: 'não terminou' };

/** The points of an attempt that the previous attempt already had, by their opening words: they came back unchanged. */
export function repeatedPoints(attempts: readonly SpecsAttemptView[], index: number): string[] {
  const now = Object.values(attempts[index]?.after ?? {}).flatMap((a) => a?.findings ?? []);
  const before = new Set(Object.values(attempts[index - 1]?.after ?? {}).flatMap((a) => (a?.findings ?? []).map(norm)));
  return now.filter((f) => before.has(norm(f)));
}

/** What the team tried on a rejected specs.md and what came of each try, so the owner reads why it did not settle. */
export function SpecsAttempts({ attempts }: { attempts: readonly SpecsAttemptView[] }) {
  if (attempts.length === 0) return null;
  const stuck = repeatedPoints(attempts, attempts.length - 1);
  return (
    <details data-testid="specs-attempts" open className="rounded-lg border border-line bg-surface p-[0.85rem] text-[0.8rem]">
      <summary data-testid="specs-attempts-title" className="cursor-pointer font-semibold text-ink">O que o time tentou e por que não resolveu</summary>
      <ol className="m-0 mt-[0.6rem] grid list-none gap-[0.6rem] p-0">
        {attempts.map((a, i) => {
          const verdicts = (['po', 'sm'] as const).flatMap((role) => (a.after?.[role] ? [`${role.toUpperCase()} ${VERDICT[a.after[role]!.verdict] ?? a.after[role]!.verdict}`] : []));
          const repeated = repeatedPoints(attempts, i).length;
          return (
            <li key={a.n} data-testid={`specs-attempt-${a.n}`} className="grid gap-[0.2rem] text-ink-soft">
              <b className="text-ink">Tentativa {a.n}</b>
              <span>Os revisores apontaram {a.points === 1 ? '1 ponto' : `${a.points} pontos`} em {a.items.join(', ')}. O time refez {a.redone.length > 0 ? a.redone.join(', ') : 'nada'}.</span>
              {a.failed.map((f) => <span key={f.item} className="text-warn">O agente não conseguiu refazer {f.item}: {f.issues.join('; ')}</span>)}
              {verdicts.length > 0 && <span>Depois: {verdicts.join(' · ')}.</span>}
              {repeated > 0 && <span data-testid={`specs-attempt-${a.n}-repeated`} className="text-warn">{repeated === 1 ? 'Um ponto voltou' : `${repeated} pontos voltaram`} sem mudar.</span>}
            </li>
          );
        })}
      </ol>
      {stuck.length > 0 && (
        <p data-testid="specs-attempts-why" className="m-0 mt-[0.6rem] text-warn">Por que não resolveu: o mesmo ponto voltou depois de refazer os itens ({stuck[0]!.slice(0, 120)}). Refazer o item não corrige isso: o problema está em um documento ou na decisão que falta. O botão Pedir ajuda ao time decide isso no lugar do dono.</p>
      )}
    </details>
  );
}

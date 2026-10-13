import { useEffect, useState } from 'react';
import { refineApi, type ProgramDecision } from '../api.js';
import { Icon } from '../components/Icons.js';
import { panel, sectionHeading, sectionTitle } from '../pages/project-shared.js';

const BACKEND = { jev: 'Jev', local: 'modelo local', claude: 'Claude' } as const;
const who = (d: ProgramDecision) => (d.backend === null ? 'sem resposta' : `${BACKEND[d.backend as keyof typeof BACKEND] ?? d.backend}${d.escalated ? ' (escalada)' : ''}`);
const said = (a: ProgramDecision['answers'][number]) => `${a.question}: ${typeof a.value === 'number' ? Number(a.value.toFixed(2)) : a.value}${a.confidence === null ? '' : ` (${Math.round(a.confidence * 100)}%)`}`;

/** Reads the decisions of a program's runs every 15 seconds while it runs, once when it finished. */
export function useDecisions(projectId: string, specId: string, live: boolean) {
  const [decisions, setDecisions] = useState<{ decisions: ProgramDecision[]; unanswered: number }>({ decisions: [], unanswered: 0 });
  useEffect(() => {
    const load = () => refineApi.programDecisions(projectId, specId).then(setDecisions).catch(() => undefined);
    void load();
    if (!live) return;
    const timer = setInterval(() => void load(), 15_000);
    return () => clearInterval(timer);
  }, [projectId, specId, live]);
  return decisions;
}

/** Who decided what in the runs of the program, newest first: the decision, who answered and what each question came to. */
export function DecisionTimeline({ decisions, unanswered = 0, titles }: { decisions: ProgramDecision[]; unanswered?: number; titles: Record<string, string> }) {
  return (
    <section className={`${panel} gap-3`} data-testid="decision-timeline">
      <div className={sectionTitle}>
        <span className="grid size-6 flex-none place-items-center rounded-sm bg-accent-soft text-accent-ink" aria-hidden="true"><Icon name="list" size={14} /></span>
        <h2 className={`${sectionHeading} ml-1`}>Decisões dos agentes</h2>
      </div>
      {unanswered > 0 && <p className="hint m-0">{unanswered} {unanswered === 1 ? 'consulta ficou' : 'consultas ficaram'} sem resposta de nenhum modelo e não aparece{unanswered === 1 ? '' : 'm'} aqui.</p>}
      {decisions.length === 0 ? <p className="hint m-0">Nenhuma decisão respondida ainda.</p> : (
        <ol className="m-0 grid max-h-96 list-none gap-2 overflow-y-auto p-0">
          {decisions.map((d, i) => (
            <li key={`${d.runId}-${d.at}-${i}`} className="grid gap-0.5 border-b border-line pb-2 text-[0.8125rem] last:border-b-0">
              <span className="flex flex-wrap items-baseline gap-x-2">
                <time className="font-mono text-ink-faint tabular-nums" dateTime={d.at}>{new Date(d.at).toLocaleTimeString('pt-BR')}</time>
                <b className="font-mono font-semibold text-ink">{d.decisionId}</b>
                <span className="text-ink-soft">{who(d)}</span>
                <span className="text-ink-soft">· {titles[d.key] ?? d.key}</span>
              </span>
              {d.answers.length > 0 && <span className="font-mono text-[0.75rem] text-ink-soft wrap-anywhere">{d.answers.map(said).join(' · ')}</span>}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

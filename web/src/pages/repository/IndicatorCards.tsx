import type { RepoDashboard } from '../../api.js';
import { money, plural } from '../project-shared.js';

/** The seven indicator cards of a repository, each a number the journals give; a card reads its own detail line.
 * Two columns on a phone (cost takes the whole row), four from 768 px, seven from 1280 px. */
export function IndicatorCards({ dashboard }: { dashboard: RepoDashboard }) {
  const c = dashboard.counts;
  const cards = [
    { id: 'tasks', label: 'Tarefas', value: String(c.tasks), detail: `${plural(c.delivered, 'concluída', 'concluídas')} · ${plural(c.pending, 'pendente', 'pendentes')} · ${c.running} em execução` },
    { id: 'runs', label: 'Runs', value: String(c.runs), detail: `${c.runsActive} em andamento` },
    { id: 'failures', label: 'Falhas', value: String(c.failures), detail: 'runs e tarefas com falha' },
    { id: 'blockers', label: 'Bloqueios', value: String(c.blockers), detail: 'tarefas, runs pausadas, perguntas e segredos' },
    { id: 'delivered', label: 'Entregas', value: String(c.specsDelivered), detail: `${plural(c.delivered, 'tarefa entregue', 'tarefas entregues')} · ${plural(c.specsAwaiting, 'spec aguarda', 'specs aguardam')} validação` },
    { id: 'progress', label: 'Progresso geral', value: c.progress === null ? 'sem dados' : `${c.progress}%`, detail: `${c.delivered} de ${c.tasks} tarefas` },
    { id: 'cost', label: 'Custo', value: money(c.cost), detail: `${plural(c.runs, 'run', 'runs')} deste repositório` },
  ];
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7" data-testid="repo-cards">
      {cards.map((card) => (
        <div key={card.id} className={`card grid content-start gap-1 p-3${card.id === 'cost' ? ' col-span-2 md:col-span-1' : ''}`} data-testid={`card-${card.id}`}>
          <span className="hint">{card.label}</span>
          <strong className="text-[1.125rem] tabular-nums">{card.value}</strong>
          {card.id === 'progress' && c.progress !== null && (
            <div className="h-1.5 overflow-hidden rounded-full bg-accent-line" role="progressbar" aria-label="Progresso geral" aria-valuemin={0} aria-valuemax={100} aria-valuenow={c.progress}>
              <div className="h-full rounded-full bg-accent" style={{ width: `${c.progress}%` }} />
            </div>
          )}
          <span className="hint text-[0.75rem]">{card.detail}</span>
        </div>
      ))}
    </div>
  );
}

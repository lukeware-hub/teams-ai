import type { RepoDashboard } from '../../api.js';

/** The six indicator cards of a repository, each a number the journals give; a card reads its own detail line. */
export function IndicatorCards({ dashboard }: { dashboard: RepoDashboard }) {
  const c = dashboard.counts;
  const cards = [
    { id: 'tasks', label: 'Tarefas', value: String(c.tasks), detail: `${c.delivered} concluídas · ${c.pending} pendentes · ${c.running} em execução` },
    { id: 'runs', label: 'Runs', value: String(c.runs), detail: `${c.runsActive} em andamento` },
    { id: 'failures', label: 'Falhas', value: String(c.failures), detail: 'runs e tarefas com falha' },
    { id: 'blockers', label: 'Bloqueios', value: String(c.blockers), detail: 'tarefas, runs pausadas, perguntas e segredos' },
    { id: 'delivered', label: 'Entregas', value: String(c.delivered), detail: `${c.specsDelivered} specs entregues · ${c.specsAwaiting} aguardam validação` },
    { id: 'progress', label: 'Progresso geral', value: c.progress === null ? 'sem dados' : `${c.progress}%`, detail: `${c.delivered} de ${c.tasks} tarefas` },
  ];
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6" data-testid="repo-cards">
      {cards.map((card) => (
        <div key={card.id} className="card grid content-start gap-1 p-3" data-testid={`card-${card.id}`}>
          <span className="hint">{card.label}</span>
          <strong className="text-[1.125rem]">{card.value}</strong>
          <span className="hint text-[0.75rem]">{card.detail}</span>
        </div>
      ))}
    </div>
  );
}

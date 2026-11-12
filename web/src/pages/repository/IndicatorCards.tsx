import type { RepoDashboard } from '../../api.js';
import { InfoTip } from '../../components/InfoTip.js';
import { Meter, money, plural } from '../project-shared.js';

/** The seven indicator cards of a repository, each a number the journals give; a card reads its own detail line.
 * Two columns on a phone (cost takes the whole row), four from 768 px, seven from 1280 px. */
export function IndicatorCards({ dashboard }: { dashboard: RepoDashboard }) {
  const c = dashboard.counts;
  const cards = [
    { id: 'tasks', label: 'Tarefas', help: 'Todas as tarefas planejadas para este repositório e como estão: concluídas, pendentes e em execução.', value: String(c.tasks), detail: `${plural(c.delivered, 'concluída', 'concluídas')} · ${plural(c.pending, 'pendente', 'pendentes')} · ${c.running} em execução` },
    { id: 'runs', label: 'Runs', help: 'Quantas execuções já mexeram neste repositório, e quantas ainda estão rodando.', value: String(c.runs), detail: `${c.runsActive} em andamento` },
    { id: 'failures', label: 'Falhas', help: 'Execuções e tarefas que terminaram com erro. Abra a lista de falhas abaixo para ver o motivo de cada uma.', value: String(c.failures), detail: 'runs e tarefas com falha' },
    { id: 'blockers', label: 'Bloqueios', help: 'O que está parado esperando você ou uma correção: tarefas bloqueadas, execuções pausadas, perguntas e segredos.', value: String(c.blockers), detail: 'tarefas, runs pausadas, perguntas e segredos' },
    { id: 'delivered', label: 'Entregas', help: 'Specs com todas as tarefas entregues, e quantas aguardam a sua validação.', value: String(c.specsDelivered), detail: `${plural(c.delivered, 'tarefa entregue', 'tarefas entregues')} · ${plural(c.specsAwaiting, 'spec aguarda', 'specs aguardam')} validação` },
    { id: 'progress', label: 'Progresso geral', help: 'Tarefas entregues divididas pelo total de tarefas do repositório.', value: c.progress === null ? 'sem dados' : `${c.progress}%`, detail: `${c.delivered} de ${c.tasks} tarefas` },
    { id: 'cost', label: 'Custo', help: 'Quanto as execuções deste repositório gastaram em modelos, somado, em dólar.', value: money(c.cost), detail: `${plural(c.runs, 'run', 'runs')} deste repositório` },
  ];
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7" data-testid="repo-cards">
      {cards.map((card) => (
        <div key={card.id} className={`card grid content-start gap-1 p-3 text-left hyphens-manual${card.id === 'cost' ? ' col-span-2 md:col-span-1' : ''}`} data-testid={`card-${card.id}`}>
          <span className="flex items-center gap-1">
            <span data-testid={`indicator-label-${card.id}`} className="hint">{card.label}</span>
            <InfoTip label={card.label} text={card.help} />
          </span>
          <strong data-testid={`indicator-value-${card.id}`} className="text-[1.125rem] tabular-nums">{card.value}</strong>
          {card.id === 'progress' && c.progress !== null && <Meter value={c.progress} label="Progresso geral" testId="indicator-progress" />}
          <span data-testid={`indicator-detail-${card.id}`} className="hint text-[0.75rem]">{card.detail}</span>
        </div>
      ))}
    </div>
  );
}

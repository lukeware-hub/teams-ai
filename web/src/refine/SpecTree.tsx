import { coverageGaps, coverageMatrix } from '@server/refine/coverage';
import type { AcceptanceCriterion, BacklogView } from '../api.js';
import { Icon } from '../components/Icons.js';
import { InfoTip } from '../components/InfoTip.js';

const HELP = 'Cada seção do flow.md deve ser coberta por um item; cada item tem uma spec com critérios de aceite; cada critério é coberto por tarefas do pré-plano. O que falta aparece em vermelho e impede o refinamento de ficar pronto.';
const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const criterionText = (c: AcceptanceCriterion) => `${c.id}: dado ${c.given}, quando ${c.when}, então ${c.then}`;

/** The detailed backlog as a coverage tree: doc section -> spec -> acceptance criterion -> pre-plan tasks, gaps in red. */
export function SpecTree({ backlog, evaluating = false }: { backlog: BacklogView; evaluating?: boolean }) {
  const matrix = coverageMatrix(backlog as never);
  const gaps = coverageGaps(backlog as never);
  const titles = new Map(backlog.items.map((i) => [i.key, i.title]));
  const specs = matrix.items.filter((i) => i.specId !== null).length;
  const criteria = matrix.items.reduce((n, i) => n + i.criteria.length, 0);
  const tasks = Object.values(backlog.preplans ?? {}).reduce((n, row) => n + (row.preplan?.tasks.length ?? 0), 0);
  const preplans = Object.values(backlog.preplans ?? {}).filter((row) => row.preplan).length;
  return (
    <div className="my-4 grid gap-[0.6rem]" data-testid="spec-tree">
      <h4 className="m-0 flex flex-wrap items-center gap-2">
        <Icon name="list" size={20} />
        Cobertura · {count(matrix.sections.length, 'seção', 'seções')} · {count(specs, 'spec', 'specs')} · {count(criteria, 'critério', 'critérios')} · {count(tasks, 'tarefa', 'tarefas')} · {count(gaps.length, 'lacuna', 'lacunas')}
        <InfoTip text={HELP} />
      </h4>
      {evaluating && <p className="m-0 text-[0.8125rem] text-ink-soft" data-testid="tree-progress">Detalhando… {specs}/{matrix.items.length} specs · {preplans}/{matrix.items.length} pré-planos</p>}
      {!evaluating && gaps.length > 0 && (
        <ul className="m-0 grid gap-1 rounded-md border border-bad bg-bad-soft py-[0.6rem] pr-[0.8rem] pl-[1.6rem] text-[0.8125rem] text-bad" data-testid="tree-gaps">
          {gaps.map((g, n) => <li key={n}>{g}</li>)}
        </ul>
      )}
      {matrix.sections.length > 0 && (
        <ol className="m-0 grid gap-[0.3rem] pl-[1.2rem] text-[0.8125rem] [&>li]:flex [&>li]:flex-wrap [&>li]:items-center [&>li]:gap-[0.35rem]">
          {matrix.sections.map((s, n) => (
            <li key={n} data-testid={`tree-section-${n}`} className={s.items.length > 0 ? '' : 'text-bad'}>
              <b>{s.heading}</b>
              {s.items.length > 0 ? s.items.map((k) => <span key={k} className="rounded-full bg-surface-muted px-[0.45rem] py-[0.05rem]">{titles.get(k) ?? k}</span>) : <span>sem item</span>}
            </li>
          ))}
        </ol>
      )}
      {matrix.items.map((item) => {
        const spec = backlog.specs?.[item.key]?.spec ?? null;
        const planned = backlog.preplans?.[item.key]?.preplan?.tasks ?? [];
        return (
          <details key={item.key} className="rounded-md border border-line bg-surface" data-testid={`tree-${item.key}`}>
            <summary className="flex cursor-pointer items-center gap-2 px-[0.65rem] py-[0.45rem]"><b>{titles.get(item.key) ?? item.key}</b>{item.specId ? <code className="text-[0.75rem] text-ink-faint">{item.specId}</code> : evaluating ? <span>pendente</span> : <span className="text-bad">sem spec</span>}</summary>
            <ul className="m-0 grid gap-1 pt-0 pr-[0.65rem] pb-[0.6rem] pl-[1.6rem] text-[0.8125rem]">
              {item.criteria.map((c) => {
                const full = spec?.acceptanceCriteria.find((a) => a.id === c.id);
                return (
                  <li key={c.id} data-testid={`tree-ac-${c.id}`} className={c.tasks.length > 0 ? '' : 'text-bad'}>
                    {c.id}{full && <InfoTip text={criterionText(full)} />} → {c.tasks.length > 0 ? c.tasks.map((t) => `${t} ${planned.find((x) => x.id === t)?.title ?? ''}`.trim()).join(', ') : 'sem tarefa'}
                  </li>
                );
              })}
            </ul>
          </details>
        );
      })}
    </div>
  );
}

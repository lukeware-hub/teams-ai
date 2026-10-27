import { useMemo } from 'react';
import { coverageGaps, coverageMatrix } from '@server/refine/coverage';
import type { AcceptanceCriterion, BacklogView } from '../api.js';
import { Icon } from '../components/Icons.js';
import { InfoTip } from '../components/InfoTip.js';

const HELP = 'Cada seção do flow.md deve ser coberta por um item; cada item tem uma spec com critérios de aceite; cada critério é coberto por tarefas do pré-plano. O que falta aparece em vermelho e impede o refinamento de ficar pronto.';
const stat = 'rounded-md border px-[0.6rem] py-[0.3rem] text-[0.8125rem] font-semibold normal-case tracking-normal';
const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const criterionText = (c: AcceptanceCriterion) => `${c.id}: dado ${c.given}, quando ${c.when}, então ${c.then}`;

/** The detailed backlog as a coverage tree: doc section -> spec -> acceptance criterion -> pre-plan tasks, gaps in red. */
export function SpecTree({ backlog, evaluating = false }: { backlog: BacklogView; evaluating?: boolean }) {
  const matrix = useMemo(() => coverageMatrix(backlog as never), [backlog]);
  const gaps = useMemo(() => coverageGaps(backlog as never), [backlog]);
  const titles = new Map(backlog.items.map((i) => [i.key, i.title]));
  const specs = matrix.items.filter((i) => i.specId !== null).length;
  const criteria = matrix.items.reduce((n, i) => n + i.criteria.length, 0);
  const tasks = Object.values(backlog.preplans ?? {}).reduce((n, row) => n + (row.preplan?.tasks.length ?? 0), 0);
  return (
    <div className="my-4 grid gap-[0.6rem]" data-testid="spec-tree">
      <h3 className="section-title m-0 flex items-center gap-2"><Icon name="list" size={20} />Cobertura<InfoTip text={HELP} /></h3>
      <ul className="m-0 flex list-none flex-wrap gap-2 p-0" aria-label="Resumo da cobertura">
        {[
          count(matrix.sections.length, 'seção', 'seções'),
          count(specs, 'spec', 'specs'),
          count(criteria, 'critério', 'critérios'),
          count(tasks, 'tarefa', 'tarefas'),
        ].map((text) => <li key={text} className={`${stat} border-line bg-surface text-ink-soft`}>{text}</li>)}
        <li className={`${stat} ${gaps.length === 0 ? 'border-good-line bg-good-soft text-good' : 'border-warn-line bg-warn-soft text-warn'}`}>{count(gaps.length, 'lacuna', 'lacunas')}</li>
      </ul>
      {!evaluating && gaps.length > 0 && (
        <ul className="m-0 grid gap-1 rounded-md border border-warn-line bg-warn-soft py-[0.6rem] pr-[0.8rem] pl-[1.6rem] text-[0.8125rem] text-warn" data-testid="tree-gaps">
          {gaps.map((g, n) => <li key={n}>{g}</li>)}
        </ul>
      )}
      {matrix.sections.length > 0 && (
        <ol className="m-0 grid list-none gap-1 p-0 text-[0.8125rem]">
          {matrix.sections.map((s, n) => (
            <li key={n} data-testid={`tree-section-${n}`} className={s.items.length > 0 ? '' : 'text-warn'}>
              <details className="settings-collapse">
                <summary className="settings-collapse-summary py-[0.6rem]!">
                  <Icon name="chevron-right" size={16} />
                  <span className="settings-collapse-title wrap-anywhere">{s.heading}</span>
                  <span className="settings-collapse-meta">{count(s.items.length, 'item', 'itens')}</span>
                </summary>
                <div className="settings-collapse-body">
                  <span className="flex flex-wrap gap-[0.35rem] pt-[0.85rem]">
                    {s.items.length > 0 ? s.items.map((k) => <span key={k} className="rounded-full bg-surface-muted px-[0.6rem] py-[0.15rem] leading-snug text-ink-soft">{titles.get(k) ?? k}</span>) : <span>sem item</span>}
                  </span>
                </div>
              </details>
            </li>
          ))}
        </ol>
      )}
      <div className="grid">
        {matrix.items.map((item) => {
          const spec = backlog.specs?.[item.key]?.spec ?? null;
          const planned = backlog.preplans?.[item.key]?.preplan?.tasks ?? [];
          return (
            <details key={item.key} className="settings-collapse" data-testid={`tree-${item.key}`}>
              <summary className="settings-collapse-summary flex-wrap">
                <Icon name="chevron-right" size={16} />
                <span className="settings-collapse-title flex-[1_1_12rem] wrap-anywhere">{titles.get(item.key) ?? item.key}</span>
                {item.specId ? <code className="settings-collapse-meta">{item.specId}</code> : evaluating ? <span className="settings-collapse-meta">pendente</span> : <span className="status-chip tone-bad">sem spec</span>}
              </summary>
              <div className="settings-collapse-body">
                <ul className="m-0 grid list-none gap-[0.4rem] pt-[0.85rem] text-[0.8125rem] leading-snug text-ink-soft">
                  {item.criteria.map((c) => {
                    const full = spec?.acceptanceCriteria.find((a) => a.id === c.id);
                    return (
                      <li key={c.id} data-testid={`tree-ac-${c.id}`} className={c.tasks.length > 0 ? '' : 'text-warn'}>
                        {c.id}{full && <InfoTip text={criterionText(full)} />} → {c.tasks.length > 0 ? c.tasks.map((t) => `${t} ${planned.find((x) => x.id === t)?.title ?? ''}`.trim()).join(', ') : 'sem tarefa'}
                      </li>
                    );
                  })}
                </ul>
              </div>
            </details>
          );
        })}
      </div>
    </div>
  );
}

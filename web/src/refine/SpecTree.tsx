import { useMemo, useState, type ReactNode } from 'react';
import { coverageGaps, coverageMatrix } from '@server/refine/coverage';
import type { AcceptanceCriterion, BacklogView } from '../api.js';
import { Icon } from '../components/Icons.js';
import { InfoTip } from '../components/InfoTip.js';

const HELP = 'Cada seção do flow.md deve ser coberta por um item; cada item tem uma spec com critérios de aceite; cada critério é coberto por tarefas do pré-plano. O que falta aparece em vermelho e impede o refinamento de ficar pronto.';
const stat = 'rounded-md border px-[0.6rem] py-[0.3rem] text-[0.8125rem] font-semibold normal-case tracking-normal';
const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
type Kind = 'sections' | 'specs' | 'criteria' | 'tasks';
const criterionText = (c: AcceptanceCriterion) => `${c.id}: dado ${c.given}, quando ${c.when}, então ${c.then}`;

/** A collapsible row with a chevron, a title and a count, styled like the backlog's épico rows. */
function GroupSummary({ title, total }: { title: string; total: number }) {
  return (
    <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 text-[0.8125rem] text-ink-soft [&::-webkit-details-marker]:hidden">
      <span className="flex-none transition-transform duration-[140ms] ease-out group-open:rotate-90"><Icon name="chevron-right" size={16} /></span>
      <span className="min-w-0 flex-1 font-semibold wrap-anywhere">{title}</span>
      <span className="count-pill">{total}</span>
    </summary>
  );
}

/** A collapsible épico group whose rows are the épico's sections or specs. */
function EpicGroup({ testId, title, total, children }: { testId: string; title: string; total: number; children: ReactNode }) {
  return (
    <details className="group grid open:gap-[0.4rem]" data-testid={testId}>
      <GroupSummary title={title} total={total} />
      <div className="grid gap-[0.4rem]">{children}</div>
    </details>
  );
}

/** The detailed backlog as a coverage tree: épico -> doc section or spec -> acceptance criterion -> pre-plan tasks, gaps in red. */
export function SpecTree({ backlog, evaluating = false, note }: { backlog: BacklogView; evaluating?: boolean; note?: ReactNode }) {
  const [shown, setShown] = useState<Kind | null>(null);
  const matrix = useMemo(() => coverageMatrix(backlog as never), [backlog]);
  const gaps = useMemo(() => coverageGaps(backlog as never), [backlog]);
  const titles = new Map(backlog.items.map((i) => [i.key, i.title]));
  const specs = matrix.items.filter((i) => i.specId !== null).length;
  const criteria = matrix.items.reduce((n, i) => n + i.criteria.length, 0);
  const tasks = Object.values(backlog.preplans ?? {}).reduce((n, row) => n + (row.preplan?.tasks.length ?? 0), 0);
  const epicOf = new Map(backlog.items.map((i) => [i.key, i.epic]));
  const epics = backlog.epics.map((e) => ({ ...e, items: matrix.items.filter((i) => epicOf.get(i.key) === e.key) })).filter((e) => e.items.length > 0);
  // A section goes under the épico of its first item by rank; a section with no item goes to "Sem item".
  const sectionsOf = (epicKey: string | undefined) => matrix.sections.flatMap((s, n) => ((s.items.length > 0 ? epicOf.get(s.items[0]) : undefined) === epicKey ? [{ ...s, n }] : []));
  const sectionEpics = backlog.epics.map((e) => ({ ...e, sections: sectionsOf(e.key) })).filter((e) => e.sections.length > 0);
  const orphans = sectionsOf(undefined);
  const sectionList = (list: ReturnType<typeof sectionsOf>) => (
    <ol className="m-0 grid list-none gap-1 p-0 text-[0.8125rem]">
      {list.map((s) => (
        <li key={s.n} data-testid={`tree-section-${s.n}`} className={s.items.length > 0 ? '' : 'text-warn'}>
          <details className="group">
            <GroupSummary title={s.heading} total={s.items.length} />
            <span className="flex flex-wrap gap-[0.35rem] pt-[0.25rem] pb-[0.5rem] pl-[1.6rem]">
              {s.items.length > 0 ? s.items.map((k) => <span key={k} className="rounded-full bg-surface-muted px-[0.6rem] py-[0.15rem] leading-snug text-ink-soft">{titles.get(k) ?? k}</span>) : <span>sem item</span>}
            </span>
          </details>
        </li>
      ))}
    </ol>
  );
  const epicTitle = new Map(backlog.epics.map((e) => [e.key, e.title]));
  const plannedTasks = Object.values(backlog.preplans ?? {}).flatMap((row) => row.preplan?.tasks ?? []);
  const chips: Array<{ kind: Kind; text: string }> = [
    { kind: 'sections', text: count(matrix.sections.length, 'seção', 'seções') },
    { kind: 'specs', text: count(specs, 'spec', 'specs') },
    { kind: 'criteria', text: count(criteria, 'critério', 'critérios') },
    { kind: 'tasks', text: count(tasks, 'tarefa', 'tarefas') },
  ];
  const row = (key: string, main: ReactNode, meta?: ReactNode) => (
    <li key={key} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-b border-line py-[0.45rem] last:border-b-0">
      <span className="min-w-0 flex-1 wrap-anywhere">{main}</span>
      {meta && <span className="flex-none">{meta}</span>}
    </li>
  );
  const rowsOf = (kind: Kind) => {
    if (kind === 'sections') return matrix.sections.map((s, n) => row(String(n), s.heading, count(s.items.length, 'item', 'itens')));
    if (kind === 'specs') return matrix.items.filter((i) => i.specId !== null).map((i) => row(i.key, `${titles.get(i.key) ?? i.key} · ${epicTitle.get(epicOf.get(i.key) ?? '') ?? 'Sem épico'}`, <code className="settings-collapse-meta">{i.specId}</code>));
    if (kind === 'criteria') {
      return matrix.items.flatMap((i) => i.criteria.map((c) => {
        const full = backlog.specs?.[i.key]?.spec?.acceptanceCriteria.find((a) => a.id === c.id);
        return row(`${i.key}-${c.id}`, full ? criterionText(full) : c.id, c.tasks.length > 0 ? c.tasks.join(', ') : 'sem tarefa');
      }));
    }
    return plannedTasks.map((t, n) => row(String(n), `${t.id} ${t.title}`, t.criteriaRefs.join(', ')));
  };
  const rows = shown ? rowsOf(shown) : [];
  return (
    <div className="my-4 grid gap-[0.6rem]" data-testid="spec-tree">
      <h3 className="section-title m-0 flex items-center gap-2"><Icon name="list" size={20} />Cobertura<InfoTip text={HELP} /></h3>
      <ul className="m-0 flex list-none flex-wrap gap-2 p-0" aria-label="Resumo da cobertura">
        {chips.map(({ kind, text }) => (
          <li key={kind}>
            <button type="button" aria-pressed={shown === kind} className={`${stat} cursor-pointer ${shown === kind ? 'border-accent-line bg-accent-soft text-accent-ink' : 'border-line bg-surface text-ink-soft hover:text-ink'}`} onClick={() => setShown(shown === kind ? null : kind)}>{text}</button>
          </li>
        ))}
        <li className={`${stat} ${gaps.length === 0 ? 'border-good-line bg-good-soft text-good' : 'border-warn-line bg-warn-soft text-warn'}`}>{count(gaps.length, 'lacuna', 'lacunas')}</li>
      </ul>
      {shown && (
        <ul data-testid={`coverage-list-${shown}`} className="m-0 grid list-none rounded-md border border-line bg-surface px-[0.8rem] py-[0.2rem] text-[0.8125rem] leading-snug text-ink-soft">
          {rows.length > 0 ? rows : <li className="py-[0.45rem]">Nenhum item ainda.</li>}
        </ul>
      )}
      {!evaluating && gaps.length > 0 && (
        <ul className="m-0 grid gap-1 rounded-md border border-warn-line bg-warn-soft py-[0.6rem] pr-[0.8rem] pl-[1.6rem] text-[0.8125rem] text-warn" data-testid="tree-gaps">
          {gaps.map((g, n) => <li key={n}>{g}</li>)}
        </ul>
      )}
      {note}
      {sectionEpics.map((e) => (
        <EpicGroup key={e.key} testId={`tree-section-epic-${e.key}`} title={e.title} total={e.sections.length}>
          {sectionList(e.sections)}
        </EpicGroup>
      ))}
      {orphans.length > 0 && (
        <EpicGroup testId="tree-section-epic-none" title="Sem item" total={orphans.length}>
          {sectionList(orphans)}
        </EpicGroup>
      )}
      {epics.map((epic) => (
        <EpicGroup key={epic.key} testId={`tree-epic-${epic.key}`} title={epic.title} total={epic.items.length}>
          {epic.items.map((item) => {
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
        </EpicGroup>
      ))}
    </div>
  );
}

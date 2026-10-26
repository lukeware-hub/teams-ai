import type { QuestionRow } from '../api.js';
import { Icon } from '../components/Icons.js';

/** The Spec Kit questions the PO or SM answered from the documents: closed by default, each with the quote that backs it. */
export function AgentAnswers({ rows, titles }: { rows: QuestionRow[]; titles: Map<string, string> }) {
  return (
    <details className="group rounded-lg border border-line bg-surface px-4 py-3" data-testid="agent-answers">
      <summary className="flex cursor-pointer list-none items-center gap-2 text-[0.8125rem] font-semibold text-ink [&::-webkit-details-marker]:hidden">
        <span className="text-ink-soft transition-transform group-open:rotate-90"><Icon name="chevron-right" size={16} /></span>
        Respondidas pelo PO e pelo SM ({rows.length})
      </summary>
      <ul className="m-0 mt-3 grid list-none gap-3 p-0">
        {rows.map((q) => (
          <li key={q.questionId} className="grid gap-[0.3rem] border-t border-line pt-3">
            <p className="m-0 text-[0.875rem] text-ink-soft">{q.text}</p>
            <p className="m-0 text-[0.9rem] font-semibold text-ink">{q.answer}</p>
            <small className="text-[0.75rem] text-ink-soft">
              {q.answeredBy?.toUpperCase()}{q.itemKey ? ` · ${titles.get(q.itemKey) ?? q.itemKey}` : ''}
            </small>
            {(q.evidence ?? []).map((e) => (
              <blockquote key={`${e.file}-${e.quote}`} className="m-0 grid gap-[0.2rem] rounded-md bg-surface-sunken px-3 py-2 text-[0.8125rem] leading-normal text-ink-soft">
                <span className="text-[0.75rem]">{e.file} › {e.heading || 'sem título'}</span>
                <span>“{e.quote}”</span>
              </blockquote>
            ))}
          </li>
        ))}
      </ul>
    </details>
  );
}

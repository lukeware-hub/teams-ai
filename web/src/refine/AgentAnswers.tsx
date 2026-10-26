import { useState } from 'react';
import type { QuestionRow } from '../api.js';
import { Icon } from '../components/Icons.js';

/** The Spec Kit questions the PO or the SM answered from the documents: closed by default, each with the quote that backs it. The owner may replace an answer with his own. */
export function AgentAnswers({ rows, titles, locked = false, onAnswer }: { rows: QuestionRow[]; titles: Map<string, string>; locked?: boolean; onAnswer?: (questionId: string, text: string) => unknown }) {
  const [editing, setEditing] = useState<{ questionId: string; text: string } | null>(null);
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
            {onAnswer && !locked && (editing?.questionId === q.questionId ? (
              <div className="grid gap-2">
                <textarea aria-label="Minha resposta" data-testid={`own-answer-${q.questionId}`} className="min-h-20 w-full resize-y p-3 text-[0.875rem] leading-normal" value={editing.text} onChange={(e) => setEditing({ questionId: q.questionId, text: e.target.value })} />
                <div className="flex flex-wrap gap-2">
                  <button type="button" className="primary h-10 px-3" data-testid={`save-own-${q.questionId}`} disabled={editing.text.trim() === ''} onClick={() => { onAnswer(q.questionId, editing.text.trim()); setEditing(null); }}>Salvar minha resposta</button>
                  <button type="button" className="secondary h-10 px-3" onClick={() => setEditing(null)}>Cancelar</button>
                </div>
              </div>
            ) : (
              <button type="button" className="secondary h-10 w-fit px-3 text-[0.8125rem]" data-testid={`own-${q.questionId}`} onClick={() => setEditing({ questionId: q.questionId, text: q.answer ?? '' })}>Responder eu mesmo</button>
            ))}
          </li>
        ))}
      </ul>
    </details>
  );
}

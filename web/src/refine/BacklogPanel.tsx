import type { BacklogView } from '../api.js';
import { Icon } from '../components/Icons.js';
import { InfoTip } from '../components/InfoTip.js';
import './backlog.css';

const SIZE = { S: 'pequena', M: 'média', L: 'grande' } as const;
const HELP = 'Os agentes quebram os cinco documentos em specs organizadas em épicos e priorizadas de P0 (base de tudo) a P3 (depois). Gasta uma avaliação. Para mudar prioridade ou cortes, escreva no briefing.md e reavalie. O início da execução a partir do backlog chega no próximo passo.';

/** The documents broken into prioritized specs, the way the agents organized them; the human reads and steers through the docs. */
export function BacklogPanel({ backlog, evaluating, locked, onEnable }: { backlog: BacklogView | null | undefined; evaluating: boolean; locked: boolean; onEnable?: () => void }) {
  if (!backlog?.enabled) {
    if (!onEnable) return null;
    return (
      <div className="backlog-panel card-inner" data-testid="backlog-off">
        <h4><Icon name="list" size={20} />Backlog<InfoTip text={HELP} /></h4>
        <p className="muted">Quebre os documentos em specs organizadas e priorizadas, em vez de uma spec só.</p>
        <button type="button" className="secondary" data-testid="enable-backlog" disabled={locked} onClick={onEnable}>Quebrar em backlog</button>
      </div>
    );
  }
  const titles = new Map(backlog.items.map((i) => [i.key, i.title]));
  const epics = backlog.epics.map((e) => ({ ...e, items: backlog.items.filter((i) => i.epic === e.key).sort((a, b) => a.rank - b.rank) })).filter((e) => e.items.length > 0);
  return (
    <div className="backlog-panel" data-testid="backlog-on">
      <h4><Icon name="list" size={20} />Backlog{backlog.items.length > 0 ? ` · ${backlog.items.length} specs em ${epics.length} épicos` : ''}<InfoTip text={HELP} /></h4>
      {backlog.items.length === 0 && <p className="muted">{evaluating ? 'Montando o backlog…' : 'O backlog aparece depois da próxima avaliação. Clique em Avaliar.'}</p>}
      {epics.map((epic) => (
        <section key={epic.key} className="backlog-epic" data-testid={`epic-${epic.key}`}>
          <h5><span>{epic.title}</span><span className="count-pill">{epic.items.length}</span></h5>
          <ol className="backlog-items">
            {epic.items.map((i) => (
              <li key={i.key} className="backlog-item" data-testid={`item-${i.key}`}>
                <details>
                  <summary>
                    <span className={`bk-chip bk-${i.priority.toLowerCase()}`}>{i.priority}</span>
                    <b>{i.title}</b>
                    <span className="bk-meta">#{i.rank} · {SIZE[i.size]}</span>
                  </summary>
                  <div className="bk-body">
                    <p>{i.scope}</p>
                    <p>Por quê: {i.rationale}</p>
                    {i.dependsOn.length > 0 && <p>Depende de: {i.dependsOn.map((d) => titles.get(d) ?? d).join(', ')}</p>}
                    <p>Origem: {i.sources.map((s) => `${s.doc} › ${s.heading}`).join('; ')}</p>
                  </div>
                </details>
              </li>
            ))}
          </ol>
        </section>
      ))}
    </div>
  );
}

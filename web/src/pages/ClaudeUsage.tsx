import { useEffect, useState } from 'react';
import type { ClaudeUsage, UnavailableReason, UsageLimit } from '@server/usage/claude-usage';
import { usageApi } from '../api.js';
import { InfoTip } from '../components/InfoTip.js';
import { Loading } from '../components/Loading.js';
import { hhmm } from '../refine/ProgramPanel.js';
import { panel, sectionTitle } from './project-shared.js';

const REFRESH_MS = 60_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
// At the start of a week this share counts as gone, so the first hours do not look like an overrun.
const MIN_ELAPSED = 0.1;
const HELP = 'Mostra quanto do limite de uso do seu plano Claude já foi usado na sessão atual e na semana, com a hora de cada renovação. Os números vêm do login que os agentes usam.';
const NAMES: Record<string, string> = { session: 'Sessão atual', weekly_all: 'Esta semana' };
const FILL: Record<UsageLimit['severity'], string> = { normal: 'bg-accent', warning: 'bg-warn', critical: 'bg-bad' };
const REASONS: Record<UnavailableReason, string> = {
  'not-logged-in': 'Entre no Claude pelo Login do Claude, acima, para ver o seu uso.',
  renewing: 'O login do Claude está perto de vencer e é renovado na próxima execução de um agente.',
  'no-plan': 'Este login não tem um plano Claude com limites de uso.',
  'api-key': 'Os agentes usam uma chave de API, que não tem limite de sessão nem semanal.',
  failed: 'Não foi possível ler o seu uso agora. Tente de novo em instantes.',
};

const startOfDay = (at: Date) => new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime();

/** hoje, amanhã, or the weekday of a day within the week. */
function dayName(at: Date, now: Date): string {
  const days = Math.round((startOfDay(at) - startOfDay(now)) / DAY_MS);
  if (days === 0) return 'hoje';
  if (days === 1) return 'amanhã';
  return at.toLocaleDateString('pt-BR', { weekday: 'long' });
}

function resetText(row: UsageLimit, now: Date): string | null {
  if (!row.resetsAt) return null;
  const at = new Date(row.resetsAt);
  return row.kind === 'session' ? `Redefine às ${hhmm(at)}` : `Reinicia ${dayName(at, now)}, ${hhmm(at)}`;
}

function captions(row: UsageLimit, now: Date): string[] {
  const allowance = row.allowancePercent === null ? null : `Até ${row.allowancePercent}% do seu limite semanal`;
  return [allowance, resetText(row, now)].filter((line): line is string => line !== null);
}

/** Whether the share of the weekly limit used is at or under the share of the week already gone. */
function onPace(percent: number, resetsAt: string, now: number): boolean {
  const gone = 1 - (Date.parse(resetsAt) - now) / WEEK_MS;
  return percent <= Math.min(1, Math.max(MIN_ELAPSED, gone)) * 100;
}

/** One sentence on the plan: a full meter, or how the week's pace compares with its reset. */
function summary(limits: UsageLimit[], now: Date): string | null {
  if (limits.some((row) => row.percent >= 100)) return 'Limite atingido. As execuções ficam pausadas até a renovação.';
  const weekly = limits.find((row) => row.kind === 'weekly_all');
  if (!weekly?.resetsAt) return null;
  const day = dayName(new Date(weekly.resetsAt), now);
  return onPace(weekly.percent, weekly.resetsAt, now.getTime())
    ? `Dentro do previsto. Você deve chegar à redefinição de ${day} com folga.`
    : `Acima do previsto. No ritmo atual, o limite semanal acaba antes da redefinição de ${day}.`;
}

function LimitRow({ row, now }: { row: UsageLimit; now: Date }) {
  const name = NAMES[row.kind] ?? row.label ?? 'Limite';
  return (
    <li className="grid grid-cols-[minmax(0,12rem)_minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 border-b border-line py-3 last:border-b-0 max-md:grid-cols-1">
      <div className="min-w-0">
        <p className="m-0 text-[0.9375rem] text-ink">{name}</p>
        {captions(row, now).map((line) => (
          <p key={line} className="m-0 text-[0.8125rem] text-ink-soft">{line}</p>
        ))}
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-surface-muted" role="progressbar" aria-label={name} aria-valuemin={0} aria-valuemax={100} aria-valuenow={row.percent}>
        <span className={`block size-full origin-left rounded-full transition-transform duration-[var(--duration-slow)] ease-[var(--ease-out)] ${FILL[row.severity]}`} style={{ transform: `scaleX(${row.percent / 100})` }} />
      </div>
      <span className="text-[0.8125rem] font-[650] text-ink-soft tabular-nums">{row.percent}% usado</span>
    </li>
  );
}

function UsageBody({ usage, now }: { usage: ClaudeUsage; now: Date }) {
  if (!usage.available) return <p className="m-0 text-[0.875rem] text-ink-soft">{REASONS[usage.reason]}</p>;
  const text = summary(usage.limits, now);
  return (
    <>
      {text ? <p className="m-0 text-[0.9375rem] text-ink">{text}</p> : null}
      <ul className="m-0 grid list-none p-0">
        {usage.limits.map((row) => <LimitRow key={`${row.kind}-${row.label}`} row={row} now={now} />)}
      </ul>
    </>
  );
}

const STORE_KEY = 'claude-usage';

/** The last reading kept in this tab, so a reload shows the numbers at once. */
function lastReading(): ClaudeUsage | null {
  try {
    const raw = sessionStorage.getItem(STORE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function keepReading(next: ClaudeUsage) {
  try {
    sessionStorage.setItem(STORE_KEY, JSON.stringify(next));
  } catch {
    // Blocked storage only loses the instant reload.
  }
}

export function ClaudeUsagePanel() {
  const [usage, setUsage] = useState<ClaudeUsage | null>(lastReading);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    const read = () => {
      void usageApi.claude()
        .then((next) => {
          if (!active) return;
          setUsage(next);
          keepReading(next);
          setFailed(false);
        })
        .catch(() => {
          if (active) setFailed(true);
        });
    };
    read();
    const timer = setInterval(read, REFRESH_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);
  const now = new Date();
  return (
    <section className={`${panel} gap-3`} aria-labelledby="usage-title">
      <div className={sectionTitle}>
        <h2 className="flex-[0_1_auto] text-[1.125rem] leading-[1.3]" id="usage-title">Seu uso</h2>
        {usage?.available ? <span className="text-[0.8125rem] text-ink-soft">{usage.plan}</span> : null}
        <InfoTip label="Seu uso" text={HELP} />
      </div>
      {usage ? <UsageBody usage={usage} now={now} /> : failed ? <p className="error">{REASONS.failed}</p> : <Loading />}
    </section>
  );
}

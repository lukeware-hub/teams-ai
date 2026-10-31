import type { TaskState } from '../pipeline/task-state.js';
import type { RunListStatus, RunRow } from '../api/run-index.js';

/** Every run status in plain words, the same words the run screen shows. */
export const RUN_STATUS: Record<RunListStatus, string> = {
  running: 'em andamento',
  draining: 'encerrando',
  'paused:quota': 'pausada porque a cota de uso acabou',
  'paused:auth': 'pausada por falha de login',
  'awaiting-validation': 'esperando a validação de uma pessoa',
  interrupted: 'interrompida',
  complete: 'concluída',
  done: 'concluída',
  drained: 'encerrada depois de um pedido para parar',
  blocked: 'bloqueada',
  deadlocked: 'travada',
  'phase-failed': 'fase falhou',
  'verification-failed': 'verificação falhou',
  'deploy-failed': 'deploy falhou',
  'launch-failed': 'não iniciou',
  unknown: 'sem status',
};

/** A run's status as the chat states it; an interrupted run the person stopped says so. */
export const runLabel = (run: Pick<RunRow, 'status' | 'stopped'>): string => (run.status === 'interrupted' && run.stopped ? `${RUN_STATUS.interrupted}, parada por você` : RUN_STATUS[run.status]);

/** The words of a task state, the same ones the spec block uses. */
export const TASK_STATE: Record<TaskState, string> = {
  planned: 'aguardando a vez',
  ready: 'pronta para começar',
  implementing: 'sendo desenvolvida agora',
  validating: 'em testes',
  reviewing: 'em revisão',
  rebasing: 'sendo atualizada com o código mais novo',
  merging: 'sendo incorporada ao código principal',
  merged: 'concluída',
  blocked: 'bloqueada',
  superseded: 'substituída por outra',
};

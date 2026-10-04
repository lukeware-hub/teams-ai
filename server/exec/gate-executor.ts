import type { Exec } from './command.js';
import { dockerGateExecutor, type GateExecutor } from './gate-runner.js';
import { K8sGateExecutor, type K8sExecutorConfig } from './k8s-gate-executor.js';

export type ExecutorConfig = { kind: 'docker' | 'k8s' } & K8sExecutorConfig;

/** `docker` is the default so existing setups are unchanged. */
export function createGateExecutor(cfg: ExecutorConfig, exec: Exec): GateExecutor {
  return cfg.kind === 'k8s' ? new K8sGateExecutor({ exec, config: cfg }) : dockerGateExecutor(exec);
}

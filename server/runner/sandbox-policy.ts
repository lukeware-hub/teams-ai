export const UNSAFE_NO_SANDBOX_ENV = 'TEAMS_AI_UNSAFE_NO_SANDBOX';

/**
 * The sandbox is mandatory for agent steps (audit C1). Running without it needs two independent
 * opt-ins: the config flag `sandbox.unsafeNoSandbox` and the env variable of the host process.
 * Returns the refusal message, or null when the policy allows the run.
 */
export function sandboxPolicyViolation(
  sandbox: { enabled?: boolean; unsafeNoSandbox?: boolean } | undefined,
  hostEnv: NodeJS.ProcessEnv,
): string | null {
  if (sandbox?.enabled !== false) return null;
  if (sandbox.unsafeNoSandbox === true && hostEnv[UNSAFE_NO_SANDBOX_ENV] === '1') return null;
  return `sandbox.enabled=false is refused: agent steps must run sandboxed. To run unsandboxed anyway set sandbox.unsafeNoSandbox=true in the config and ${UNSAFE_NO_SANDBOX_ENV}=1 in the environment`;
}

# Plan 26: k8s gate logs keep stdout and stderr apart

`kubectl logs` merges both streams, so the k8s executor returned everything as stdout and
`classifyGate` never saw the gate's stderr.

Approach (simplest robust): the Job runs `sh -c <wrapper> gate <command>`. The wrapper runs the
gate command (`$1`, never interpolated) with stdout and stderr redirected to two files in `/tmp`,
then prints both tails between two delimiter lines and exits with the gate's exit code. The
executor splits the log on the delimiters; a log without them (pod killed mid-way) is all stdout.
JUnit is unaffected (read from the worktree by `runGate`).

1. Tests first: golden manifest uses the wrapper; lifecycle tests prove an infra-looking stderr
   classifies as infra and a stdout test failure as code; split helper unit tests.
2. Implement wrapper, `splitGateLogs`, and the stderr plus OOMKilled reason join.
3. Verify: tsc, test/exec, full suite.

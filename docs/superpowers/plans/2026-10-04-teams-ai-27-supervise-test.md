# Plan 27: supervise CLI test and legacy compose hardening

1. Test first: run main() with the supervise command and injected fakes (run index, process control, signals) through two scan intervals. Verify: interrupted run resumed once, live run untouched, finished run skipped, SIGTERM ends the loop with exit code 0.
2. Add a `supervision` seam to UiHooks in server/cli.ts (idx + control), following the existing hooks pattern.
3. docker-compose.yml: drop the docker.sock mount, move volumes under /home/node, add a header saying Kubernetes (deploy/k8s) is the supported deployment.

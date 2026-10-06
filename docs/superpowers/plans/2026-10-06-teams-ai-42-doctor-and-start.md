# Plan 42 - `task doctor` and `task start`

Goal: one command brings the platform up and tells the user, in pt-br, what to fix when a prerequisite is missing.

- `Taskfile.yml`: `doctor` (internal checks `doctor:docker`, `doctor:daemon`, `doctor:compose`, each a Task `precondition` with a pt-br `msg`), and `start` = `doctor` -> `setup` -> `docker compose up -d --build --wait` -> open the browser (best effort, per platform).
- No Node dependency on the host: the Docker path only needs Git, Docker Desktop and Task. That is why the checks are Task preconditions and not a script.
- Verified by hand: `task doctor` passes with Docker running and prints the Docker install message when `docker` is not on PATH.
- Out of scope: port 8787 check, `/dev/net/tun` check (compose reports both on `up`).

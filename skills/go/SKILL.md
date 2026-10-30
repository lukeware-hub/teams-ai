---
name: go
description: Use when a Go build, test, vet, module, or install step fails (go build, go test, go install, go mod tidy, gotestsum, golangci-lint), or when a Go runtime panic appears in the project.
---

# Go errors

## Diagnose

1. Read the first error line of the output, not the last. Go lists the root cause first.
2. Record the Go version (`go version`) and the `go` line of `go.mod`. A tool built with an older Go can fail on a newer toolchain.
3. Reproduce with the exact command that failed, then change one thing at a time.
4. For a panic, read the goroutine stack from the top frame that belongs to the project.

## Common errors

- `invalid array length` or other errors inside `golang.org/x/...` while installing a tool: the tool pins an old `x/tools`. Install the tool at a version built for the project Go version, or pin the tool in a `tools.go` file of the module so `go.mod` resolves it.
- `go: updates to go.mod needed`: run `go mod tidy` and commit `go.mod` and `go.sum` together.
- `missing go.sum entry`: run `go mod download` and commit `go.sum`.
- `cannot find package` or `no required module provides package`: check the import path and run `go mod tidy`.
- `go install pkg@version` ignores the project `go.mod`: it resolves its own dependency set. Use a version compatible with the project Go version.
- `permission denied` on a system path during setup: use a user-writable install prefix (for example `GOBIN` inside the workspace) instead of a system directory.

## Standard tools

- `go vet ./...` for suspicious constructs.
- `go test ./... -race` for data races when concurrency is involved.
- `gofmt -l .` to list unformatted files.
- `golangci-lint run` when the project uses it.
- `go env GOPATH GOBIN GOFLAGS` to check the environment.

## Resolution flow

Follow the error flow in the agent rules: search with `agent-reach` (official docs and Go issues first), apply the fix, and rerun the failing command.

## Solutions

The `solutions/` folder keeps notes from past runs for people. The agents do not read or write it, so a note there is never applied on its own.

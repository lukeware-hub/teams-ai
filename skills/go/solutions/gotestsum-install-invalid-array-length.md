# gotestsum install fails with invalid array length

- **Error:** `internal/tokeninternal/tokeninternal.go:64: invalid array length` while running `go install gotest.tools/gotestsum@v1.12.0`
- **Context:** Go 1.26.9; gotestsum v1.12.0 resolves golang.org/x/tools v0.19.0, which does not compile with Go 1.26.9; operating system: Linux gate image
- **Root cause:** `go install pkg@version` resolves the tool with its own dependency set, not the project `go.mod`, so the old `x/tools` is built with the newer toolchain
- **Solution:** not yet applied. Candidate fixes: install a gotestsum release built for Go 1.26, or declare the tool in a `tools.go` file of the module so the project `go.mod` pins a compatible `x/tools`
- **Source:** observed in a target project's gate install of a Go service
- **Date:** 2026-10-21
- **Status:** not validated

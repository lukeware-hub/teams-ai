---
name: rust
description: Use when a Rust build, check, test, clippy, or cargo dependency step fails (cargo build, cargo test, cargo clippy, borrow checker errors, E0xxx compiler codes, linker errors, feature resolution).
---

# Rust errors

## Diagnose

1. Read the first `error[E....]` line. Run `rustc --explain E0xxx` (or `cargo build` again) for the full explanation.
2. Record `rustc --version`, the `rust-version` field of `Cargo.toml`, and the toolchain in `rust-toolchain.toml` if present.
3. Check the lock file (`Cargo.lock`) matches the manifest; a changed dependency can change the resolved versions.
4. Reproduce with the exact cargo command and change one thing at a time.

## Common errors

- `E0502` or `E0499` (borrow checker): two borrows overlap. Shorten the borrow scope or clone the value when the cost is small.
- `E0277` (trait bound not satisfied): the type lacks a trait. Check the bound in the error note, then derive or implement it.
- `E0433` or `E0432` (unresolved path or import): check the `use` path and that the item is `pub` in its module.
- `package requires rustc X` or `is not compatible with the version of rustc`: update the toolchain (`rustup update stable`) or pin an older dependency version.
- Linker errors (`cannot find -l...`, `linking with cc failed`): a system library is missing; install the `-dev` package named in the error, or enable the feature that vendors it.
- `feature ... is required` or conflicting features: check `[features]` and the `default-features` setting of the dependency.

## Standard tools

- `cargo check` for fast compile errors without linking.
- `cargo test -- --nocapture` for test output.
- `cargo clippy --all-targets -- -D warnings` for lint findings.
- `cargo tree -d` to find duplicate dependency versions.
- `rustup show` to confirm the active toolchain.

## Resolution flow

Follow the error flow in the agent rules: check `skills/rust/solutions/` first, then search with `agent-reach` (official docs, crate issue trackers, the Rust users forum), apply the fix, rerun the failing command, and record the validated result in `skills/rust/solutions/`.

## Solutions

Known fixes live in `skills/rust/solutions/`. Copy `_template.md` for a new entry. Update an existing entry instead of duplicating it.

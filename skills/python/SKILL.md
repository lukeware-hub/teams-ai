---
name: python
description: Use when a Python install, import, test, lint, or runtime step fails (pip, venv, pytest, ruff, mypy, ImportError, ModuleNotFoundError, externally-managed-environment).
---

# Python errors

## Diagnose

1. Read the last traceback frame that belongs to the project, and the exception line above it.
2. Record `python --version`. Many errors come from a different interpreter than the project expects, so compare it with the version the project declares.
3. Check the virtual environment is active and that the package is installed in it (`pip show <package>`).
4. Reproduce with the exact command, then change one thing at a time.

## Common errors

- `ModuleNotFoundError`: the package is missing from this interpreter, or the import name differs from the package name.
- `externally-managed-environment` (PEP 668): create a virtual environment (`python -m venv .venv`) and install there. Do not use `--break-system-packages`.
- `ImportError: cannot import name`: a version mismatch; check the pinned version in the lock file or requirements.
- `Python 3.x required` or `requires-python`: the interpreter is older than the project needs; use the version the project declares.
- Windows Store alias (`python` opens the Store): use `py -3` or the full path to `python.exe`.
- `pytest` collects nothing or errors on import: check `__init__.py`, the `testpaths` setting, and the import root (`PYTHONPATH` or `pythonpath` in config).

## Standard tools

- `python -m pip check` for broken dependency sets.
- `python -m pytest -x -vv <path>` to stop at the first failure with full output.
- `ruff check .` and `mypy <package>` when the project uses them.
- `python -X importtime -c "import <module>"` to find a slow or failing import.

## Resolution flow

Follow the error flow in the agent rules: search with `agent-reach` (official docs, package issue trackers, Stack Overflow), apply the fix, and rerun the failing command.

## Solutions

The `solutions/` folder keeps notes from past runs for people. The agents do not read or write it, so a note there is never applied on its own.

# Plan 43 - Windows prerequisites installer

Goal: replace the manual Step 0/Step 1 of the README by one idempotent script.

- `scripts/windows/install.ps1`: requires an elevated PowerShell and `winget`; installs WSL2 + Ubuntu only if no Ubuntu distro exists; installs Git, Docker Desktop and Task only when `winget list --id` does not find them; tells the user to reboot when WSL or Docker was installed.
- Verified: PowerShell parser reports no syntax errors. Not run end to end here (it installs software); run it twice on a clean Windows machine and check that the second run installs nothing.

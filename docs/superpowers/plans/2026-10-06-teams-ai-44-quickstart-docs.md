# Plan 44 - Quickstart docs and onboarding token link

- `README.md`: "Comece em 5 minutos (Windows)" at the top, `task start` and `task doctor` in the task table.
- Onboarding (`web/src/components/SecretCard.tsx`): GitHub token step links to the token creation page with `repo` and `workflow` already selected. Covered in `web/src/pages/Onboarding.test.tsx`.
- Deviation from the approved idea: no new server-side `hint` field. The UI is already in pt-br and `secret.hint` already means the masked value, so a second `hint` would be confusing; the link answers the real friction (which scopes to pick).

# Claude plan usage on the settings page

## Context

The settings page shows the Claude plan usage the way Claude Desktop does: the plan name, one pace sentence, and one meter per limit (the current session, this week, and a weekly limit per model) with its reset time. The agents run on the same Claude login, so these numbers are the ones that pause a run. Before this change the usage lived only in memory inside the quota breaker and never reached the page.

The page now asks the Claude Code command line for the usage. The command answers a `get_usage` control request with the same rows the usage service sends, in about two seconds, with no model call and nothing written to disk.

## Decisions

1. Ask the command line for the usage instead of calling the usage service directly. No token handling is added, and the command decides which plans have limits.
2. Never run the command while the stored login is about to renew. A renewal rotates the refresh token that the agent steps copy, so the check uses the same five-minute window as the step runner.
3. Keep each result for one minute and share one run between reads that arrive together. The page listens on every interface without a token, so a caller must not start processes freely.
4. Render the rows in the order and with the severity the server sends.
5. The pace sentence compares the share of the weekly limit used with the share of the week already gone.

## Changes

- `server/usage/claude-usage.ts`: reads the usage, maps the reply to a view, keeps the result for a minute.
- `server/api/usage-routes.ts`: `GET /api/usage/claude`, which answers every outcome with a view.
- `server/runner/step-home.ts`: reads the plan tier from the same credential reader as the expiry.
- `server/cli.ts`: connects the route.
- `web/src/pages/ClaudeUsage.tsx`: the panel, refreshed every minute.
- `web/src/pages/Settings.tsx`: shows the panel after the environment section.
- `web/src/api.ts`: `usageApi.claude`.

## Tests

- `test/usage/claude-usage.test.ts`: the captured reply, the plan labels, every failure, each blocked reason, the one-minute cache and the shared run.
- `test/api/usage-routes.test.ts`: the route answers the view.
- `web/src/pages/ClaudeUsage.test.tsx`: rows, captions, bar colours, the pace sentences, each reason, loading, a failed first read and the one-minute refresh.
- `web/src/pages/Settings.test.tsx`: the panel appears on the page.

## Verification

The full root and web suites, the root typecheck, the production build, and a look at the page in Chrome at desktop and phone widths, with the numbers compared to the raw reply.

## Limits

- The command marks this reply as experimental. The image pins the command version, and a change of shape shows as "could not read the usage" instead of an error page.
- With an expired stored login there are no numbers until the next agent run renews it.
- The panel shows the login the agents use, which is the login inside the container.

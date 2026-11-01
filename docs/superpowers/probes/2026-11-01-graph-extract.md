# Probe: isolated semantic extraction (2026-11-01)

Run once with the owner's go, with `npx tsx scripts/probes/graph-extract.ts`. Two small documents, one step home per check.

Results: the extraction exited 0 and wrote 4 nodes and 5 edges, 3 of them between different documents (`crossFileEdges`); the tool check exited 0 and wrote no file (`fileWritten: false`); the host login was not changed (`hostCredentialsUnchanged: true`).

```json
{
  "extract": {
    "exit": 0,
    "seconds": 8,
    "nodes": 4,
    "edges": 5,
    "crossFileEdges": 3,
    "inputTokens": 25314,
    "outputTokens": 919,
    "stderrTail": ""
  },
  "tool": {
    "exit": 0,
    "seconds": 10,
    "fileWritten": false,
    "stdoutHead": "{\"duration_api_ms\":5112,\"stop_reason\":\"end_turn\",\"session_id\":\"2328f865-7948-4f19-a8e5-4564ae3b3f0d\",\"total_cost_usd\":0.004516,\"usage\":{\"input_tokens\":6,\"cache_creation_input_tokens\":17590,\"cache_read",
    "stderrTail": "Warning: no stdin data received in 3s, proceeding without it. If piping from a slow command, redirect stdin explicitly: < /dev/null to skip, or wait longer.\n"
  },
  "hostCredentialsUnchanged": true
}
```

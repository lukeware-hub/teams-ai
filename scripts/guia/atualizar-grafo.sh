#!/bin/sh
# Rebuilds the graph of docs/guia with the graphify and the Claude login inside the running container,
# then records the guide hash so the test that guards a stale graph passes. Run it after editing docs/guia.
set -eu
container=$(docker compose ps -q teams-ai)
[ -n "$container" ] || { echo "Suba a plataforma antes: task up" >&2; exit 1; }
work=$(docker exec "$container" mktemp -d)
COPYFILE_DISABLE=1 tar -C docs/guia --exclude=graphify-out --exclude='._*' -cf - . | docker exec -i "$container" sh -c "mkdir -p $work/guia && tar -C $work/guia -xf -"
docker exec "$container" sh -c "cd $work && graphify extract guia --backend claude-cli --no-cluster"
mkdir -p docs/guia/graphify-out
docker cp "$container:$work/guia/graphify-out/graph.json" docs/guia/graphify-out/graph.json
docker exec "$container" rm -rf "$work"
npx tsx scripts/guia/escrever-hash.ts

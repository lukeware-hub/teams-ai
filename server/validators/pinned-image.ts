/** One `FROM` instruction: `FROM [--platform=...] <image>[:<tag>][@sha256:<digest>] [AS <stage>]` (Dockerfile grammar). */
const FROM_LINE = /^\s*FROM\s+(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+(\S+))?\s*$/i;

interface FromInstruction {
  image: string;
  stage: string | null;
}

function parseFromLines(dockerfile: string): FromInstruction[] {
  const lines: FromInstruction[] = [];
  for (const raw of dockerfile.split(/\r?\n/)) {
    const m = FROM_LINE.exec(raw);
    if (m) lines.push({ image: m[1]!, stage: m[2] ?? null });
  }
  return lines;
}

/** The tag after the last `:`, read only past the last `/` so a registry host's port (`host:5000/image`) is
 * never mistaken for a tag. Null when the image has no tag at all. */
function imageTag(image: string): string | null {
  const afterSlash = image.slice(image.lastIndexOf('/') + 1);
  const colon = afterSlash.lastIndexOf(':');
  return colon === -1 ? null : afterSlash.slice(colon + 1);
}

/**
 * Every `FROM` line's image must carry a `@sha256:` digest or an explicit non-`latest` tag (roadmap R10.2), so a
 * rebuild never silently picks up a different base image. A `FROM` that names an earlier stage by its `AS` alias
 * (multi-stage builds) is not an image reference and is never checked.
 */
export function unpinnedBaseImages(dockerfile: string): string[] {
  const froms = parseFromLines(dockerfile);
  const stages = new Set(froms.map((f) => f.stage).filter((s): s is string => s !== null));
  const bad: string[] = [];
  for (const { image } of froms) {
    if (stages.has(image)) continue;
    if (image.includes('@sha256:')) continue;
    const tag = imageTag(image);
    if (!tag || tag === 'latest') bad.push(image);
  }
  return bad;
}

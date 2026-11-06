/** The force layout of the code graph: linked nodes pull together, every node pushes its neighbours away, and each community starts in its own spot. */

export interface LayoutNode {
  id: string;
  community: string;
}

export interface Layout {
  /** Node positions, in the order the nodes were given. */
  x: Float64Array;
  y: Float64Array;
  /** Moves every node one step; false once the graph has settled. */
  step: () => boolean;
}

const STEPS = 300;
const REPEL_RADIUS = 90;
const REPEL_FORCE = 700;
const LINK_LENGTH = 26;

// A small seeded generator: the same graph always lands in the same picture.
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function createLayout(nodes: readonly LayoutNode[], links: ReadonlyArray<{ source: string; target: string }>): Layout {
  const n = nodes.length;
  const random = seeded(n * 7919 + links.length);
  const index = new Map(nodes.map((node, i) => [node.id, i]));
  const pairs: Array<[number, number]> = [];
  for (const l of links) {
    const [a, b] = [index.get(l.source), index.get(l.target)];
    if (a !== undefined && b !== undefined && a !== b) pairs.push([a, b]);
  }
  // Each community starts around its own point on a ring, so the groups are apart before any force acts.
  const communities = [...new Set(nodes.map((node) => node.community))];
  const ring = Math.max(80, Math.sqrt(n) * 18);
  const centre = new Map(communities.map((c, i) => [c, { x: ring * Math.cos((2 * Math.PI * i) / communities.length), y: ring * Math.sin((2 * Math.PI * i) / communities.length) }]));
  const linked = new Uint8Array(n);
  for (const [a, b] of pairs) {
    linked[a] = 1;
    linked[b] = 1;
  }
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  // A node with no link takes no part in the forces: it waits in a tidy disc beside the graph, so it never crowds the linked ones.
  const apart = nodes.reduce((count, _, i) => count + (linked[i] ? 0 : 1), 0);
  const discRadius = Math.sqrt(apart) * 9;
  let placed = 0;
  nodes.forEach((node, i) => {
    if (!linked[i]) {
      const angle = placed * 2.399963;
      const out = Math.sqrt(placed + 0.5) * 9;
      x[i] = ring * 2.4 + discRadius + out * Math.cos(angle);
      y[i] = out * Math.sin(angle);
      placed++;
      return;
    }
    const c = centre.get(node.community)!;
    x[i] = c.x + (random() - 0.5) * 60;
    y[i] = c.y + (random() - 0.5) * 60;
  });
  const fx = new Float64Array(n);
  const fy = new Float64Array(n);
  let done = 0;

  const step = (): boolean => {
    if (done >= STEPS || n === 0) return false;
    const heat = 1 - done / STEPS;
    fx.fill(0);
    fy.fill(0);
    // Repulsion only between nodes in the same or a touching cell of a grid, so the cost grows with the graph, not with its square.
    const cells = new Map<number, number[]>();
    const key = (cx: number, cy: number) => cx * 73856093 + cy * 19349663;
    for (let i = 0; i < n; i++) {
      if (!linked[i]) continue;
      const k = key(Math.floor(x[i]! / REPEL_RADIUS), Math.floor(y[i]! / REPEL_RADIUS));
      const list = cells.get(k);
      if (list) list.push(i);
      else cells.set(k, [i]);
    }
    for (let i = 0; i < n; i++) {
      if (!linked[i]) continue;
      const cx = Math.floor(x[i]! / REPEL_RADIUS);
      const cy = Math.floor(y[i]! / REPEL_RADIUS);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          for (const j of cells.get(key(cx + dx, cy + dy)) ?? []) {
            if (j <= i) continue;
            let ox = x[i]! - x[j]!;
            let oy = y[i]! - y[j]!;
            let d2 = ox * ox + oy * oy;
            if (d2 > REPEL_RADIUS * REPEL_RADIUS) continue;
            if (d2 < 0.01) {
              ox = random() - 0.5;
              oy = random() - 0.5;
              d2 = 0.25;
            }
            const push = REPEL_FORCE / d2;
            fx[i]! += ox * push;
            fy[i]! += oy * push;
            fx[j]! -= ox * push;
            fy[j]! -= oy * push;
          }
        }
      }
    }
    for (const [a, b] of pairs) {
      const ox = x[b]! - x[a]!;
      const oy = y[b]! - y[a]!;
      const d = Math.hypot(ox, oy) || 0.1;
      const pull = ((d - LINK_LENGTH) / d) * 0.08;
      fx[a]! += ox * pull;
      fy[a]! += oy * pull;
      fx[b]! -= ox * pull;
      fy[b]! -= oy * pull;
    }
    for (let i = 0; i < n; i++) {
      if (!linked[i]) continue;
      // A light pull to the middle keeps lone nodes from drifting out of the picture.
      fx[i]! -= x[i]! * 0.004;
      fy[i]! -= y[i]! * 0.004;
      const f = Math.hypot(fx[i]!, fy[i]!) || 1;
      const move = Math.min(f, 12 * heat + 0.5);
      x[i]! += (fx[i]! / f) * move;
      y[i]! += (fy[i]! / f) * move;
    }
    done++;
    return done < STEPS;
  };

  return { x, y, step };
}

/** Runs the layout to the end at once; used when the person asked for reduced motion and by the tests. */
export function settle(layout: Layout): void {
  while (layout.step());
}

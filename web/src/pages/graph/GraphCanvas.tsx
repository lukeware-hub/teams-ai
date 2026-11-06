import { useEffect, useMemo, useRef, useState } from 'react';
import type { GraphMapNode } from '@server/api/repository-graph.js';
import { createLayout, settle } from './layout.js';

interface View {
  scale: number;
  x: number;
  y: number;
}

const STEPS_PER_FRAME = 6;
const HIT = 10;
const prefersLessMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** The picture of the code graph: nodes coloured by community, drag to move, wheel or pinch to zoom, hover or click to follow a node's links. */
export function GraphCanvas({ nodes, links, colorOf, hidden, selected, matches, onSelect }: {
  nodes: readonly GraphMapNode[];
  links: ReadonlyArray<{ source: string; target: string }>;
  colorOf: (community: string) => string;
  /** Communities the person turned off. */
  hidden: ReadonlySet<string>;
  selected: string | null;
  /** Nodes the search found; they get a ring. */
  matches: ReadonlySet<string>;
  onSelect: (id: string | null) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const layout = useMemo(() => createLayout(nodes, links), [nodes, links]);
  const index = useMemo(() => new Map(nodes.map((n, i) => [n.id, i])), [nodes]);
  const neighbours = useMemo(() => {
    const map = new Map<number, Set<number>>();
    const add = (from: number, to: number) => {
      const set = map.get(from) ?? new Set<number>();
      set.add(to);
      map.set(from, set);
    };
    for (const l of links) {
      const [a, b] = [index.get(l.source), index.get(l.target)];
      if (a === undefined || b === undefined) continue;
      add(a, b);
      add(b, a);
    }
    return map;
  }, [links, index]);
  const [hover, setHover] = useState<number | null>(null);
  const view = useRef<View>({ scale: 1, x: 0, y: 0 });
  const moved = useRef(false);
  const fitted = useRef(true);
  const size = useRef({ w: 0, h: 0 });
  const frame = useRef(0);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef(0);
  // The latest props for the drawing, so the animation loop never reads a stale one.
  const live = useRef({ hidden, selected, matches, hover, colorOf });
  live.current = { hidden, selected, matches, hover, colorOf };

  // The view that shows the whole graph.
  const fit = () => {
    const { w, h } = size.current;
    if (w === 0 || nodes.length === 0) return;
    let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
    for (let i = 0; i < nodes.length; i++) {
      if (live.current.hidden.has(nodes[i]!.community)) continue;
      x0 = Math.min(x0, layout.x[i]!);
      x1 = Math.max(x1, layout.x[i]!);
      y0 = Math.min(y0, layout.y[i]!);
      y1 = Math.max(y1, layout.y[i]!);
    }
    if (x0 === Infinity) return;
    const scale = Math.min((w - 40) / Math.max(1, x1 - x0), (h - 40) / Math.max(1, y1 - y0));
    view.current = { scale, x: w / 2 - ((x0 + x1) / 2) * scale, y: h / 2 - ((y0 + y1) / 2) * scale };
  };

  const draw = () => {
    const el = canvas.current;
    const ctx = el?.getContext('2d');
    if (!el || !ctx) return;
    const { w, h } = size.current;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (fitted.current) fit();
    const { scale, x: tx, y: ty } = view.current;
    const { hidden: off, selected: pick, matches: found, hover: over } = live.current;
    const focus = over ?? (pick !== null ? index.get(pick) ?? null : null);
    const near = focus === null ? new Set<number>() : neighbours.get(focus) ?? new Set<number>();
    const style = getComputedStyle(el);
    const line = style.getPropertyValue('--line-strong').trim() || '#9aa3b5';
    const ring = style.getPropertyValue('--ink').trim() || '#ffffff';
    const visible = (i: number) => !off.has(nodes[i]!.community);
    const at = (i: number) => [layout.x[i]! * scale + tx, layout.y[i]! * scale + ty] as const;
    ctx.lineWidth = 1;
    for (const l of links) {
      const [a, b] = [index.get(l.source), index.get(l.target)];
      if (a === undefined || b === undefined || !visible(a) || !visible(b)) continue;
      const lit = focus !== null && (a === focus || b === focus);
      ctx.globalAlpha = focus === null ? 0.22 : lit ? 0.9 : 0.05;
      ctx.strokeStyle = lit ? ring : line;
      ctx.beginPath();
      ctx.moveTo(...at(a));
      ctx.lineTo(...at(b));
      ctx.stroke();
    }
    nodes.forEach((n, i) => {
      if (!visible(i)) return;
      const [px, py] = at(i);
      if (px < -10 || py < -10 || px > w + 10 || py > h + 10) return;
      const radius = 2.5 + Math.min(6, n.edges / 8);
      ctx.globalAlpha = focus !== null && i !== focus && !near.has(i) ? 0.15 : 1;
      ctx.fillStyle = live.current.colorOf(n.community);
      ctx.beginPath();
      ctx.arc(px, py, radius, 0, 2 * Math.PI);
      ctx.fill();
      if (found.has(n.id) || n.id === pick) {
        ctx.globalAlpha = 1;
        ctx.strokeStyle = ring;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(px, py, radius + 3.5, 0, 2 * Math.PI);
        ctx.stroke();
        ctx.lineWidth = 1;
      }
    });
    ctx.globalAlpha = 1;
  };

  // Sizes the canvas to its box.
  useEffect(() => {
    const el = canvas.current;
    const parent = box.current;
    if (!el || !parent) return;
    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      const { width, height } = parent.getBoundingClientRect();
      size.current = { w: width, h: height };
      el.width = Math.round(width * dpr);
      el.height = Math.round(height * dpr);
      draw();
    };
    resize();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(resize) : null;
    observer?.observe(parent);
    return () => observer?.disconnect();
  });

  // Runs the layout a few steps per frame so the page stays responsive, or all at once under reduced motion.
  useEffect(() => {
    fitted.current = true;
    if (prefersLessMotion()) {
      settle(layout);
      draw();
      return;
    }
    const run = () => {
      let more = true;
      for (let k = 0; k < STEPS_PER_FRAME && more; k++) more = layout.step();
      draw();
      if (more) frame.current = requestAnimationFrame(run);
    };
    frame.current = requestAnimationFrame(run);
    return () => cancelAnimationFrame(frame.current);
  }, [layout]);

  // Draws again when something the picture shows changes.
  useEffect(draw, [hidden, selected, matches, hover, colorOf]);

  const nodeAt = (clientX: number, clientY: number): number | null => {
    const rect = canvas.current!.getBoundingClientRect();
    const [mx, my] = [clientX - rect.left, clientY - rect.top];
    const { scale, x, y } = view.current;
    let best: number | null = null;
    let bestD = HIT * HIT;
    for (let i = 0; i < nodes.length; i++) {
      if (live.current.hidden.has(nodes[i]!.community)) continue;
      const d = (layout.x[i]! * scale + x - mx) ** 2 + (layout.y[i]! * scale + y - my) ** 2;
      if (d < bestD) [best, bestD] = [i, d];
    }
    return best;
  };

  const zoomAt = (px: number, py: number, factor: number) => {
    const v = view.current;
    const scale = Math.min(20, Math.max(0.05, v.scale * factor));
    const k = scale / v.scale;
    view.current = { scale, x: px - (px - v.x) * k, y: py - (py - v.y) * k };
    fitted.current = false;
    draw();
  };

  // The wheel needs a listener that may cancel the page scroll, which React's own does not allow.
  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      zoomAt(e.clientX - r.left, e.clientY - r.top, e.deltaY < 0 ? 1.15 : 1 / 1.15);
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  });

  // One pointer drags the picture, two pinch it; a press that did not move picks the node under it.
  const press = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    moved.current = false;
    pinch.current = 0;
  };
  const move = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const last = pointers.current.get(e.pointerId);
    if (!last) {
      setHover(nodeAt(e.clientX, e.clientY));
      return;
    }
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const all = [...pointers.current.values()];
    if (all.length === 2) {
      const d = Math.hypot(all[0]!.x - all[1]!.x, all[0]!.y - all[1]!.y);
      const r = canvas.current!.getBoundingClientRect();
      if (pinch.current > 0) zoomAt((all[0]!.x + all[1]!.x) / 2 - r.left, (all[0]!.y + all[1]!.y) / 2 - r.top, d / pinch.current);
      pinch.current = d;
      moved.current = true;
      return;
    }
    const [dx, dy] = [e.clientX - last.x, e.clientY - last.y];
    if (Math.hypot(dx, dy) > 2) moved.current = true;
    view.current = { ...view.current, x: view.current.x + dx, y: view.current.y + dy };
    fitted.current = false;
    draw();
  };
  const release = (e: React.PointerEvent<HTMLCanvasElement>) => {
    pointers.current.delete(e.pointerId);
    if (moved.current) return;
    const hit = nodeAt(e.clientX, e.clientY);
    onSelect(hit === null ? null : nodes[hit]!.id);
  };

  return (
    <div ref={box} data-testid="graph-canvas-box" className="relative h-[60vh] min-h-72 w-full overflow-hidden rounded-lg border border-line bg-surface-sunken">
      <canvas
        ref={canvas}
        data-testid="graph-canvas"
        role="img"
        aria-label={`Mapa do grafo do código: ${nodes.length} nós. Use a busca e a lista de comunidades para explorar pelo teclado.`}
        className="block size-full cursor-grab touch-none active:cursor-grabbing"
        onPointerDown={press}
        onPointerMove={move}
        onPointerUp={release}
        onPointerCancel={(e) => pointers.current.delete(e.pointerId)}
        onPointerLeave={() => setHover(null)}
      />
      {hover !== null ? (
        <p data-testid="graph-hover" className="pointer-events-none absolute top-2 left-2 m-0 max-w-[80%] rounded-md bg-tooltip-bg px-2 py-1 text-[0.75rem] text-tooltip-ink">{nodes[hover]!.label}</p>
      ) : null}
    </div>
  );
}

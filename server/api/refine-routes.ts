import { SECRET_NAME } from '../core/secrets.js';
import type { DocFile } from '../refine/draft.js';
import type { SessionRegistry } from '../refine/registry.js';
import type { SuggestFile } from '../refine/suggest.js';
import { ConflictError, NotFoundError } from '../refine/session.js';
import type { StoredEvent } from '../store/event-store.js';
import { tailJournal } from './journal-tail.js';
import { HttpError, type Route, type RouteContext } from './server.js';

const P = '/api';
/** Up to four 5 MB images as base64 (a third larger) plus the JSON around them. */
const IMAGES_BODY_MAX = 28 * 1024 * 1024;

const str = (v: unknown, field: string, optional = false): string => {
  const x = (v as Record<string, unknown> | null)?.[field];
  if (x === undefined && optional) return '';
  if (typeof x !== 'string') throw new HttpError(400, `${field} must be a string`);
  return x;
};

/** Session errors map to HTTP: conflict 409, not found 404, bad input 400. */
const wrap = (h: (ctx: RouteContext) => Promise<void>) => async (ctx: RouteContext) => {
  try {
    await h(ctx);
  } catch (err) {
    if (err instanceof ConflictError) throw new HttpError(409, err.message);
    if (err instanceof NotFoundError) throw new HttpError(404, err.message);
    if (err instanceof RangeError) throw new HttpError(400, err.message);
    throw err;
  }
};

export function refineRoutes(deps: { registry: SessionRegistry; log?: (line: string) => void }): Route[] {
  const { registry } = deps;
  const get = (params: Record<string, string>) => registry.get(params.projectId!, params.specId!);
  const idOf = async (s: { snapshot(): Promise<{ projectId: string; specId: string }> }) => {
    const x = await s.snapshot();
    return { sessionId: `${x.projectId}/${x.specId}` };
  };
  const optionalBody = (ctx: RouteContext) => ctx.body().catch(() => ({}));
  const S = `${P}/refine/:projectId/:specId`;
  return [
    { method: 'GET', path: `${P}/refine`, handler: wrap(async ({ json }) => json(200, await registry.list())) },
    {
      method: 'POST',
      path: `${P}/projects/new`,
      handler: wrap(async ({ body, json }) => {
        const b = await body();
        json(200, await idOf(await registry.newProject(str(b, 'projectId'), str(b, 'name'), str(b, 'description', true), str(b, 'firstSpecId', true) || undefined)));
      }),
    },
    {
      method: 'POST',
      path: `${P}/names/suggest`,
      handler: wrap(async ({ body, json }) => {
        const b = await body();
        const kind = str(b, 'kind');
        if (kind !== 'project' && kind !== 'spec') throw new HttpError(400, 'kind must be project or spec');
        json(200, await registry.suggestName(kind, { projectId: str(b, 'projectId', true) || undefined, name: str(b, 'name', true), description: str(b, 'description', true) }));
      }),
    },
    {
      method: 'POST',
      path: `${P}/projects/:projectId/specs`,
      handler: wrap(async ({ params, body, json }) => {
        const b = await body();
        json(200, await idOf(await registry.newSpec(params.projectId!, str(b, 'specId'), str(b, 'description', true))));
      }),
    },
    {
      method: 'POST',
      path: `${P}/projects/:projectId/specs/:specId/continue`,
      handler: wrap(async (ctx) => {
        const report = str(await optionalBody(ctx), 'report', true);
        ctx.json(200, await idOf(await registry.continueSpec(ctx.params.projectId!, ctx.params.specId!, report || undefined)));
      }),
    },
    {
      method: 'POST',
      path: `${P}/projects/:projectId/specs/:specId/restart`,
      handler: wrap(async (ctx) => ctx.json(200, await idOf(await registry.restartSpec(ctx.params.projectId!, ctx.params.specId!)))),
    },
    { method: 'GET', path: S, handler: wrap(async ({ params, json }) => json(200, await (await get(params)).snapshot())) },
    {
      method: 'DELETE',
      path: S,
      handler: wrap(async ({ params, json }) => {
        await registry.deleteDraft(params.projectId!, params.specId!);
        json(200, { ok: true });
      }),
    },
    {
      method: 'PUT',
      path: `${S}/docs/:file`,
      handler: wrap(async ({ params, body, json }) => {
        const file = params.file!;
        if (!['project.md', 'brief.md', 'stack.md', 'flow.md', 'design.md'].includes(file)) throw new HttpError(400, `unknown doc ${file}`);
        await (await get(params)).saveDoc(file as DocFile, str(await body(), 'text'));
        json(200, { ok: true });
      }),
    },
    {
      method: 'POST',
      path: `${S}/docs/design.md/images`,
      handler: wrap(async ({ params, body, json }) => {
        const images = (await body(IMAGES_BODY_MAX) as { images?: unknown }).images;
        if (!Array.isArray(images) || images.some((i) => typeof i?.data !== 'string')) throw new HttpError(400, 'images must be a list of {data}');
        json(200, { text: await (await get(params)).suggestDesignFromImages(images as { data: string }[]) });
      }),
    },
    {
      method: 'POST',
      path: `${S}/docs/:file/suggest`,
      handler: wrap(async ({ params, json }) => {
        const file = params.file!;
        if (!['project.md', 'brief.md', 'stack.md', 'design.md'].includes(file)) throw new HttpError(400, `no suggestion for ${file}`);
        json(200, { text: await (await get(params)).suggest(file as SuggestFile) });
      }),
    },
    {
      method: 'POST',
      path: `${S}/evaluate`,
      handler: wrap(async ({ params, json }) => {
        const s = await get(params);
        if (s.busy) throw new ConflictError('evaluation in progress');
        if (s.state.status === 'started') throw new ConflictError('session already started a run');
        s.ensureCanEvaluate();
        s.evaluate().catch((err: Error) => deps.log?.(`refine ${params.projectId}/${params.specId}: ${err.message}`));
        json(202, { state: 'evaluating' });
      }),
    },
    {
      method: 'POST',
      path: `${S}/backlog`,
      handler: wrap(async ({ params, json }) => {
        await (await get(params)).enableBacklog();
        json(200, { ok: true });
      }),
    },
    {
      method: 'POST',
      path: `${S}/backlog/detail`,
      handler: wrap(async ({ params, json }) => {
        await (await get(params)).enableDetail();
        json(200, { ok: true });
      }),
    },
    {
      method: 'POST',
      path: `${S}/answers`,
      handler: wrap(async ({ params, body, json }) => {
        const b = await body();
        await (await get(params)).answer(str(b, 'questionId'), str(b, 'text'), (b as Record<string, unknown> | null)?.docsAnswered === true);
        json(200, { ok: true });
      }),
    },
    {
      method: 'POST',
      path: `${S}/questions/:questionId/skip`,
      handler: wrap(async ({ params, json }) => {
        await (await get(params)).skip(params.questionId!);
        json(200, { ok: true });
      }),
    },
    {
      method: 'POST',
      path: `${S}/patches/:patchId/accept`,
      handler: wrap(async ({ params, json }) => {
        await (await get(params)).accept(params.patchId!);
        json(200, { ok: true });
      }),
    },
    {
      method: 'POST',
      path: `${S}/patches/:patchId/reject`,
      handler: wrap(async (ctx) => {
        const reason = str(await optionalBody(ctx), 'reason', true);
        await (await get(ctx.params)).reject(ctx.params.patchId!, reason || null);
        ctx.json(200, { ok: true });
      }),
    },
    {
      method: 'PUT',
      path: `${S}/secrets/:name`,
      handler: wrap(async ({ params, body, json }) => {
        const name = params.name!;
        if (!SECRET_NAME.test(name)) throw new HttpError(400, 'invalid secret name');
        const value = str(await body(), 'value');
        await (await get(params)).writeSecret(name, value);
        json(200, { present: true });
      }),
    },
    {
      method: 'POST',
      path: `${S}/start`,
      handler: wrap(async ({ params, json }) => json(200, await registry.start(params.projectId!, params.specId!))),
    },
    {
      method: 'GET',
      path: `${S}/program`,
      handler: wrap(async ({ params, json }) => json(200, { program: await registry.program(params.projectId!, params.specId!) })),
    },
    {
      method: 'GET',
      path: `${S}/program/decisions`,
      handler: wrap(async ({ params, json }) => json(200, await registry.programDecisions(params.projectId!, params.specId!))),
    },
    {
      method: 'POST',
      path: `${S}/program/:itemSpecId/retry`,
      handler: wrap(async ({ params, json }) => json(200, { program: await registry.retryProgramItem(params.projectId!, params.specId!, params.itemSpecId!) })),
    },
    {
      method: 'POST',
      path: `${S}/program/:itemSpecId/prioritize`,
      handler: wrap(async ({ params, json }) => json(200, { program: await registry.prioritizeProgramItem(params.projectId!, params.specId!, params.itemSpecId!) })),
    },
    {
      method: 'GET',
      path: `${S}/events`,
      handler: wrap(async ({ req, params, sse }) => {
        const s = await get(params);
        const header = req.headers['last-event-id'];
        const after = Number(Array.isArray(header) ? header[0] : (header ?? 0)) || 0;
        const w = sse();
        let last = after;
        let tail: { close(): void } | null = null;
        const send = (e: StoredEvent) => {
          last = e.seq;
          w.send('journal', e, String(e.seq));
          if (e.type === 'REFINE_STARTED_RUN') {
            w.send('end', {});
            tail?.close();
            w.close();
          }
        };
        for (const e of s.events) if (e.seq > after) send(e);
        if (s.state.status === 'started') return;
        tail = tailJournal(s.eventsFile, last, send);
        w.onClose(() => tail?.close());
      }),
    },
  ];
}

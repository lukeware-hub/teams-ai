import { ConflictError, NotFoundError } from '../refine/session.js';
import { ChatUnavailableError, type ChatService } from '../chat/service.js';
import { HttpError, type Route, type RouteContext } from './server.js';

const P = '/api/chat/:projectId';

/** Same mapping as the refinement routes: conflict 409, not found 404, bad input 400. */
const wrap = (h: (ctx: RouteContext) => Promise<void>) => async (ctx: RouteContext) => {
  try {
    await h(ctx);
  } catch (err) {
    if (err instanceof ConflictError) throw new HttpError(409, err.message);
    if (err instanceof NotFoundError) throw new HttpError(404, err.message);
    if (err instanceof RangeError) throw new HttpError(400, err.message);
    if (err instanceof ChatUnavailableError) throw new HttpError(503, err.message);
    throw err;
  }
};

export function chatRoutes(deps: { chat: ChatService }): Route[] {
  const { chat } = deps;
  return [
    { method: 'GET', path: P, handler: wrap(async ({ params, json }) => json(200, { messages: await chat.messages(params.projectId!) })) },
    {
      method: 'POST',
      path: `${P}/messages`,
      handler: wrap(async ({ params, body, json }) => {
        const text = ((await body()) as { text?: unknown } | null)?.text;
        if (typeof text !== 'string') throw new HttpError(400, 'text must be a string');
        json(200, { message: await chat.ask(params.projectId!, text) });
      }),
    },
    { method: 'DELETE', path: P, handler: wrap(async ({ params, json }) => { await chat.clear(params.projectId!); json(200, { ok: true }); }) },
  ];
}

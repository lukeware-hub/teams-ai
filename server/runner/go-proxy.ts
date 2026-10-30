import http from 'node:http';
import { pathToFileURL } from 'node:url';

/** A path of the Go module proxy protocol: a module's version list or latest version, or one version's info, mod or zip. */
const MODULE_PATH = /^\/[\w.~!/-]+\/@(?:latest|v\/(?:list|[\w.!+-]+\.(?:info|mod|zip)))$/;

/**
 * The Go module proxy of the agent sandboxes. proxy.golang.org redirects a larger zip to storage.googleapis.com, which a
 * sandbox must never reach (any bucket there would be a way out for data), so this server follows the redirect itself.
 * Anything but the module protocol is a 404, so the go command checks sums at sum.golang.org directly.
 */
export function goProxyHandler(upstream = 'https://proxy.golang.org'): http.RequestListener {
  return (req, res) => {
    const url = req.url ?? '';
    if (req.method !== 'GET' || !MODULE_PATH.test(url)) {
      res.writeHead(404).end();
      return;
    }
    // ponytail: each answer is buffered whole; stream it if module zips ever outgrow memory.
    fetch(`${upstream}${url}`)
      .then(async (r) => res.writeHead(r.status, { 'content-type': r.headers.get('content-type') ?? 'application/octet-stream' }).end(Buffer.from(await r.arrayBuffer())))
      .catch(() => res.writeHead(502).end());
  };
}

// The goproxy service of docker-compose.yml runs this file with plain node: keep it to erasable TypeScript.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) http.createServer(goProxyHandler()).listen(Number(process.env.PORT ?? 8080));

import http from 'node:http';
const port = Number(process.env.PORT ?? 3000);
http
  .createServer((req, res) => {
    if (req.url === '/health') return void res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
    res.writeHead(200, { 'content-type': 'text/plain' }).end(`hello from ${process.env.APP_GREETING ?? 'teams-ai'}\n`);
  })
  .listen(port, () => console.log(`listening on ${port}`));

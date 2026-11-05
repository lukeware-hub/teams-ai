/** Seeded flaws for the live sec run: each flawed case must come back with a blocking finding on its file; the clean one must not. */
export interface SecCase {
  name: string;
  file: string;
  flawed: boolean;
  task: string;
  code: string;
}

export const SEC_CASES: SecCase[] = [
  {
    name: 'csrf',
    file: 'transfer.js',
    flawed: true,
    task: 'adds POST /transfer, which moves money between accounts for the user of the session cookie',
    code: `const express = require('express');
const app = express();
app.use(express.urlencoded({ extended: false }));
app.post('/login', (req, res) => {
  res.cookie('sid', createSession(req.body.user), { httpOnly: true, secure: true, sameSite: 'none' });
  res.redirect('/');
});
app.post('/transfer', (req, res) => {
  const user = sessionUser(req.cookies.sid);
  moveMoney(user, req.body.to, Number(req.body.amount));
  res.sendStatus(204);
});
module.exports = app;
`,
  },
  {
    name: 'idor',
    file: 'invoices.js',
    flawed: true,
    task: 'adds GET /invoices/:id, which returns an invoice of the signed-in customer',
    code: `const express = require('express');
const router = express.Router();
router.get('/invoices/:id', requireLogin, async (req, res) => {
  const invoice = await db.query('SELECT * FROM invoices WHERE id = $1', [req.params.id]);
  res.json(invoice.rows[0]);
});
module.exports = router;
`,
  },
  {
    name: 'cors',
    file: 'server.js',
    flawed: true,
    task: 'adds GET /me, which returns the profile and the API token of the signed-in user to the web app',
    code: `const express = require('express');
const cors = require('cors');
const app = express();
app.use(cors({ origin: (origin, done) => done(null, origin), credentials: true }));
app.get('/me', requireLogin, (req, res) => res.json({ email: req.user.email, apiToken: req.user.apiToken }));
module.exports = app;
`,
  },
  {
    name: 'ssrf',
    file: 'preview.js',
    flawed: true,
    task: 'adds GET /preview?url=, which fetches a page for the signed-in user and returns its text',
    code: `const express = require('express');
const router = express.Router();
router.get('/preview', requireLogin, async (req, res) => {
  const page = await fetch(req.query.url);
  res.type('text/plain').send(await page.text());
});
module.exports = router;
`,
  },
  {
    name: 'clean',
    file: 'notes.js',
    flawed: false,
    task: 'adds GET /notes/:id, which returns a note of the signed-in user',
    code: `const express = require('express');
const router = express.Router();
router.get('/notes/:id', requireLogin, async (req, res) => {
  if (!/^\\d+$/.test(req.params.id)) return res.sendStatus(400);
  const note = await db.query('SELECT id, title, body FROM notes WHERE id = $1 AND owner_id = $2', [req.params.id, req.user.id]);
  if (note.rows.length === 0) return res.sendStatus(404);
  res.json(note.rows[0]);
});
module.exports = router;
`,
  },
];

import { XMLParser, XMLValidator } from 'fast-xml-parser';

export type TestStatus = 'passed' | 'failed' | 'skipped';

export interface TestResult {
  /** `<classname>::<name>`; classname falls back to the enclosing suite name. */
  id: string;
  name: string;
  classname: string;
  status: TestStatus;
  acIds: string[];
}

export class JUnitParseError extends Error {}

type XmlNode = Record<string, unknown>;

// `[AC-001]` in a test name, or `ac_001` / `ac-001` where an identifier cannot hold brackets (Rust fn, pytest def).
const AC_TAG = /\[ac-(\d{3})\]|(?<![a-z0-9])ac[_-](\d{3})(?!\d)/gi;

export function extractAcIds(text: string): string[] {
  const ids = new Set<string>();
  for (const match of text.matchAll(AC_TAG)) ids.add(`AC-${match[1] ?? match[2]}`);
  return [...ids];
}

function asNode(value: unknown): XmlNode {
  return value !== null && typeof value === 'object' ? (value as XmlNode) : {};
}

function asNodes(value: unknown): XmlNode[] {
  if (value === undefined || value === null || value === '') return [];
  return (Array.isArray(value) ? value : [value]).map(asNode);
}

interface RawCase {
  node: XmlNode;
  suiteName: string;
}

function collectCases(container: XmlNode, suiteName: string, out: RawCase[]): void {
  const ownName = typeof container.name === 'string' && container.name !== '' ? container.name : suiteName;
  for (const node of asNodes(container.testcase)) out.push({ node, suiteName: ownName });
  for (const child of asNodes(container.testsuite)) collectCases(child, ownName, out);
  for (const child of asNodes(container.testsuites)) collectCases(child, ownName, out);
}

/**
 * TAP is the default output of `node --test` outside a terminal; a smoke/e2e command that does not write JUnit still reports every
 * test this way. `ok`/`not ok` lines count at any indentation: the idiomatic way to write one `[AC-xxx]` test per criterion is
 * `test('[AC-xxx] ...', ...)` nested inside a `describe(...)` block (the convention `test.md`/`sm.md` lead agents to), and Node's
 * test runner indents every nested subtest's own `ok`/`not ok` line under its parent's. Requiring zero indentation (as this used
 * to) silently credited only the parent `describe`'s rollup line, which carries no `[AC-xxx]` tag, so every criterion read back
 * as "no smoke test" even though the suite passed in full (live, R8.7 golden run, 2026-10-08: TAP showed `# pass 3, # fail 0` and
 * the deploy still failed at smoke). An untagged rollup line is harmless here: `evaluateSmoke`/`evaluateE2e` only match rows whose
 * `acIds` includes the specific criterion, so a parent line with no tag is simply never selected by either.
 * The `spec` reporter lines (`✔ name (1ms)`, `✖ name`, `﹣ name # SKIP`) count too: a command that picks that reporter prints no TAP. * `go test -v` (`--- PASS: TestSmoke/[AC-003]_name (0.00s)`), `cargo test` (`test ac_003_name ... ok`) and `pytest -v`
 * (`test_x.py::test_ac_003_name PASSED`) result lines count too: those smoke/e2e commands print no TAP.
 */
/** One result line of go test -v, cargo test or pytest -v; null for any other line. */
function otherRunnerLine(line: string): { name: string; status: TestResult['status'] } | null {
  const go = /^\s*--- (PASS|FAIL|SKIP): (\S+)/.exec(line);
  if (go) return { name: go[2]!, status: go[1] === 'PASS' ? 'passed' : go[1] === 'FAIL' ? 'failed' : 'skipped' };
  const cargo = /^test (\S+) \.\.\. (ok|FAILED|ignored)$/.exec(line.trim());
  if (cargo) return { name: cargo[1]!, status: cargo[2] === 'ok' ? 'passed' : cargo[2] === 'FAILED' ? 'failed' : 'skipped' };
  const pytest = /^(\S+::\S+) (PASSED|FAILED|ERROR|SKIPPED)\b/.exec(line.trim());
  if (pytest) return { name: pytest[1]!, status: pytest[2] === 'PASSED' ? 'passed' : pytest[2] === 'SKIPPED' ? 'skipped' : 'failed' };
  return null;
}

export function parseTap(text: string): TestResult[] {
  const out: TestResult[] = [];
  for (const line of text.split(/\r?\n/)) {
    const tap = /^\s*(not )?ok \d+(?: -)? (.*)$/.exec(line);
    const spec = tap ? null : /^\s*([✔✖﹣]) (.*)$/.exec(line);
    const other = tap || spec ? null : otherRunnerLine(line);
    if (other) {
      out.push({ id: `tap::${other.name}`, classname: 'tap', ...other, acIds: extractAcIds(other.name) });
      continue;
    }
    if (!tap && !spec) continue;
    const rest = (tap?.[2] ?? spec![2])!;
    const skipped = /#\s*(skip|todo)\b/i.test(rest) || spec?.[1] === '﹣';
    const failed = tap ? Boolean(tap[1]) : spec![1] === '✖';
    const name = rest.replace(/\s+#\s*(skip|todo)\b.*$/i, '').replace(/\s+\([\d.]+m?s\)$/, '').trim();
    out.push({ id: `tap::${name}`, name, classname: 'tap', status: skipped ? 'skipped' : failed ? 'failed' : 'passed', acIds: extractAcIds(name) });
  }
  return out;
}

export function parseJUnit(xml: string): TestResult[] {
  const validation = XMLValidator.validate(xml);
  if (validation !== true) {
    throw new JUnitParseError(`invalid JUnit XML: ${validation.err.msg} (line ${validation.err.line})`);
  }
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '',
    isArray: (name) => name === 'testsuites' || name === 'testsuite' || name === 'testcase',
  });
  const cases: RawCase[] = [];
  collectCases(asNode(parser.parse(xml)), '', cases);

  return cases.map(({ node, suiteName }) => {
    const name = String(node.name ?? '');
    const classname = typeof node.classname === 'string' && node.classname !== '' ? node.classname : suiteName;
    const status: TestStatus =
      'failure' in node || 'error' in node ? 'failed' : 'skipped' in node ? 'skipped' : 'passed';
    const acIds = status === 'skipped' ? [] : extractAcIds(`${classname} ${name}`);
    return { id: `${classname}::${name}`, name, classname, status, acIds };
  });
}

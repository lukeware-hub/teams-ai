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

const AC_TAG = /\[ac-(\d{3})\]/gi;

export function extractAcIds(text: string): string[] {
  const ids = new Set<string>();
  for (const match of text.matchAll(AC_TAG)) ids.add(`AC-${match[1]}`);
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

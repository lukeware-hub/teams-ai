// The eight kinds the documentation repository may hold: five documents, and spec, plan and task per alias (plan 119).
const FIVE_DOCS = /^docs\/(?:project|flow|briefing|design|stack)\.md$/;
const SPEC_FILE = /^docs\/(?:([^/]+)\/)?specify\/([^/]+)\/(?:spec|plan|task)\.md$/;
const ALIAS = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SERVICE = /^[a-z0-9]+(?:-[a-z0-9]+)*-(?:api|jobs|web|mobile|workflow)$/;
const WINDOWS_DEVICE = /^(?:con|nul|aux|prn|com[1-9]|lpt[1-9])$/;

const isAlias = (value) => ALIAS.test(value) && value.length <= 40 && !WINDOWS_DEVICE.test(value);

/** Whether a path of the repository is one of the eight kinds. */
export function isEightKind(rel) {
  if (FIVE_DOCS.test(rel)) return true;
  const match = SPEC_FILE.exec(rel);
  return match !== null && isAlias(match[2]) && (match[1] === undefined || SERVICE.test(match[1]));
}

/** The paths of a list that are not one of the eight kinds. */
export const disallowedFiles = (files) => files.filter((rel) => !isEightKind(rel));

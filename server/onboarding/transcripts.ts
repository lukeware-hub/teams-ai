import { redactSecrets } from '../core/redact.js';

export type Cli = 'claude' | 'gh';

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const OSC = /\x1b\][^\x07]*?(?:\x07|\x1b\\)/g;
const URL = /https:\/\/[^\s"'<>\x1b]+/;
const TERMINATED_URL = /https:\/\/[^\s\"'<>\x1b]+(?=\s)/;
const ONE_TIME_CODE = /one-time code(?:[^A-Z0-9]{1,20})([A-Z0-9]{4}-[A-Z0-9]{4})/i;
const PASTE_CODE = /paste[^\n]{0,40}code|enter[^\n]{0,40}code|authorization code|code here/i;
const SUCCESS: Record<Cli, RegExp> = {
  gh: /logged in as/i,
  claude: /login successful|logged in|successfully (?:logged in|authenticated)/i,
};
export const TAIL_CHARS = 4096;

export function stripAnsi(text: string): string {
  return text.replace(ANSI, '').replace(OSC, '');
}

export function extractUrl(text: string): string | null {
  const m = URL.exec(stripAnsi(text));
  return m ? m[0].replace(/[.,;:)\]]+$/, '') : null;
}

export function extractOneTimeCode(text: string): string | null {
  const m = ONE_TIME_CODE.exec(stripAnsi(text));
  return m ? m[1]!.toUpperCase() : null;
}

export function isPasteCodePrompt(text: string): boolean {
  return PASTE_CODE.test(stripAnsi(text));
}

export function isSuccessLine(cli: Cli, text: string): boolean {
  return SUCCESS[cli].test(stripAnsi(text));
}

export interface TranscriptState {
  url: string | null;
  code: string | null;
  pasteCodePrompt: boolean;
  success: boolean;
}

/**
 * Spec (onboarding) §3: the pty output is redacted before it is stored or streamed; the raw text is
 * never kept. State is derived from the whole (redacted) transcript so a URL split across chunks
 * is still found; a URL is only accepted once whitespace follows it, so a chunk boundary inside the
 * URL does not freeze a truncated value.
 */
export class TranscriptReader {
  readonly state: TranscriptState = { url: null, code: null, pasteCodePrompt: false, success: false };
  private buffer = '';

  constructor(
    private readonly cli: Cli,
    private readonly known: () => readonly string[],
  ) {}

  get tail(): string {
    return this.buffer.length > TAIL_CHARS ? this.buffer.slice(-TAIL_CHARS) : this.buffer;
  }

  push(chunk: string): string {
    const clean = redactSecrets(stripAnsi(chunk), this.known());
    this.buffer = (this.buffer + clean).slice(-TAIL_CHARS * 2);
    if (this.state.url === null) {
      const m = TERMINATED_URL.exec(this.buffer);
      if (m) this.state.url = extractUrl(m[0]);
    }
    if (this.state.code === null) this.state.code = extractOneTimeCode(this.buffer);
    if (!this.state.pasteCodePrompt && this.cli === 'claude') this.state.pasteCodePrompt = isPasteCodePrompt(this.buffer);
    if (!this.state.success) this.state.success = isSuccessLine(this.cli, this.buffer);
    return clean;
  }
}

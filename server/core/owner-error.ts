/** A failure the owner reads: the message is the plain reason, and the detail holds the raw errors for the log. */
export class OwnerError extends Error {
  readonly detail: string;
  constructor(message: string, detail: string) {
    super(message);
    this.name = 'OwnerError';
    this.detail = detail;
  }
}

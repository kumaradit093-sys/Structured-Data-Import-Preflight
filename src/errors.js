/** An input, file, or configuration failure. Inspect code to handle it programmatically. */
export class PreflightError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PreflightError';
    this.code = code;
  }
}

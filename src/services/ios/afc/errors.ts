/**
 * Raised when an AFC socket is no longer usable (timeout, desync, or close).
 */
export class AfcConnectionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'AfcConnectionError';
  }
}

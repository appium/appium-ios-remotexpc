export class TunnelAvailabilityError extends Error {
  readonly code = 'ERR_TUNNEL_AVAILABILITY';

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

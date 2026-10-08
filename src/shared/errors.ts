// Typed "durable object not initialized" error. Both SessionDO and ManualDO load
// their state lazily; a read/mutate before create()/init() (or after reset())
// must fail loudly and consistently rather than dereferencing an undefined
// `this.data`. The HTTP boundary translates this into a clean 404 in one place.
//
// NOTE: thrown errors crossing a Workers RPC boundary are reconstructed as plain
// Errors on the caller side — `instanceof` does NOT survive. Detection therefore
// matches the sentinel message, which IS preserved.

export const NOT_INITIALIZED = 'DO_NOT_INITIALIZED';

export class NotInitialized extends Error {
  constructor() {
    super(NOT_INITIALIZED);
    this.name = 'NotInitialized';
  }
}

export function isNotInitialized(err: unknown): boolean {
  return err instanceof Error && err.message.includes(NOT_INITIALIZED);
}

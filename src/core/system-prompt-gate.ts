import type { Clock } from "../clock.js";

/**
 * Remembers credentials whose Cursor account is not enabled for the SDK
 * `systemPrompt` option. The SDK reports the gate only on the first `send()`
 * of an agent created with it, so the first request on such a credential is
 * retried with the inline prompt and later requests skip the doomed attempt.
 * Keyed by credential fingerprint; holds no key material.
 */
export class SystemPromptGate {
  private readonly gatedUntil = new Map<string, number>();

  constructor(
    private readonly clock: Clock,
    private readonly ttlMs = 6 * 60 * 60_000,
  ) {}

  isGated(fingerprint: string): boolean {
    const until = this.gatedUntil.get(fingerprint);
    if (until === undefined) return false;
    if (until <= this.clock.now()) {
      this.gatedUntil.delete(fingerprint);
      return false;
    }
    return true;
  }

  markGated(fingerprint: string): void {
    this.gatedUntil.set(fingerprint, this.clock.now() + this.ttlMs);
  }

  /** The SDK names the harness flag when an account lacks access. */
  static matches(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error ?? "");
    return /--system-prompt/i.test(message);
  }
}

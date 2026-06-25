/**
 * Runtime/fake helpers for ProviderPorts and Clock.
 *
 * The *types* (ProviderPorts, Clock, Prompter, RunCommand, etc.) are declared
 * in types.ts. This file provides:
 *   - FakeFetch: test double for the fetch port (queue-based, no real network)
 *   - FakeClock: test double for Clock (controllable time + sleep)
 *   - FakePrompter: test double for Prompter (captures calls, no output)
 *   - FakeRunCommand: test double for RunCommand (queue-based, no real subprocess)
 *
 * Following the FakeSecretStore/ThrowingSecretStore pattern in testing.ts.
 * All fakes are exported for reuse across test suites.
 */

import type { Clock, Prompter, RunCommand, RunCommandResult } from "./types.js";

// ---------------------------------------------------------------------------
// FakeFetch
// ---------------------------------------------------------------------------

export interface FakeFetchCall {
  url: string;
  init: RequestInit | undefined;
}

interface QueuedResponse {
  status: number;
  body: unknown;
}

/**
 * Queue-based fetch fake. Push responses in order; each call consumes one
 * entry. Asserts no unconsumed responses remain at test end (unless
 * `relaxedExhaustion` is set).
 *
 * Usage:
 *   const ff = new FakeFetch();
 *   ff.pushJson(200, { access_token: "tok" });
 *   const result = await someFunction({ ..., fetch: ff.fetch });
 *   ff.assertExhausted(); // in afterEach
 */
export class FakeFetch {
  private _queue: QueuedResponse[] = [];
  /** All calls made, in order. Exposed for assertion. */
  readonly calls: FakeFetchCall[] = [];
  /** When true, assertExhausted() is a no-op (for tests that over-provision). */
  relaxedExhaustion = false;

  /** Push a JSON response onto the queue. */
  pushJson(status: number, body: unknown): void {
    this._queue.push({ status, body });
  }

  /** Push a network error (fetch rejects) onto the queue. */
  pushError(error: Error): void {
    this._queue.push({ status: -1, body: error });
  }

  /** The fetch function to pass as a port. Arrow function to preserve `this`. */
  readonly fetch: typeof globalThis.fetch = (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;

    this.calls.push({ url, init });

    if (this._queue.length === 0) {
      return Promise.reject(
        new Error(
          `FakeFetch: unexpected call to ${url} — queue is empty. Push more responses with pushJson().`,
        ),
      );
    }

    const entry = this._queue.shift();
    if (entry === undefined) {
      return Promise.reject(new Error("FakeFetch: queue unexpectedly empty"));
    }

    if (entry.status === -1) {
      return Promise.reject(entry.body as Error);
    }

    const json = entry.body;
    const response = {
      ok: entry.status >= 200 && entry.status < 300,
      status: entry.status,
      statusText: entry.status === 200 ? "OK" : String(entry.status),
      json: () => Promise.resolve(json),
      text: () => Promise.resolve(JSON.stringify(json)),
      headers: new Headers(),
    } as unknown as Response;

    return Promise.resolve(response);
  };

  /** Assert all queued responses were consumed. Call in afterEach. */
  assertExhausted(): void {
    if (!this.relaxedExhaustion && this._queue.length > 0) {
      throw new Error(
        `FakeFetch: ${this._queue.length} unconsumed response(s) remain after test.`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// FakeClock
// ---------------------------------------------------------------------------

/**
 * Controllable Clock for tests. `sleep()` resolves immediately (no real delay)
 * and records the requested duration in `sleepHistory`.
 *
 * When `autoAdvance` is true, each sleep call also increments `currentTime` by
 * the sleep amount, so `now()` reflects the passage of simulated time.
 */
export class FakeClock implements Clock {
  /** Current simulated time in epoch-ms. */
  currentTime: number;
  /** Whether sleep() advances currentTime. Default: true. */
  autoAdvance: boolean;
  /** All sleep durations requested, in order. */
  readonly sleepHistory: number[] = [];

  constructor(initialTime = 1_000_000_000_000) {
    this.currentTime = initialTime;
    this.autoAdvance = true;
  }

  now(): number {
    return this.currentTime;
  }

  async sleep(ms: number): Promise<void> {
    this.sleepHistory.push(ms);
    if (this.autoAdvance) {
      this.currentTime += ms;
    }
    // Resolves immediately — no real delay
  }

  /** Total ms slept across all sleep() calls. */
  get totalSlept(): number {
    return this.sleepHistory.reduce((acc, ms) => acc + ms, 0);
  }
}

// ---------------------------------------------------------------------------
// FakePrompter
// ---------------------------------------------------------------------------

export interface DisplayDeviceCodeCall {
  userCode: string;
  verificationUri: string;
  expiresIn: number;
}

/**
 * No-op Prompter for tests. Captures calls to displayDeviceCode without
 * producing any output.
 */
export class FakePrompter implements Prompter {
  readonly displayDeviceCodeCalls: DisplayDeviceCodeCall[] = [];

  async displayDeviceCode(opts: {
    userCode: string;
    verificationUri: string;
    expiresIn: number;
  }): Promise<void> {
    this.displayDeviceCodeCalls.push({ ...opts });
  }
}

// ---------------------------------------------------------------------------
// FakeRunCommand
// ---------------------------------------------------------------------------

interface QueuedRunResult {
  result: RunCommandResult | Error;
}

/**
 * Queue-based RunCommand fake for tests. Push results in order; each call
 * consumes one entry.
 *
 * Usage:
 *   const frc = new FakeRunCommand();
 *   frc.push({ exitCode: 0, stdout: '{"token":"t"}', stderr: "" });
 *   const result = await frc.run("some-cmd", ["arg1"]);
 */
export class FakeRunCommand {
  private _queue: QueuedRunResult[] = [];
  /** All calls made, in order. */
  readonly calls: Array<{ command: string; args: string[] }> = [];

  push(result: RunCommandResult | Error): void {
    this._queue.push({ result });
  }

  readonly run: RunCommand = async (
    command: string,
    args: string[],
    _opts?: { timeoutMs?: number },
  ): Promise<RunCommandResult> => {
    this.calls.push({ command, args });

    if (this._queue.length === 0) {
      throw new Error(
        `FakeRunCommand: unexpected call to "${command}" — queue is empty.`,
      );
    }

    const entry = this._queue.shift();
    if (entry === undefined) {
      throw new Error("FakeRunCommand: queue unexpectedly empty");
    }
    if (entry.result instanceof Error) {
      throw entry.result;
    }
    return entry.result;
  };
}

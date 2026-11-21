import { matchesBlompFileKey } from "./blomp-keys";

export const trialDMaxFileBytes = 512 * 1024;
export const trialDMaxPayloadBytes = 3 * 1024 * 1024;
export const trialDMaxRequests = 22;

const operations = [
  "create",
  "listBefore",
  "part",
  "headBefore",
  "listAfter",
  "complete",
  "headAfter",
  "verify",
  "download",
] as const;
type Operation = (typeof operations)[number] | "options";
type File = { key: string; size: number };

export class TrialDBudget {
  private readonly sessions: Map<
    string,
    { size: number; next: number; options: number }
  >;
  private requests = 0;
  private payload = 0;
  private stopped = false;

  constructor(owner: string, files: readonly File[]) {
    if (
      files.length !== 2 ||
      files[0].key === files[1].key ||
      files.some(
        ({ key, size }) =>
          !key.startsWith("axfluxo/05_完成品/") ||
          !matchesBlompFileKey(key, "outputs", owner) ||
          !Number.isSafeInteger(size) ||
          size < 1 ||
          size > trialDMaxFileBytes,
      )
    )
      throw Error("TRIAL_D_SCOPE");
    this.sessions = new Map(
      files.map(({ key, size }) => [key, { size, next: 0, options: 0 }]),
    );
  }

  get counters() {
    return {
      requests: this.requests,
      reservedPayloadBytes: this.payload,
      stopped: this.stopped,
    };
  }

  stop() {
    this.stopped = true;
  }

  /** Reserve synchronously before issuing or accepting any in-scope request.
   * Reservations survive failure and must share one instance across all paths. */
  reserve(key: string, operation: Operation) {
    const session = this.sessions.get(key);
    const payload =
      operation === "part" || operation === "verify" || operation === "download"
        ? (session?.size ?? 0)
        : 0;
    if (
      this.stopped ||
      !session ||
      this.requests >= trialDMaxRequests ||
      this.payload + payload > trialDMaxPayloadBytes ||
      (operation === "options"
        ? session.options >= 2
        : operations[session.next] !== operation)
    ) {
      this.stop();
      throw Error("TRIAL_D_STOP");
    }
    this.requests++;
    this.payload += payload;
    if (operation === "options") session.options++;
    else session.next++;
    let consumed = false;
    return {
      payloadBytes: payload,
      readPayload: (body: AsyncIterable<Uint8Array> | Iterable<Uint8Array>) => {
        if (consumed || !payload) {
          this.stop();
          throw Error("TRIAL_D_STOP");
        }
        consumed = true;
        return this.readPayload(body, payload);
      },
    };
  }

  /** For file data only. Protocol bodies need their own separate bounded reader. */
  private async readPayload(
    body: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
    limit: number,
  ) {
    try {
      if (
        this.stopped ||
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > trialDMaxFileBytes
      )
        throw Error("TRIAL_D_PAYLOAD_SIZE");
      const bytes = Buffer.alloc(limit);
      let size = 0;
      for await (const chunk of body) {
        const end = size + chunk.byteLength;
        if (this.stopped || end > limit) throw Error("TRIAL_D_PAYLOAD_SIZE");
        bytes.set(chunk, size);
        size = end;
      }
      if (size !== limit) throw Error("TRIAL_D_PAYLOAD_SIZE");
      return bytes;
    } catch (error) {
      this.stop();
      throw error;
    }
  }
}

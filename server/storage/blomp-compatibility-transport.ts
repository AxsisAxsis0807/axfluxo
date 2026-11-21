import { Readable } from "node:stream";
import { blompHttpHandler } from "./blomp";

export const compatibilityMiB = 1024 ** 2;
export const compatibilityMaximumBytes = 64 * compatibilityMiB;
export const compatibilityMaximumRequests = 60;
export const compatibilityCleanupRequests = 12;
export const compatibilityControlBytes = 64 * 1024;
const cleanupByteReserve = compatibilityMiB;
const hostname = "storage.blomp.com";
export type ProbeRequest = Parameters<
  ReturnType<typeof blompHttpHandler>["handle"]
>[0];
type Driver = Pick<ReturnType<typeof blompHttpHandler>, "handle" | "destroy">;

export class CompatibilityFailure extends Error {
  constructor(
    public readonly code: string,
    public readonly status?: number,
  ) {
    super(code);
  }
}

export class ProbeServiceStop extends CompatibilityFailure {}

function serviceStopReason(status: number, contentType: string | undefined) {
  switch (status) {
    case 401:
      return "PROBE_AUTH_REQUIRED";
    case 402:
      return "PROBE_PAYMENT_REQUIRED";
    case 403:
      return "PROBE_ACCESS_DENIED";
    case 429:
      return "PROBE_RATE_LIMITED";
  }
  if (status >= 300 && status < 400) return "PROBE_REDIRECT_BLOCKED";
  if (/^text\/html\b/i.test(contentType ?? "")) return "PROBE_HTML_RESPONSE";
}

/** The SDK, signed requests and OPTIONS all use this single guarded transport. */
export class CompatibilityTransport {
  readonly metadata = { handlerProtocol: "http/1.1" };
  private requestCount = 0;
  private sent = 0;
  private received = 0;
  private readonly startedKeys = new Set<string>();
  private readonly uploadIds = new Map<string, string>();
  private pendingResponse?: Readable;
  private envelope?: { responseLimit: number; cleanup: boolean; used: boolean };
  constructor(
    private readonly bucket: string,
    private readonly keys: ReadonlySet<string>,
    private readonly driver: Driver = blompHttpHandler(),
    private readonly singleObjectLimit?: number,
    private readonly recordStatus?: (method: string, status: number) => void,
    private readonly imageRoundTrip = false,
  ) {
    if (
      keys.size < 1 ||
      keys.size > 3 ||
      (singleObjectLimit !== undefined &&
        (keys.size !== 1 ||
          !Number.isSafeInteger(singleObjectLimit) ||
          singleObjectLimit < 1 ||
          singleObjectLimit > (imageRoundTrip ? 1_027_053 : 1_000_000)))
    )
      throw new CompatibilityFailure("OUT_OF_SCOPE");
  }
  get counters() {
    return {
      requests: this.requestCount,
      uploadBytesReserved: this.sent,
      responseBytes: this.received,
      multipartStarts: this.startedKeys.size,
    };
  }
  bindUpload(key: string, id: string) {
    if (
      !this.startedKeys.has(key) ||
      !id ||
      id.length > 2048 ||
      /[\x00-\x1f\x7f]/.test(id) ||
      this.uploadIds.has(key)
    )
      throw new CompatibilityFailure("UPLOAD_ID_UNCONFIRMED");
    this.uploadIds.set(key, id);
  }
  destroy() {
    this.driver.destroy();
  }
  async run<T>(
    responseLimit: number,
    cleanup: boolean,
    operation: () => Promise<T>,
  ) {
    if (this.envelope) throw new CompatibilityFailure("CONCURRENT_REQUEST");
    if (!Number.isSafeInteger(responseLimit) || responseLimit < 0)
      throw new CompatibilityFailure("BAD_RESPONSE_BUDGET");
    this.envelope = { responseLimit, cleanup, used: false };
    try {
      return await operation();
    } finally {
      this.pendingResponse?.destroy();
      this.pendingResponse = undefined;
      this.envelope = undefined;
    }
  }
  async handle(request: ProbeRequest) {
    const envelope = this.envelope;
    if (
      this.imageRoundTrip &&
      (envelope?.cleanup ||
        request.method !== (this.requestCount === 0 ? "PUT" : "GET"))
    )
      throw new CompatibilityFailure("OUT_OF_SCOPE");
    const prefix = "/" + this.bucket + "/";
    const path = decodeURIComponent(request.path);
    if (
      !envelope ||
      envelope.used ||
      request.protocol !== "https:" ||
      request.hostname !== hostname ||
      (request.headers.host && request.headers.host !== hostname) ||
      Object.hasOwn(request.query, "delete") ||
      (request.method !== "POST" && Object.hasOwn(request.query, "uploads")) ||
      (request.method === "DELETE" && !envelope.cleanup) ||
      (request.port !== undefined && request.port !== 443) ||
      request.username ||
      request.password ||
      request.fragment ||
      !path.startsWith(prefix) ||
      !this.keys.has(path.slice(prefix.length)) ||
      !["GET", "HEAD", "PUT", "POST", "DELETE", "OPTIONS"].includes(
        request.method,
      )
    )
      throw new CompatibilityFailure("OUT_OF_SCOPE");
    if (envelope.cleanup && !["DELETE", "HEAD", "GET"].includes(request.method))
      throw new CompatibilityFailure("OUT_OF_SCOPE");
    const key = path.slice(prefix.length);
    if (
      Object.hasOwn(request.query, "uploadId") &&
      (typeof request.query.uploadId !== "string" ||
        request.query.uploadId !== this.uploadIds.get(key))
    )
      throw new CompatibilityFailure("OUT_OF_SCOPE_UPLOAD");
    const body: unknown = request.body;
    if (
      body != null &&
      !(typeof body === "string" || body instanceof Uint8Array)
    )
      throw new CompatibilityFailure("UNBOUNDED_REQUEST_BODY");
    const upload =
      typeof body === "string"
        ? Buffer.byteLength(body)
        : (body?.byteLength ?? 0);
    if (
      this.singleObjectLimit !== undefined &&
      (!["GET", "HEAD", "PUT", "DELETE"].includes(request.method) ||
        Object.hasOwn(request.query, "uploadId") ||
        upload > this.singleObjectLimit ||
        envelope.responseLimit > this.singleObjectLimit)
    )
      throw new CompatibilityFailure("OUT_OF_SCOPE");
    const declared = request.headers["content-length"];
    if (upload && Number(declared) !== upload)
      throw new CompatibilityFailure("INVALID_REQUEST_LENGTH");
    const starts =
      request.method === "POST" && Object.hasOwn(request.query, "uploads");
    const requestLimit =
      this.singleObjectLimit !== undefined
        ? this.imageRoundTrip
          ? 2
          : 6
        : envelope.cleanup
          ? compatibilityMaximumRequests
          : compatibilityMaximumRequests - compatibilityCleanupRequests;
    const byteLimit =
      this.singleObjectLimit !== undefined
        ? (this.imageRoundTrip ? 2 : 3) * this.singleObjectLimit
        : envelope.cleanup
          ? compatibilityMaximumBytes
          : compatibilityMaximumBytes - cleanupByteReserve;
    if (
      this.requestCount >= requestLimit ||
      this.sent + this.received + upload + envelope.responseLimit > byteLimit ||
      (starts && (this.startedKeys.size >= 2 || this.startedKeys.has(key)))
    )
      throw new CompatibilityFailure("PROBE_BUDGET_EXCEEDED");
    envelope.used = true;
    this.requestCount++;
    this.sent += upload; // Includes ambiguous writes and XML so accounting is conservative.
    if (starts) this.startedKeys.add(key);
    const signal = AbortSignal.timeout(30000);
    const { response } = await this.driver.handle(request, {
      abortSignal: signal,
    });
    const incoming: unknown = response.body;
    if (!(incoming instanceof Readable))
      throw new CompatibilityFailure("INVALID_RESPONSE_BODY");
    this.recordStatus?.(request.method, response.statusCode);
    const stopReason =
      this.singleObjectLimit === undefined
        ? undefined
        : serviceStopReason(
            response.statusCode,
            response.headers["content-type"],
          );
    if (stopReason) {
      incoming.destroy();
      throw new ProbeServiceStop(stopReason, response.statusCode);
    }
    if (
      this.singleObjectLimit !== undefined &&
      request.method === "PUT" &&
      response.statusCode !== 200
    ) {
      incoming.destroy();
      throw new CompatibilityFailure(
        "PROBE_PUT_NOT_CONFIRMED",
        response.statusCode,
      );
    }
    const length = response.headers["content-length"];
    const metadataOnly = request.method === "HEAD";
    const dataRead =
      request.method === "GET" &&
      !Object.hasOwn(request.query, "uploadId") &&
      (response.statusCode === 200 || response.statusCode === 206);
    if (
      dataRead &&
      (length === undefined || response.headers["transfer-encoding"])
    ) {
      incoming.destroy();
      throw new CompatibilityFailure("UNBOUNDED_FILE_RESPONSE");
    }
    if (
      (response.statusCode >= 300 && response.statusCode < 400) ||
      (response.headers["content-encoding"] &&
        response.headers["content-encoding"] !== "identity") ||
      (!metadataOnly &&
        length !== undefined &&
        (!/^\d+$/.test(length) || Number(length) > envelope.responseLimit))
    ) {
      incoming.destroy();
      throw new CompatibilityFailure("UNSAFE_RESPONSE", response.statusCode);
    }
    if (metadataOnly || response.statusCode === 204 || length === "0") {
      incoming.destroy();
      return { response: { ...response, body: Readable.from([]) } };
    }
    this.pendingResponse = incoming;
    const accountResponse = (bytes: number) => {
      if (this.sent + this.received + bytes > byteLimit)
        throw new CompatibilityFailure("RESPONSE_BUDGET_EXCEEDED");
      this.received += bytes;
    };
    const stop = () => incoming.destroy();
    signal.addEventListener("abort", stop, { once: true });
    const bounded = Readable.from(
      (async function* () {
        let count = 0;
        try {
          if (signal.aborted) stop();
          for await (const chunk of incoming as AsyncIterable<Buffer>) {
            if (signal.aborted)
              throw new CompatibilityFailure("RESPONSE_TIMEOUT");
            count += chunk.length;
            if (count > envelope.responseLimit)
              throw new CompatibilityFailure("RESPONSE_BUDGET_EXCEEDED");
            accountResponse(chunk.length);
            yield chunk;
          }
          if (signal.aborted)
            throw new CompatibilityFailure("RESPONSE_TIMEOUT");
        } finally {
          signal.removeEventListener("abort", stop);
          incoming.destroy();
        }
      })(),
      { objectMode: false },
    );
    return { response: { ...response, body: bounded } };
  }
}

import { newBlompTestKey } from "./blomp-keys";
import { createHash, randomBytes } from "node:crypto";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { blompConfiguration, type BlompConfig } from "./blomp-config";
import {
  BlompError,
  blompClient,
  blompStorage,
  type BlompStorage,
} from "./blomp";
import {
  CompatibilityFailure,
  CompatibilityTransport,
} from "./blomp-compatibility-transport";

/** Explicit opt-in only. No service entrypoint, CI hook or import-time network activity. */
export async function verifyBlomp(
  env: Record<string, string | undefined>,
  args: string[],
  report: (step: string) => void,
  factory: typeof blompStorage = blompStorage,
  recordKey?: (key: string) => void,
) {
  const sizeOptions = args.filter((arg) => arg.startsWith("--test-bytes="));
  const approvals = args.filter((arg) => !arg.startsWith("--test-bytes="));
  if (
    approvals.length !== 2 ||
    !approvals.includes("--approved-connect") ||
    !approvals.includes("--approved-delete-test")
  )
    throw new BlompError("BLOMP_APPROVAL_REQUIRED");
  const size = sizeOptions[0]?.slice("--test-bytes=".length) ?? "1024";
  const bytes = Number(size);
  if (
    sizeOptions.length > 1 ||
    !/^[1-9]\d{0,6}$/.test(size) ||
    bytes > 1_000_000
  )
    throw new BlompError("BLOMP_SIZE_MISMATCH");
  const config = blompConfiguration(env);
  if (!config) throw new BlompError("BLOMP_DISABLED");
  report("configuration: PASS");
  if (sizeOptions.length && factory === blompStorage) {
    await verifyBoundedObject(config, bytes, report, undefined, recordKey);
    return;
  }
  const storage = factory(config);
  try {
    await probe(storage, report, bytes);
  } finally {
    storage.close();
  }
}

export async function verifyBoundedObject(
  config: BlompConfig,
  size: number,
  report: (step: string) => void,
  driver?: ConstructorParameters<typeof CompatibilityTransport>[2],
  recordKey?: (key: string) => void,
) {
  if (!Number.isSafeInteger(size) || size < 1 || size > 1_000_000)
    throw new BlompError("BLOMP_SIZE_MISMATCH");
  const key = newBlompTestKey("probe.bin");
  recordKey?.(key);
  const target = { Bucket: config.bucket, Key: key };
  const transport = new CompatibilityTransport(
    config.bucket,
    new Set([key]),
    driver,
    size,
    (method, status) => report(`${method} response: HTTP ${status}`),
  );
  const client = blompClient(config, transport);
  const body = randomBytes(size);
  const expected = createHash("sha256").update(body).digest("hex");
  const verifyBody = async (stream: AsyncIterable<Uint8Array>) => {
    const hash = createHash("sha256");
    let received = 0;
    for await (const chunk of stream) {
      received += chunk.byteLength;
      hash.update(chunk);
    }
    if (received !== size || hash.digest("hex") !== expected)
      throw new BlompError("BLOMP_HASH_MISMATCH");
  };
  const code = (error: unknown) => {
    if (error instanceof BlompError || error instanceof CompatibilityFailure)
      return error.code;
    const failure = error as {
      name?: string;
      code?: string;
      $metadata?: { httpStatusCode?: number };
    } | null;
    if (failure?.name === "TimeoutError" || failure?.code === "ETIMEDOUT")
      return "PROBE_TIMEOUT";
    if (failure?.name === "AbortError") return "PROBE_ABORTED";
    switch (failure?.name) {
      case "SignatureDoesNotMatch":
        return "PROBE_SDK_SIGNATURE_MISMATCH";
      case "InvalidAccessKeyId":
      case "ExpiredToken":
        return "PROBE_SDK_CREDENTIAL_REJECTED";
      case "NoSuchBucket":
        return "PROBE_SDK_BUCKET_NOT_FOUND";
    }
    if (
      ["ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"].includes(
        failure?.code ?? "",
      )
    )
      return "PROBE_NETWORK_FAILURE";
    if (failure?.$metadata?.httpStatusCode !== undefined)
      return "PROBE_SDK_HTTP_ERROR";
    return "BLOMP_VERIFICATION_FAILED";
  };
  const diagnostic = (error: unknown) => {
    const status =
      error instanceof CompatibilityFailure
        ? error.status
        : (error as { $metadata?: { httpStatusCode?: number } } | null)
            ?.$metadata?.httpStatusCode;
    return typeof status === "number" &&
      Number.isInteger(status) &&
      status >= 100 &&
      status <= 599
      ? `${code(error)} (HTTP ${status})`
      : code(error);
  };
  let failed = false;
  try {
    await transport.run(0, false, () =>
      client.send(
        new PutObjectCommand({
          ...target,
          Body: body,
          ContentLength: size,
          ContentType: "application/octet-stream",
        }),
      ),
    );
    report(`authenticated upload ${size} bytes: PASS`);
    const head = await transport.run(0, false, () =>
      client.send(new HeadObjectCommand(target)),
    );
    if (head.ContentLength !== size)
      throw new BlompError("BLOMP_SIZE_MISMATCH");
    report("HEAD: PASS");
    await transport.run(size, false, async () => {
      const result = await client.send(new GetObjectCommand(target));
      await verifyBody(result.Body as AsyncIterable<Uint8Array>);
    });
    report("download SHA-256: PASS");
    const url = new URL(
      await getSignedUrl(client, new GetObjectCommand(target), {
        expiresIn: 60,
      }),
    );
    if (
      url.origin !== config.endpoint ||
      url.username ||
      url.password ||
      url.hash
    )
      throw new BlompError("BLOMP_SIGNED_READ_FAILED");
    await transport.run(size, false, async () => {
      const { response } = await transport.handle({
        protocol: url.protocol,
        hostname: url.hostname,
        path: url.pathname,
        method: "GET",
        headers: {},
        query: Object.fromEntries(url.searchParams),
        clone() {
          return this;
        },
      });
      if (response.statusCode !== 200)
        throw new BlompError("BLOMP_SIGNED_READ_FAILED");
      await verifyBody(response.body as AsyncIterable<Uint8Array>);
    });
    report("signed GET SHA-256 (server, not browser CORS): PASS");
  } catch (error) {
    failed = true;
    report(`probe failed: ${diagnostic(error)}`);
  } finally {
    try {
      if (!failed) {
        await transport.run(0, true, () =>
          client.send(new DeleteObjectCommand(target)),
        );
        report("test object deletion: PASS");
        const absent = await transport
          .run(0, true, () => client.send(new HeadObjectCommand(target)))
          .then(
            () => false,
            (error: unknown) => {
              if (
                (error as { $metadata?: { httpStatusCode?: number } })
                  ?.$metadata?.httpStatusCode === 404
              )
                return true;
              throw error;
            },
          );
        if (!absent) throw new BlompError("BLOMP_CLEANUP_FAILED");
        report("post-deletion HEAD absence: PASS");
      } else if (transport.counters.requests) {
        report("cleanup not attempted; dedicated object may remain");
      }
    } catch (error) {
      failed = true;
      report(`test cleanup: FAILED (${diagnostic(error)})`);
    } finally {
      client.destroy();
      const { requests, uploadBytesReserved, responseBytes } =
        transport.counters;
      report(
        `HTTP requests: ${requests}; upload bytes reserved: ${uploadBytesReserved}; response body bytes accepted: ${responseBytes}`,
      );
    }
  }
  if (failed) throw new BlompError("BLOMP_VERIFICATION_FAILED");
}
async function probe(
  storage: BlompStorage,
  report: (step: string) => void,
  size: number,
) {
  const ref = storage.newTestReference();
  const bytes = randomBytes(size);
  const hash = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
  try {
    // No bucket enumeration and no reads/writes to existing objects.
    await storage.putTest(ref, bytes);
    report(`authenticated upload ${bytes.length} bytes: PASS`);
    if ((await storage.head(ref))?.size !== bytes.length)
      throw new BlompError("BLOMP_SIZE_MISMATCH");
    report("HEAD: PASS");
    const digest = createHash("sha256");
    let size = 0;
    for await (const chunk of await storage.stream(
      ref,
      undefined,
      AbortSignal.timeout(30000),
    )) {
      size += chunk.length;
      if (size > bytes.length) throw new BlompError("BLOMP_SIZE_MISMATCH");
      digest.update(chunk);
    }
    if (size !== bytes.length || digest.digest("hex") !== hash(bytes))
      throw new BlompError("BLOMP_HASH_MISMATCH");
    report("download SHA-256: PASS");
    const signed = await storage.sign(ref, "GET");
    const response = await fetch(signed.url, {
      redirect: "error",
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok || !response.body)
      throw new BlompError("BLOMP_SIGNED_READ_FAILED");
    const reader = response.body.getReader(),
      signedHash = createHash("sha256");
    let received = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        received += value.length;
        if (received > bytes.length)
          throw new BlompError("BLOMP_SIZE_MISMATCH");
        signedHash.update(value);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
    if (received !== bytes.length || signedHash.digest("hex") !== hash(bytes))
      throw new BlompError("BLOMP_HASH_MISMATCH");
    report("signed GET SHA-256 (server, not browser CORS): PASS");
  } catch (error) {
    report(
      "probe failed: " +
        (error instanceof BlompError
          ? error.code
          : "BLOMP_VERIFICATION_FAILED"),
    );
    throw error;
  } finally {
    // Also try cleanup after an ambiguous PUT response. Same invocation's random key only.
    try {
      await storage.deleteTest(ref);
      report("test object deletion: PASS");
      if (await storage.head(ref)) throw new BlompError("BLOMP_CLEANUP_FAILED");
      report("post-deletion HEAD absence: PASS");
    } catch {
      report("test cleanup: FAILED; owner must inspect connection-tests area");
      throw new BlompError("BLOMP_CLEANUP_FAILED");
    }
  }
}

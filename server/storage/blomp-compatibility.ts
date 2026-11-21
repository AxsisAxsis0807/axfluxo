import { newBlompTestKey } from "./blomp-keys";
import { randomUUID, createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  ListPartsCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { z } from "zod";
import { blompClient } from "./blomp";
import { BLOMP_ENDPOINT, blompConfiguration } from "./blomp-config";
import {
  CompatibilityFailure,
  CompatibilityTransport,
  compatibilityControlBytes,
  compatibilityMaximumBytes,
  compatibilityMaximumRequests,
  compatibilityMiB,
  type ProbeRequest,
} from "./blomp-compatibility-transport";

const origin = "https://axsisaxsis0807.github.io";
const control = compatibilityControlBytes;
const mime = "application/octet-stream";
const mib = compatibilityMiB;
export const compatibilityEvidence = z.strictObject({
  checkedAt: z.iso.datetime(),
  configuredAccountConfirmed: z.literal(true),
  freePlan: z.literal(true),
  noBillOnOverage: z.literal(true),
  availableBytes: z.number().int().min(compatibilityMaximumBytes),
  transferRemainingBytes: z
    .number()
    .int()
    .min(compatibilityMaximumBytes)
    .optional(),
  requestAllowance: z
    .number()
    .int()
    .min(compatibilityMaximumRequests)
    .optional(),
});
export const compatibilityCases = [
  "signed PUT",
  "authenticated GET",
  "signed GET",
  "signed HEAD",
  "Range GET",
  "CORS HTTP",
  "browser CORS",
  "Multipart start",
  "signed PART",
  "ETag",
  "ListParts",
  "resume",
  "complete",
  "SHA-256",
  "abort",
  "expiry",
  "delete",
  "absence",
] as const;
type Case = (typeof compatibilityCases)[number];
type Outcome = "PASS" | "FAIL" | "NOT RUN";
type Target = {
  key: string;
  uploadId?: string;
  started?: boolean;
  objectPossible?: boolean;
  pendingWrite?: "put" | "part" | "complete";
};
type Journal = (event: Record<string, unknown>) => void;
type Env = Record<string, string | undefined>;
type Part = { PartNumber: number; ETag: string; Size: number };

export function checkCompatibilityGate(
  env: Env,
  args: readonly string[],
  evidence: unknown,
  now = Date.now(),
) {
  if (
    args.length !== 2 ||
    !args.includes("--approved-compatibility") ||
    !args.includes("--approved-cleanup")
  )
    throw new CompatibilityFailure("APPROVAL_REQUIRED");
  if (env.NODE_TLS_REJECT_UNAUTHORIZED === "0")
    throw new CompatibilityFailure("TLS_REQUIRED");
  const config = blompConfiguration(env);
  if (!config) throw new CompatibilityFailure("BLOMP_DISABLED");
  const parsed = compatibilityEvidence.safeParse(evidence);
  if (
    !parsed.success ||
    Date.parse(parsed.data.checkedAt) > now ||
    now - Date.parse(parsed.data.checkedAt) > 15 * 60 * 1000
  )
    throw new CompatibilityFailure("CAPACITY_OR_COST_UNCONFIRMED");
  return config;
}

function ensure(condition: unknown, code: string): asserts condition {
  if (!condition) throw new CompatibilityFailure(code);
}
function statusOf(error: unknown) {
  if (error instanceof CompatibilityFailure) return error.status;
  return (error as { $metadata?: { httpStatusCode?: number } } | null)
    ?.$metadata?.httpStatusCode;
}
function isNoSuchUpload(error: unknown) {
  return (
    statusOf(error) === 404 &&
    error instanceof Error &&
    error.name === "NoSuchUpload"
  );
}
function safeFailure(error: unknown) {
  if (error instanceof CompatibilityFailure) return error.code;
  const status = statusOf(error);
  return typeof status === "number" && status >= 400 && status <= 599
    ? "HTTP_" + status
    : "REQUEST_UNCONFIRMED";
}
const sha = (...parts: Uint8Array[]) => {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part);
  return hash.digest("hex");
};

export async function verifyBlompCompatibility({
  env,
  args,
  evidence,
  journal,
  checkpoint,
  driver,
  wait = delay,
}: {
  env: Env;
  args: readonly string[];
  evidence: unknown;
  journal: Journal;
  checkpoint: (value: {
    key: string;
    uploadId?: string;
    part: Part;
  }) => unknown;
  driver?: ConstructorParameters<typeof CompatibilityTransport>[2];
  wait?: (milliseconds: number) => Promise<unknown>;
}) {
  const config = checkCompatibilityGate(env, args, evidence);
  const id = randomUUID();
  const targets: Target[] = ["single", "multipart", "cancel"].map((name) => ({
    key: newBlompTestKey(`${name}.bin`, id),
  }));
  const [single, multipart, cancel] = targets;
  const transport = new CompatibilityTransport(
    config.bucket,
    new Set(targets.map((t) => t.key)),
    driver,
  );
  const client = blompClient(config, transport);
  const outcomes = Object.fromEntries(
    compatibilityCases.map((name) => [name, "NOT RUN"]),
  ) as Record<Case, Outcome>;
  const errors: { step: Case; code: string }[] = [];
  let cleanup = false;
  const note = (step: string, target?: Target) =>
    journal({
      id,
      step,
      ...(target
        ? {
            key: target.key,
            ...(target.uploadId ? { uploadId: target.uploadId } : {}),
          }
        : {}),
      ...transport.counters,
    });
  async function step<T>(name: Case, work: () => Promise<T>) {
    try {
      const result = await work();
      if (outcomes[name] !== "FAIL") outcomes[name] = "PASS";
      return result;
    } catch (error) {
      outcomes[name] = "FAIL";
      errors.push({ step: name, code: safeFailure(error) });
      throw error;
    }
  }
  async function section(work: () => Promise<void>) {
    try {
      await work();
    } catch {
      /* A dependent section stops. The isolated cases can still run. */
    }
  }
  const input = (target: Target) => ({
    Bucket: config.bucket,
    Key: target.key,
  });
  const send = <T>(
    target: Target,
    operation: string,
    responseLimit: number,
    run: () => Promise<T>,
  ) => {
    note(operation, target);
    return transport.run(responseLimit, cleanup, run);
  };
  function pathFor(target: Target) {
    return (
      "/" +
      encodeURIComponent(config.bucket) +
      "/" +
      target.key.split("/").map(encodeURIComponent).join("/")
    );
  }
  async function sign(
    target: Target,
    method: "GET" | "HEAD" | "PUT",
    part?: { id: string; number: number; size: number },
    lifetime = 60,
  ) {
    const source = input(target);
    const options = {
      expiresIn: lifetime,
      signableHeaders: new Set(["content-length"]),
    };
    const url = new URL(
      await (method === "GET"
        ? getSignedUrl(client, new GetObjectCommand(source), options)
        : method === "HEAD"
          ? getSignedUrl(client, new HeadObjectCommand(source), options)
          : part
            ? getSignedUrl(
                client,
                new UploadPartCommand({
                  ...source,
                  UploadId: part.id,
                  PartNumber: part.number,
                  ContentLength: part.size,
                }),
                options,
              )
            : getSignedUrl(
                client,
                new PutObjectCommand({ ...source, ContentLength: mib }),
                options,
              )),
    );
    ensure(
      url.origin === BLOMP_ENDPOINT &&
        decodeURIComponent(url.pathname) ===
          decodeURIComponent(pathFor(target)) &&
        url.searchParams.get("X-Amz-Algorithm") === "AWS4-HMAC-SHA256" &&
        url.searchParams
          .get("X-Amz-Credential")
          ?.endsWith("/us-east-1/s3/aws4_request") &&
        url.searchParams.get("X-Amz-Expires") === String(lifetime) &&
        (method !== "PUT" ||
          url.searchParams
            .get("X-Amz-SignedHeaders")
            ?.split(";")
            .includes("content-length")) &&
        (!part ||
          (url.searchParams.get("uploadId") === part.id &&
            url.searchParams.get("partNumber") === String(part.number))),
      "BAD_SIGNATURE_SCOPE",
    );
    return url;
  }
  async function raw(
    target: Target,
    method: string,
    url: URL,
    options: {
      body?: Uint8Array;
      limit?: number;
      headers?: Record<string, string>;
    } = {},
  ) {
    ensure(
      url.origin === BLOMP_ENDPOINT &&
        decodeURIComponent(url.pathname) ===
          decodeURIComponent(pathFor(target)) &&
        !url.username &&
        !url.password &&
        !url.hash,
      "OUT_OF_SCOPE",
    );
    note("raw-" + method, target);
    const query: ProbeRequest["query"] = {};
    for (const [key, value] of url.searchParams) {
      ensure(!Object.hasOwn(query, key), "BAD_SIGNATURE_QUERY");
      Object.defineProperty(query, key, { value, enumerable: true });
    }
    return transport.run(options.limit ?? control, cleanup, async () => {
      const { response } = await transport.handle({
        protocol: "https:",
        hostname: url.hostname,
        path: url.pathname,
        method,
        query,
        clone() {
          return this;
        },
        headers: {
          ...options.headers,
          ...(options.body
            ? {
                "content-length": String(options.body.byteLength),
                "content-type": mime,
              }
            : {}),
        },
        body: options.body,
      });
      const hash = createHash("sha256");
      let size = 0;
      for await (const chunk of response.body as AsyncIterable<Buffer>) {
        size += chunk.byteLength;
        hash.update(chunk);
      }
      return {
        status: response.statusCode,
        headers: response.headers,
        size,
        hash: hash.digest("hex"),
      };
    });
  }
  async function head(target: Target, expected?: number) {
    try {
      const result = (await send(target, "head", 0, () =>
        client.send(new HeadObjectCommand(input(target))),
      )) as { ContentLength?: number };
      ensure(
        expected !== undefined && result.ContentLength === expected,
        "UNEXPECTED_OBJECT",
      );
    } catch (error) {
      if (expected === undefined && statusOf(error) === 404) return;
      throw error;
    }
  }
  async function readSigned(
    target: Target,
    url: URL,
    length: number,
    expectedHash: string,
    headers?: Record<string, string>,
  ) {
    const result = await raw(target, "GET", url, {
      limit: Math.max(length, control),
      headers,
    });
    ensure(
      result.status === 200 &&
        result.size === length &&
        result.hash === expectedHash,
      "SIGNED_GET_MISMATCH",
    );
    return result;
  }
  async function readAuthenticated(
    target: Target,
    length: number,
    expectedHash: string,
  ) {
    note("authenticated-get", target);
    await transport.run(length, cleanup, async () => {
      const result = await client.send(new GetObjectCommand(input(target)));
      const hash = createHash("sha256");
      let size = 0;
      ensure(result.Body, "MISSING_BODY");
      for await (const chunk of result.Body as AsyncIterable<Buffer>) {
        size += chunk.length;
        hash.update(chunk);
      }
      ensure(
        size === length && hash.digest("hex") === expectedHash,
        "AUTHENTICATED_GET_MISMATCH",
      );
    });
  }
  async function start(target: Target) {
    await step("Multipart start", async () => {
      ensure(!target.started, "REPEAT_CREATE");
      target.started = true;
      const result = (await send(target, "create", control, () =>
        client.send(
          new CreateMultipartUploadCommand({
            ...input(target),
            ContentType: mime,
          }),
        ),
      )) as { UploadId?: string; Key?: string };
      ensure(
        result.UploadId && result.Key === target.key,
        "UPLOAD_ID_UNCONFIRMED",
      );
      transport.bindUpload(target.key, result.UploadId);
      target.uploadId = result.UploadId;
      note("created", target);
    });
  }
  async function list(target: Target): Promise<Part[]> {
    ensure(target.uploadId, "UPLOAD_ID_UNCONFIRMED");
    const result = (await send(target, "list-parts", control, () =>
      client.send(
        new ListPartsCommand({ ...input(target), UploadId: target.uploadId }),
      ),
    )) as {
      Parts?: Part[];
      IsTruncated?: boolean;
      Key?: string;
      UploadId?: string;
    };
    ensure(
      !result.IsTruncated &&
        result.Key === target.key &&
        result.UploadId === target.uploadId,
      "UNEXPECTED_PARTS",
    );
    return result.Parts ?? [];
  }
  function allowedOrigin(headers: Record<string, string>) {
    const value = headers["access-control-allow-origin"];
    return value === origin || value === "*";
  }
  function tokens(value?: string) {
    return (value ?? "")
      .toLowerCase()
      .split(",")
      .map((item) => item.trim());
  }
  async function uploadPart(target: Target, number: number, body: Buffer) {
    const result = await step("signed PART", async () => {
      ensure(target.uploadId, "UPLOAD_ID_UNCONFIRMED");
      const url = await sign(target, "PUT", {
        id: target.uploadId,
        number,
        size: body.length,
      });
      if (target === multipart && number === 1) {
        await section(async () => {
          await step("CORS HTTP", async () => {
            const preflight = await raw(target, "OPTIONS", url, {
              headers: {
                origin,
                "access-control-request-method": "PUT",
                "access-control-request-headers": "content-type",
              },
            });
            const methods = tokens(
              preflight.headers["access-control-allow-methods"],
            );
            const headers = tokens(
              preflight.headers["access-control-allow-headers"],
            );
            const accepted =
              preflight.status >= 200 &&
              preflight.status < 300 &&
              allowedOrigin(preflight.headers) &&
              (methods.includes("put") || methods.includes("*")) &&
              (headers.includes("content-type") || headers.includes("*"));
            journal({
              id,
              step: "cors-part-preflight",
              status: preflight.status,
              accepted,
            });
            ensure(accepted, "CORS_PART_PREFLIGHT_MISMATCH");
          });
        });
      }
      target.pendingWrite = "part";
      const response = await raw(target, "PUT", url, {
        body,
        headers: { origin },
        limit: control,
      });
      target.pendingWrite = undefined;
      ensure(response.status === 200, "PART_REJECTED");
      if (target === multipart && number === 1) {
        corsPartObserved = true;
        await section(async () => {
          await step("CORS HTTP", async () => {
            const exposed = tokens(
              response.headers["access-control-expose-headers"],
            );
            const accepted =
              allowedOrigin(response.headers) &&
              (exposed.includes("etag") || exposed.includes("*"));
            journal({
              id,
              step: "cors-part-response",
              status: response.status,
              accepted,
            });
            ensure(accepted, "CORS_PART_RESPONSE_MISMATCH");
          });
        });
      }
      return response;
    });
    return step("ETag", async () => {
      ensure(result.headers.etag, "MISSING_ETAG");
      return {
        PartNumber: number,
        ETag: result.headers.etag,
        Size: body.length,
      };
    });
  }
  function matchParts(actual: Part[], expected: Part[]) {
    ensure(
      actual.length === expected.length &&
        expected.every((part, index) => {
          const seen = actual[index];
          return (
            seen.PartNumber === part.PartNumber &&
            seen.ETag === part.ETag &&
            seen.Size === part.Size
          );
        }),
      "PARTS_MISMATCH",
    );
  }
  const small = Buffer.alloc(mib, 0x24);
  const large = Buffer.alloc(8 * mib, 0x63);
  let singleReady = false;
  let corsPartObserved = false;
  const singleCors = { put: false, get: false, head: false };
  let unresolved = false;
  try {
    note("begin");
    await section(async () => {
      await step("signed PUT", async () => {
        const url = await sign(single, "PUT");
        single.objectPossible = true;
        single.pendingWrite = "put";
        const result = await raw(single, "PUT", url, {
          body: small,
          headers: { origin },
        });
        single.pendingWrite = undefined;
        singleCors.put = allowedOrigin(result.headers);
        ensure(
          result.status >= 200 && result.status < 300,
          "SIGNED_PUT_REJECTED",
        );
        await head(single, small.length);
        singleReady = true;
      });
    });
    if (singleReady) {
      await section(() =>
        step("authenticated GET", () =>
          readAuthenticated(single, small.length, sha(small)),
        ),
      );
      await section(async () => {
        await step("signed GET", async () => {
          const result = await readSigned(
            single,
            await sign(single, "GET"),
            small.length,
            sha(small),
            { origin },
          );
          singleCors.get = allowedOrigin(result.headers);
        });
      });
      await section(async () => {
        await step("signed HEAD", async () => {
          const result = await raw(single, "HEAD", await sign(single, "HEAD"), {
            headers: { origin },
          });
          singleCors.head = allowedOrigin(result.headers);
          ensure(
            result.status === 200 &&
              Number(result.headers["content-length"]) === small.length,
            "SIGNED_HEAD_MISMATCH",
          );
        });
      });
      await section(async () => {
        await step("Range GET", async () => {
          const result = await raw(single, "GET", await sign(single, "GET"), {
            headers: { range: "bytes=0-1023" },
            limit: small.length,
          });
          ensure(
            result.status === 206 &&
              result.size === 1024 &&
              result.headers["content-range"] ===
                `bytes 0-1023/${small.length}` &&
              result.hash === sha(small.subarray(0, 1024)),
            "RANGE_MISMATCH",
          );
        });
      });
    }
    await section(async () => {
      await step("CORS HTTP", async () => {
        let policyAccepted = true;
        for (const [method, headers] of [
          ["PUT", "content-type"],
          ["GET", "range"],
          ["HEAD", ""],
        ] as const) {
          const url = await sign(single, method);
          const result = await raw(single, "OPTIONS", url, {
            headers: {
              origin,
              "access-control-request-method": method,
              ...(headers ? { "access-control-request-headers": headers } : {}),
            },
          });
          const allowOrigin = result.headers["access-control-allow-origin"];
          const methods = tokens(
            result.headers["access-control-allow-methods"],
          );
          const allowed = tokens(
            result.headers["access-control-allow-headers"],
          );
          journal({
            id,
            step: "cors-preflight",
            method,
            status: result.status,
            originAllowed: allowOrigin === origin || allowOrigin === "*",
            methodAllowed:
              methods.includes(method.toLowerCase()) || methods.includes("*"),
            headerAllowed:
              !headers || allowed.includes(headers) || allowed.includes("*"),
          });
          policyAccepted &&=
            result.status >= 200 &&
            result.status < 300 &&
            (allowOrigin === origin || allowOrigin === "*") &&
            (methods.includes(method.toLowerCase()) || methods.includes("*")) &&
            (!headers || allowed.includes(headers) || allowed.includes("*"));
        }
        if (singleReady) {
          const result = await raw(single, "GET", await sign(single, "GET"), {
            headers: { origin, range: "bytes=0-1023" },
            limit: small.length,
          });
          const exposed = tokens(
            result.headers["access-control-expose-headers"],
          );
          const allowed = result.headers["access-control-allow-origin"];
          journal({
            id,
            step: "cors-response",
            status: result.status,
            etag: exposed.includes("etag") || exposed.includes("*"),
            contentRange:
              exposed.includes("content-range") || exposed.includes("*"),
            contentLength: Boolean(result.headers["content-length"]),
          });
          policyAccepted &&=
            result.status === 206 &&
            (allowed === origin || allowed === "*") &&
            (exposed.includes("etag") || exposed.includes("*")) &&
            (exposed.includes("content-range") || exposed.includes("*"));
        }
        journal({ id, step: "cors-single-responses", ...singleCors });
        ensure(
          policyAccepted &&
            singleReady &&
            Object.values(singleCors).every(Boolean),
          "CORS_HTTP_MISMATCH",
        );
      });
    });
    await section(async () => {
      await start(multipart);
      const one = await uploadPart(multipart, 1, large);
      await step("ListParts", async () =>
        matchParts(await list(multipart), [one]),
      );
      note("interrupted-after-part-1", multipart);
      const restored = checkpoint({
        key: multipart.key,
        uploadId: multipart.uploadId,
        part: one,
      }) as { key: string; uploadId: string; part: Part };
      const two = await step("resume", async () => {
        ensure(
          restored.key === multipart.key &&
            restored.uploadId === multipart.uploadId,
          "CHECKPOINT_MISMATCH",
        );
        matchParts(await list(multipart), [restored.part]);
        return uploadPart(multipart, 2, small);
      });
      await step("ListParts", async () =>
        matchParts(await list(multipart), [one, two]),
      );
      await step("complete", async () => {
        multipart.objectPossible = true;
        multipart.pendingWrite = "complete";
        await send(multipart, "complete", control, () =>
          client.send(
            new CompleteMultipartUploadCommand({
              ...input(multipart),
              UploadId: multipart.uploadId,
              MultipartUpload: {
                Parts: [one, two].map(({ PartNumber, ETag }) => ({
                  PartNumber,
                  ETag,
                })),
              },
            }),
          ),
        );
        multipart.pendingWrite = undefined;
        await head(multipart, large.length + small.length);
      });
      await step("SHA-256", () =>
        readAuthenticated(
          multipart,
          large.length + small.length,
          sha(large, small),
        ),
      );
    });
    if (!multipart.started || multipart.uploadId)
      await section(async () => {
        await start(cancel);
        const part = await uploadPart(cancel, 1, large);
        await step("ListParts", async () =>
          matchParts(await list(cancel), [part]),
        );
        note("cancel-requested", cancel);
      });
    if (singleReady && outcomes["signed GET"] === "PASS")
      await section(async () => {
        await step("expiry", async () => {
          const expired = await sign(single, "GET", undefined, 15);
          await readSigned(single, expired, small.length, sha(small));
          await wait(16000);
          const result = await raw(single, "GET", expired, {
            limit: small.length,
          });
          ensure(
            result.status === 401 || result.status === 403,
            "EXPIRED_SIGNATURE_NOT_REJECTED",
          );
          await readSigned(
            single,
            await sign(single, "GET"),
            small.length,
            sha(small),
          );
        });
      });
    if (
      singleReady &&
      outcomes["authenticated GET"] === "PASS" &&
      outcomes["signed GET"] === "PASS" &&
      outcomes["SHA-256"] === "NOT RUN"
    ) {
      // Keep whole-suite integrity unverified when the Multipart check did not run.
      note("single-sha256-checked", single);
    }
  } finally {
    cleanup = true;
    try {
      for (const target of targets) {
        if (target.started && !target.uploadId) {
          unresolved = true;
          outcomes.absence = "FAIL";
          errors.push({ step: "absence", code: "UPLOAD_ID_UNCONFIRMED" });
          note("unknown-upload-id", target);
          continue;
        }
        if (target.pendingWrite === "complete") {
          try {
            await head(target, large.length + small.length);
            target.pendingWrite = undefined;
            note("completed-key-reconciled", target);
          } catch {
            /* The key remains unconfirmed for manual inspection. */
          }
        }
        if (target.pendingWrite) {
          unresolved = true;
          outcomes.absence = "FAIL";
          errors.push({ step: "absence", code: "WRITE_OUTCOME_UNKNOWN" });
          note("write-outcome-unknown", target);
          continue;
        }
        if (target.uploadId) {
          let partsRemain = true;
          // A previously completed upload normally returns NoSuchUpload.
          if (target.objectPossible) {
            try {
              await list(target);
            } catch (error) {
              if (isNoSuchUpload(error)) partsRemain = false;
              else {
                unresolved = true;
                errors.push({ step: "abort", code: safeFailure(error) });
                outcomes.abort = "FAIL";
              }
            }
          }
          if (
            partsRemain &&
            (!target.objectPossible || outcomes.abort !== "FAIL")
          )
            await section(async () => {
              await step("abort", async () => {
                await send(target, "abort", control, () =>
                  client.send(
                    new AbortMultipartUploadCommand({
                      ...input(target),
                      UploadId: target.uploadId,
                    }),
                  ),
                );
                note("abort-accepted", target);
                try {
                  await list(target);
                } catch (error) {
                  if (isNoSuchUpload(error)) {
                    note("parts-absent", target);
                    return;
                  }
                  throw error;
                }
                throw new CompatibilityFailure("UPLOAD_STILL_PRESENT");
              });
            });
        }
        if (target.objectPossible)
          await section(async () => {
            await step("delete", async () => {
              await send(target, "delete", control, () =>
                client.send(new DeleteObjectCommand(input(target))),
              );
            });
          });
        if (target.objectPossible || target.started)
          await section(async () => {
            await step("absence", async () => head(target));
          });
      }
      note("finished");
    } finally {
      client.destroy();
    }
  }
  if (!corsPartObserved && outcomes["CORS HTTP"] === "PASS")
    outcomes["CORS HTTP"] = "NOT RUN";
  return {
    id,
    outcomes,
    errors,
    ...transport.counters,
    keysAttempted: targets.filter((t) => t.started || t.objectPossible).length,
    residualPossible:
      unresolved ||
      ["abort", "delete", "absence"].some(
        (k) => outcomes[k as Case] === "FAIL",
      ),
  };
}

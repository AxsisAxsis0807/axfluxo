import { newBlompTestKey } from "./blomp-keys";
import { createHash } from "node:crypto";
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { blompClient, BlompError } from "./blomp";
import type { BlompConfig } from "./blomp-config";
import {
  CompatibilityFailure,
  CompatibilityTransport,
} from "./blomp-compatibility-transport";

export const diagnosticPngBytes = 1_027_053;
const digest = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

export function inspectDiagnosticPng(bytes: Buffer) {
  if (
    bytes.length !== diagnosticPngBytes ||
    !bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")) ||
    bytes.readUInt32BE(8) !== 13 ||
    bytes.toString("ascii", 12, 16) !== "IHDR" ||
    bytes.readUInt32BE(16) !== 1109 ||
    bytes.readUInt32BE(20) !== 628
  ) {
    throw new BlompError("BLOMP_IMAGE_SOURCE_MISMATCH");
  }
  return digest(bytes);
}

/** Dedicated two-request probe. It never runs from an application entrypoint. */
export async function verifyBlompImage(
  config: BlompConfig,
  source: Buffer,
  expectedSha256: string,
  recordKey: (key: string) => void,
  report: (step: string) => void,
  driver: ConstructorParameters<typeof CompatibilityTransport>[2],
) {
  const body = Buffer.from(source);
  if (inspectDiagnosticPng(body) !== expectedSha256)
    throw new BlompError("BLOMP_IMAGE_SOURCE_MISMATCH");
  const key = newBlompTestKey("Photoroom_20261119_191218.png");
  recordKey(key);
  const target = { Bucket: config.bucket, Key: key };
  const transport = new CompatibilityTransport(
    config.bucket,
    new Set([key]),
    driver,
    diagnosticPngBytes,
    (method, status) => report(`${method} response: HTTP ${status}`),
    true,
  );
  const client = blompClient(config, transport);
  try {
    await transport.run(0, false, () =>
      client.send(
        new PutObjectCommand({
          ...target,
          Body: body,
          ContentLength: body.length,
          ContentType: "image/png",
        }),
      ),
    );
    report("PNG PUT: CONFIRMED");
    const result = await transport.run(diagnosticPngBytes, false, async () => {
      const { Body, ContentLength, $metadata } = await client.send(
        new GetObjectCommand(target),
      );
      if (
        $metadata.httpStatusCode !== 200 ||
        ContentLength !== diagnosticPngBytes ||
        !Body
      )
        throw new BlompError("BLOMP_IMAGE_DOWNLOAD_MISMATCH");
      const downloaded = Buffer.alloc(diagnosticPngBytes);
      let offset = 0;
      for await (const chunk of Body as AsyncIterable<Uint8Array>) {
        if (offset + chunk.byteLength > downloaded.length)
          throw new BlompError("BLOMP_IMAGE_DOWNLOAD_MISMATCH");
        downloaded.set(chunk, offset);
        offset += chunk.byteLength;
      }
      if (offset !== downloaded.length || digest(downloaded) !== expectedSha256)
        throw new BlompError("BLOMP_IMAGE_DOWNLOAD_MISMATCH");
      return downloaded;
    });
    report("PNG download SHA-256: PASS");
    return result;
  } catch (error) {
    const code =
      error instanceof CompatibilityFailure || error instanceof BlompError
        ? error.code
        : "BLOMP_IMAGE_REQUEST_FAILED";
    report(`PNG verification stopped: ${code}`);
    throw new BlompError(code);
  } finally {
    client.destroy();
    const { requests, uploadBytesReserved, responseBytes } = transport.counters;
    report(
      `HTTP requests: ${requests}; upload bytes reserved: ${uploadBytesReserved}; response body bytes accepted: ${responseBytes}`,
    );
  }
}

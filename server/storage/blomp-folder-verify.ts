import { createHash } from "node:crypto";
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { blompClient } from "./blomp";
import type { BlompConfig } from "./blomp-config";
import {
  CompatibilityFailure,
  CompatibilityTransport,
  ProbeServiceStop,
} from "./blomp-compatibility-transport";
import { blompTestFolderKeys } from "./blomp-keys";

const payload = Buffer.from("AxFluxo Blomp UTF-8 folder check\n");
export const blompFolderTestBytes = payload.length;
const sha256 = (input: Uint8Array) =>
  createHash("sha256").update(input).digest("hex");

export async function verifyBlompFolders(
  config: BlompConfig,
  runId: string,
  reserveRun: (keys: readonly string[]) => void,
  report: (event: string) => void,
  driver?: ConstructorParameters<typeof CompatibilityTransport>[2],
) {
  const keys = blompTestFolderKeys(runId);
  reserveRun(keys);
  for (const [index, key] of keys.entries()) {
    const label = `folder ${index + 1}`;
    const transport = new CompatibilityTransport(
      config.bucket,
      new Set([key]),
      driver,
      payload.length,
      (method, status) => report(`${label} ${method} HTTP ${status}`),
    );
    const client = blompClient(config, transport);
    const target = { Bucket: config.bucket, Key: key };
    try {
      try {
        await transport.run(0, false, () =>
          client.send(
            new PutObjectCommand({
              ...target,
              Body: payload,
              ContentLength: payload.length,
              ContentType: "text/plain; charset=utf-8",
            }),
          ),
        );
      } catch (error) {
        if (
          !(error instanceof ProbeServiceStop) ||
          error.code !== "PROBE_HTML_RESPONSE" ||
          error.status !== 200
        )
          throw error;
      }
      report(`${label} SAVE_UNCONFIRMED`);
      const head = await transport.run(0, false, () =>
        client.send(new HeadObjectCommand(target)),
      );
      if (
        head.$metadata.httpStatusCode !== 200 ||
        head.ContentLength !== payload.length ||
        !head.ETag
      )
        throw new CompatibilityFailure("FOLDER_HEAD_MISMATCH");
      report(`${label} OBJECT_PRESENT`);
      await transport.run(payload.length, false, async () => {
        const result = await client.send(new GetObjectCommand(target));
        if (
          result.$metadata.httpStatusCode !== 200 ||
          result.ContentLength !== payload.length ||
          !result.Body
        )
          throw new CompatibilityFailure("FOLDER_GET_MISMATCH");
        const bytes = await result.Body.transformToByteArray();
        if (
          bytes.length !== payload.length ||
          sha256(bytes) !== sha256(payload)
        )
          throw new CompatibilityFailure("FOLDER_SHA256_MISMATCH");
      });
      report(`${label} INTEGRITY_VERIFIED`);
    } catch (error) {
      const code =
        error instanceof CompatibilityFailure
          ? error.code
          : "FOLDER_REQUEST_FAILED";
      report(`${label} STOP ${code}`);
      throw new CompatibilityFailure(code);
    } finally {
      client.destroy();
      const { requests, uploadBytesReserved, responseBytes } =
        transport.counters;
      report(
        `${label} requests=${requests} uploadBytesReserved=${uploadBytesReserved} responseBytes=${responseBytes}`,
      );
    }
  }
}

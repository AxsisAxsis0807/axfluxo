import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { newBlompFileKey } from "../../storage/blomp-keys";
import {
  TrialDBudget,
  trialDMaxFileBytes,
  trialDMaxPayloadBytes,
  trialDMaxRequests,
} from "../../storage/blomp-trial-d-budget";

const owner = "11111111-1111-4111-8111-111111111111";
const files = ["all-versions.mp4", "fnf.mp4"].map((name) => ({
  key: newBlompFileKey("outputs", owner, null, name),
  size: trialDMaxFileBytes,
}));
const sequence = [
  "create",
  "listBefore",
  "options",
  "part",
  "headBefore",
  "listAfter",
  "complete",
  "headAfter",
  "verify",
  "options",
  "download",
] as const;

describe("isolated Trial D budget", () => {
  it("admits exactly two one-part exchanges and cuts off the next request", async () => {
    const gate = new TrialDBudget(owner, files);
    for (const file of files)
      for (const operation of sequence) gate.reserve(file.key, operation);
    expect(gate.counters).toEqual({
      requests: trialDMaxRequests,
      reservedPayloadBytes: trialDMaxPayloadBytes,
      stopped: false,
    });
    expect(() => gate.reserve(files[0].key, "download")).toThrow(
      "TRIAL_D_STOP",
    );
    expect(gate.counters.requests).toBe(22);
  });

  it("rejects oversized files, duplicate keys, and foreign owners", () => {
    expect(() => new TrialDBudget(owner, [files[0], files[0]])).toThrow(
      "TRIAL_D_SCOPE",
    );
    expect(
      () =>
        new TrialDBudget(owner, [
          { ...files[0], size: trialDMaxFileBytes + 1 },
          files[1],
        ]),
    ).toThrow("TRIAL_D_SCOPE");
    expect(
      () => new TrialDBudget("22222222-2222-4222-8222-222222222222", files),
    ).toThrow("TRIAL_D_SCOPE");
    expect(() => new TrialDBudget(owner, [...files, files[0]])).toThrow(
      "TRIAL_D_SCOPE",
    );
  });

  it("does not refund failed reservations or allow out-of-order transfers", async () => {
    const gate = new TrialDBudget(owner, files);
    expect(() => gate.reserve(files[0].key, "part")).toThrow("TRIAL_D_STOP");
    expect(() => gate.reserve(files[0].key, "create")).toThrow("TRIAL_D_STOP");
    const started = new TrialDBudget(owner, files);
    started.reserve(files[0].key, "create");
    started.reserve(files[0].key, "listBefore");
    const part = started.reserve(files[0].key, "part");
    await expect(part.readPayload([Buffer.alloc(1)])).rejects.toThrow(
      "TRIAL_D_PAYLOAD_SIZE",
    );
    expect(started.counters.reservedPayloadBytes).toBe(trialDMaxFileBytes);
    expect(() => started.reserve(files[1].key, "create")).toThrow(
      "TRIAL_D_STOP",
    );
  });

  it("stops on oversized payload chunks or a reused read permit", async () => {
    const started = () => {
      const gate = new TrialDBudget(owner, files);
      gate.reserve(files[0].key, "create");
      gate.reserve(files[0].key, "listBefore");
      return { gate, part: gate.reserve(files[0].key, "part") };
    };
    const oversized = started();
    await expect(
      oversized.part.readPayload([Buffer.alloc(trialDMaxFileBytes + 1)]),
    ).rejects.toThrow("TRIAL_D_PAYLOAD_SIZE");
    expect(oversized.gate.counters.stopped).toBe(true);
    const replay = started();
    await replay.part.readPayload([Buffer.alloc(trialDMaxFileBytes)]);
    expect(() => replay.part.readPayload([])).toThrow("TRIAL_D_STOP");
    expect(replay.gate.counters.stopped).toBe(true);
  });

  it("bounds real loopback HTTP request bodies and rejects a second PUT", async () => {
    const scope = files.map((file) => ({ ...file, size: 4 }));
    const gate = new TrialDBudget(owner, scope);
    gate.reserve(scope[0].key, "create");
    gate.reserve(scope[0].key, "listBefore");
    const server = createServer(async (request, response) => {
      try {
        if (request.method !== "PUT" || request.url !== "/part")
          throw Error("SCOPE");
        const part = gate.reserve(scope[0].key, "part");
        await part.readPayload(request);
        response.writeHead(204).end();
      } catch {
        gate.stop();
        response.writeHead(403).end();
      }
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    try {
      const address = server.address();
      if (!address || typeof address === "string")
        throw Error("Missing socket");
      const url = `http://127.0.0.1:${address.port}/part`;
      expect((await fetch(url, { method: "PUT", body: "1234" })).status).toBe(
        204,
      );
      expect((await fetch(url, { method: "PUT", body: "1234" })).status).toBe(
        403,
      );
      expect(gate.counters).toEqual({
        requests: 3,
        reservedPayloadBytes: 4,
        stopped: true,
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

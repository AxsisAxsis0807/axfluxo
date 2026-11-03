import { WasmEngine } from "../../../src/services/local-encoding/engine";
import {
  write,
  type LocalJob,
} from "../../../src/services/local-encoding/storage";
import { newProject } from "../../../src/domain/video/all-versions";
import { FnfSession } from "../../../src/services/video/fnf-session";
import { defaultFnfPreferences } from "../../../src/domain/video/fnf-showcase";
import { plan } from "../../../src/services/local-encoding/plan";
const owner = "test-owner";
Object.assign(window, {
  encodeLocal: async (mode: "av" | "fnf") => {
    const blob = await (await fetch("/source.mp4")).blob();
    const ref = {
      libraryId: "local",
      fileId: "source",
      versionId: "source",
      hash: "a".repeat(64),
      kind: "video" as const,
    };
    await write(owner, "asset:source", {
      reference: ref,
      blob,
      width: 160,
      height: 90,
      durationUs: 2_100_000,
    });
    const coverCanvas = document.createElement("canvas");
    coverCanvas.width = 100;
    coverCanvas.height = 100;
    const ctx = coverCanvas.getContext("2d")!;
    ctx.fillStyle = "red";
    ctx.fillRect(0, 0, 100, 100);
    const cover = await new Promise<Blob>((resolve) =>
      coverCanvas.toBlob((b) => resolve(b!)),
    );
    const coverRef = {
      ...ref,
      fileId: "cover",
      versionId: "cover",
      kind: "image" as const,
    };
    await write(owner, "asset:cover", {
      reference: coverRef,
      blob: cover,
      width: 100,
      height: 100,
      durationUs: 0,
    });
    const session = new FnfSession({
      reference: ref,
      durationUs: 2_100_000,
      width: 160,
      height: 90,
      geometryVerified: true,
    });
    session.name(session.ranges[0].id, "Song");
    const p = newProject();
    p.document = session.document();
    p.cover = coverRef;
    p.namesText = "Song";
    const pref = defaultFnfPreferences();
    pref.template.scale = 1080 / 160;
    const snapshot = mode === "av" ? p : session.snapshot(pref);
    const job: LocalJob = {
      id: crypto.randomUUID(),
      owner,
      snapshot,
      outputIndex: 0,
      filename: "test.mp4",
      state: "running",
      next: 0,
      total: plan(snapshot).length,
      activeMs: 0,
      restUntil: 0,
      createdAt: Date.now(),
    };
    const engine = new WasmEngine();
    try {
      if (mode === "av") {
        const wave = await engine.waveform(
          owner,
          ref.versionId,
          new AbortController().signal,
        );
        if (
          wave.levels[0].peaks.length < 100 ||
          !wave.levels[0].peaks.some((p) => p > 0)
        )
          throw Error("Local waveform is missing");
      }
      for (; job.next < job.total; job.next++)
        await write(
          owner,
          `part:${job.id}:${job.next}`,
          await engine.chunk(job, new AbortController().signal),
        );
      const output = await engine.finish(job, new AbortController().signal);
      return Array.from(new Uint8Array(await output.arrayBuffer()));
    } finally {
      engine.dispose();
    }
  },
});

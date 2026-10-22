import { describe, it, expect } from "vitest";
import {
  newProject,
  newText,
  reducer,
  cloneProject,
  documentSchema,
  keySchema,
  defaultCrop,
  resolveText,
} from "../src/domain/document";
import { cropGeometry, dragCrop, pinchCrop } from "../src/domain/crop";
import { layoutText } from "../src/domain/text";
describe("document and history", () => {
  it("rejects unknown versions, nonfinite geometry and dangerous keys", () => {
    const d = newProject();
    expect(documentSchema.safeParse({ ...d, schemaVersion: 2 }).success).toBe(
      false,
    );
    expect(keySchema.safeParse("constructor").success).toBe(false);
    d.pages[0].width = NaN;
    expect(documentSchema.safeParse(d).success).toBe(false);
  });
  it("undo is one command and new commands discard redo", () => {
    const d = newProject();
    const h = { past: [], present: d, future: [] };
    const edited = { ...d, name: "changed" };
    const a = reducer(h, { type: "commit", document: edited });
    const b = reducer(a, { type: "undo" });
    expect(b.present.name).toBe(d.name);
    expect(
      reducer(b, { type: "commit", document: edited }).future,
    ).toHaveLength(0);
    expect(reducer(b, { type: "redo" }).present.name).toBe("changed");
  });
  it("template instantiation has new IDs and isolated nested settings", () => {
    const d = newProject();
    d.pages[0].layers.push(newText());
    const c = cloneProject(d);
    c.pages[0].layers[0].x = 10;
    expect(c.id).not.toBe(d.id);
    expect(c.pages[0].layers[0].id).not.toBe(d.pages[0].layers[0].id);
    expect(d.pages[0].layers[0].x).toBe(540);
  });
  it("resolves plain text bindings without evaluation", () => {
    const d = newProject();
    const l = newText();
    l.textBinding = { key: "title", prefix: "(", suffix: ")" };
    d.values.title = "<script>";
    expect(resolveText(l, d)).toBe("(<script>)");
  });
});
describe("cover geometry", () => {
  for (const rotation of [0, 30, 45, 90, 127, 180, 270])
    for (const [W, H] of [
      [1200, 600],
      [600, 1200],
    ])
      it(`covers every inverse corner at ${rotation} ${W}`, () => {
        const { s, crop } = cropGeometry(
          { ...defaultCrop(), rotation, focus: { u: 0, v: 1 } },
          W,
          H,
          1080,
          1350,
        );
        const t = (rotation * Math.PI) / 180;
        for (const x of [-540, 540])
          for (const y of [-675, 675]) {
            const sx =
              crop.focus.u * W + (Math.cos(t) * x + Math.sin(t) * y) / s;
            const sy =
              crop.focus.v * H + (-Math.sin(t) * x + Math.cos(t) * y) / s;
            expect(sx).toBeGreaterThanOrEqual(-1e-8);
            expect(sx).toBeLessThanOrEqual(W + 1e-8);
            expect(sy).toBeGreaterThanOrEqual(-1e-8);
            expect(sy).toBeLessThanOrEqual(H + 1e-8);
          }
      });
  it("contain fits rotated source and drag is normalized", () => {
    const c = { ...defaultCrop(), mode: "contain" as const, rotation: 35 };
    const g = cropGeometry(c, 1200, 600, 1000, 1000);
    expect(
      g.s *
        (Math.cos((35 * Math.PI) / 180) * 1200 +
          Math.sin((35 * Math.PI) / 180) * 600),
    ).toBeLessThanOrEqual(1000.0001);
    expect(
      dragCrop({ ...defaultCrop(), zoom: 2 }, 1200, 600, 1000, 1000, 10, 0)
        .focus.u,
    ).toBeLessThan(0.5);
  });
  it("pinch preserves anchor before clamping", () => {
    const c = { ...defaultCrop(), zoom: 2 };
    const q = { x: 100, y: 20 };
    const before = cropGeometry(c, 1000, 1000, 500, 500);
    const next = pinchCrop(c, 1000, 1000, 500, 500, 1.5, q, q);
    const after = cropGeometry(next, 1000, 1000, 500, 500);
    expect(before.crop.focus.u * 1000 + q.x / before.s).toBeCloseTo(
      after.crop.focus.u * 1000 + q.x / after.s,
    );
  });
});
describe("text", () => {
  it("retains graphemes and explicit empty lines; detects overflow", () => {
    const l = { ...newText(), width: 60, height: 30 };
    const r = layoutText(
      l,
      "👨‍👩‍👧‍👦あ\n\nいう",
      (s) =>
        [...new Intl.Segmenter("ja", { granularity: "grapheme" }).segment(s)]
          .length * 20,
    );
    expect(r.lines.join("")).toBe("👨‍👩‍👧‍👦あいう");
    expect(r.lines).toContain("");
    expect(r.overflow).toBe(true);
  });
});
it("rejects missing or incompatible binding references", () => {
  const d = newProject();
  const l = newText();
  l.textBinding = { key: "missing", prefix: "", suffix: "" };
  d.pages[0].layers.push(l);
  expect(documentSchema.safeParse(d).success).toBe(false);
  d.variables = [
    { key: "missing", label: "image", type: "image", required: false },
  ];
  expect(documentSchema.safeParse(d).success).toBe(false);
});
it("reducer returns identical outputs for identical command inputs", () => {
  const d = newProject(),
    h = { past: [], present: d, future: [] };
  const a = {
    type: "commit" as const,
    document: { ...d, name: "changed" },
    at: "2026-10-23T00:00:00.000Z",
  };
  expect(reducer(h, a)).toEqual(reducer(h, a));
});

import { expect, it } from "vitest";
import project from "./fixtures/workflow-first/studio-v1.json";
import workflow from "./fixtures/workflow-first/workflow-v1.json";
import viewport from "./fixtures/workflow-first/viewport-v1.json";
import { documentSchema, resolveAsset } from "../src/domain/document";
import { parseWorkflow } from "../src/domain/workflow/connections";
import { viewportSchema } from "../src/domain/workflow/schema";

it("retains v1 fixtures unchanged, including viewport and distinct variable references", () => {
  const document = documentSchema.parse(project);
  expect(document).toEqual(project);
  expect(parseWorkflow(workflow)).toEqual(workflow);
  expect(viewportSchema.parse(viewport)).toEqual(viewport);
  const image = document.pages[0].layers[0];
  if (image.kind !== "image") throw new Error("fixture must contain an image");
  expect(resolveAsset(image, document)).toBe(document.values.photo);
  expect(
    new Set([
      image.assetId,
      document.variables[0].default,
      document.values.photo,
    ]).size,
  ).toBe(3);
});
it("v1 reader refuses a future image-edit node and leaves its original JSON intact", () => {
  const unsupported = {
    ...workflow,
    nodes: [{ ...workflow.nodes[0], type: "image-edit" }],
  };
  const original = JSON.stringify(unsupported);
  expect(() => parseWorkflow(unsupported)).toThrow();
  expect(JSON.stringify(unsupported)).toBe(original);
  expect(() => parseWorkflow({ ...workflow, schemaVersion: 2 })).toThrow();
});

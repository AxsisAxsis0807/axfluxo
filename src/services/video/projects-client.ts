import { z } from "zod";
import {
  allVersionsProjectSchema,
  ALEO_HASH,
  AV_RENDERER,
  type AllVersionsProject,
} from "../../domain/video/all-versions";
import type { AuthenticatedApi } from "../cloud-library/client";
import type { ProjectTransport } from "./project-sync";
import { batchViewSchema } from "../../../server/contracts/video";
export const projectView = z.strictObject({
  revision: z.number().int().positive(),
  project: allVersionsProjectSchema,
});
const textView = z.strictObject({
  png: z.string(),
  width: z.number(),
  height: z.number(),
  fontHash: z.literal(ALEO_HASH),
  rendererVersion: z.literal(AV_RENDERER),
  fontSize: z.number(),
});
export function projectsClient(api: AuthenticatedApi, owner?: string) {
  const get = (id: string) =>
    api.request(
      `/projects/${id}`,
      projectView,
      "GET",
      undefined,
      undefined,
      undefined,
      owner,
    );
  const transport: ProjectTransport = {
    put: async (project, revision) => {
      const bytes = new TextEncoder().encode(JSON.stringify(project)),
        hash = Array.from(
          new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
          (b) => b.toString(16).padStart(2, "0"),
        ).join("");
      const result = await api.request(
        `/projects/${project.id}`,
        projectView,
        "POST",
        project,
        `av:${project.id}:${revision}:${hash}`,
        `"${revision}"`,
        owner,
      );
      if (result.ok) return { revision: result.data.revision };
      if (result.code === "PROJECT_CONFLICT" || result.code === "CONFLICT") {
        const remote = await get(project.id);
        if (remote.ok) return { conflict: remote.data.project };
      }
      throw new Error(result.code);
    },
  };
  return {
    get,
    transport,
    text: async (project: AllVersionsProject, index: number) => {
      const r = await api.request(
        "/projects/text-preview",
        textView,
        "POST",
        { project, index },
        crypto.randomUUID(),
        undefined,
        owner,
      );
      if (!r.ok) throw new Error(r.code);
      return r.data;
    },
    render: async (id: string, revision: number) => {
      const r = await api.request(
        `/projects/${id}/render`,
        batchViewSchema,
        "POST",
        {},
        crypto.randomUUID(),
        `"${revision}"`,
        owner,
      );
      if (!r.ok) throw new Error(r.code);
      return r.data;
    },
    api,
  };
}

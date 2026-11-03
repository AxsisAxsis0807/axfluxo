import { z } from "zod";
export const developerServicesSchema = z.strictObject({
  cloudLibrary: z.boolean(),
  uploads: z.boolean(),
  preview: z.boolean(),
  projects: z.boolean(),
  fnfPreferences: z.boolean(),
  outputs: z.boolean(),
  renderAcceptance: z.boolean(),
  fnfRenderAcceptance: z.boolean(),
  deleteAcceptance: z.boolean(),
  push: z.boolean(),
});
export type DeveloperServices = z.infer<typeof developerServicesSchema>;
export const unavailableDeveloperServices: DeveloperServices = {
  cloudLibrary: false,
  uploads: false,
  preview: false,
  projects: false,
  fnfPreferences: false,
  outputs: false,
  renderAcceptance: false,
  fnfRenderAcceptance: false,
  deleteAcceptance: false,
  push: false,
};

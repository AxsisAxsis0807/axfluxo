export const storageRoles = [
  "inputs",
  "originals",
  "intermediates",
  "checkpoints",
  "outputs",
] as const;
export type StorageRole = (typeof storageRoles)[number];

/** Defaults affect new files only. Persist the resolved provider and location on each record. */
export const defaultStorageProvider = {
  inputs: "blomp",
  originals: "blomp",
  intermediates: "blomp",
  checkpoints: "blomp",
  outputs: "blomp",
} as const satisfies Record<StorageRole, string>;

export function isSourceRole(role: StorageRole) {
  return role === "inputs" || role === "originals";
}

import { z } from "zod";
export const driveCodes = [
  "DRIVE_RECONNECT_REQUIRED",
  "DRIVE_SCOPE_REQUIRED",
  "DRIVE_OAUTH_FAILED",
  "DRIVE_UNAVAILABLE",
  "DRIVE_RESOURCE_MISSING",
  "DRIVE_QUOTA_EXCEEDED",
  "DRIVE_RETRY_LATER",
  "DRIVE_PERMISSION_DENIED",
  "DRIVE_ID_EXISTS",
  "DRIVE_API_FAILED",
  "DRIVE_FOLDER_RECOVERY_REQUIRED",
  "DRIVE_INTEGRITY_FAILED",
  "DRIVE_STATE_INVALID",
  "DRIVE_CONNECTION_CHANGED",
  "DRIVE_ACCOUNT_MISMATCH",
  "DRIVE_FILE_INVALID",
] as const;
export const driveStatus = z.object({
  connected: z.boolean(),
  folders: z
    .object({
      rootId: z.string().nullable(),
      queueId: z.string().nullable(),
      completedId: z.string().nullable(),
    })
    .nullable(),
});
export const driveFile = z.object({
  fileId: z.string(),
  size: z.number(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  verified: z.literal(true),
  base64: z.string().optional(),
});

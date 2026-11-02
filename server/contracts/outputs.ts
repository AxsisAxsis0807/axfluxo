import { z } from "zod";
export const saveConfirmationSchema = z.strictObject({
  versionId: z.string().min(1).max(200),
  hash: z.string().regex(/^[a-f0-9]{64}$/),
  photoLibraryChecked: z.literal(true),
});
export const outputItemSchema = z.object({
  id: z.uuid(),
  versionId: z.string(),
  hash: z.string(),
  size: z.number().int().positive(),
  createdAt: z.string(),
  filename: z.string(),
  unconfirmed30Days: z.boolean(),
  state: z.enum(["unconfirmed", "pending", "held", "deleting", "deleted"]),
  reason: z.string().nullable(),
});
export const outputsSchema = z.object({
  items: z.array(outputItemSchema),
  nextCursor: z.string().nullable(),
});
export type OutputItem = z.infer<typeof outputItemSchema>;
export const pushSubscriptionSchema = z.strictObject({
  endpoint: z.url().max(2048),
  keys: z.strictObject({
    p256dh: z.string().regex(/^[A-Za-z0-9_-]{87,88}=?$/),
    auth: z
      .string()
      .regex(/^[A-Za-z0-9_-]{22}==?$/)
      .or(z.string().regex(/^[A-Za-z0-9_-]{22}$/)),
  }),
});
export function allowedPushEndpoint(value: string) {
  const u = new URL(value);
  return (
    u.protocol === "https:" &&
    !u.username &&
    !u.password &&
    !u.port &&
    !u.hash &&
    ([
      "web.push.apple.com",
      "fcm.googleapis.com",
      "fcm.push.google.com",
      "updates.push.services.mozilla.com",
    ].includes(u.hostname) ||
      u.hostname.endsWith(".push.apple.com"))
  );
}

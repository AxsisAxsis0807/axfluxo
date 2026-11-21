import { randomUUID } from "node:crypto";
import {
  storageRoles,
  type StorageRole,
} from "../../src/domain/storage/destinations";

export const blompRoleFolders: Record<StorageRole, string> = {
  inputs: "01_入力素材",
  originals: "02_元素材",
  intermediates: "03_途中データ",
  checkpoints: "04_チェックポイント",
  outputs: "05_完成品",
};
const uuid =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const projectUuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const testFolder = "99_接続テスト";

export function validBlompFilename(name: string) {
  return (
    !!name.trim() &&
    name !== "." &&
    name !== ".." &&
    !/[\x00-\x1f\x7f/\\]/.test(name) &&
    name.isWellFormed()
  );
}

export function newBlompFileKey(
  role: StorageRole,
  owner: string,
  projectId: string | null,
  filename: string,
) {
  return `axfluxo/${blompRoleFolders[role]}/${owner}/${projectId ?? "未指定"}/${randomUUID()}/${filename}`;
}

export function newBlompTestKey(filename: string, id = randomUUID()) {
  return `axfluxo/${testFolder}/${id}/${filename}`;
}

export function matchesBlompFileKey(
  key: string,
  role: StorageRole,
  owner?: string,
) {
  const [root, folder, keyOwner, project, id, filename, ...extra] =
    key.split("/");
  if (
    root !== "axfluxo" ||
    !keyOwner ||
    !uuid.test(keyOwner) ||
    (owner !== undefined && keyOwner !== owner)
  )
    return false;
  if (folder === role) return uuid.test(project ?? "") && id === undefined;
  return (
    Object.hasOwn(blompRoleFolders, role) &&
    folder === blompRoleFolders[role] &&
    (project === "未指定" || projectUuid.test(project ?? "")) &&
    uuid.test(id ?? "") &&
    filename !== undefined &&
    validBlompFilename(filename) &&
    extra.length === 0 &&
    Buffer.byteLength(key, "utf8") <= 1024
  );
}

export function validBlompKey(key: string) {
  if (storageRoles.some((role) => matchesBlompFileKey(key, role))) return true;
  const [root, folder, id, filename, ...extra] = key.split("/");
  return (
    root === "axfluxo" &&
    (folder === testFolder || folder === "connection-tests") &&
    uuid.test(id ?? "") &&
    filename === "probe.bin" &&
    extra.length === 0
  );
}

export const blompTestFolders = [
  "01_元素材",
  "02_途中素材",
  "03_完成品",
] as const;

export function blompTestFolderKeys(runId: string) {
  if (!uuid.test(runId)) throw new Error("INVALID_TEST_RUN_ID");
  return blompTestFolders.map(
    (folder) => `axfluxo/${testFolder}/${folder}/${runId}/接続確認.txt`,
  );
}

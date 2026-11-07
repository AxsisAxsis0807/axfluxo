import type { ExportEntry } from "./export-queue";
import type { LocalProjectData, Source } from "./local-project";

export type StoredProject = Omit<
  LocalProjectData,
  "sources" | "cover" | "coverFile"
> & {
  schema: 1;
  sources: Omit<Source, "file" | "url">[];
};
type StoredEntry = Omit<
  ExportEntry,
  "input" | "recovery" | "persistedRecipe" | "result"
> & {
  result?: { filename: string };
  order: number;
  recipe?: { project: StoredProject; index: number };
};
function fingerprint(value: unknown) {
  return JSON.stringify(value, (_key, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item).sort(([a], [b]) => a.localeCompare(b)),
        )
      : item,
  );
}
export class RecoveryLeaseError extends Error {}
const DB = "axfluxo.local-video-recovery";
const OWNER = crypto.randomUUID();
const LEASE_MS = 20_000;
let acquired = false;
let database: Promise<IDBDatabase> | undefined;
function open() {
  return (database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => {
      for (const name of ["projects", "assets", "jobs", "meta"])
        request.result.createObjectStore(name);
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => {
        request.result.close();
        database = undefined;
      };
      resolve(request.result);
    };
    request.onerror = () => {
      database = undefined;
      reject(request.error);
    };
    request.onblocked = () =>
      reject(Error("保存領域の更新を別のタブが使用中です。"));
  }));
}
const request = <T>(r: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
function done(tx: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    let failure: DOMException | null = null;
    tx.oncomplete = () => resolve();
    tx.onabort = () =>
      reject(failure ?? tx.error ?? Error("保存を中断しました。"));
    tx.onerror = (event) => {
      failure = (event.target as IDBRequest).error ?? tx.error;
    };
  });
}
export function recoveryMessage(error: unknown) {
  return error instanceof DOMException && error.name === "QuotaExceededError"
    ? "端末の保存容量が不足しています。自動復旧用の保存に失敗しました。元の素材と完成動画を保持してください。"
    : `自動保存・復旧を利用できません。元の素材を保持してください。${error instanceof Error ? error.message : "保存領域を確認してください。"}`;
}
/** One writer for both tools and the shared queue. Every mutation rechecks the lease
 * in the same transaction; a frozen/expired tab cannot overwrite a new owner. */
async function write<T>(task: (tx: IDBTransaction) => Promise<T>): Promise<T> {
  const db = await open();
  const tx = db.transaction(
    ["projects", "assets", "jobs", "meta"],
    "readwrite",
  );
  const completion = done(tx);
  try {
    const meta = tx.objectStore("meta");
    const lease = (await request(meta.get("lease"))) as
      { owner: string; until: number } | undefined;
    if (
      lease &&
      lease.owner !== OWNER &&
      (acquired || lease.until > Date.now())
    )
      throw new RecoveryLeaseError(
        "別のタブで動画ツールを使用中です。そのタブを閉じてからお待ちください。",
      );
    meta.put({ owner: OWNER, until: Date.now() + LEASE_MS }, "lease");
    const value = await task(tx);
    await completion;
    acquired = true;
    return value;
  } catch (error) {
    try {
      tx.abort();
    } catch {
      /* transaction has already settled */
    }
    await completion.catch(() => {});
    throw error;
  }
}
export const renewRecoveryLease = () => write(async () => {});
const assetKey = (project: Pick<LocalProjectData, "id" | "mode">, id: string) =>
  `${project.mode}:${project.id}:${id}`;
function stored(project: LocalProjectData): StoredProject {
  const { sources, cover: _url, coverFile: _file, ...settings } = project;
  void _url;
  void _file;
  return {
    ...settings,
    schema: 1,
    sources: sources.map(({ file: _f, url: _u, ...s }) => {
      void _f;
      void _u;
      return s;
    }),
  };
}
const CHUNK_BYTES = 4 * 1024 * 1024;
const stagingKey = (key: string) => `staging:${key}`;
const chunkKey = (key: string, index: number) => `chunk:${key}:${index}`;
type ChunkAsset = {
  storage: "chunks-v1";
  size: number;
  count: number;
  type: string;
  name?: string;
  lastModified?: number;
};
async function checksum(bytes: ArrayBuffer) {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    (value) => value.toString(16).padStart(2, "0"),
  ).join("");
}
/** Read Blob bytes outside IDB transactions. Only one 4 MiB chunk is prepared at
 * a time; published metadata never refers to a half-written asset. */
async function prepareAsset(key: string, blob: Blob) {
  const db = await open();
  if (await request(db.transaction("assets").objectStore("assets").getKey(key)))
    return;
  const count = Math.ceil(blob.size / CHUNK_BYTES);
  const stage = async (tx: IDBTransaction) => {
    tx.objectStore("meta").put(
      { key, until: Date.now() + 120_000 },
      stagingKey(key),
    );
  };
  await write(stage);
  for (let index = 0; index < count; index++) {
    const bytes = await blob
      .slice(
        index * CHUNK_BYTES,
        Math.min(blob.size, (index + 1) * CHUNK_BYTES),
      )
      .arrayBuffer();
    const hash = await checksum(bytes);
    await write(async (tx) => {
      tx.objectStore("assets").put({ bytes, hash }, chunkKey(key, index));
      await stage(tx);
    });
  }
  const manifest: ChunkAsset = {
    storage: "chunks-v1",
    size: blob.size,
    count,
    type: blob.type,
    ...(blob instanceof File
      ? { name: blob.name, lastModified: blob.lastModified }
      : {}),
  };
  await write(async (tx) => {
    tx.objectStore("assets").put(manifest, key);
    await stage(tx);
  });
}
async function publishAssets(tx: IDBTransaction, project: LocalProjectData) {
  for (const [key] of projectAssets(project)) {
    if (!(await request(tx.objectStore("assets").getKey(key))))
      throw Error("素材の保存が完了していません。");
    tx.objectStore("meta").delete(stagingKey(key));
  }
}
async function readAsset(
  key: string,
): Promise<{ blob: Blob; name?: string; lastModified?: number }> {
  const db = await open();
  const value: unknown = await request(
    db.transaction("assets").objectStore("assets").get(key),
  );
  // Compatible with original v1 File/Blob and portable Blob+metadata records.
  if (value instanceof Blob)
    return {
      blob: value,
      ...(value instanceof File
        ? { name: value.name, lastModified: value.lastModified }
        : {}),
    };
  if (!value || typeof value !== "object")
    throw Error("保存済み素材が見つかりません。元の素材を保持してください。");
  if ("blob" in value && value.blob instanceof Blob)
    return {
      blob: value.blob,
      name: (value as { name?: string }).name,
      lastModified: (value as { lastModified?: number }).lastModified,
    };
  const manifest = value as ChunkAsset;
  if (
    manifest.storage !== "chunks-v1" ||
    !Number.isSafeInteger(manifest.size) ||
    manifest.size < 0 ||
    manifest.count !== Math.ceil(manifest.size / CHUNK_BYTES)
  )
    throw Error("保存素材の情報が不正です。データは保持しました。");
  let blob = new Blob([], { type: manifest.type });
  for (let index = 0; index < manifest.count; index++) {
    const part = (await request(
      db.transaction("assets").objectStore("assets").get(chunkKey(key, index)),
    )) as { bytes: ArrayBuffer; hash: string } | undefined;
    const expected = Math.min(CHUNK_BYTES, manifest.size - index * CHUNK_BYTES);
    if (
      !(part?.bytes instanceof ArrayBuffer) ||
      part.bytes.byteLength !== expected ||
      (await checksum(part.bytes)) !== part.hash
    )
      throw Error(
        "保存素材の一部が欠けるか破損しています。データは保持しました。",
      );
    blob = new Blob([blob, part.bytes], { type: manifest.type });
  }
  return { blob, name: manifest.name, lastModified: manifest.lastModified };
}
/** Advisory only: actual transaction failures remain authoritative on Safari. */
async function checkCapacity(assets: readonly (readonly [string, Blob])[]) {
  if (typeof navigator === "undefined" || !navigator.storage?.estimate) return;
  const db = await open();
  const tx = db.transaction(["assets", "meta"]);
  const missing = await Promise.all(
    assets.map(async ([key, blob]) =>
      (await request(tx.objectStore("assets").getKey(key))) ||
      (await request(tx.objectStore("meta").getKey(stagingKey(key))))
        ? 0
        : blob.size,
    ),
  );
  const bytes = missing.reduce((sum, size) => sum + size, 0);
  if (!bytes) return;
  let estimate: StorageEstimate;
  try {
    estimate = await navigator.storage.estimate();
  } catch {
    return;
  }
  if (
    estimate.quota !== undefined &&
    estimate.quota > 0 &&
    estimate.usage !== undefined &&
    estimate.usage + bytes > estimate.quota
  )
    throw new DOMException("保存容量が不足しています。", "QuotaExceededError");
}
function projectAssets(project: LocalProjectData): [string, Blob][] {
  return [
    ...project.sources.map(
      (s) => [assetKey(project, s.id), s.file] as [string, Blob],
    ),
    ...(project.coverFile
      ? [
          [assetKey(project, project.coverId), project.coverFile] as [
            string,
            Blob,
          ],
        ]
      : []),
  ];
}
async function writeLocalProject(project: LocalProjectData) {
  await checkCapacity(projectAssets(project));
  for (const [key, blob] of projectAssets(project))
    await prepareAsset(key, blob);
  await write(async (tx) => {
    await publishAssets(tx, project);
    tx.objectStore("projects").put(
      stored(project),
      `${project.mode}:${project.id}`,
    );
    tx.objectStore("meta").put(project.id, `active:${project.mode}`);
    await collectAssets(tx);
  });
}
let projectWrites = Promise.resolve();
// One active write and one latest snapshot per project. Playback cursor updates
// must not retain an unbounded queue of old metadata and detection arrays.
const pendingProjects = new Map<
  string,
  {
    project: LocalProjectData;
    promise: Promise<void>;
  }
>();
export function saveLocalProject(project: LocalProjectData) {
  const key = `${project.mode}:${project.id}`;
  const existing = pendingProjects.get(key);
  if (existing) {
    existing.project = project;
    return existing.promise;
  }
  const entry = { project, promise: Promise.resolve() };
  entry.promise = projectWrites
    .catch(() => {})
    .then(async () => {
      pendingProjects.delete(key);
      await writeLocalProject(entry.project);
    });
  pendingProjects.set(key, entry);
  projectWrites = entry.promise;
  return entry.promise;
}
export async function loadLocalProject(mode: LocalProjectData["mode"]) {
  await projectWrites.catch(() => {});
  const data = await write(async (tx) => {
    const id = await request(tx.objectStore("meta").get(`active:${mode}`));
    return id
      ? ((await request(tx.objectStore("projects").get(`${mode}:${id}`))) as
          StoredProject | undefined)
      : undefined;
  });
  return data ? hydrate(data) : undefined;
}
export async function hydrate(data: StoredProject): Promise<LocalProjectData> {
  if (data.schema !== 1)
    throw Error(
      "保存データのバージョンに対応していません。データは保持しました。",
    );
  const keys = [
    ...data.sources.map((source) => assetKey(data, source.id)),
    ...(data.coverId ? [assetKey(data, data.coverId)] : []),
  ];
  const restored: File[] = [];
  for (let index = 0; index < keys.length; index++) {
    const asset = await readAsset(keys[index]);
    restored.push(
      new File([asset.blob], asset.name ?? data.sources[index]?.id ?? "cover", {
        type: asset.blob.type,
        lastModified: asset.lastModified,
      }),
    );
  }
  const created: string[] = [];
  const url = (file: File) => {
    const value = URL.createObjectURL(file);
    created.push(value);
    return value;
  };
  try {
    const sources = data.sources.map((s, i) => ({
      ...s,
      file: restored[i],
      url: url(restored[i]),
    }));
    const coverFile = data.coverId ? restored.at(-1) : undefined;
    return {
      ...data,
      sources,
      coverFile,
      cover: coverFile ? url(coverFile) : "",
    };
  } catch (error) {
    created.forEach(URL.revokeObjectURL);
    throw error;
  }
}
export function releaseProjectUrls(project: LocalProjectData) {
  project.sources.forEach((s) => URL.revokeObjectURL(s.url));
  if (project.cover) URL.revokeObjectURL(project.cover);
}
async function collectAssets(tx: IDBTransaction) {
  const jobs = tx.objectStore("jobs");
  // Delete only unreachable assets, across every project and queued recipe.
  const referenced = new Set<string>();
  const projects = (await request(
    tx.objectStore("projects").getAll(),
  )) as StoredProject[];
  const rows = (await request(jobs.getAll())) as StoredEntry[];
  for (const project of [
    ...projects,
    ...rows.flatMap((r) => (r.recipe ? [r.recipe.project] : [])),
  ]) {
    project.sources.forEach((s) => referenced.add(assetKey(project, s.id)));
    if (project.coverId) referenced.add(assetKey(project, project.coverId));
  }
  rows.filter((r) => r.result).forEach((r) => referenced.add(`output:${r.id}`));
  const meta = tx.objectStore("meta");
  for (const key of await request(meta.getAllKeys())) {
    if (!String(key).startsWith("staging:")) continue;
    const stage = (await request(meta.get(key))) as {
      key: string;
      until: number;
    };
    if (stage.until > Date.now()) referenced.add(stage.key);
    else meta.delete(key);
  }
  const assets = tx.objectStore("assets");
  for (const key of await request(assets.getAllKeys())) {
    const text = String(key);
    const owner = text.startsWith("chunk:")
      ? text.slice(6, text.lastIndexOf(":"))
      : text;
    if (!referenced.has(owner)) assets.delete(key);
  }
}
/** Blob assets and completed results are written once; progress writes only metadata. */
export async function saveExportEntries(entries: ExportEntry[]) {
  const assets = new Map<string, Blob>();
  for (const entry of entries) {
    const recipe = entry.recovery ?? entry.input?.recovery;
    if (recipe)
      projectAssets(recipe.project).forEach(([key, blob]) =>
        assets.set(key, blob),
      );
    if (entry.result) assets.set(`output:${entry.id}`, entry.result.blob);
  }
  await checkCapacity([...assets]);
  for (const [key, blob] of assets) await prepareAsset(key, blob);
  await write(async (tx) => {
    const jobs = tx.objectStore("jobs");
    const previous = (await request(jobs.getAll())) as StoredEntry[];
    for (const row of previous)
      if (!entries.some((e) => e.id === row.id)) {
        jobs.delete(row.id);
        // Deletion follows explicit per-output save confirmation. A newer edit or
        // any remaining job keeps the project and all of its shared materials.
        const project = row.recipe?.project;
        if (
          row.state === "completed" &&
          project &&
          !entries.some((e) => {
            const other = e.recovery?.project ?? e.persistedRecipe?.project;
            return other?.id === project.id && other.mode === project.mode;
          })
        ) {
          const projects = tx.objectStore("projects");
          const key = `${project.mode}:${project.id}`;
          const current = await request(projects.get(key));
          if (fingerprint(current) === fingerprint(project)) {
            projects.delete(key);
            const meta = tx.objectStore("meta");
            if (
              (await request(meta.get(`active:${project.mode}`))) === project.id
            )
              meta.delete(`active:${project.mode}`);
          }
        }
      }
    for (const entry of entries) {
      const { input, result, recovery, persistedRecipe, ...metadata } = entry;
      const recipe = recovery ?? input?.recovery;
      if (recipe) await publishAssets(tx, recipe.project);
      const row: StoredEntry = {
        ...metadata,
        order: entries.indexOf(entry),
        recipe: recipe
          ? { project: stored(recipe.project), index: recipe.index }
          : persistedRecipe,
      };
      // Keep the durable result even when a progress-only record is refreshed.
      if (result) {
        const outputKey = `output:${entry.id}`;
        tx.objectStore("meta").delete(stagingKey(outputKey));
        row.result = { filename: result.filename };
      }
      jobs.put(row, entry.id);
    }
    await collectAssets(tx);
  });
}
export async function loadExportEntries(): Promise<ExportEntry[]> {
  await renewRecoveryLease();
  const db = await open();
  const rows = (await request(
    db.transaction("jobs").objectStore("jobs").getAll(),
  )) as StoredEntry[];
  const { buildLocalJobs } = await import("./local-project");
  const entries: ExportEntry[] = [];
  for (const row of rows.sort((a, b) => a.order - b.order)) {
    const { recipe, order: _order, result: savedResult, ...entry } = row;
    void _order;
    if (savedResult) {
      const { blob } = await readAsset(`output:${entry.id}`);
      if (!blob?.size)
        throw Error("完成動画を読み込めません。データを保持しました。");
      entries.push({
        ...entry,
        persistedRecipe: recipe,
        result: { filename: entry.filename, blob },
        state: "completed",
      });
      continue;
    }
    if (recipe) {
      let project: LocalProjectData | undefined;
      try {
        project = await hydrate(recipe.project);
        const jobs = await buildLocalJobs(project);
        if (!jobs[recipe.index]) throw Error("復旧するジョブが不正です。");
        const interrupted =
          ["queued", "preparing", "rendering"].includes(entry.state) ||
          Boolean(entry.interrupted);
        const attempts = (entry.recoveryAttempts ?? 0) + (interrupted ? 1 : 0);
        entries.push({
          ...entry,
          input: jobs[recipe.index],
          recovery: jobs[recipe.index].recovery,
          recoveryAttempts: attempts,
          interrupted: false,
          error:
            attempts > 3
              ? "復旧を3回試行しました。素材と端末の状態を確認して再試行してください。"
              : entry.error,
          state: interrupted
            ? attempts > 3
              ? "failed"
              : "queued"
            : entry.state,
          progress: interrupted ? 0 : entry.progress,
          message: interrupted
            ? "中断した動画を先頭から再作成します"
            : entry.message,
        });
      } catch (error) {
        throw Error(
          `ジョブの復旧に失敗しました。保存データは保持しています。${recoveryMessage(error)}`,
        );
      } finally {
        if (project) releaseProjectUrls(project);
      }
    } else entries.push(entry);
  }
  return entries;
}

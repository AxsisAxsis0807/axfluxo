import {
  runSchema,
  attemptSchema,
  cacheEntrySchema,
} from "../../domain/workflow/run-schema";
import {
  ExecutionError,
  outputIds,
  terminal,
  type RunRepository,
  type Commit,
  type Run,
  type CacheEntry,
  type Output,
} from "../../domain/workflow/execution";
const stores = ["runs", "attempts", "cache", "outputs"] as const;
type Store = (typeof stores)[number];
export function openRunDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("axfluxo-execution", 1);
    let settled = false;
    request.onupgradeneeded = () => {
      for (const store of stores) {
        const created = request.result.createObjectStore(store, {
          keyPath: "id",
        });
        if (store === "runs") {
          created.createIndex("createdAt", "createdAt");
          created.createIndex("workflowCreatedAt", ["workflowId", "createdAt"]);
        }
        if (store === "attempts") created.createIndex("runId", "runId");
      }
    };
    request.onblocked = () => {
      settled = true;
      reject(
        new ExecutionError(
          "DB_BLOCKED",
          "実行DBがブロックされています。他のタブを閉じてください",
        ),
      );
    };
    request.onerror = () =>
      reject(
        new ExecutionError(
          request.error?.name === "VersionError" ? "DB_VERSION" : "DB_OPEN",
          "実行DBを開けません。既存データは保持されています",
        ),
      );
    request.onsuccess = () => {
      const db = request.result;
      if (settled) {
        db.close();
        return;
      }
      db.onversionchange = () => db.close();
      resolve(db);
    };
  });
}
async function transaction<T>(
  names: Store[],
  mode: IDBTransactionMode,
  schedule: (tx: IDBTransaction, result: (value: T) => void) => void,
  signal?: AbortSignal,
): Promise<T> {
  const db = await openRunDB();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(names, mode);
      let result: T;
      const abort = () => {
        try {
          tx.abort();
        } catch {}
      };
      const detach = () => signal?.removeEventListener("abort", abort);
      tx.oncomplete = () => {
        detach();
        resolve(result);
      };
      tx.onabort = () => {
        detach();
        reject(
          new ExecutionError(
            signal?.aborted ? "CANCELLED" : "DB_WRITE",
            signal?.aborted
              ? "実行を中断しました"
              : "実行履歴を保存できませんでした",
          ),
        );
      };
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) {
        abort();
        return;
      }
      try {
        schedule(tx, (v) => {
          result = v;
        });
      } catch {
        abort();
      }
    });
  } finally {
    db.close();
  }
}
const read = <T>(store: Store, id?: string) =>
  transaction<T>([store], "readonly", (tx, result) => {
    const request =
      id === undefined
        ? tx.objectStore(store).getAll()
        : tx.objectStore(store).get(id);
    request.onsuccess = () => result(request.result);
  });
export const runRepository: RunRepository = {
  commit: (change: Commit, signal) =>
    transaction<void>(
      [...stores],
      "readwrite",
      (tx) => {
        tx.objectStore("runs").put(change.run);
        if (change.attempt) tx.objectStore("attempts").put(change.attempt);
        if (change.cache) tx.objectStore("cache").put(change.cache);
        for (const output of change.outputs ?? [])
          tx.objectStore("outputs").add(output);
      },
      signal,
    ),
  list: (id) =>
    transaction<Run[]>(["runs"], "readonly", (tx, result) => {
      const store = tx.objectStore("runs");
      const request = id
        ? store
            .index("workflowCreatedAt")
            .openCursor(IDBKeyRange.bound([id, ""], [id, "\uffff"]), "prev")
        : store.index("createdAt").openCursor(null, "prev");
      const rows: Run[] = [];
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor || rows.length >= 100) {
          result(rows);
          return;
        }
        const parsed = runSchema.safeParse(cursor.value);
        if (!parsed.success) {
          tx.abort();
          return;
        }
        rows.push(parsed.data as Run);
        cursor.continue();
      };
    }),
  attempts: (id) =>
    transaction<import("../../domain/workflow/execution").Attempt[]>(
      ["attempts"],
      "readonly",
      (tx, result) => {
        const request = tx.objectStore("attempts").index("runId").getAll(id);
        request.onsuccess = () => {
          const parsed = attemptSchema.array().safeParse(request.result);
          if (!parsed.success) {
            tx.abort();
            return;
          }
          result(parsed.data);
        };
      },
    ),
  cached: async (key) => {
    const result = cacheEntrySchema.safeParse(
      await read<unknown>("cache", key),
    );
    return result.success ? (result.data as CacheEntry) : undefined;
  },
  output: (id) => read<Output | undefined>("outputs", id),
  // Histories pin immutable outputs. Eviction never deletes a run's data.
  evictCache: () =>
    transaction<void>([...stores], "readwrite", (tx) => {
      tx.objectStore("cache").clear();
      const pinned = new Set<string>();
      const request = tx.objectStore("runs").openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor) {
          const parsed = runSchema.safeParse(cursor.value);
          if (!parsed.success) {
            tx.abort();
            return;
          }
          for (const node of Object.values(parsed.data.nodes))
            for (const id of outputIds(
              (node.outputs as Record<
                string,
                import("../../domain/workflow/execution").Value
              >) ?? {},
            ))
              pinned.add(id);
          for (const source of Object.values(parsed.data.snapshot.sources))
            if (source.reference.scope === "execution")
              pinned.add(source.reference.outputId);
          cursor.continue();
          return;
        }
        const outputs = tx.objectStore("outputs").openKeyCursor();
        outputs.onsuccess = () => {
          const output = outputs.result;
          if (!output) return;
          if (!pinned.has(String(output.key)))
            tx.objectStore("outputs").delete(output.primaryKey);
          output.continue();
        };
      };
    }),
};
/** One local runner/render stream across tabs. Locks release on crash/reload. */
export async function withRunnerLock<T>(task: () => Promise<T>): Promise<T> {
  if (!globalThis.navigator?.locks)
    throw new ExecutionError(
      "LOCKS_UNAVAILABLE",
      "このブラウザーは安全な実行ロックに対応していません",
    );
  return navigator.locks.request(
    "axfluxo-execution",
    { ifAvailable: true },
    (lock) => {
      if (!lock) throw new ExecutionError("RUN_BUSY", "別のタブで実行中です");
      return task();
    },
  );
}
export async function recoverInterrupted(
  repository: RunRepository = runRepository,
) {
  if (!globalThis.navigator?.locks) return;
  await navigator.locks.request(
    "axfluxo-execution",
    { ifAvailable: true },
    async (lock) => {
      if (!lock) return;
      await recoverRunsUnderLock(repository);
    },
  );
}

/** Caller must own axfluxo-execution lock. Never reruns work. */
export async function recoverRunsUnderLock(
  repository: RunRepository = runRepository,
) {
  for (const run of await repository.list()) {
    if (terminal(run.state)) continue;
    run.state = "interrupted";
    run.endedAt = new Date().toISOString();
    const attempts = await repository.attempts(run.id);
    for (const node of Object.values(run.nodes))
      if (!terminal(node.state)) node.state = "interrupted";
    for (const attempt of attempts.filter((a) => !terminal(a.state))) {
      attempt.state = "interrupted";
      attempt.endedAt = run.endedAt;
      await repository.commit({ run, attempt });
    }
    await repository.commit({ run });
  }
}

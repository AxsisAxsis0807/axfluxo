"use client";
import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import fontManifest from "../../../public/fonts/manifest.json";
import { sha256 } from "../../services/assets";
import {
  type Run,
  type Graph,
  type Value,
  safeError,
  terminal,
} from "../../domain/workflow/execution";
import { createRegistry } from "../../services/workflow/registry";
import { Runner, prepareSnapshot } from "../../services/workflow/runner";
import {
  runRepository,
  recoverInterrupted,
  recoverRunsUnderLock,
  withRunnerLock,
} from "../../services/workflow/run-repository";
import { createAssetResolver } from "../../services/workflow/asset-resolver";
import { saveLibraryOutput } from "../../services/library/repository";
const registry = createRegistry(saveLibraryOutput),
  resolver = createAssetResolver();
const labels = {
  queued: "待機",
  running: "実行中",
  succeeded: "成功",
  failed: "失敗",
  blocked: "依存先の失敗で停止",
  cancelled: "中断",
  interrupted: "前回の実行が途切れました",
};
const versions = async () => ({
  rendererVersion: "studio-1/workflow-1",
  fontVersion: await sha256(new Blob([JSON.stringify(fontManifest)])),
});
export default function RunPanel({
  workflowId,
  snapshot,
  disabled,
  active,
}: {
  workflowId: string;
  snapshot: () => Promise<Graph>;
  disabled: boolean;
  active: boolean;
}) {
  const [runs, setRuns] = useState<Run[]>([]),
    [run, setRun] = useState<Run>(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [policy, setPolicy] = useState<"stop" | "continue">("stop");
  const controller = useRef<AbortController | null>(null),
    mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    let disposed = false;
    void recoverInterrupted()
      .then(() => runRepository.list(workflowId))
      .then((rows) => {
        if (!disposed) {
          setRuns(rows);
          setRun(rows[0]);
        }
      })
      .catch(() => {
        if (!disposed) setError("実行履歴を読み込めませんでした");
      });
    const cancel = () => controller.current?.abort();
    window.addEventListener("pagehide", cancel);
    return () => {
      disposed = true;
      mounted.current = false;
      cancel();
      window.removeEventListener("pagehide", cancel);
    };
  }, [workflowId]);
  useEffect(() => {
    if (!active) controller.current?.abort();
  }, [active]);
  const start = async (previous?: Run) => {
    if (controller.current) return;
    const abort = new AbortController();
    controller.current = abort;
    setBusy(true);
    setError("");
    try {
      await withRunnerLock(async () => {
        await recoverRunsUnderLock();
        const currentVersions = await versions();
        const fixed = previous
          ? { ...structuredClone(previous.snapshot), ...currentVersions }
          : await prepareSnapshot(
              await snapshot(),
              registry,
              resolver,
              currentVersions,
              abort.signal,
            );
        for (const image of Object.values(fixed.sources))
          await resolver.resolve(image.reference, abort.signal);
        await new Runner(registry, runRepository, resolver).run(fixed, {
          signal: abort.signal,
          policy: previous?.policy ?? policy,
          retryOf: previous?.id,
          onChange: (next) => {
            if (mounted.current) setRun(next);
          },
        });
      });
    } catch (e) {
      if (mounted.current)
        setError(
          abort.signal.aborted ? "実行を中断しました" : safeError(e).message,
        );
    } finally {
      controller.current = null;
      if (mounted.current) {
        setBusy(false);
        try {
          setRuns(await runRepository.list(workflowId));
        } catch {
          setError("実行履歴を読み込めませんでした");
        }
      }
    }
  };
  const nodes = Object.values(run?.nodes ?? {}),
    completed = nodes.filter((n) => terminal(n.state)).length;
  return (
    <details className="run-panel">
      <summary>Workflowを実行・実行履歴</summary>
      <div className="button-row">
        <button
          disabled={busy || disabled || !active}
          onClick={() => void start()}
        >
          Workflowを実行
        </button>
        <button disabled={!busy} onClick={() => controller.current?.abort()}>
          実行を中断
        </button>
        <label>
          失敗時
          <select
            disabled={busy}
            value={policy}
            onChange={(event) => setPolicy(event.target.value as typeof policy)}
          >
            <option value="stop">全体停止</option>
            <option value="continue">独立した枝を続行</option>
          </select>
        </label>
      </div>
      {error && <p role="alert">{error}</p>}
      {run && (
        <>
          <p aria-live="polite">
            実行状態: {labels[run.state]} ({completed}/{nodes.length})
          </p>
          <progress
            aria-label="Workflow実行進捗"
            value={completed}
            max={Math.max(1, nodes.length)}
          />
          <ul>
            {nodes.map((node) => (
              <li key={node.nodeId}>
                <span>
                  {registry.get(
                    `${run.snapshot.graph.nodes.find((n) => n.id === node.nodeId)?.type}@1`,
                  )
                    ? run.snapshot.graph.nodes.find((n) => n.id === node.nodeId)
                        ?.type
                    : node.nodeId}
                  : {labels[node.state]}
                </span>
                {node.error && (
                  <p>
                    {node.error.code}: {node.error.message}
                  </p>
                )}
                {node.state === "succeeded" &&
                  Object.entries(node.outputs ?? {}).map(([port, value]) => (
                    <Result key={`${run.id}:${port}`} value={value} />
                  ))}
              </li>
            ))}
          </ul>
        </>
      )}
      <h3>実行履歴</h3>
      <p>再実行は入力versionを固定した新しいattemptを作成します。</p>
      <ul>
        {runs.map((item) => (
          <li key={item.id}>
            <button disabled={busy} onClick={() => setRun(item)}>
              {new Date(item.createdAt).toLocaleString()} · {labels[item.state]}
            </button>
            <button
              disabled={busy || disabled || !active}
              onClick={() => void start(item)}
            >
              この入力で再実行
            </button>
          </li>
        ))}
      </ul>
      <button
        disabled={busy}
        onClick={() =>
          void withRunnerLock(() => runRepository.evictCache()).catch((e) =>
            setError(safeError(e).message),
          )
        }
      >
        キャッシュを破棄（履歴の結果は保持）
      </button>
    </details>
  );
}
function Result({ value }: { value: Value }) {
  const [url, setUrl] = useState<string>(),
    [open, setOpen] = useState(false),
    [error, setError] = useState(false);
  useEffect(() => {
    if (!open || value.type !== "image") return;
    const abort = new AbortController();
    let objectUrl: string | undefined;
    void resolver
      .resolve(value.reference, abort.signal)
      .then((output) => {
        if (abort.signal.aborted) return;
        objectUrl = URL.createObjectURL(output.blob);
        setUrl(objectUrl);
      })
      .catch(() => {
        if (!abort.signal.aborted) setError(true);
      });
    return () => {
      abort.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [open, value]);
  if (value.type === "text") return <p>{value.value.slice(0, 200)}</p>;
  if (value.type === "number") return <p>{value.value}</p>;
  if (value.type === "collection<image>")
    return <p>{value.items.length}枚（順序固定）</p>;
  return (
    <div>
      <button
        onClick={() => {
          setUrl(undefined);
          setError(false);
          setOpen(!open);
        }}
      >
        {open ? "プレビューを閉じる" : "結果をプレビュー"}
      </button>
      {open && url && (
        <Image unoptimized src={url} width={160} height={160} alt="実行結果" />
      )}
      {error && <p>結果を読み込めません</p>}
    </div>
  );
}

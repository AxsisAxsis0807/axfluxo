import type { AssetRef, WorkspaceDocument } from "../workspace/schema";
import type { WorkflowDocument, PortType } from "./schema";
export type AssetKind = "image" | "file" | "audio" | "video";
/** Library IDs and version are mandatory: never resolve an implicit latest. */
export type LibraryReference = {
  scope: "library";
  libraryId: string;
  fileId: string;
  versionId: string;
  kind: AssetKind;
  hash: string;
};
export type Reference =
  | { scope: "workspace"; reference: AssetRef; kind: "image" }
  | { scope: "legacy"; assetId: string; hash: string; kind: "image" }
  | { scope: "execution"; outputId: string; hash: string; kind: "image" }
  | LibraryReference;
export type ImageValue = {
  type: "image";
  reference: Reference;
  hash: string;
  mime: string;
  size: number;
  width: number;
  height: number;
};
export type Value =
  | ImageValue
  | { type: "text"; value: string }
  | { type: "number"; value: number }
  | { type: "file"; reference: LibraryReference }
  | { type: "collection<image>"; items: ImageValue[] };
export type State =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "blocked"
  | "cancelled"
  | "interrupted";
export type SafeError = { code: string; message: string; nodeId?: string };
export type Graph = WorkspaceDocument | WorkflowDocument;
export type Snapshot = {
  graph: Graph;
  sources: Record<string, ImageValue>;
  revisions: Record<string, string>;
  rendererVersion: string;
  fontVersion: string;
  outputSpec: "png-v1";
};
export type Attempt = {
  id: string;
  runId: string;
  nodeId: string;
  number: number;
  state: State;
  startedAt: string;
  endedAt?: string;
  cacheHit?: boolean;
  error?: SafeError;
};
export type NodeRun = {
  nodeId: string;
  state: State;
  attemptIds: string[];
  outputs?: Record<string, Value>;
  error?: SafeError;
};
export type Run = {
  id: string;
  workflowId: string;
  snapshot: Snapshot;
  policy: "stop" | "continue";
  state: State;
  createdAt: string;
  endedAt?: string;
  nodes: Record<string, NodeRun>;
  error?: SafeError;
  retryOf?: string;
};
export type Output = {
  id: string;
  blob: Blob;
  hash: string;
  mime: string;
  width: number;
  height: number;
};
export type CacheEntry = { id: string; outputs: Record<string, Value> };
export type Commit = {
  run: Run;
  attempt?: Attempt;
  cache?: CacheEntry;
  outputs?: Output[];
};
export interface RunRepository {
  commit(change: Commit, signal?: AbortSignal): Promise<void>;
  list(workflowId?: string, limit?: number): Promise<Run[]>;
  attempts(runId: string): Promise<Attempt[]>;
  cached(key: string): Promise<CacheEntry | undefined>;
  output(id: string): Promise<Output | undefined>;
  evictCache(): Promise<void>;
}
export interface Resolver {
  pin(assetId: string, scope: "workspace" | "legacy"): Promise<ImageValue>;
  resolve(reference: Reference, signal: AbortSignal): Promise<Output>;
}
export type NodeContext = {
  signal: AbortSignal;
  snapshot: Snapshot;
  nodeId: string;
  inputs: Record<string, Value>;
  resolver: Resolver;
  outputs: Output[];
};
export type NodeDefinition = {
  validate?: (node: Graph["nodes"][number]) => void;
  pure: true;
  required: string[] | ((node: Graph["nodes"][number]) => string[]);
  ports: {
    id: string;
    direction: "input" | "output";
    type: PortType;
    label: string;
  }[];
  execute(
    node: Graph["nodes"][number],
    context: NodeContext,
  ): Promise<Record<string, Value>>;
};
export class ExecutionError extends Error {
  constructor(
    public code: string,
    message: string,
    public nodeId?: string,
  ) {
    super(message);
  }
}
export function safeError(error: unknown, nodeId?: string): SafeError {
  return error instanceof ExecutionError
    ? {
        code: error.code,
        message: error.message,
        nodeId: error.nodeId ?? nodeId,
      }
    : {
        code: "EXECUTION_FAILED",
        message:
          "処理に失敗しました。入力・保存容量を確認して再試行してください",
        nodeId,
      };
}
export const terminal = (state: State) =>
  state !== "queued" && state !== "running";
export function outputIds(outputs: Record<string, Value>): string[] {
  return Object.values(outputs).flatMap((v) => {
    const images =
      v.type === "image" ? [v] : v.type === "collection<image>" ? v.items : [];
    return images.flatMap((image) =>
      image.reference.scope === "execution" ? [image.reference.outputId] : [],
    );
  });
}

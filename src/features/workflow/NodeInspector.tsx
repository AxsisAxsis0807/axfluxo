import { useEffect, useRef, useState } from "react";
import {
  definitions,
  type WorkflowNode,
  type WorkflowDocument,
} from "../../domain/workflow/schema";
export type Endpoint = { nodeId: string; portId: string };
// Keep the DOM field stable for native undo/IME. Invalid intermediate numbers
// stay visible locally, while only validated configs reach the document.
export function ConfigField({
  value,
  multiline,
  numeric,
  onChange,
  onDraftChange,
}: {
  value: string;
  multiline?: boolean;
  numeric?: boolean;
  onChange: (value: string) => boolean;
  onDraftChange: (pending: boolean) => void;
}) {
  const [draft, setDraft] = useState(value);
  const composing = useRef(false);
  useEffect(() => {
    setDraft(value);
    onDraftChange(false);
  }, [value, onDraftChange]);
  useEffect(() => () => onDraftChange(false), [onDraftChange]);
  const props = {
    value: draft,
    onChange: (
      e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
    ) => {
      setDraft(e.target.value);
      if (!composing.current) onDraftChange(!onChange(e.target.value));
    },
    onCompositionStart: () => {
      composing.current = true;
      onDraftChange(true);
    },
    onCompositionEnd: (
      e: React.CompositionEvent<HTMLInputElement | HTMLTextAreaElement>,
    ) => {
      composing.current = false;
      setDraft(e.currentTarget.value);
      onDraftChange(!onChange(e.currentTarget.value));
    },
  };
  return multiline ? (
    <textarea {...props} rows={4} maxLength={20000} />
  ) : (
    <input
      {...props}
      type={numeric ? "number" : "text"}
      min={numeric ? 64 : undefined}
      max={numeric ? 8192 : undefined}
    />
  );
}
export default function NodeInspector({
  node,
  document: doc,
  pending,
  onPort,
  onChange,
  onClose,
  onDelete,
  onDuplicate,
  onDisconnect,
  onDraftChange,
  nodeDefinitions = definitions,
  allNodes,
  assetChoices,
}: {
  node: WorkflowNode;
  nodeDefinitions?: Record<string, { label: string }>;
  allNodes?: { id: string; type: string }[];
  assetChoices?: { id: string; name: string }[];
  document: WorkflowDocument;
  pending?: Endpoint;
  onPort: (node: WorkflowNode, portId: string) => void;
  onChange: (config: WorkflowNode["config"]) => boolean;
  onDraftChange: (pending: boolean) => void;
  onClose: () => void;
  onDelete: () => void;
  onDuplicate: () => void;
  onDisconnect: (id: string) => void;
}) {
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    const focus = window.document.activeElement as HTMLElement;
    panel.current?.focus();
    return () => {
      if (focus?.isConnected) focus.focus();
    };
  }, []);
  const config = node.config;
  return (
    <aside
      className="wf-inspector nodrag nopan nowheel"
      ref={panel}
      tabIndex={-1}
      aria-label="ノード詳細設定"
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
    >
      <header>
        <h2>{definitions[node.type].label}</h2>
        <button aria-label="ノード設定を閉じる" onClick={onClose}>
          閉じる
        </button>
      </header>
      <p>配置・設定確認用。実行は今後対応します。</p>
      {node.type === "source" && (
        <label>
          素材ID（任意）
          {assetChoices ? (
            <select
              aria-label="入力素材を選択"
              value={"assetId" in config ? (config.assetId ?? "") : ""}
              onChange={(e) =>
                onChange(e.target.value ? { assetId: e.target.value } : {})
              }
            >
              <option value="">未選択</option>
              {assetChoices.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          ) : (
            <ConfigField
              value={"assetId" in config ? (config.assetId ?? "") : ""}
              onDraftChange={onDraftChange}
              onChange={(value) => onChange(value ? { assetId: value } : {})}
            />
          )}
        </label>
      )}
      {node.type === "text" && (
        <label>
          文章
          <ConfigField
            multiline
            value={"text" in config ? config.text : ""}
            onDraftChange={onDraftChange}
            onChange={(text) => onChange({ text })}
          />
        </label>
      )}
      {node.type === "image" && "width" in config && (
        <>
          <label>
            処理
            <select
              value={config.operation}
              onChange={(e) =>
                onChange({
                  ...config,
                  operation: e.target.value as "resize" | "crop",
                })
              }
            >
              <option value="resize">リサイズ（今後対応）</option>
              <option value="crop">クロップ（今後対応）</option>
            </select>
          </label>
          <label>
            幅
            <ConfigField
              numeric
              value={String(config.width)}
              onDraftChange={onDraftChange}
              onChange={(value) =>
                onChange({
                  ...config,
                  width: value === "" ? NaN : Number(value),
                })
              }
            />
          </label>
        </>
      )}
      {node.type === "save" && (
        <label>
          保存名
          <ConfigField
            value={"name" in config ? config.name : ""}
            onDraftChange={onDraftChange}
            onChange={(name) => onChange({ name })}
          />
        </label>
      )}
      {node.type === "post" && "mode" in config && (
        <label>
          投稿方式
          <select
            value={config.mode}
            onChange={(e) =>
              onChange({ mode: e.target.value as "draft" | "direct" })
            }
          >
            <option value="draft">下書き（今後対応）</option>
            <option value="direct">直接投稿（今後対応）</option>
          </select>
        </label>
      )}
      <h3>端子を選択して接続</h3>
      <p>出力を選び、接続先の入力を選択してください。</p>
      {definitions[node.type].ports.map((p) => (
        <button
          key={p.id}
          className="wf-port-button"
          aria-pressed={pending?.nodeId === node.id && pending.portId === p.id}
          onClick={() => onPort(node, p.id)}
        >
          {p.direction === "output" ? "出力 →" : "入力 ←"} {p.label} ({p.type})
        </button>
      ))}
      <h3>接続一覧</h3>
      {doc.edges
        .filter((e) => e.sourceNodeId === node.id || e.targetNodeId === node.id)
        .map((e) => (
          <div key={e.id} className="wf-connection">
            <span>
              {
                nodeDefinitions[
                  (allNodes ?? doc.nodes).find((n) => n.id === e.sourceNodeId)!
                    .type
                ].label
              }{" "}
              →{" "}
              {
                nodeDefinitions[
                  (allNodes ?? doc.nodes).find((n) => n.id === e.targetNodeId)!
                    .type
                ].label
              }
            </span>
            <button
              aria-label={`接続解除 ${e.id}`}
              onClick={() => onDisconnect(e.id)}
            >
              接続解除
            </button>
          </div>
        ))}
      <div className="button-row">
        <button onClick={onDuplicate}>複製</button>
        <button onClick={onDelete}>削除</button>
      </div>
    </aside>
  );
}

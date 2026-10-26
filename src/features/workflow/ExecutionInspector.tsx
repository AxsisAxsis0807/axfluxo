import { useEffect, useRef, useState } from "react";
import { ConfigField } from "./NodeInspector";
import type { ExecutionNode } from "../../domain/workflow/execution-schema";
import {
  executionDefinitions,
  executionNodeSchema,
} from "../../domain/workflow/execution-schema";
import type { WorkspaceDocument } from "../../domain/workspace/schema";
export default function ExecutionInspector({
  node,
  document: doc,
  onChange,
  onPort,
  onClose,
  onDelete,
  onDisconnect,
  onDraftChange,
}: {
  node: ExecutionNode;
  document: WorkspaceDocument;
  onChange: (node: ExecutionNode) => boolean;
  onPort: (id: string) => void;
  onClose: () => void;
  onDelete: () => void;
  onDisconnect: (id: string) => void;
  onDraftChange: (invalid: boolean) => void;
}) {
  const [invalid, setInvalid] = useState(false);
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement;
    panel.current?.focus();
    return () => {
      onDraftChange(false);
      if (opener?.isConnected) opener.focus();
    };
  }, [onDraftChange]);
  const update = (name: string, value: number | boolean) => {
    const parsed = executionNodeSchema.safeParse({
      ...node,
      config: { ...node.config, [name]: value },
    });
    const valid = parsed.success && onChange(parsed.data);
    setInvalid(!valid);
    return valid;
  };
  return (
    <aside
      className="wf-inspector nodrag nopan nowheel"
      aria-label="実行ノード設定"
      tabIndex={-1}
      ref={panel}
      onKeyDown={(event) => {
        if (event.key === "Escape") onClose();
      }}
    >
      <header>
        <h2>{executionDefinitions[node.type].label}</h2>
        <button onClick={onClose}>閉じる</button>
      </header>
      {Object.entries(node.config).map(([name, value]) => (
        <label key={name}>
          {
            (
              {
                value: "数値",
                brightness: "明るさ",
                contrast: "コントラスト",
                saturation: "彩度",
                reverse: "順序を反転",
                index: "要素番号（0から）",
                width: "幅",
                height: "高さ",
              } as Record<string, string>
            )[name]
          }
          {typeof value === "boolean" ? (
            <input
              type="checkbox"
              checked={value}
              onChange={(event) => {
                onDraftChange(!update(name, event.target.checked));
              }}
            />
          ) : (
            <ConfigField
              numeric
              min={
                name === "value"
                  ? null
                  : name === "width" || name === "height"
                    ? 64
                    : 0
              }
              max={
                name === "value"
                  ? null
                  : name === "width" || name === "height"
                    ? 4096
                    : name === "index"
                      ? 199
                      : 2
              }
              value={String(value)}
              onChange={(draft) =>
                update(name, draft === "" ? NaN : Number(draft))
              }
              onDraftChange={onDraftChange}
            />
          )}
        </label>
      ))}
      {invalid && (
        <p role="alert">設定が範囲外です。保存値は変更していません。</p>
      )}
      <h3>端子を選択して接続</h3>
      {executionDefinitions[node.type].ports.map((p) => (
        <button
          className="wf-port-button"
          key={p.id}
          onClick={() => onPort(p.id)}
        >
          {p.direction === "output" ? "出力 →" : "入力 ←"} {p.label} ({p.type})
        </button>
      ))}
      {doc.edges
        .filter((e) => e.sourceNodeId === node.id || e.targetNodeId === node.id)
        .map((e) => (
          <button key={e.id} onClick={() => onDisconnect(e.id)}>
            接続解除 {e.sourcePortId} → {e.targetPortId}
          </button>
        ))}
      <button onClick={onDelete}>削除</button>
    </aside>
  );
}

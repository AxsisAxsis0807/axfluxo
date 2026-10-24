import { useState } from "react";
import {
  definitions,
  nodeTypes,
  type NodeType,
} from "../../domain/workflow/schema";
export default function NodePalette({
  onAdd,
}: {
  onAdd: (type: NodeType) => void;
}) {
  const [query, setQuery] = useState("");
  return (
    <details className="wf-palette">
      <summary>＋ ノードを追加</summary>
      <div>
        <button
          onClick={(e) =>
            e.currentTarget.closest("details")?.removeAttribute("open")
          }
        >
          ノード一覧を閉じる
        </button>
        <label>
          ノード検索
          <input
            aria-label="ノード検索"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        {nodeTypes
          .filter((t) => definitions[t].label.includes(query))
          .map((t) => (
            <button
              key={t}
              onClick={(e) => {
                onAdd(t);
                e.currentTarget.closest("details")?.removeAttribute("open");
              }}
            >
              {definitions[t].label} <small>設定のみ</small>
            </button>
          ))}
        {!nodeTypes.some((t) => definitions[t].label.includes(query)) && (
          <p>一致するノードがありません</p>
        )}
      </div>
    </details>
  );
}

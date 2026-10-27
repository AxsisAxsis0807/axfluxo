import { useState } from "react";
import {
  definitions,
  nodeTypes,
  type NodeType,
} from "../../domain/workflow/schema";
export default function NodePalette({
  onAdd,
  onAddImageEdit,
}: {
  onAdd: (type: NodeType) => void;
  onAddImageEdit?: () => void;
}) {
  const types: (NodeType | "image-edit")[] = onAddImageEdit
    ? [...nodeTypes, "image-edit"]
    : [...nodeTypes];
  const label = (type: NodeType | "image-edit") =>
    type === "image-edit" ? "画像編集" : definitions[type].label;
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
        {types
          .filter((t) => label(t).includes(query))
          .map((t) => (
            <button
              key={t}
              onClick={(e) => {
                if (t === "image-edit") onAddImageEdit?.();
                else onAdd(t);
                e.currentTarget.closest("details")?.removeAttribute("open");
              }}
            >
              {label(t)}{" "}
              <small>
                {!onAddImageEdit
                  ? "設定のみ"
                  : t === "source"
                    ? "画像をライブラリーから選択"
                    : t === "image-edit"
                      ? "個別描画"
                      : t === "post"
                        ? "未対応"
                        : "接続して実行"}
              </small>
            </button>
          ))}
        {!types.some((t) => label(t).includes(query)) && (
          <p>一致するノードがありません</p>
        )}
      </div>
    </details>
  );
}

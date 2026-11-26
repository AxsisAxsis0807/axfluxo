import { AudioLines, ChevronDown, ChevronUp, Scissors } from "lucide-react";
import type { ReactNode } from "react";
import { versionRows, type AudioEdit } from "./all-versions-edit";

export default function AllVersionsAudioCards({
  edit,
  songTitle,
  onTitle,
  onNames,
  openId,
  onToggle,
  onMove,
  renderTrim,
}: {
  edit: AudioEdit;
  songTitle: string;
  onTitle: (value: string) => void;
  onNames: (value: string) => void;
  openId: string | null;
  onToggle: (id: string) => void;
  onMove: (id: string, direction: -1 | 1) => void;
  renderTrim: (index: number) => ReactNode;
}) {
  const { byId } = versionRows(edit);
  return (
    <section className="av-panel" aria-labelledby="all-versions-info">
      <h2 id="all-versions-info">基本情報</h2>
      <label>
        曲名
        <input
          value={songTitle}
          onChange={(event) => onTitle(event.target.value)}
        />
      </label>
      <label>
        バージョン名（改行区切り）
        <textarea
          rows={4}
          value={edit.names}
          onChange={(event) => onNames(event.target.value)}
        />
      </label>
      <div
        className="av-management"
        aria-labelledby="all-versions-sources"
        role="region"
      >
        <header className="av-between">
          <h2 id="all-versions-sources">音源管理・並べ替え</h2>
          <span>{edit.sources.length}曲</span>
        </header>
        {edit.sources.map((source, index) => {
          const expanded = openId === source.id;
          const trimId = `all-versions-trim-${source.id}`;
          return (
            <article
              key={source.id}
              className="av-card"
              aria-label={`音源 ${index + 1}`}
            >
              <div className="av-file">
                <span>{index + 1}</span>
                <AudioLines size={16} aria-hidden="true" />
                <span>{source.file.name}</span>
              </div>
              <div className="av-track">
                <div>
                  <strong>{songTitle}</strong>
                  {byId.get(source.id)?.map((name, row) => (
                    <div key={row} className="av-version">
                      {name}
                    </div>
                  ))}
                </div>
                <div className="av-moves">
                  <button
                    type="button"
                    aria-label={`音源 ${index + 1} を上へ移動`}
                    disabled={index === 0}
                    onClick={() => onMove(source.id, -1)}
                  >
                    <ChevronUp size={20} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    aria-label={`音源 ${index + 1} を下へ移動`}
                    disabled={index === edit.sources.length - 1}
                    onClick={() => onMove(source.id, 1)}
                  >
                    <ChevronDown size={20} aria-hidden="true" />
                  </button>
                </div>
              </div>
              <button
                type="button"
                className="av-trim-button"
                aria-expanded={expanded}
                aria-controls={trimId}
                onClick={() => onToggle(source.id)}
              >
                <Scissors size={16} aria-hidden="true" /> 切り取り
              </button>
              <div id={trimId} hidden={!expanded} className="av-trim">
                {expanded && renderTrim(index)}
              </div>
            </article>
          );
        })}
        <footer className="av-between">
          <span>曲間</span>
          <strong>0秒（固定）</strong>
        </footer>
      </div>
      <style>{cardStyles}</style>
    </section>
  );
}

const cardStyles = `.av-panel {
  --editor-border: #3c3c3c;
  --editor-muted: #b6b6b6;
  width: min(100%, 40rem);
  margin: 16px auto;
  padding: 16px;
  box-sizing: border-box;
  border: 1px solid var(--editor-border);
  border-radius: 16px;
  background: #1c1c1c;
  color: #f5f5f5;
  color-scheme: dark;
}

.av-panel h2 {
  margin: 0;
  font-size: 1rem;
  line-height: 1.4;
}

.local-video-tool .av-panel > label {
  display: grid;
  gap: 12px;
  color: var(--editor-muted);
  font-size: 0.875rem;
}

.av-panel > label input,
.av-panel > label textarea {
  width: 100%;
  box-sizing: border-box;
  padding: 8px 14px;
  border: 1px solid #555;
  background: transparent;
  color: #f5f5f5;
  font-family: inherit;
  line-height: 1.25;
}

.av-panel > label input,
.av-panel .av-trim-button {
  border-radius: 999px;
}

.av-panel > label textarea {
  border-radius: 10px;
  resize: vertical;
}

.av-management {
  margin-top: 20px;
  padding-top: 20px;
  border-top: 1px solid var(--editor-border);
}

.av-between {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.av-between span,
.av-file {
  color: var(--editor-muted);
  font-size: 0.875rem;
}

.av-card {
  margin-top: 12px;
  padding: 11px;
  border: 1px solid var(--editor-border);
  border-radius: 9px;
  min-width: 0;
}

.av-file {
  display: grid;
  grid-template-columns: auto auto minmax(0, 1fr);
  align-items: center;
  gap: 8px;
  padding-bottom: 14px;
  border-bottom: 1px solid var(--editor-border);
}

.av-track {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 44px;
  align-items: center;
  gap: 8px;
  margin: 8px 0;
}

.av-track strong {
  display: block;
  font-size: 1rem;
  line-height: 1.3;
}

.av-version {
  color: var(--editor-muted);
  margin-top: 4px;
  font-size: 1rem;
  white-space: pre-wrap;
}

.av-moves button,
.av-panel .av-trim-button {
  display: flex;
  align-items: center;
  justify-content: center;
  color: inherit;
  background: transparent;
}

.av-moves button {
  width: 44px;
  padding: 0;
  border: 0;
  border-radius: 999px;
}

.av-moves button:disabled {
  background: #272727;
  color: #777;
  cursor: default;
}

.av-panel .av-trim-button {
  width: 100%;
  gap: 8px;
  border: 1px solid #555;
}

.av-trim:not([hidden]),
.av-management footer {
  margin-top: 14px;
}
`;

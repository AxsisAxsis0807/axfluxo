"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import WorkspaceDialog from "../workspace/WorkspaceDialog";
import ImageEditor from "../editor/ImageEditor";
import { useEditorSession } from "../editor/useEditorSession";
import { EditorDraftContext } from "../editor/EditorDraftContext";
import {
  baseLayer,
  defaultCrop,
  newPage,
  newText,
  reducer,
  type Action,
  type ImageLayer,
  type Layer,
  type ProjectDocument,
} from "../../domain/document";
import {
  editorRecordSchema,
  type EditorRecord,
} from "../../domain/workspace/schema";
import { Autosave, type Status } from "../../services/workspace/autosave";
import {
  saveDraft,
  WorkspaceConflict,
  storeAsset,
  getAsset,
} from "../../services/workspace/repository";
import { importImage } from "../../services/assets";
import { download, zipImages } from "../../services/backup";
import { exportPage } from "../../renderers/scene";
import type { Asset } from "../../services/storage";

export default function ImageEditSession({
  initial,
  initialPageId,
  nodeName,
  onApply,
  onBackup,
  onSaveCopy,
  onReload,
}: {
  initial: EditorRecord;
  initialPageId?: string;
  nodeName: string;
  onApply: (
    record: EditorRecord,
    expected: number,
    pageId: string,
  ) => Promise<void>;
  onBackup: () => Promise<void>;
  onSaveCopy: (record: EditorRecord) => Promise<void>;
  onReload: () => Promise<void>;
}) {
  const session = useEditorSession(initial.document, initialPageId),
    record = useRef(structuredClone(initial));
  const currentHistory = useRef(session.history);
  currentHistory.current = session.history;
  const [status, setStatus] = useState<Status>("保存済み"),
    [error, setError] = useState("");
  const [saveError, setSaveError] = useState("");
  const [applyConflict, setApplyConflict] = useState(false);
  const saveFailure = useRef<unknown>(undefined);
  const [pending, setPending] = useState(false),
    pendingFields = useRef(new Set<string>()),
    composing = useRef(false),
    formPending = useRef(false),
    invalid = useRef(false);
  const [assets, setAssets] = useState<Asset[]>([]),
    [crop, setCrop] = useState<ImageLayer>();
  const importing = useRef(false);
  const [importBusy, setImportBusy] = useState(false);
  const [busy, setBusy] = useState(false),
    [exporting, setExporting] = useState(false),
    [exportOpen, setExportOpen] = useState(false);
  const [format, setFormat] = useState<"png" | "jpeg">("png"),
    [allPages, setAllPages] = useState(false),
    [output, setOutput] = useState<Blob>(),
    [exportError, setExportError] = useState("");
  const input = useRef<HTMLInputElement>(null),
    replacement = useRef<HTMLInputElement>(null),
    mounted = useRef(true),
    exportController = useRef<AbortController | null>(null);
  const page =
      session.doc.pages.find((p) => p.id === session.pageId) ??
      session.doc.pages[0],
    layer = page.layers.find((l) => l.id === session.selected);
  const report = useCallback((e: unknown) => {
    if (saveFailure.current === e) return;
    if (e instanceof WorkspaceConflict) setApplyConflict(true);
    setError(e instanceof Error ? e.message : String(e));
  }, []);
  const [saver] = useState(
    () =>
      new Autosave<EditorRecord, EditorRecord>(
        initial.revision,
        saveDraft,
        (next, e, saved) => {
          if (saved) record.current.revision = saved.revision;
          if (mounted.current) {
            setStatus(next);
            saveFailure.current = e;
            setSaveError(e ? (e instanceof Error ? e.message : String(e)) : "");
          }
        },
      ),
  );
  const draftChange = useCallback((id: string, isPending: boolean) => {
    if (isPending) pendingFields.current.add(id);
    else pendingFields.current.delete(id);
    setPending(
      pendingFields.current.size > 0 || formPending.current || invalid.current,
    );
  }, []);
  const send = (action: Action) => {
    try {
      const next = reducer(currentHistory.current, action);
      currentHistory.current = next;
      record.current = { ...record.current, document: next.present };
      session.dispatch(action);
      invalid.current = false;
      setError("");
      saver.edit(record.current);
      setPending(pendingFields.current.size > 0 || formPending.current);
    } catch (e) {
      invalid.current = true;
      setPending(true);
      report(e);
    }
  };
  const commit = (doc: ProjectDocument) =>
    send({ type: "commit", document: doc, at: new Date().toISOString() });
  const changePage = (patch: Partial<typeof page>) =>
    commit({
      ...record.current.document,
      pages: record.current.document.pages.map((p) =>
        p.id === page.id ? { ...p, ...patch } : p,
      ),
    });
  const patchLayer = (id: string, patch: Partial<Layer>, allowLocked = false) =>
    changePage({
      layers: page.layers.map((l) =>
        l.id === id && (!l.locked || allowLocked)
          ? ({ ...l, ...patch } as Layer)
          : l,
      ),
    });
  const addLayer = (item: Layer) => {
    if (page.layers.length >= 100) {
      report(new Error("レイヤーは100個までです"));
      return;
    }
    const latest = record.current.document.pages.find((p) => p.id === page.id);
    if (!latest) return;
    changePage({
      layers: [
        ...latest.layers,
        { ...item, x: page.width / 2, y: page.height / 2 },
      ],
    });
    session.setSelected(item.id);
    session.setMobilePanel(true);
    session.setPanel("design");
  };
  const refreshAssets = useCallback(async () => {
    const entries = await Promise.all(
      Object.entries(record.current.assets).map(async ([id, ref]) => ({
        ...(await getAsset(ref)),
        id,
      })),
    );
    if (mounted.current) setAssets(entries);
  }, []);
  useEffect(() => {
    mounted.current = true;
    saver.resume();
    void refreshAssets().catch(report);
    return () => {
      mounted.current = false;
      exportController.current?.abort();
      saver.dispose();
    };
  }, [refreshAssets, report, saver]);
  const resolver = useMemo(
    () => async (id: string) => {
      const ref = record.current.assets[id];
      if (!ref) throw new Error("画像参照がありません");
      return getAsset(ref);
    },
    [],
  );
  const save = async () => {
    if (importing.current)
      throw new Error("画像の取り込み完了後に保存してください");
    if (
      composing.current ||
      pendingFields.current.size ||
      formPending.current ||
      invalid.current
    )
      throw new Error(
        "入力未確定です。変換・フォームを確定してから保存してください",
      );
    await saver.flush();
  };
  useEffect(() => {
    const prevent = (event: BeforeUnloadEvent) => {
      if (saver.dirty || pending || busy || importBusy) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", prevent);
    return () => window.removeEventListener("beforeunload", prevent);
  }, [saver, pending, busy, importBusy]);
  // A real history entry prevents Back from discarding this full-screen session.
  useEffect(() => {
    window.history.pushState({ ...window.history.state, imageEdit: true }, "");
    const back = () => {
      window.history.pushState(
        { ...window.history.state, imageEdit: true },
        "",
      );
      report(
        new Error(
          "編集画面の「保存してWorkflowへ戻る」で保存して戻ってください",
        ),
      );
    };
    window.addEventListener("popstate", back);
    return () => window.removeEventListener("popstate", back);
  }, [report]);
  const apply = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await save();
      await onApply(
        editorRecordSchema.parse(record.current),
        saver.revision,
        page.id,
      );
    } catch (e) {
      report(e);
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  const addFile = async (file: File, replace = false) => {
    if (busy || exporting || importing.current) {
      report(new Error("処理の完了後に画像を追加してください"));
      return;
    }
    importing.current = true;
    setImportBusy(true);
    try {
      const asset = await importImage(file),
        ref = await storeAsset(asset),
        id = crypto.randomUUID();
      record.current.assets = { ...record.current.assets, [id]: ref };
      await refreshAssets();
      if (replace && layer?.kind === "image")
        setCrop({ ...layer, assetId: id });
      else
        addLayer({
          ...baseLayer("image"),
          kind: "image",
          assetId: id,
          width: Math.min(page.width, 900),
          height: Math.min(page.height, 900),
          crop: defaultCrop(),
          effects: { brightness: 1, contrast: 1, saturation: 1, blur: 0 },
        });
    } catch (e) {
      report(e);
    } finally {
      importing.current = false;
      if (mounted.current) setImportBusy(false);
    }
  };
  const exportImages = async () => {
    if (exporting) return;
    setExporting(true);
    setExportError("");
    setOutput(undefined);
    const controller = new AbortController();
    exportController.current = controller;
    try {
      await save();
      const doc = structuredClone(record.current.document),
        pages = allPages
          ? doc.pages
          : [doc.pages.find((p) => p.id === page.id)!],
        files: Record<string, Uint8Array> = {};
      let first: Blob | undefined;
      for (let i = 0; i < pages.length; i++) {
        controller.signal.throwIfAborted();
        const blob = await exportPage(
          pages[i],
          doc,
          format,
          0.92,
          "#ffffff",
          false,
          resolver,
          controller.signal,
        );
        controller.signal.throwIfAborted();
        first ??= blob;
        files[
          `${String(i + 1).padStart(2, "0")}-${pages[i].name.replace(/[^\p{L}\p{N}_-]/gu, "_")}.${format === "jpeg" ? "jpg" : "png"}`
        ] = new Uint8Array(await blob.arrayBuffer());
      }
      if (mounted.current)
        setOutput(pages.length > 1 ? zipImages(files) : first);
    } catch (e) {
      if (mounted.current)
        setExportError(e instanceof Error ? e.message : String(e));
    } finally {
      if (mounted.current) setExporting(false);
    }
  };
  const moveLayer = (direction: number) => {
    if (!layer || layer.locked) return;
    const list = [...page.layers],
      i = list.findIndex((l) => l.id === layer.id),
      to = i + direction;
    if (to < 0 || to >= list.length || list[to].locked) return;
    [list[i], list[to]] = [list[to], list[i]];
    changePage({ layers: list });
  };
  return (
    <EditorDraftContext.Provider value={draftChange}>
      <div
        className="image-edit-session"
        aria-label="画像編集セッション"
        onCompositionStartCapture={() => {
          composing.current = true;
          setPending(true);
        }}
        onCompositionEndCapture={() => {
          composing.current = false;
        }}
        onInputCapture={(e) => {
          if ((e.target as HTMLElement).closest("form")) {
            formPending.current = true;
            setPending(true);
          }
        }}
        onSubmit={() => {
          if (!invalid.current) {
            formPending.current = false;
            setPending(pendingFields.current.size > 0);
          }
        }}
        onKeyDown={(e) => {
          if (importing.current || busy || exporting) return;
          if (
            e.nativeEvent.isComposing ||
            (e.target as HTMLElement).closest(
              "input,textarea,select,[contenteditable=true],dialog",
            )
          )
            return;
          if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
            e.preventDefault();
            void save().catch(report);
          }
          if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
            e.preventDefault();
            send({
              type: e.shiftKey ? "redo" : "undo",
              at: new Date().toISOString(),
            });
          }
          if (
            (e.key === "Delete" || e.key === "Backspace") &&
            layer &&
            !layer.locked
          ) {
            e.preventDefault();
            changePage({
              layers: page.layers.filter((l) => l.id !== layer.id),
            });
          }
        }}
      >
        <header className="session-bar">
          <b>{nodeName}</b>
          <span role="status">
            {importBusy
              ? "画像取り込み中"
              : pending
                ? "入力未確定・未保存"
                : status}
          </span>
          <button disabled={busy || exporting} onClick={() => void apply()}>
            保存してWorkflowへ戻る
          </button>
          <button disabled={busy} onClick={() => setExportOpen(true)}>
            画像を書き出す
          </button>
        </header>
        <p className="session-note">
          作業版を自動保存しています。戻る操作で適用版を確定し、出力画像はWorkflowで個別に更新します。Undo履歴はこのセッション内のみです。
        </p>
        {(error || saveError || applyConflict) && (
          <div role="alert" className="wf-notice">
            {error ||
              saveError ||
              "適用時の更新が競合しました。再読込または別コピー保存を選んでください"}
            <button
              onClick={() => {
                setError("");
                void saver.retry().catch(report);
              }}
            >
              保存を再試行
            </button>
            {(status === "競合・未保存" || applyConflict) && (
              <>
                <button
                  disabled={busy}
                  onClick={() => {
                    setBusy(true);
                    void onReload()
                      .catch(report)
                      .finally(() => {
                        if (mounted.current) setBusy(false);
                      });
                  }}
                >
                  保存版を再読込（現在の編集を破棄）
                </button>
                <button
                  disabled={pending}
                  onClick={() => {
                    if (importing.current) {
                      report(new Error("画像取り込み完了を待ってください"));
                      return;
                    }
                    setBusy(true);
                    void onSaveCopy(structuredClone(record.current))
                      .catch(report)
                      .finally(() => {
                        if (mounted.current) setBusy(false);
                      });
                  }}
                >
                  別コピーとして保存
                </button>
              </>
            )}
          </div>
        )}
        <input
          hidden
          type="file"
          accept="image/png,image/jpeg,image/webp"
          ref={input}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void addFile(file);
            e.target.value = "";
          }}
        />
        <input
          hidden
          type="file"
          accept="image/png,image/jpeg,image/webp"
          ref={replacement}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void addFile(file, true);
            e.target.value = "";
          }}
        />
        <div inert={busy || exporting || importBusy ? true : undefined}>
          <ImageEditor
            {...session}
            doc={session.doc}
            page={page}
            layer={layer}
            status={
              importBusy
                ? "画像取り込み中"
                : pending
                  ? "入力未確定・未保存"
                  : status
            }
            dispatch={send}
            input={input}
            replaceInput={replacement}
            assets={assets}
            crop={crop}
            setCrop={setCrop}
            commit={commit}
            patchLayer={patchLayer}
            changePage={changePage}
            save={save}
            report={report}
            onBack={() => void apply()}
            makeBackup={async () => {
              try {
                await save();
                await onBackup();
              } catch (e) {
                report(e);
              }
            }}
            saveTemplate={async () => {}}
            workflowSession
            assetResolver={resolver}
            addText={() => addLayer(newText())}
            addShape={(shape = "rect") =>
              addLayer({
                ...baseLayer("shape"),
                kind: "shape",
                shape,
                fill: "#b6ed79",
                fillAlpha: 1,
                stroke: "#b6ed79",
                strokeWidth: shape === "line" ? 8 : 0,
                radius: 24,
                width: 400,
                height: shape === "line" ? 16 : 300,
              })
            }
            duplicateLayer={() => {
              if (layer)
                addLayer({
                  ...structuredClone(layer),
                  id: crypto.randomUUID(),
                  locked: false,
                  name: layer.name + " のコピー",
                });
            }}
            reorderLayer={moveLayer}
            deleteLayer={() => {
              if (layer && !layer.locked) {
                changePage({
                  layers: page.layers.filter((l) => l.id !== layer.id),
                });
                session.setSelected(undefined);
              }
            }}
            addPage={(duplicate = false) => {
              if (session.doc.pages.length >= 20) {
                report(new Error("ページは20枚までです"));
                return;
              }
              const p = duplicate
                ? {
                    ...structuredClone(page),
                    id: crypto.randomUUID(),
                    layers: page.layers.map((l) => ({
                      ...structuredClone(l),
                      id: crypto.randomUUID(),
                    })),
                  }
                : newPage();
              commit({
                ...record.current.document,
                pages: [...record.current.document.pages, p],
              });
              session.setPageId(p.id);
              session.setSelected(undefined);
            }}
            removePage={() => {
              if (session.doc.pages.length === 1) return;
              const pages = session.doc.pages.filter((p) => p.id !== page.id);
              commit({ ...record.current.document, pages });
              session.setPageId(pages[0].id);
              session.setSelected(undefined);
            }}
            reorderPage={(direction) => {
              const pages = [...session.doc.pages],
                i = pages.findIndex((p) => p.id === page.id),
                to = i + direction;
              if (to < 0 || to >= pages.length) return;
              [pages[i], pages[to]] = [pages[to], pages[i]];
              commit({ ...record.current.document, pages });
            }}
            sessionBusy={busy || exporting}
          />
        </div>
        {exportOpen && (
          <WorkspaceDialog
            label="画像書き出し"
            className="session-export"
            onClose={() => {
              exportController.current?.abort();
              setExportOpen(false);
            }}
          >
            <h2>端末へ画像を書き出す</h2>
            <label>
              形式
              <select
                value={format}
                onChange={(e) => setFormat(e.target.value as "png" | "jpeg")}
              >
                <option value="png">PNG</option>
                <option value="jpeg">JPEG（白背景）</option>
              </select>
            </label>
            <label>
              <input
                type="checkbox"
                checked={allPages}
                onChange={(e) => setAllPages(e.target.checked)}
              />
              全ページをZIPで書き出す
            </label>
            <button disabled={exporting} onClick={() => void exportImages()}>
              画像を生成
            </button>
            {exporting && (
              <button onClick={() => exportController.current?.abort()}>
                生成をキャンセル
              </button>
            )}
            {exportError && <p role="alert">{exportError}</p>}
            {output && (
              <button
                onClick={() =>
                  download(
                    output,
                    `image-edit.${allPages && session.doc.pages.length > 1 ? "zip" : format === "jpeg" ? "jpg" : "png"}`,
                  )
                }
              >
                ファイルを保存
              </button>
            )}
            <button
              onClick={() => {
                exportController.current?.abort();
                setExportOpen(false);
              }}
            >
              閉じる
            </button>
            <p>
              ダウンロードを開始します。保存完了はSafariやFiles側で確認してください。
            </p>
          </WorkspaceDialog>
        )}
      </div>
    </EditorDraftContext.Provider>
  );
}

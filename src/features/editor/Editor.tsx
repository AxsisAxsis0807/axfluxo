"use client";
import Account from "../auth/Account";
import dynamic from "next/dynamic";
import { WORKFLOW_ENABLED } from "../../config/workflow-limits";
const Workflow = dynamic(() => import("../workflow/Workflow"), {
  ssr: false,
  loading: () => <p role="status">Workflowを読み込み中…</p>,
});
import { useCallback, useEffect, useRef, useState } from "react";
/* eslint-disable @next/next/no-img-element -- Blob URLs are local decoded user assets. */
import {
  Download,
  FolderOpen,
  Grid2X2,
  ImagePlus,
  Layers,
  LayoutTemplate,
  Plus,
  Settings,
  Shapes,
  Sparkles,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import {
  baseLayer,
  cloneProject,
  defaultCrop,
  documentSchema,
  newPage,
  newProject,
  newText,
  requiredMissing,
  uid,
  type ImageLayer,
  type Layer,
  type Page,
  type ProjectDocument,
} from "../../domain/document";
import {
  all,
  put,
  ConflictError,
  remove,
  SaveQueue,
  saveTemplateVersion,
  type Asset,
  type Template,
} from "../../services/storage";
import { importImage } from "../../services/assets";
import { download, zipImages } from "../../services/backup";
import { exportPage } from "../../renderers/scene";
import { createSample } from "../../services/sample";
import ImageEditor from "./ImageEditor";
import { NumberField, colorField } from "./EditorFields";
import { legacyStudioAdapter } from "./LegacyStudioAdapter";
import { useEditorSession } from "./useEditorSession";
type View =
  "workflow" | "dashboard" | "studio" | "templates" | "assets" | "settings";
type LocalTemplate = Template & { templateId?: string };
const start = newProject();
export default function Editor() {
  const {
    history,
    dispatch,
    doc,
    pageId,
    setPageId,
    selected,
    setSelected,
    panel,
    setPanel,
    mobilePanel,
    setMobilePanel,
    zoom,
    setZoom,
    snap,
    setSnap,
    panMode,
    setPanMode,
    fitToken,
    setFitToken,
  } = useEditorSession(start);
  const current = useRef(doc);
  current.current = doc;
  const [workflowOpened, setWorkflowOpened] = useState(false);
  const [view, setView] = useState<View>("dashboard");
  const [projects, setProjects] = useState<ProjectDocument[]>([]),
    [assets, setAssets] = useState<Asset[]>([]),
    [templates, setTemplates] = useState<LocalTemplate[]>([]),
    [ready, setReady] = useState(false),
    [status, setStatus] = useState("読み込み中"),
    [error, setError] = useState(""),
    [crop, setCrop] = useState<ImageLayer>(),
    [exportOpen, setExportOpen] = useState(false),
    [format, setFormat] = useState<"png" | "jpeg">("png"),
    [exportAll, setExportAll] = useState(false),
    [quality, setQuality] = useState(0.92),
    [jpegColor, setJpegColor] = useState("#ffffff"),
    [allowOverflow, setAllowOverflow] = useState(false),
    [exportBusy, setExportBusy] = useState(false),
    [progress, setProgress] = useState(""),
    [exportBlob, setExportBlob] = useState<{
      blob: Blob;
      name: string;
      url?: string;
    }>(),
    [editingTemplate, setEditingTemplate] = useState<{
      id: string;
      version: number;
    }>();
  const queue = useRef(new SaveQueue()),
    saved = useRef(new Map<string, number>()),
    saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined),
    lastSave = useRef(0),
    cancelExport = useRef(false),
    input = useRef<HTMLInputElement>(null),
    replaceInput = useRef<HTMLInputElement>(null),
    backupInput = useRef<HTMLInputElement>(null),
    exportDialog = useRef<HTMLDialogElement>(null);
  const page = doc.pages.find((p) => p.id === pageId) ?? doc.pages[0];
  const layer = page.layers.find((l) => l.id === selected);
  const report = useCallback((e: unknown) => {
    setError(e instanceof Error ? e.message : String(e));
  }, []);
  const refresh = useCallback(async () => {
    const library = await legacyStudioAdapter.loadLibrary();
    setProjects(library.projects);
    setAssets(library.assets);
    setTemplates(library.templates);
  }, []);
  useEffect(() => {
    refresh()
      .then(() => {
        setReady(true);
        setStatus("未保存");
      })
      .catch(report);
  }, [refresh, report]);
  const commit = useCallback(
    (d: ProjectDocument) => {
      try {
        documentSchema.parse(d);
        dispatch({ type: "commit", document: d, at: new Date().toISOString() });
        setStatus("未保存");
        setError("");
      } catch (e) {
        report(e);
      }
    },
    [report, dispatch],
  );
  const changePage = useCallback(
    (patch: Partial<Page>) => {
      const d = structuredClone(current.current);
      d.pages = d.pages.map((p) => (p.id === page.id ? { ...p, ...patch } : p));
      commit(d);
    },
    [page.id, commit],
  );
  const patchLayer = useCallback(
    (id: string, patch: Partial<Layer>, allowLocked = false) => {
      const d = structuredClone(current.current),
        p = d.pages.find((p) => p.id === page.id)!;
      p.layers = p.layers.map((l) =>
        l.id === id && (!l.locked || allowLocked)
          ? ({ ...l, ...patch } as Layer)
          : l,
      );
      commit(d);
    },
    [page.id, commit],
  );
  const save = useCallback(
    async (snapshot = current.current) => {
      const frozen = structuredClone(snapshot);
      return queue.current.enqueue(async () => {
        const expected = saved.current.get(frozen.id) ?? null;
        if (expected === frozen.revision) return;
        if (current.current.id === frozen.id) setStatus("保存中…");
        try {
          await legacyStudioAdapter.saveDocument(frozen, expected);
          saved.current.set(frozen.id, frozen.revision);
          lastSave.current = Date.now();
          if (
            current.current.id === frozen.id &&
            current.current.revision === frozen.revision
          )
            setStatus("この端末に保存済み");
          await refresh();
        } catch (e) {
          if (current.current.id === frozen.id)
            setStatus(
              e instanceof ConflictError ? "競合・未保存" : "保存エラー",
            );
          throw e;
        }
      });
    },
    [refresh],
  );
  useEffect(() => {
    if (!ready || (doc.revision === 0 && !saved.current.has(doc.id))) return;
    clearTimeout(saveTimer.current);
    const delay = Math.max(
      0,
      Math.min(750, 5000 - (Date.now() - lastSave.current)),
    );
    saveTimer.current = setTimeout(() => {
      save(doc).catch(report);
    }, delay);
    return () => clearTimeout(saveTimer.current);
  }, [doc, ready, save, report]);
  useEffect(() => {
    const listener = (e: BeforeUnloadEvent) => {
      if (
        current.current.revision !==
        (saved.current.get(current.current.id) ?? 0)
      ) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", listener);
    return () => window.removeEventListener("beforeunload", listener);
  }, []);
  const open = async (
    d: ProjectDocument,
    template?: { id: string; version: number },
  ) => {
    try {
      if (current.current.revision > 0) await save();
      const valid = documentSchema.parse(d);
      if (projects.some((p) => p.id === valid.id))
        saved.current.set(valid.id, valid.revision);
      dispatch({ type: "load", document: valid });
      setPageId(valid.pages[0].id);
      setSelected(undefined);
      setView("studio");
      setEditingTemplate(template);
      setStatus(saved.current.has(valid.id) ? "この端末に保存済み" : "未保存");
      setZoom(1);
      setError("");
    } catch (e) {
      report(e);
    }
  };
  const addLayer = (l: Layer) => {
    if (page.layers.length >= 100)
      return report(new Error("レイヤーは100個までです"));
    l.x = page.width / 2;
    l.y = page.height / 2;
    changePage({ layers: [...page.layers, l] });
    setSelected(l.id);
    setPanel("design");
    setMobilePanel(true);
  };
  const addText = () => addLayer(newText());
  const addShape = (shape: "rect" | "ellipse" | "line" = "rect") =>
    addLayer({
      ...baseLayer("shape"),
      kind: "shape",
      shape,
      fill: "#b6ed79",
      fillAlpha: 1,
      stroke: "#b6ed79",
      strokeWidth: shape === "line" ? 8 : 0,
      radius: shape === "rect" ? 24 : 0,
      width: 400,
      height: shape === "line" ? 16 : 300,
    });
  const addImage = async (file: File, replacing = false) => {
    try {
      const a = await importImage(file);
      if (
        assets.reduce((n, a) => n + a.blob.size + a.original.size, 0) +
          a.blob.size +
          a.original.size >
        200 * 1024 * 1024
      )
        throw new Error("素材合計200MiBを超えています");
      await legacyStudioAdapter.storeAsset(a);
      await refresh();
      if (replacing && layer?.kind === "image") {
        setCrop({ ...layer, assetId: a.id });
        return;
      }
      const l: ImageLayer = {
        ...baseLayer("image"),
        kind: "image",
        assetId: a.id,
        width: Math.min(page.width, 900),
        height: Math.min(page.height, 900),
        crop: defaultCrop(),
        effects: { brightness: 1, contrast: 1, saturation: 1, blur: 0 },
      };
      addLayer(l);
    } catch (e) {
      report(e);
    }
  };
  const deleteLayer = () => {
    if (!layer || layer.locked) return;
    changePage({ layers: page.layers.filter((l) => l.id !== layer.id) });
    setSelected(undefined);
  };
  const duplicateLayer = () => {
    if (!layer) return;
    addLayer({
      ...structuredClone(layer),
      id: uid(),
      name: layer.name + " のコピー",
      locked: false,
    });
  };
  const reorderLayer = (direction: number) => {
    if (!layer || layer.locked) return;
    const list = [...page.layers],
      i = list.findIndex((l) => l.id === layer.id),
      to = i + direction;
    if (to < 0 || to >= list.length || list[to].locked) return;
    [list[i], list[to]] = [list[to], list[i]];
    changePage({ layers: list });
  };
  const addPage = (duplicate = false) => {
    if (doc.pages.length >= 20)
      return report(new Error("ページは20枚までです"));
    const p = duplicate
      ? {
          ...structuredClone(page),
          id: uid(),
          name: page.name + " コピー",
          layers: page.layers.map((l) => ({
            ...structuredClone(l),
            id: uid(),
          })),
        }
      : newPage();
    commit({ ...doc, pages: [...doc.pages, p] });
    setPageId(p.id);
    setSelected(undefined);
  };
  const removePage = () => {
    if (doc.pages.length === 1) return;
    const pages = doc.pages.filter((p) => p.id !== page.id);
    commit({ ...doc, pages });
    setPageId(pages[0].id);
    setSelected(undefined);
  };
  const reorderPage = (direction: number) => {
    const pages = [...doc.pages],
      i = pages.findIndex((p) => p.id === page.id),
      to = i + direction;
    if (to < 0 || to >= pages.length) return;
    [pages[i], pages[to]] = [pages[to], pages[i]];
    commit({ ...doc, pages });
  };
  useEffect(() => {
    const listener = (e: KeyboardEvent) => {
      if (
        e.isComposing ||
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        e.target instanceof HTMLSelectElement ||
        document.querySelector("dialog[open]")
      )
        return;
      if (view !== "studio") return;
      const command = e.metaKey || e.ctrlKey;
      if (command && e.key.toLowerCase() === "s") {
        e.preventDefault();
        save().catch(report);
      }
      if (command && e.key.toLowerCase() === "z") {
        e.preventDefault();
        dispatch({
          type: e.shiftKey ? "redo" : "undo",
          at: new Date().toISOString(),
        });
      }
      if (command && e.key.toLowerCase() === "d") {
        e.preventDefault();
        duplicateLayer();
      }
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        deleteLayer();
      }
      if (e.key === "Escape") {
        setSelected(undefined);
        setMobilePanel(false);
      }
      if (layer && !layer.locked && e.key.startsWith("Arrow")) {
        e.preventDefault();
        const step = e.shiftKey ? 10 : 1;
        patchLayer(layer.id, {
          x:
            layer.x +
            (e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0),
          y:
            layer.y +
            (e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0),
        });
      }
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  });
  const makeBackup = async () => {
    try {
      download(
        await legacyStudioAdapter.backup(structuredClone(doc)),
        `${safeName(doc.name)}.axfluxo.zip`,
      );
    } catch (e) {
      report(e);
    }
  };
  const saveTemplate = async () => {
    try {
      await save();
      const root = editingTemplate?.id ?? uid(),
        version = (editingTemplate?.version ?? 0) + 1;
      const t: LocalTemplate = {
        id: uid(),
        templateId: root,
        name: doc.name,
        description: doc.caption,
        version,
        document: structuredClone(doc),
        createdAt: new Date().toISOString(),
      };
      await saveTemplateVersion({ ...t, templateId: root }, version - 1);
      setEditingTemplate({ id: root, version });
      await refresh();
      setError("テンプレートをこの端末に保存しました（v" + version + "）");
    } catch (e) {
      report(e);
    }
  };
  const createFromTemplate = (t: LocalTemplate, edit = false) => {
    const d = cloneProject(t.document, {
      id: t.templateId ?? t.id,
      version: t.version,
    });
    d.name = t.name + (edit ? " — テンプレート編集" : " の作品");
    void open(
      d,
      edit ? { id: t.templateId ?? t.id, version: t.version } : undefined,
    );
  };
  const latestTemplates = templates.filter(
    (t) =>
      !templates.some(
        (o) =>
          (o.templateId ?? o.id) === (t.templateId ?? t.id) &&
          o.version > t.version,
      ),
  );
  const runExport = async () => {
    if (exportBusy) return;
    setExportBlob(undefined);
    cancelExport.current = false;
    const snapshot = structuredClone(doc);
    const missing = requiredMissing(snapshot);
    if (missing.length)
      return report(
        new Error("必須変数を入力してください: " + missing.join(", ")),
      );
    setExportBusy(true);
    try {
      const pages = exportAll ? snapshot.pages : [structuredClone(page)],
        files: Record<string, Uint8Array> = {};
      let first: Blob | undefined;
      for (let i = 0; i < pages.length; i++) {
        if (cancelExport.current)
          throw new Error("書き出しをキャンセルしました");
        setProgress(`${i + 1} / ${pages.length} ページを描画中`);
        const blob = await exportPage(
          pages[i],
          snapshot,
          format,
          quality,
          jpegColor,
          allowOverflow,
          legacyStudioAdapter.assetResolver,
        );
        if (cancelExport.current)
          throw new Error("書き出しをキャンセルしました");
        first ??= blob;
        files[
          `${String(snapshot.pages.findIndex((p) => p.id === pages[i].id) + 1).padStart(2, "0")}-${safeName(pages[i].name)}.${format === "jpeg" ? "jpg" : "png"}`
        ] = new Uint8Array(await blob.arrayBuffer());
      }
      const blob = pages.length > 1 ? zipImages(files) : first!;
      const name = `${safeName(snapshot.name)}${pages.length > 1 ? ".zip" : format === "jpeg" ? ".jpg" : ".png"}`;
      setExportBlob({
        blob,
        name,
        url: pages.length === 1 ? URL.createObjectURL(blob) : undefined,
      });
      setProgress(
        "書き出しを準備しました。プレビューを確認して保存してください。",
      );
    } catch (e) {
      report(e);
      setProgress("失敗・キャンセル。設定を確認して再試行できます。");
    } finally {
      setExportBusy(false);
    }
  };
  useEffect(
    () => () => {
      if (exportBlob?.url) URL.revokeObjectURL(exportBlob.url);
    },
    [exportBlob],
  );
  useEffect(() => {
    if (exportOpen) {
      const previous = document.activeElement as HTMLElement;
      exportDialog.current?.showModal();
      return () => previous?.focus();
    }
  }, [exportOpen]);
  const chooseView = (v: View) => {
    if (v === "workflow") setWorkflowOpened(true);
    if (view === "studio" && v !== "studio") save().catch(report);
    setView(v);
  };
  const newWork = () => void open(newProject());
  return (
    <div className="app-shell">
      <input
        ref={input}
        type="file"
        hidden
        accept="image/png,image/jpeg,image/webp"
        onChange={(e) => {
          if (e.target.files?.[0]) void addImage(e.target.files[0]);
          e.target.value = "";
        }}
      />
      <input
        ref={replaceInput}
        type="file"
        hidden
        accept="image/png,image/jpeg,image/webp"
        onChange={(e) => {
          if (e.target.files?.[0]) void addImage(e.target.files[0], true);
          e.target.value = "";
        }}
      />
      <input
        ref={backupInput}
        type="file"
        hidden
        accept=".zip"
        onChange={async (e) => {
          try {
            if (e.target.files?.[0])
              await open(await legacyStudioAdapter.restore(e.target.files[0]));
          } catch (err) {
            report(err);
          }
          e.target.value = "";
        }}
      />
      <aside className="global-nav">
        <button
          className="brand"
          onClick={() => chooseView("dashboard")}
          aria-label="AxFluxo ホーム"
        >
          <span className="brand-symbol">
            A<span>↗</span>
          </span>
          <b>
            AxFluxo<span>VISUAL WORKSPACE</span>
          </b>
        </button>
        <div className="workspace-label">WORKSPACE</div>
        <nav>
          {(
            [
              { id: "dashboard", label: "ホーム", Icon: Grid2X2 },
              { id: "studio", label: "スタジオ", Icon: Sparkles },
              { id: "templates", label: "テンプレート", Icon: LayoutTemplate },
              { id: "assets", label: "素材ライブラリ", Icon: FolderOpen },
            ] as const
          ).map(({ id, label, Icon }) => (
            <button
              className={view === id ? "active" : ""}
              key={id}
              onClick={() => chooseView(id)}
            >
              <Icon size={18} />
              <span>{label}</span>
              {id === "studio" && <small>EDITOR</small>}
            </button>
          ))}
          {WORKFLOW_ENABLED && (
            <button
              className={view === "workflow" ? "active" : ""}
              onClick={() => chooseView("workflow")}
            >
              <Shapes size={18} />
              <span>Workflow</span>
            </button>
          )}
        </nav>
        <div className="nav-bottom">
          <div className="local-badge">
            <span className="online-dot" />
            <div>
              あなたの端末が、ワークスペース。
              <small>画像はサーバーへ送信されません</small>
            </div>
          </div>
          <button
            className={view === "settings" ? "active" : ""}
            onClick={() => chooseView("settings")}
          >
            <Settings size={18} />
            <span>設定・保存について</span>
          </button>
          <div className="profile">
            <div>AX</div>
            <span>
              Personal workspace<small>LOCAL EDITION · v0.1</small>
            </span>
          </div>
        </div>
      </aside>
      <main className="main-shell">
        <header className="topbar">
          <div className="breadcrumb">
            <span>ワークスペース</span>
            <span>/</span>
            <b>
              {view === "studio"
                ? "スタジオ"
                : view === "dashboard"
                  ? "ホーム"
                  : view === "templates"
                    ? "テンプレート"
                    : view === "assets"
                      ? "素材ライブラリ"
                      : view === "workflow"
                        ? "Workflow"
                        : "設定"}
            </b>
          </div>
          <div className="top-actions">
            <Account />
            <span className="privacy">
              <span className="online-dot" /> LOCAL FIRST
            </span>
            <button
              className="icon-button"
              aria-label="バックアップ取込"
              onClick={() => backupInput.current?.click()}
            >
              <Upload size={17} />
            </button>
            {view === "studio" ? (
              <button
                className="primary"
                onClick={() => {
                  setExportOpen(true);
                  setProgress("");
                  setExportBlob(undefined);
                }}
              >
                <Download size={16} />
                書き出し
              </button>
            ) : (
              <button className="primary" disabled={!ready} onClick={newWork}>
                <Plus size={16} />
                新しいプロジェクト
              </button>
            )}
          </div>
        </header>
        {error && (
          <div className="notice" role="alert">
            <span>{error}</span>
            {status.includes("競合") && (
              <button
                onClick={() => {
                  const copy = cloneProject(doc);
                  dispatch({ type: "load", document: copy });
                  setStatus("未保存");
                  save(copy).catch(report);
                }}
              >
                コピーとして保存
              </button>
            )}
            <button aria-label="通知を閉じる" onClick={() => setError("")}>
              <X size={16} />
            </button>
          </div>
        )}
        {workflowOpened && (
          <div hidden={view !== "workflow"}>
            <Workflow />
          </div>
        )}
        {view === "dashboard" && (
          <div className="dashboard">
            <div className="page-heading">
              <div>
                <div className="eyebrow">YOUR IDEAS, IN FLOW.</div>
                <h1>次のアイデアを、ここから。</h1>
                <p>
                  画像も、ことばも、レイアウトも。あなたらしい表現を自由に。
                </p>
              </div>
              <span className="date-tag">
                PERSONAL STUDIO <span>↗</span>
              </span>
            </div>
            <section className="hero-card">
              <div className="hero-copy">
                <span className="pill">AxFluxo Studio</span>
                <h2>
                  ひらめきに、
                  <br />
                  もっと自由なかたちを。
                </h2>
                <p>
                  素材を重ね、ことばを添えて。
                  <br />
                  一枚のビジュアルから、次のストーリーへ。
                </p>
                <button onClick={newWork}>
                  制作をはじめる <span>↗</span>
                </button>
              </div>
              <div className="hero-art" aria-hidden="true">
                <div className="art-label">CREATE WITHOUT LIMITS</div>
                <div className="orb orb-one" />
                <div className="orb orb-two" />
                <div className="art-grid" />
                <span className="art-word">
                  MAKE
                  <br />
                  <i>IT YOURS.</i>
                </span>
                <div className="art-caption">
                  <span>01 — EXPLORE YOUR EXPRESSION</span>
                  <span>AX / 2026</span>
                </div>
              </div>
            </section>
            <section className="quick-start">
              <button onClick={newWork}>
                <div className="quick-icon">
                  <Plus size={20} />
                </div>
                <span>
                  白紙からつくる<small>自由なサイズで、自由な発想を。</small>
                </span>
                <span>↗</span>
              </button>
              <button onClick={() => chooseView("templates")}>
                <div className="quick-icon purple">
                  <LayoutTemplate size={20} />
                </div>
                <span>
                  テンプレートを使う
                  <small>保存したレイアウトで、新しい作品を。</small>
                </span>
                <span>↗</span>
              </button>
              <button onClick={() => backupInput.current?.click()}>
                <div className="quick-icon blue">
                  <Upload size={20} />
                </div>
                <span>
                  バックアップを開く
                  <small>画像も編集内容も、まとめて復元。</small>
                </span>
                <span>↗</span>
              </button>
            </section>
            <section>
              <div className="section-heading">
                <h2>
                  最近のプロジェクト <small>{projects.length}</small>
                </h2>
                <button
                  className="sample-button"
                  onClick={async () => {
                    try {
                      const sample = await createSample();
                      await refresh();
                      await open(sample);
                    } catch (e) {
                      report(e);
                    }
                  }}
                >
                  2ページのサンプルを試す ↗
                </button>
              </div>
              {projects.length ? (
                <div className="project-grid">
                  {projects.map((p, index) => (
                    <article className="project-card" key={p.id}>
                      <button
                        className={`project-preview variant-${index % 3}`}
                        onClick={() => void open(p)}
                      >
                        <div className="preview-shapes">
                          <span />
                          <span />
                        </div>
                        <span>{p.name}</span>
                        <small>
                          {p.pages[0].width} × {p.pages[0].height}
                        </small>
                      </button>
                      <div className="project-meta">
                        <button onClick={() => void open(p)}>
                          <b>{p.name}</b>
                          <small>
                            {p.pages.length}ページ ·{" "}
                            {new Date(p.updatedAt).toLocaleDateString("ja-JP")}
                          </small>
                        </button>
                        <button
                          aria-label={`${p.name}を削除`}
                          onClick={() => {
                            if (
                              confirm(
                                "この端末からプロジェクトを削除しますか？バックアップは残りません。",
                              )
                            )
                              remove("projects", p.id)
                                .then(refresh)
                                .catch(report);
                          }}
                        >
                          <Trash2 size={16} />
                        </button>
                      </div>
                    </article>
                  ))}
                  <button className="new-project-card" onClick={newWork}>
                    <Plus size={28} />
                    <span>新しいプロジェクト</span>
                  </button>
                </div>
              ) : (
                <div className="empty-projects">
                  <div>
                    <Layers size={28} />
                    <h3>あなたの作品が、ここに並びます。</h3>
                    <p>最初のプロジェクトをつくってみましょう。</p>
                  </div>
                  <button onClick={newWork}>
                    プロジェクトを作成 <Plus size={16} />
                  </button>
                </div>
              )}
            </section>
            <div className="dashboard-foot">
              <span>
                <span className="online-dot" /> 創作のデータは、この端末の中に。
              </span>
              <button onClick={() => chooseView("settings")}>
                保存とバックアップについて ↗
              </button>
            </div>
          </div>
        )}
        {view === "studio" && (
          <ImageEditor
            assetResolver={legacyStudioAdapter.assetResolver}
            onBack={() => chooseView("dashboard")}
            doc={doc}
            commit={commit}
            status={status}
            history={history}
            dispatch={dispatch}
            save={save}
            report={report}
            makeBackup={makeBackup}
            saveTemplate={saveTemplate}
            editingTemplate={editingTemplate}
            input={input}
            addText={addText}
            addShape={addShape}
            setMobilePanel={setMobilePanel}
            mobilePanel={mobilePanel}
            setPanel={setPanel}
            page={page}
            setPanMode={setPanMode}
            panMode={panMode}
            snap={snap}
            setSnap={setSnap}
            selected={selected}
            setSelected={setSelected}
            patchLayer={patchLayer}
            zoom={zoom}
            setZoom={setZoom}
            fitToken={fitToken}
            setFitToken={setFitToken}
            setPageId={setPageId}
            addPage={addPage}
            reorderPage={reorderPage}
            removePage={removePage}
            panel={panel}
            layer={layer}
            setCrop={setCrop}
            crop={crop}
            replaceInput={replaceInput}
            assets={assets}
            duplicateLayer={duplicateLayer}
            reorderLayer={reorderLayer}
            deleteLayer={deleteLayer}
            changePage={changePage}
          />
        )}
        {view === "templates" && (
          <div className="dashboard">
            <div className="page-heading">
              <div>
                <div className="eyebrow">REUSE YOUR CREATIVE FLOW</div>
                <h1>テンプレート</h1>
                <p>レイアウトを残して、次の作品へ。元の作品は変わりません。</p>
              </div>
            </div>
            {latestTemplates.length ? (
              <div className="project-grid">
                {latestTemplates.map((t) => (
                  <article className="template-card" key={t.id}>
                    <LayoutTemplate size={32} />
                    <h2>{t.name}</h2>
                    <p>{t.description || "ローカルテンプレート"}</p>
                    <small>
                      v{t.version} · {t.document.pages.length}ページ
                    </small>
                    <button
                      className="primary full-button"
                      onClick={() => createFromTemplate(t)}
                    >
                      このレイアウトで作成
                    </button>
                    <div className="button-row">
                      <button onClick={() => createFromTemplate(t, true)}>
                        編集
                      </button>
                      <button
                        onClick={async () => {
                          await put("templates", {
                            ...structuredClone(t),
                            id: uid(),
                            templateId: uid(),
                            version: 1,
                            name: t.name + " コピー",
                          });
                          await refresh();
                        }}
                      >
                        複製
                      </button>
                      <button
                        onClick={async () => {
                          if (
                            !confirm(
                              "テンプレートの全バージョンを削除しますか？",
                            )
                          )
                            return;
                          for (const v of templates.filter(
                            (v) =>
                              (v.templateId ?? v.id) === (t.templateId ?? t.id),
                          ))
                            await remove("templates", v.id);
                          await refresh();
                        }}
                      >
                        削除
                      </button>
                    </div>
                    <details>
                      <summary>バージョン履歴</summary>
                      {templates
                        .filter(
                          (v) =>
                            (v.templateId ?? v.id) === (t.templateId ?? t.id),
                        )
                        .sort((a, b) => b.version - a.version)
                        .map((v) => (
                          <button
                            key={v.id}
                            onClick={() => createFromTemplate(v)}
                          >
                            v{v.version}から作品を作成
                          </button>
                        ))}
                    </details>
                  </article>
                ))}
              </div>
            ) : (
              <div className="empty-projects">
                <div>
                  <LayoutTemplate size={30} />
                  <h3>繰り返し使いたいデザインを、ここに。</h3>
                  <p>
                    スタジオで作品をつくり「テンプレート保存」を選んでください。
                  </p>
                </div>
                <button onClick={newWork}>制作をはじめる ↗</button>
              </div>
            )}
          </div>
        )}
        {view === "assets" && (
          <div className="dashboard">
            <div className="page-heading">
              <div>
                <div className="eyebrow">YOUR CREATIVE MATERIALS</div>
                <h1>素材ライブラリ</h1>
                <p>
                  この端末に取り込んだ原本と、編集用の正立画像を保持します。
                </p>
              </div>
            </div>
            <div className="asset-grid">
              {assets.map((a) => (
                <AssetCard
                  asset={a}
                  key={a.id}
                  onUse={() => {
                    setView("studio");
                    addLayer({
                      ...baseLayer("image"),
                      kind: "image",
                      assetId: a.id,
                      width: Math.min(page.width, 900),
                      height: Math.min(page.height, 900),
                      crop: defaultCrop(),
                      effects: {
                        brightness: 1,
                        contrast: 1,
                        saturation: 1,
                        blur: 0,
                      },
                    });
                  }}
                />
              ))}
              <button
                className="asset-upload"
                onClick={() => {
                  setView("studio");
                  input.current?.click();
                }}
              >
                <ImagePlus size={32} />
                <b>画像を取り込む</b>
                <small>PNG / JPEG / 静止WebP · 20MiBまで</small>
              </button>
            </div>
          </div>
        )}
        {view === "settings" && (
          <div className="dashboard settings-page">
            <div className="eyebrow">LOCAL BY DESIGN</div>
            <h1>あなたのデータは、あなたの端末に。</h1>
            <section className="settings-card">
              <h2>保存とバックアップ</h2>
              <p>
                プロジェクト・画像・テンプレートは、このブラウザのIndexedDBに保存されます。編集確定後に自動保存し、直近5世代を復旧用に保持します。端末やブラウザを変えると自動では引き継がれません。
              </p>
              <p>
                ブラウザデータの削除や容量不足でデータが失われる場合があります。大切な作品はスタジオの「バックアップ」で
                .axfluxo.zip
                として外部に保存してください。文書・画像原本・編集用画像・フォント参照を含みます。
              </p>
              <div className="button-row">
                <button onClick={() => backupInput.current?.click()}>
                  <Upload size={16} />
                  バックアップを取込
                </button>
                <button
                  onClick={async () => {
                    const persisted = await navigator.storage?.persist?.();
                    const estimate = await navigator.storage?.estimate?.();
                    setError(
                      `永続化: ${persisted ? "許可" : "ブラウザ判断・未許可"} / 使用量 約${Math.round((estimate?.usage ?? 0) / 1024 / 1024)}MiB`,
                    );
                  }}
                >
                  保存容量を確認
                </button>
              </div>
            </section>
            <section className="settings-card">
              <h2>以前の保存状態からコピーを復旧</h2>
              <p>元のプロジェクトを上書きせず、別の作品として開きます。</p>
              <button
                onClick={async () => {
                  const revisions = await all<{
                    id: string;
                    projectId: string;
                    document: ProjectDocument;
                  }>("revisions");
                  const candidates = revisions
                    .filter((r) => r.projectId === doc.id)
                    .sort((a, b) => b.document.revision - a.document.revision);
                  if (!candidates.length)
                    return setError("現在の作品の復旧履歴はありません");
                  const revision = prompt(
                    "復旧するrevision: " +
                      candidates.map((r) => r.document.revision).join(", "),
                    String(candidates[0].document.revision),
                  );
                  const found = candidates.find(
                    (r) => String(r.document.revision) === revision,
                  );
                  if (found) await open(cloneProject(found.document));
                }}
              >
                現在の作品の保存履歴を開く
              </button>
            </section>
            <section className="settings-card">
              <h2>対応形式・上限</h2>
              <p>
                PNG / JPEG /
                静止WebP。1枚20MiB、24MP、長辺8192pxまで。キャンバスは64〜4096px・8.5MP、20ページ、各100レイヤーまで。初期版はsRGBを基本とします。HEIC、動画、アニメーション、SVGには対応していません。
              </p>
              <p>
                メール認証はアカウントメニューから利用できます。制作データは端末内に保存され、クラウド同期・SNS自動投稿・動画編集は将来フェーズです。
              </p>
            </section>
            <section className="settings-card">
              <h2>フォント・ライセンス</h2>
              <p>
                Noto Sans JP / Inter / Loraを同梱しています。フォントはSIL Open
                Font Licenseに従います。各ライセンスは
                <a
                  href={`${process.env.NEXT_PUBLIC_BASE_PATH || ""}/fonts/noto-sans-jp-LICENSE.txt`}
                >
                  Noto Sans JP
                </a>
                ・
                <a
                  href={`${process.env.NEXT_PUBLIC_BASE_PATH || ""}/fonts/inter-LICENSE.txt`}
                >
                  Inter
                </a>
                ・
                <a
                  href={`${process.env.NEXT_PUBLIC_BASE_PATH || ""}/fonts/lora-LICENSE.txt`}
                >
                  Lora
                </a>
                をご覧ください。日本語以外の未収録文字やカラー絵文字の完全一致は保証していません。
              </p>
            </section>
          </div>
        )}
      </main>
      {exportOpen && (
        <dialog
          className="modal export-dialog"
          ref={exportDialog}
          onCancel={() => {
            cancelExport.current = true;
            setExportOpen(false);
          }}
        >
          <header>
            <div>
              <small>EXPORT YOUR CREATION</small>
              <h2>作品を書き出す</h2>
            </div>
            <button
              aria-label="書き出しを閉じる"
              onClick={() => {
                cancelExport.current = true;
                setExportOpen(false);
              }}
            >
              <X size={20} />
            </button>
          </header>
          <p>出力開始時の作品を固定し、ページ順に描画します。</p>
          <div className="fields">
            <label>
              形式
              <select
                aria-label="形式"
                value={format}
                onChange={(e) => {
                  setFormat(e.target.value as "png" | "jpeg");
                  setExportBlob(undefined);
                }}
              >
                <option value="png">PNG（透明を保持）</option>
                <option value="jpeg">JPEG（背景色と合成）</option>
              </select>
            </label>
            <label>
              範囲
              <select
                aria-label="範囲"
                value={exportAll ? "all" : "current"}
                onChange={(e) => setExportAll(e.target.value === "all")}
              >
                <option value="current">現在のページ</option>
                <option value="all">全ページ（複数はZIP）</option>
              </select>
            </label>
          </div>
          {format === "jpeg" && (
            <>
              <NumberField
                label="JPEG品質"
                value={quality}
                min={0.5}
                max={1}
                step={0.01}
                onChange={setQuality}
              />
              {colorField("JPEG合成背景", jpegColor, setJpegColor)}
            </>
          )}
          <label className="checkbox">
            <input
              type="checkbox"
              checked={allowOverflow}
              onChange={(e) => setAllowOverflow(e.target.checked)}
            />
            通常文字のはみ出しを確認し、許可する
          </label>
          <small>
            画像を原寸以上に拡大した場合は画質が低下することがあります。
          </small>
          {exportBlob?.url && (
            <div className="export-preview">
              <img src={exportBlob.url} alt="書き出しプレビュー" />
            </div>
          )}
          <p role="status">{progress}</p>
          <footer>
            <button
              onClick={() => {
                cancelExport.current = true;
              }}
            >
              処理をキャンセル
            </button>
            <button
              className="primary"
              disabled={exportBusy}
              onClick={runExport}
            >
              {progress.includes("描画中") ? "再試行" : "プレビューを生成"}
            </button>
          </footer>
          {exportBlob && (
            <div className="button-row">
              <button
                className="primary"
                onClick={() => download(exportBlob.blob, exportBlob.name)}
              >
                <Download size={16} />
                ファイルを保存
              </button>
              {typeof navigator.canShare === "function" &&
                navigator.canShare({
                  files: [
                    new File([exportBlob.blob], exportBlob.name, {
                      type: exportBlob.blob.type,
                    }),
                  ],
                }) && (
                  <button
                    onClick={() =>
                      navigator
                        .share({
                          files: [
                            new File([exportBlob.blob], exportBlob.name, {
                              type: exportBlob.blob.type,
                            }),
                          ],
                        })
                        .catch(report)
                    }
                  >
                    共有シートへ
                  </button>
                )}
            </div>
          )}
        </dialog>
      )}
    </div>
  );
}
function safeName(name: string) {
  return name.replace(/[^\p{L}\p{N}_-]/gu, "_").slice(0, 80) || "axfluxo";
}
function AssetCard({ asset, onUse }: { asset: Asset; onUse: () => void }) {
  const [url, setUrl] = useState("");
  useEffect(() => {
    const url = URL.createObjectURL(asset.blob);
    setUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [asset]);
  return (
    <article className="asset-card">
      <img src={url || undefined} alt={asset.name} />
      <b>{asset.name}</b>
      <small>
        {asset.width} × {asset.height} ·{" "}
        {(asset.original.size / 1024 / 1024).toFixed(1)}MiB
      </small>
      <button onClick={onUse}>
        作品に追加 <Plus size={15} />
      </button>
    </article>
  );
}

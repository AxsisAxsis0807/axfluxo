"use client";
import Account from "../auth/Account";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
/* eslint-disable @next/next/no-img-element -- Blob URLs are local decoded user assets. */
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Check,
  ChevronDown,
  Copy,
  Crop,
  Download,
  Eye,
  EyeOff,
  FolderOpen,
  Grid2X2,
  ImagePlus,
  Layers,
  LayoutTemplate,
  Lock,
  Maximize2,
  Plus,
  Redo2,
  Save,
  Settings,
  Shapes,
  Sparkles,
  Trash2,
  Type,
  Undo2,
  Unlock,
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
  reducer,
  requiredMissing,
  resolveAsset,
  resolveText,
  uid,
  type ImageLayer,
  type Layer,
  type Page,
  type ProjectDocument,
  type TextLayer,
  variableSchema,
} from "../../domain/document";
import {
  all,
  ConflictError,
  put,
  remove,
  SaveQueue,
  saveProject,
  saveTemplateVersion,
  type Asset,
  type Template,
} from "../../services/storage";
import { importImage } from "../../services/assets";
import { backup, download, restore, zipImages } from "../../services/backup";
import { exportPage } from "../../renderers/scene";
import { createSample } from "../../services/sample";
import Canvas from "./Canvas";
import CropDialog from "./CropDialog";
type View = "dashboard" | "studio" | "templates" | "assets" | "settings";
type LocalTemplate = Template & { templateId?: string };
const start = newProject();
function NumberField({
  label,
  value,
  onChange,
  min = -16384,
  max = 16384,
  step = 1,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
}) {
  return (
    <label>
      {label}
      <input
        key={value}
        aria-label={label}
        type="number"
        min={min}
        max={max}
        step={step}
        defaultValue={Number(value.toFixed(3))}
        onBlur={(e) => {
          const value = Number(e.target.value);
          if (Number.isFinite(value) && value >= min && value <= max)
            onChange(value);
          else e.target.value = String(value);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.nativeEvent.isComposing)
            e.currentTarget.blur();
        }}
      />
    </label>
  );
}
function TextField({
  label,
  value,
  onChange,
  multiline = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  multiline?: boolean;
}) {
  const props = {
    "aria-label": label,
    key: value,
    defaultValue: value,
    onBlur: (e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      if (e.target.value !== value) onChange(e.target.value);
    },
  };
  return (
    <label>
      {label}
      {multiline ? <textarea {...props} rows={4} /> : <input {...props} />}
    </label>
  );
}
export default function Editor() {
  const [history, dispatch] = useReducer(reducer, {
    past: [],
    present: start,
    future: [],
  });
  const doc = history.present;
  const current = useRef(doc);
  current.current = doc;
  const [view, setView] = useState<View>("dashboard"),
    [pageId, setPageId] = useState(doc.pages[0].id),
    [selected, setSelected] = useState<string>(),
    [panel, setPanel] = useState<"design" | "layers" | "variables">("design"),
    [mobilePanel, setMobilePanel] = useState(false),
    [zoom, setZoom] = useState(1),
    [snap, setSnap] = useState(true),
    [panMode, setPanMode] = useState(false),
    [fitToken, setFitToken] = useState(0);
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
    const [p, a, t] = await Promise.all([
      all<ProjectDocument>("projects"),
      all<Asset>("assets"),
      all<LocalTemplate>("templates"),
    ]);
    setProjects(p.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
    setAssets(a);
    setTemplates(t);
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
    [report],
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
          await saveProject(frozen, expected);
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
      await put("assets", a);
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
      const command = e.metaKey || e.ctrlKey;
      if (command && e.key.toLowerCase() === "s") {
        e.preventDefault();
        save().catch(report);
      }
      if (view !== "studio") return;
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
        await backup(structuredClone(doc)),
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
    if (view === "studio" && v !== "studio") save().catch(report);
    setView(v);
  };
  const newWork = () => void open(newProject());
  const colorField = (
    label: string,
    value: string,
    onChange: (v: string) => void,
  ) => (
    <label className="color-field">
      {label}
      <span>
        <input
          aria-label={label}
          type="color"
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
        <code>{value.toUpperCase()}</code>
      </span>
    </label>
  );
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
              await open(await restore(e.target.files[0]));
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
          <div className="studio">
            <div className="editor-header">
              <div className="editor-title">
                <button
                  aria-label="ホームへ戻る"
                  onClick={() => chooseView("dashboard")}
                >
                  <ArrowLeft size={18} />
                </button>
                <input
                  aria-label="プロジェクト名"
                  key={doc.id + doc.name}
                  defaultValue={doc.name}
                  maxLength={200}
                  onBlur={(e) => {
                    if (e.target.value && e.target.value !== doc.name)
                      commit({ ...doc, name: e.target.value });
                  }}
                />
                <span className="save-state" role="status">
                  {status === "この端末に保存済み" && <Check size={12} />}{" "}
                  {status}
                </span>
              </div>
              <div className="editor-actions">
                <button
                  aria-label="元に戻す"
                  disabled={!history.past.length}
                  onClick={() =>
                    dispatch({ type: "undo", at: new Date().toISOString() })
                  }
                >
                  <Undo2 size={17} />
                </button>
                <button
                  aria-label="やり直す"
                  disabled={!history.future.length}
                  onClick={() =>
                    dispatch({ type: "redo", at: new Date().toISOString() })
                  }
                >
                  <Redo2 size={17} />
                </button>
                <span className="divider" />
                <button
                  aria-label="端末に保存"
                  onClick={() => save().catch(report)}
                >
                  <Save size={17} />
                </button>
                <button className="text-action" onClick={makeBackup}>
                  <Download size={16} />
                  <span>バックアップ</span>
                </button>
                <button className="text-action" onClick={saveTemplate}>
                  <LayoutTemplate size={16} />
                  <span>
                    {editingTemplate ? "テンプレート更新" : "テンプレート保存"}
                  </span>
                </button>
              </div>
            </div>
            <div className="editor-body">
              <aside className="tool-rail">
                <div>
                  <button
                    title="画像を追加"
                    aria-label="画像を追加"
                    onClick={() => input.current?.click()}
                  >
                    <ImagePlus size={22} />
                    <span>画像</span>
                  </button>
                  <button aria-label="テキストを追加" onClick={addText}>
                    <Type size={23} />
                    <span>テキスト</span>
                  </button>
                  <button aria-label="図形を追加" onClick={() => addShape()}>
                    <Shapes size={22} />
                    <span>図形</span>
                  </button>
                </div>
                <button
                  aria-label="プロパティを表示"
                  className="mobile-inspector"
                  onClick={() => setMobilePanel(!mobilePanel)}
                >
                  <Settings size={20} />
                  <span>設定</span>
                </button>
                <button
                  aria-label="レイヤーを表示"
                  onClick={() => {
                    setPanel("layers");
                    setMobilePanel(true);
                  }}
                >
                  <Layers size={22} />
                  <span>レイヤー</span>
                </button>
              </aside>
              <div className="canvas-column">
                <div className="canvas-toolbar">
                  <span>
                    {page.name} <ChevronDown size={12} />
                  </span>
                  <div>
                    <button onClick={() => setPanMode(!panMode)}>
                      {panMode ? "パン中" : "選択"}
                    </button>
                    <button
                      className={snap ? "toggle-on" : ""}
                      onClick={() => setSnap(!snap)}
                    >
                      スナップ {snap ? "ON" : "OFF"}
                    </button>
                    <span className="canvas-size">
                      {page.width} × {page.height}
                    </span>
                  </div>
                </div>
                <Canvas
                  page={page}
                  document={doc}
                  selected={selected}
                  onSelect={(id) => {
                    setSelected(id);
                    setPanel("design");
                  }}
                  onPatch={patchLayer}
                  zoom={zoom}
                  onZoom={setZoom}
                  snap={snap}
                  panMode={panMode}
                  fitToken={fitToken}
                />
                <div className="canvas-bottom">
                  <span>PNG / JPEG · sRGB</span>
                  <div>
                    <button
                      aria-label="縮小"
                      onClick={() => setZoom(Math.max(0.25, zoom - 0.25))}
                    >
                      −
                    </button>
                    <span>{Math.round(zoom * 100)}%</span>
                    <button
                      aria-label="拡大"
                      onClick={() => setZoom(Math.min(4, zoom + 0.25))}
                    >
                      ＋
                    </button>
                    <button
                      aria-label="中央へフィット"
                      onClick={() => {
                        setZoom(1);
                        setPanMode(false);
                        setFitToken((t) => t + 1);
                      }}
                    >
                      <Maximize2 size={15} />
                    </button>
                  </div>
                </div>
                <div className="pages-strip">
                  {doc.pages.map((p, i) => (
                    <button
                      className={p.id === page.id ? "selected" : ""}
                      key={p.id}
                      onClick={() => {
                        setPageId(p.id);
                        setSelected(undefined);
                      }}
                    >
                      <span
                        className="page-tile"
                        style={{ background: p.background }}
                      >
                        {String(i + 1).padStart(2, "0")}
                      </span>
                      <small>{p.name}</small>
                    </button>
                  ))}
                  <button
                    className="add-page"
                    aria-label="ページ追加"
                    onClick={() => addPage()}
                  >
                    <Plus size={20} />
                    <small>追加</small>
                  </button>
                  <div className="page-actions">
                    <button
                      aria-label="ページ複製"
                      onClick={() => addPage(true)}
                    >
                      <Copy size={16} />
                    </button>
                    <button
                      aria-label="ページを前へ"
                      onClick={() => reorderPage(-1)}
                    >
                      <ArrowLeft size={16} />
                    </button>
                    <button
                      aria-label="ページを後へ"
                      onClick={() => reorderPage(1)}
                    >
                      <ArrowLeft
                        size={16}
                        style={{ transform: "rotate(180deg)" }}
                      />
                    </button>
                    <button
                      aria-label="ページ削除"
                      disabled={doc.pages.length === 1}
                      onClick={removePage}
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                </div>
              </div>
              <aside
                className={`inspector ${mobilePanel ? "mobile-open" : ""}`}
              >
                <div className="inspector-tabs">
                  <button
                    className={panel === "design" ? "selected" : ""}
                    onClick={() => setPanel("design")}
                  >
                    デザイン
                  </button>
                  <button
                    className={panel === "layers" ? "selected" : ""}
                    onClick={() => setPanel("layers")}
                  >
                    レイヤー
                  </button>
                  <button
                    className={panel === "variables" ? "selected" : ""}
                    onClick={() => setPanel("variables")}
                  >
                    変数
                  </button>
                  <button
                    className="close-inspector"
                    aria-label="設定を閉じる"
                    onClick={() => setMobilePanel(false)}
                  >
                    <X size={16} />
                  </button>
                </div>
                <div className="inspector-content">
                  {panel === "design" && (
                    <>
                      {layer ? (
                        <>
                          <div className="property-heading">
                            <span>
                              {layer.kind === "image"
                                ? "IMAGE"
                                : layer.kind === "text"
                                  ? "TEXT"
                                  : "SHAPE"}
                            </span>
                            <button
                              aria-label="選択を解除"
                              onClick={() => setSelected(undefined)}
                            >
                              <X size={14} />
                            </button>
                          </div>
                          <TextField
                            label="レイヤー名"
                            value={layer.name}
                            onChange={(name) => patchLayer(layer.id, { name })}
                          />
                          <fieldset disabled={layer.locked}>
                            <div className="fields">
                              <NumberField
                                label="X"
                                value={layer.x}
                                onChange={(x) => patchLayer(layer.id, { x })}
                              />
                              <NumberField
                                label="Y"
                                value={layer.y}
                                onChange={(y) => patchLayer(layer.id, { y })}
                              />
                              <NumberField
                                label="幅"
                                value={layer.width}
                                min={1}
                                max={16384}
                                onChange={(width) =>
                                  patchLayer(layer.id, { width })
                                }
                              />
                              <NumberField
                                label="高さ"
                                value={layer.height}
                                min={1}
                                max={16384}
                                onChange={(height) =>
                                  patchLayer(layer.id, { height })
                                }
                              />
                              <NumberField
                                label="回転°"
                                value={layer.rotation}
                                min={-360}
                                max={360}
                                onChange={(rotation) =>
                                  patchLayer(layer.id, { rotation })
                                }
                              />
                              <NumberField
                                label="透明度"
                                value={layer.opacity}
                                min={0}
                                max={1}
                                step={0.05}
                                onChange={(opacity) =>
                                  patchLayer(layer.id, { opacity })
                                }
                              />
                            </div>
                            <button
                              className="full-button"
                              onClick={() =>
                                patchLayer(layer.id, {
                                  x: page.width / 2,
                                  y: page.height / 2,
                                })
                              }
                            >
                              ページ中央へ揃える
                            </button>
                            {layer.kind === "image" && (
                              <>
                                <div className="property-section">
                                  <h3>画像とクロップ</h3>
                                  <button
                                    className="primary full-button"
                                    onClick={() =>
                                      setCrop(structuredClone(layer))
                                    }
                                  >
                                    <Crop size={16} />
                                    中央固定クロップ
                                  </button>
                                  <button
                                    className="full-button"
                                    onClick={() =>
                                      replaceInput.current?.click()
                                    }
                                  >
                                    <ImagePlus size={16} />
                                    画像を差し替え
                                  </button>
                                  <label>
                                    画像変数
                                    <select
                                      aria-label="画像変数"
                                      value={layer.imageBinding ?? ""}
                                      onChange={(e) =>
                                        patchLayer(layer.id, {
                                          imageBinding:
                                            e.target.value || undefined,
                                        })
                                      }
                                    >
                                      <option value="">連動なし</option>
                                      {doc.variables
                                        .filter((v) => v.type === "image")
                                        .map((v) => (
                                          <option key={v.key} value={v.key}>
                                            {v.label}
                                          </option>
                                        ))}
                                    </select>
                                  </label>
                                  <label>
                                    素材
                                    <select
                                      aria-label="素材"
                                      value={resolveAsset(layer, doc)}
                                      onChange={(e) =>
                                        setCrop({
                                          ...layer,
                                          assetId: e.target.value,
                                        })
                                      }
                                    >
                                      {assets.map((a) => (
                                        <option value={a.id} key={a.id}>
                                          {a.name}
                                        </option>
                                      ))}
                                    </select>
                                  </label>
                                </div>
                                <div className="property-section">
                                  <h3>
                                    <Sparkles size={14} />
                                    エフェクト
                                  </h3>
                                  {(
                                    [
                                      "brightness",
                                      "contrast",
                                      "saturation",
                                      "blur",
                                    ] as const
                                  ).map((key, index) => (
                                    <NumberField
                                      key={key}
                                      label={
                                        [
                                          "明るさ",
                                          "コントラスト",
                                          "彩度",
                                          "ぼかし",
                                        ][index]
                                      }
                                      value={layer.effects[key]}
                                      min={0}
                                      max={key === "blur" ? 40 : 2}
                                      step={key === "blur" ? 1 : 0.05}
                                      onChange={(value) =>
                                        patchLayer(layer.id, {
                                          effects: {
                                            ...layer.effects,
                                            [key]: value,
                                          },
                                        })
                                      }
                                    />
                                  ))}
                                </div>
                              </>
                            )}
                            {layer.kind === "text" && (
                              <>
                                <div className="property-section">
                                  <h3>テキスト</h3>
                                  {layer.textBinding ? (
                                    <>
                                      <p className="help">
                                        変数「{layer.textBinding.key}
                                        」に連動しています。
                                      </p>
                                      <button
                                        className="full-button"
                                        onClick={() =>
                                          patchLayer(layer.id, {
                                            textBinding: undefined,
                                            text: resolveText(layer, doc),
                                          })
                                        }
                                      >
                                        このレイヤーの連動を解除
                                      </button>
                                    </>
                                  ) : (
                                    <TextField
                                      label="文字入力"
                                      value={layer.text}
                                      multiline
                                      onChange={(text) =>
                                        patchLayer(layer.id, { text })
                                      }
                                    />
                                  )}
                                  <label>
                                    フォント
                                    <select
                                      aria-label="フォント"
                                      value={layer.fontId}
                                      onChange={(e) =>
                                        patchLayer(layer.id, {
                                          fontId: e.target
                                            .value as TextLayer["fontId"],
                                        })
                                      }
                                    >
                                      <option value="noto">
                                        Noto Sans JP — 日本語
                                      </option>
                                      <option value="inter">
                                        Inter — Sans
                                      </option>
                                      <option value="lora">Lora — Serif</option>
                                    </select>
                                  </label>
                                  <div className="fields">
                                    <NumberField
                                      label="文字サイズ"
                                      value={layer.fontSize}
                                      min={8}
                                      max={512}
                                      onChange={(fontSize) =>
                                        patchLayer(layer.id, { fontSize })
                                      }
                                    />
                                    <label>
                                      太さ
                                      <select
                                        aria-label="太さ"
                                        value={layer.fontWeight}
                                        onChange={(e) =>
                                          patchLayer(layer.id, {
                                            fontWeight: e.target.value as
                                              "400" | "700",
                                          })
                                        }
                                      >
                                        <option value="400">Regular</option>
                                        <option value="700">Bold</option>
                                      </select>
                                    </label>
                                    <NumberField
                                      label="行間"
                                      value={layer.lineHeight}
                                      min={0.5}
                                      max={4}
                                      step={0.1}
                                      onChange={(lineHeight) =>
                                        patchLayer(layer.id, { lineHeight })
                                      }
                                    />
                                    <NumberField
                                      label="字間"
                                      value={layer.letterSpacing}
                                      min={-10}
                                      max={100}
                                      onChange={(letterSpacing) =>
                                        patchLayer(layer.id, { letterSpacing })
                                      }
                                    />
                                  </div>
                                  {colorField("文字色", layer.color, (color) =>
                                    patchLayer(layer.id, { color }),
                                  )}
                                  <label>
                                    揃え
                                    <select
                                      aria-label="揃え"
                                      value={layer.align}
                                      onChange={(e) =>
                                        patchLayer(layer.id, {
                                          align: e.target
                                            .value as TextLayer["align"],
                                        })
                                      }
                                    >
                                      <option value="left">左揃え</option>
                                      <option value="center">中央揃え</option>
                                      <option value="right">右揃え</option>
                                    </select>
                                  </label>
                                  <label>
                                    長文の処理
                                    <select
                                      aria-label="長文の処理"
                                      value={layer.overflow}
                                      onChange={(e) =>
                                        patchLayer(layer.id, {
                                          overflow: e.target.value as
                                            "warn" | "shrink",
                                        })
                                      }
                                    >
                                      <option value="warn">
                                        はみ出しを警告
                                      </option>
                                      <option value="shrink">
                                        最小サイズまで縮小
                                      </option>
                                    </select>
                                  </label>
                                  <NumberField
                                    label="最小文字サイズ"
                                    value={layer.minFontSize}
                                    min={8}
                                    max={layer.fontSize}
                                    onChange={(minFontSize) =>
                                      patchLayer(layer.id, { minFontSize })
                                    }
                                  />
                                  <label>
                                    テキスト変数
                                    <select
                                      aria-label="テキスト変数"
                                      value={layer.textBinding?.key ?? ""}
                                      onChange={(e) =>
                                        patchLayer(layer.id, {
                                          textBinding: e.target.value
                                            ? {
                                                key: e.target.value,
                                                prefix: "",
                                                suffix: "",
                                              }
                                            : undefined,
                                        })
                                      }
                                    >
                                      <option value="">連動なし</option>
                                      {doc.variables
                                        .filter((v) => v.type !== "image")
                                        .map((v) => (
                                          <option key={v.key} value={v.key}>
                                            {v.label}
                                          </option>
                                        ))}
                                    </select>
                                  </label>
                                  {layer.textBinding && (
                                    <>
                                      <TextField
                                        label="接頭辞"
                                        value={layer.textBinding.prefix}
                                        onChange={(prefix) =>
                                          patchLayer(layer.id, {
                                            textBinding: {
                                              ...layer.textBinding!,
                                              prefix,
                                            },
                                          })
                                        }
                                      />
                                      <TextField
                                        label="接尾辞"
                                        value={layer.textBinding.suffix}
                                        onChange={(suffix) =>
                                          patchLayer(layer.id, {
                                            textBinding: {
                                              ...layer.textBinding!,
                                              suffix,
                                            },
                                          })
                                        }
                                      />
                                    </>
                                  )}
                                </div>
                                <div className="property-section">
                                  <h3>背景帯</h3>
                                  <label>
                                    表示
                                    <select
                                      aria-label="表示"
                                      value={layer.background.mode}
                                      onChange={(e) =>
                                        patchLayer(layer.id, {
                                          background: {
                                            ...layer.background,
                                            mode: e.target.value as
                                              "none" | "line" | "box",
                                          },
                                        })
                                      }
                                    >
                                      <option value="none">なし</option>
                                      <option value="line">
                                        行ごとの文字幅
                                      </option>
                                      <option value="box">ボックス全体</option>
                                    </select>
                                  </label>
                                  {colorField(
                                    "帯の色",
                                    layer.background.color,
                                    (color) =>
                                      patchLayer(layer.id, {
                                        background: {
                                          ...layer.background,
                                          color,
                                        },
                                      }),
                                  )}
                                  {(
                                    ["alpha", "padding", "radius"] as const
                                  ).map((key, i) => (
                                    <NumberField
                                      key={key}
                                      label={
                                        [
                                          "帯の不透明度",
                                          "帯の余白",
                                          "帯の角丸",
                                        ][i]
                                      }
                                      value={layer.background[key]}
                                      min={0}
                                      max={key === "alpha" ? 1 : 100}
                                      step={key === "alpha" ? 0.05 : 1}
                                      onChange={(value) =>
                                        patchLayer(layer.id, {
                                          background: {
                                            ...layer.background,
                                            [key]: value,
                                          },
                                        })
                                      }
                                    />
                                  ))}
                                </div>
                                <div className="property-section">
                                  <h3>縁取り・影</h3>
                                  {colorField(
                                    "縁の色",
                                    layer.stroke.color,
                                    (color) =>
                                      patchLayer(layer.id, {
                                        stroke: { ...layer.stroke, color },
                                      }),
                                  )}
                                  <NumberField
                                    label="縁の幅"
                                    value={layer.stroke.width}
                                    min={0}
                                    max={20}
                                    onChange={(width) =>
                                      patchLayer(layer.id, {
                                        stroke: { ...layer.stroke, width },
                                      })
                                    }
                                  />
                                  {colorField(
                                    "影の色",
                                    layer.shadow.color,
                                    (color) =>
                                      patchLayer(layer.id, {
                                        shadow: { ...layer.shadow, color },
                                      }),
                                  )}
                                  <NumberField
                                    label="影のぼかし"
                                    value={layer.shadow.blur}
                                    min={0}
                                    max={40}
                                    onChange={(blur) =>
                                      patchLayer(layer.id, {
                                        shadow: { ...layer.shadow, blur },
                                      })
                                    }
                                  />
                                  <NumberField
                                    label="影の距離"
                                    value={layer.shadow.offset}
                                    min={0}
                                    max={40}
                                    onChange={(offset) =>
                                      patchLayer(layer.id, {
                                        shadow: { ...layer.shadow, offset },
                                      })
                                    }
                                  />
                                </div>
                              </>
                            )}
                            {layer.kind === "shape" && (
                              <div className="property-section">
                                <h3>図形</h3>
                                <label>
                                  形状
                                  <select
                                    aria-label="形状"
                                    value={layer.shape}
                                    onChange={(e) =>
                                      patchLayer(layer.id, {
                                        shape: e.target.value as
                                          "rect" | "ellipse" | "line",
                                      })
                                    }
                                  >
                                    <option value="rect">
                                      四角形 / 角丸四角形
                                    </option>
                                    <option value="ellipse">円 / 楕円</option>
                                    <option value="line">線</option>
                                  </select>
                                </label>
                                {colorField("塗りの色", layer.fill, (fill) =>
                                  patchLayer(layer.id, { fill }),
                                )}
                                {colorField(
                                  "枠線の色",
                                  layer.stroke,
                                  (stroke) => patchLayer(layer.id, { stroke }),
                                )}
                                <NumberField
                                  label="塗りの不透明度"
                                  value={layer.fillAlpha}
                                  min={0}
                                  max={1}
                                  step={0.05}
                                  onChange={(fillAlpha) =>
                                    patchLayer(layer.id, { fillAlpha })
                                  }
                                />
                                <NumberField
                                  label="枠線幅"
                                  value={layer.strokeWidth}
                                  min={0}
                                  max={100}
                                  onChange={(strokeWidth) =>
                                    patchLayer(layer.id, { strokeWidth })
                                  }
                                />
                                <NumberField
                                  label="角丸"
                                  value={layer.radius}
                                  min={0}
                                  max={2048}
                                  onChange={(radius) =>
                                    patchLayer(layer.id, { radius })
                                  }
                                />
                              </div>
                            )}
                          </fieldset>
                          <div className="button-row">
                            <button
                              aria-label="レイヤー複製"
                              onClick={duplicateLayer}
                            >
                              <Copy size={16} />
                            </button>
                            <button
                              aria-label="前面へ"
                              disabled={layer.locked}
                              onClick={() => reorderLayer(1)}
                            >
                              <ArrowUp size={16} />
                            </button>
                            <button
                              aria-label="背面へ"
                              disabled={layer.locked}
                              onClick={() => reorderLayer(-1)}
                            >
                              <ArrowDown size={16} />
                            </button>
                            <button
                              aria-label="レイヤー削除"
                              disabled={layer.locked}
                              onClick={deleteLayer}
                            >
                              <Trash2 size={16} />
                            </button>
                          </div>
                        </>
                      ) : (
                        <>
                          <div className="property-heading">
                            <span>CANVAS</span>
                            <Grid2X2 size={14} />
                          </div>
                          <div className="mobile-project-actions">
                            <button
                              className="full-button"
                              onClick={makeBackup}
                            >
                              <Download size={15} />
                              完全バックアップを保存
                            </button>
                            <button
                              className="full-button"
                              onClick={saveTemplate}
                            >
                              <LayoutTemplate size={15} />
                              テンプレート保存
                            </button>
                            <div className="button-row">
                              <button onClick={() => addPage(true)}>
                                ページ複製
                              </button>
                              <button
                                disabled={doc.pages.length === 1}
                                onClick={removePage}
                              >
                                ページ削除
                              </button>
                            </div>
                            <div className="button-row">
                              <button onClick={() => reorderPage(-1)}>
                                ページを前へ
                              </button>
                              <button onClick={() => reorderPage(1)}>
                                ページを後へ
                              </button>
                            </div>
                          </div>
                          <TextField
                            label="ページ名"
                            value={page.name}
                            onChange={(name) => changePage({ name })}
                          />
                          <label>
                            サイズプリセット
                            <select
                              aria-label="サイズプリセット"
                              value={`${page.width}x${page.height}`}
                              onChange={(e) => {
                                const [width, height] = e.target.value
                                  .split("x")
                                  .map(Number);
                                if (width) changePage({ width, height });
                              }}
                            >
                              <option value="custom">カスタムサイズ</option>
                              {[
                                [1080, 1080],
                                [1080, 1920],
                                [1920, 1080],
                                [1080, 1350],
                              ].map(([w, h]) => (
                                <option key={w + "x" + h} value={w + "x" + h}>
                                  {w} × {h}
                                </option>
                              ))}
                            </select>
                          </label>
                          <div className="fields">
                            <NumberField
                              label="キャンバス幅"
                              value={page.width}
                              min={64}
                              max={4096}
                              onChange={(width) => changePage({ width })}
                            />
                            <NumberField
                              label="キャンバス高さ"
                              value={page.height}
                              min={64}
                              max={4096}
                              onChange={(height) => changePage({ height })}
                            />
                          </div>
                          <p className="help">
                            サイズ変更では、レイヤーの座標を維持します。
                          </p>
                          <button
                            className="full-button"
                            onClick={() => {
                              const width = Number(
                                  prompt("拡縮後の幅", String(page.width)),
                                ),
                                height = Number(
                                  prompt("拡縮後の高さ", String(page.height)),
                                );
                              if (
                                width < 64 ||
                                height < 64 ||
                                width > 4096 ||
                                height > 4096
                              )
                                return;
                              const sx = width / page.width,
                                sy = height / page.height;
                              if (Math.abs(sx - sy) > 0.01) {
                                report(
                                  new Error(
                                    "内容の比例拡縮は元の縦横比を保持してください",
                                  ),
                                );
                                return;
                              }
                              changePage({
                                width,
                                height,
                                layers: page.layers.map((l) => ({
                                  ...l,
                                  x: l.x * sx,
                                  y: l.y * sy,
                                  width: l.width * sx,
                                  height: l.height * sy,
                                  ...(l.kind === "text"
                                    ? {
                                        fontSize: l.fontSize * sx,
                                        minFontSize: l.minFontSize * sx,
                                      }
                                    : {}),
                                })),
                              });
                            }}
                          >
                            内容も比例拡縮…
                          </button>
                          <div className="property-section">
                            <h3>背景</h3>
                            {colorField(
                              "背景色",
                              page.background,
                              (background) => changePage({ background }),
                            )}
                            <NumberField
                              label="背景の不透明度"
                              value={page.alpha}
                              min={0}
                              max={1}
                              step={0.05}
                              onChange={(alpha) => changePage({ alpha })}
                            />
                            <button
                              className="full-button"
                              onClick={() =>
                                changePage({ alpha: page.alpha ? 0 : 1 })
                              }
                            >
                              {page.alpha
                                ? "透明背景にする"
                                : "不透明背景にする"}
                            </button>
                            <button
                              className="full-button"
                              onClick={() => input.current?.click()}
                            >
                              <ImagePlus size={15} />
                              背景用の画像を追加
                            </button>
                            <p className="help">
                              背景画像は画像レイヤーとして追加し、背面へ移動できます。
                            </p>
                          </div>
                          <div className="property-section">
                            <h3>作品のメモ</h3>
                            <TextField
                              label="説明・投稿本文（保存のみ）"
                              value={doc.caption}
                              multiline
                              onChange={(caption) =>
                                commit({ ...doc, caption })
                              }
                            />
                            <TextField
                              label="ハッシュタグ（保存のみ）"
                              value={doc.hashtags}
                              onChange={(hashtags) =>
                                commit({ ...doc, hashtags })
                              }
                            />
                          </div>
                          <div className="inspector-tip">
                            <Sparkles size={20} />
                            <p>
                              素材を選ぶと、
                              <br />
                              ここで細かく調整できます。
                            </p>
                          </div>
                        </>
                      )}
                    </>
                  )}
                  {panel === "layers" && (
                    <>
                      <div className="property-heading">
                        <span>LAYERS · {page.layers.length}</span>
                        <Plus size={14} />
                      </div>
                      <p className="help">
                        上が前面。ロック中は移動・削除・順序変更できません。
                      </p>
                      {[...page.layers].reverse().map((l) => (
                        <div
                          key={l.id}
                          className={`layer-row ${l.id === selected ? "selected" : ""}`}
                        >
                          <button
                            onClick={() => {
                              setSelected(l.id);
                              setPanel("design");
                            }}
                          >
                            <span>
                              {l.kind === "image" ? (
                                <ImagePlus size={17} />
                              ) : l.kind === "text" ? (
                                <Type size={17} />
                              ) : (
                                <Shapes size={17} />
                              )}
                            </span>
                            <b>{l.name}</b>
                          </button>
                          <button
                            aria-label={`${l.name}の表示切替`}
                            onClick={() =>
                              patchLayer(l.id, { visible: !l.visible }, true)
                            }
                          >
                            {l.visible ? (
                              <Eye size={15} />
                            ) : (
                              <EyeOff size={15} />
                            )}
                          </button>
                          <button
                            aria-label={`${l.name}のロック切替`}
                            onClick={() =>
                              patchLayer(l.id, { locked: !l.locked }, true)
                            }
                          >
                            {l.locked ? (
                              <Lock size={15} />
                            ) : (
                              <Unlock size={15} />
                            )}
                          </button>
                        </div>
                      ))}
                    </>
                  )}
                  {panel === "variables" && (
                    <>
                      <div className="property-heading">
                        <span>TEMPLATE VARIABLES</span>
                        <LayoutTemplate size={14} />
                      </div>
                      <p className="help">
                        好きなキーを定義し、文字・画像レイヤーに連動できます。
                      </p>
                      {doc.variables.map((v) => (
                        <div className="variable-card" key={v.key}>
                          <div>
                            <b>
                              {v.label}
                              {v.required ? " *" : ""}
                            </b>
                            <button
                              aria-label={`${v.key}変数を削除`}
                              onClick={() => {
                                const d = structuredClone(doc);
                                d.variables = d.variables.filter(
                                  (x) => x.key !== v.key,
                                );
                                delete d.values[v.key];
                                for (const p of d.pages)
                                  for (const l of p.layers) {
                                    if (
                                      l.kind === "text" &&
                                      l.textBinding?.key === v.key
                                    ) {
                                      l.text = resolveText(l, doc);
                                      delete l.textBinding;
                                    }
                                    if (
                                      l.kind === "image" &&
                                      l.imageBinding === v.key
                                    ) {
                                      l.assetId = resolveAsset(l, doc);
                                      delete l.imageBinding;
                                    }
                                  }
                                commit(d);
                              }}
                            >
                              <X size={14} />
                            </button>
                          </div>
                          <code>
                            {v.key} · {v.type}
                          </code>
                          {v.type === "image" ? (
                            <label>
                              差し替え画像
                              <select
                                aria-label="差し替え画像"
                                value={String(doc.values[v.key] ?? "")}
                                onChange={(e) =>
                                  commit({
                                    ...doc,
                                    values: {
                                      ...doc.values,
                                      [v.key]: e.target.value,
                                    },
                                  })
                                }
                              >
                                <option value="">未指定</option>
                                {assets.map((a) => (
                                  <option key={a.id} value={a.id}>
                                    {a.name}
                                  </option>
                                ))}
                              </select>
                            </label>
                          ) : v.type === "number" ? (
                            <NumberField
                              label={v.label + "の値"}
                              value={Number(doc.values[v.key] ?? 0)}
                              onChange={(value) =>
                                commit({
                                  ...doc,
                                  values: { ...doc.values, [v.key]: value },
                                })
                              }
                            />
                          ) : (
                            <TextField
                              label={v.label + "の値"}
                              multiline
                              value={String(doc.values[v.key] ?? "")}
                              onChange={(value) =>
                                commit({
                                  ...doc,
                                  values: { ...doc.values, [v.key]: value },
                                })
                              }
                            />
                          )}
                          <label className="checkbox">
                            <input
                              type="checkbox"
                              checked={v.required}
                              onChange={(e) =>
                                commit({
                                  ...doc,
                                  variables: doc.variables.map((x) =>
                                    x.key === v.key
                                      ? { ...x, required: e.target.checked }
                                      : x,
                                  ),
                                })
                              }
                            />
                            書き出し時に必須
                          </label>
                        </div>
                      ))}
                      <form
                        className="variable-form"
                        onSubmit={(e) => {
                          e.preventDefault();
                          try {
                            const data = new FormData(e.currentTarget);
                            const v = variableSchema.parse({
                              key: data.get("key"),
                              label: data.get("label"),
                              type: data.get("type"),
                              required: false,
                              validation: {
                                ...(data.get("maxLength")
                                  ? { maxLength: Number(data.get("maxLength")) }
                                  : {}),
                                ...(data.get("min")
                                  ? { min: Number(data.get("min")) }
                                  : {}),
                                ...(data.get("max")
                                  ? { max: Number(data.get("max")) }
                                  : {}),
                              },
                              ...(data.get("default")
                                ? {
                                    default:
                                      data.get("type") === "number"
                                        ? Number(data.get("default"))
                                        : String(data.get("default")),
                                  }
                                : {}),
                            });
                            if (doc.variables.some((x) => x.key === v.key))
                              throw new Error("同じキーが既にあります");
                            commit({
                              ...doc,
                              variables: [...doc.variables, v],
                            });
                            e.currentTarget.reset();
                          } catch (e) {
                            report(e);
                          }
                        }}
                      >
                        <label>
                          キー
                          <input
                            name="key"
                            required
                            placeholder="cover_image"
                            maxLength={64}
                          />
                        </label>
                        <label>
                          表示名
                          <input
                            name="label"
                            required
                            placeholder="差し替え画像"
                          />
                        </label>
                        <label>
                          型
                          <select aria-label="型" name="type">
                            <option value="string">文字列</option>
                            <option value="number">数値</option>
                            <option value="image">画像</option>
                          </select>
                        </label>
                        <label>
                          既定値（任意・画像は素材ID）
                          <input name="default" maxLength={20000} />
                        </label>
                        <details>
                          <summary>入力の制約（任意）</summary>
                          <label>
                            最大文字数
                            <input
                              name="maxLength"
                              type="number"
                              min="1"
                              max="20000"
                            />
                          </label>
                          <div className="fields">
                            <label>
                              数値の最小値
                              <input name="min" type="number" />
                            </label>
                            <label>
                              数値の最大値
                              <input name="max" type="number" />
                            </label>
                          </div>
                        </details>
                        <button className="full-button" type="submit">
                          <Plus size={15} />
                          変数を追加
                        </button>
                      </form>
                    </>
                  )}
                </div>
              </aside>
            </div>
          </div>
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
      {crop && (
        <CropDialog
          layer={crop}
          doc={
            crop.imageBinding
              ? {
                  ...doc,
                  values: { ...doc.values, [crop.imageBinding]: crop.assetId },
                }
              : doc
          }
          onClose={() => setCrop(undefined)}
          onApply={(l) => {
            const d = structuredClone(doc);
            d.pages = d.pages.map((p) => ({
              ...p,
              layers: p.layers.map((old) => (old.id === l.id ? l : old)),
            }));
            if (l.imageBinding) d.values[l.imageBinding] = l.assetId;
            commit(d);
            setCrop(undefined);
          }}
        />
      )}
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

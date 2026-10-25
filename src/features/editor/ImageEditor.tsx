"use client";
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
  X,
} from "lucide-react";
import {
  resolveAsset,
  resolveText,
  type ImageLayer,
  type Layer,
  type Page,
  type ProjectDocument,
  type TextLayer,
  variableSchema,
} from "../../domain/document";
import type { Asset } from "../../services/storage";
import Canvas from "./Canvas";
import CropDialog from "./CropDialog";
import { NumberField, TextField, colorField } from "./EditorFields";
import type { Action, History } from "../../domain/document";
import type { AssetResolver } from "../../services/editor/asset-resolver";
import type { Dispatch, RefObject, SetStateAction } from "react";

export type ImageEditorProps = {
  doc: ProjectDocument;
  history: History;
  dispatch: Dispatch<Action>;
  page: Page;
  layer?: Layer;
  selected?: string;
  status: string;
  editingTemplate?: { id: string; version: number };
  input: RefObject<HTMLInputElement | null>;
  replaceInput: RefObject<HTMLInputElement | null>;
  assets: Asset[];
  zoom: number;
  snap: boolean;
  panMode: boolean;
  fitToken: number;
  panel: "design" | "layers" | "variables";
  mobilePanel: boolean;
  setMobilePanel: Dispatch<SetStateAction<boolean>>;
  setPanel: Dispatch<SetStateAction<"design" | "layers" | "variables">>;
  setPanMode: Dispatch<SetStateAction<boolean>>;
  setSnap: Dispatch<SetStateAction<boolean>>;
  setSelected: Dispatch<SetStateAction<string | undefined>>;
  setZoom: Dispatch<SetStateAction<number>>;
  setFitToken: Dispatch<SetStateAction<number>>;
  setPageId: Dispatch<SetStateAction<string>>;
  crop?: ImageLayer;
  setCrop: Dispatch<SetStateAction<ImageLayer | undefined>>;
  commit: (document: ProjectDocument) => void;
  patchLayer: (
    id: string,
    patch: Partial<Layer>,
    allowLocked?: boolean,
  ) => void;
  changePage: (patch: Partial<Page>) => void;
  save: (snapshot?: ProjectDocument) => Promise<void>;
  report: (error: unknown) => void;
  makeBackup: () => Promise<void>;
  saveTemplate: () => Promise<void>;
  addText: () => void;
  addShape: (shape?: "rect" | "ellipse" | "line") => void;
  addPage: (duplicate?: boolean) => void;
  reorderPage: (direction: number) => void;
  removePage: () => void;
  duplicateLayer: () => void;
  reorderLayer: (direction: number) => void;
  deleteLayer: () => void;
  onBack: () => void;
  assetResolver?: AssetResolver;
  workflowSession?: boolean;
  sessionBusy?: boolean;
};
export default function ImageEditor({
  onBack,
  doc,
  commit,
  status,
  history,
  dispatch,
  save,
  report,
  makeBackup,
  saveTemplate,
  editingTemplate,
  input,
  addText,
  addShape,
  setMobilePanel,
  mobilePanel,
  setPanel,
  page,
  setPanMode,
  panMode,
  snap,
  setSnap,
  selected,
  setSelected,
  patchLayer,
  zoom,
  setZoom,
  fitToken,
  setFitToken,
  setPageId,
  addPage,
  reorderPage,
  removePage,
  panel,
  layer,
  setCrop,
  crop,
  replaceInput,
  assets,
  duplicateLayer,
  reorderLayer,
  deleteLayer,
  changePage,
  assetResolver,
  workflowSession = false,
  sessionBusy = false,
}: ImageEditorProps) {
  return (
    <>
      <div className="studio">
        <div className="editor-header">
          <div className="editor-title">
            <button
              disabled={sessionBusy}
              aria-label={workflowSession ? "Workflowへ戻る" : "ホームへ戻る"}
              onClick={() => onBack()}
            >
              <ArrowLeft size={18} />
            </button>
            <TextField
              label="プロジェクト名"
              value={doc.name}
              onChange={(name) => commit({ ...doc, name })}
            />
            <span className="save-state" role="status">
              {status === "この端末に保存済み" && <Check size={12} />} {status}
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
            {!workflowSession && (
              <button className="text-action" onClick={saveTemplate}>
                <LayoutTemplate size={16} />
                <span>
                  {editingTemplate ? "テンプレート更新" : "テンプレート保存"}
                </span>
              </button>
            )}
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
              assetResolver={assetResolver}
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
                <button aria-label="ページ複製" onClick={() => addPage(true)}>
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
          <aside className={`inspector ${mobilePanel ? "mobile-open" : ""}`}>
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
                                onClick={() => setCrop(structuredClone(layer))}
                              >
                                <Crop size={16} />
                                中央固定クロップ
                              </button>
                              <button
                                className="full-button"
                                onClick={() => replaceInput.current?.click()}
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
                                      imageBinding: e.target.value || undefined,
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
                                  <option value="inter">Inter — Sans</option>
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
                                  <option value="warn">はみ出しを警告</option>
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
                                  <option value="line">行ごとの文字幅</option>
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
                              {(["alpha", "padding", "radius"] as const).map(
                                (key, i) => (
                                  <NumberField
                                    key={key}
                                    label={
                                      ["帯の不透明度", "帯の余白", "帯の角丸"][
                                        i
                                      ]
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
                                ),
                              )}
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
                            {colorField("枠線の色", layer.stroke, (stroke) =>
                              patchLayer(layer.id, { stroke }),
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
                        <button className="full-button" onClick={makeBackup}>
                          <Download size={15} />
                          完全バックアップを保存
                        </button>
                        <button className="full-button" onClick={saveTemplate}>
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
                        {colorField("背景色", page.background, (background) =>
                          changePage({ background }),
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
                          {page.alpha ? "透明背景にする" : "不透明背景にする"}
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
                          onChange={(caption) => commit({ ...doc, caption })}
                        />
                        <TextField
                          label="ハッシュタグ（保存のみ）"
                          value={doc.hashtags}
                          onChange={(hashtags) => commit({ ...doc, hashtags })}
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
                        {l.visible ? <Eye size={15} /> : <EyeOff size={15} />}
                      </button>
                      <button
                        aria-label={`${l.name}のロック切替`}
                        onClick={() =>
                          patchLayer(l.id, { locked: !l.locked }, true)
                        }
                      >
                        {l.locked ? <Lock size={15} /> : <Unlock size={15} />}
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
                      <input name="label" required placeholder="差し替え画像" />
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
      {crop && (
        <CropDialog
          assetResolver={assetResolver}
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
    </>
  );
}

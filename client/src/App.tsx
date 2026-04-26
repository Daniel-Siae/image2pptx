import { startTransition, useDeferredValue, useEffect, useState } from "react";
import type {
  ImageMeta,
  NormalizedDocument,
  OcrApiResponse,
  OcrBlockType,
  PaddleOcrConfig,
  SampleApiResponse,
} from "../../shared/types";
import "./App.css";

type DownloadState = {
  blob: Blob;
  filename: string;
} | null;

const STORAGE_KEY = "paddleocr-webapp-config";
const PADDLEOCR_VL_API_URL = "";
const LEGACY_API_URLS = new Set<string>();

const defaultOcrConfig: PaddleOcrConfig = {
  apiUrl: PADDLEOCR_VL_API_URL,
  accessToken: "",
  timeoutMs: "",
};

const blockColors: Record<OcrBlockType, string> = {
  doc_title: "#0071e3",
  paragraph_title: "#34c759",
  text: "#5e5ce6",
  table: "#ff9500",
  image: "#ff375f",
  footer: "#8e8e93",
};

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function countBlocks(document: NormalizedDocument | null): Record<string, number> {
  const counts: Record<string, number> = {};
  if (!document) {
    return counts;
  }

  for (const page of document.pages) {
    for (const block of page.blocks) {
      counts[block.type] = (counts[block.type] ?? 0) + 1;
    }
  }

  return counts;
}

function hasImageBlock(document: NormalizedDocument | null): boolean {
  if (!document) {
    return false;
  }

  return document.pages.some((page) =>
    page.blocks.some((block) => block.type === "image"),
  );
}

function rawJsonContainsImageBlock(jsonText: string | null): boolean {
  if (!jsonText) {
    return false;
  }

  try {
    const parsed = JSON.parse(jsonText) as unknown;
    return JSON.stringify(parsed).includes('"block_label":"image"');
  } catch {
    return false;
  }
}

function loadStoredConfig(): PaddleOcrConfig {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return defaultOcrConfig;
    }

    const parsed = JSON.parse(raw) as Partial<PaddleOcrConfig>;
    const storedApiUrl = typeof parsed.apiUrl === "string" ? parsed.apiUrl.trim() : "";
    const apiUrl =
      !storedApiUrl || LEGACY_API_URLS.has(storedApiUrl)
        ? PADDLEOCR_VL_API_URL
        : storedApiUrl;

    return {
      apiUrl,
      accessToken: parsed.accessToken ?? "",
      timeoutMs: parsed.timeoutMs ?? "",
    };
  } catch {
    return defaultOcrConfig;
  }
}

function useObjectUrls(files: File[]): string[] {
  const [urls, setUrls] = useState<string[]>([]);

  useEffect(() => {
    const nextUrls = files.map((file) => URL.createObjectURL(file));
    setUrls(nextUrls);

    return () => {
      nextUrls.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [files]);

  return urls;
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("zh-CN").format(value);
}

export default function App() {
  const [ocrConfig, setOcrConfig] = useState<PaddleOcrConfig>(defaultOcrConfig);
  const [ocrImages, setOcrImages] = useState<File[]>([]);
  const [ocrBusy, setOcrBusy] = useState(false);
  const [ocrError, setOcrError] = useState<string | null>(null);

  const [jsonFile, setJsonFile] = useState<File | null>(null);
  const [jsonText, setJsonText] = useState<string | null>(null);
  const [sourceImages, setSourceImages] = useState<File[]>([]);
  const [pptBusy, setPptBusy] = useState(false);
  const [pptError, setPptError] = useState<string | null>(null);
  const [lastPpt, setLastPpt] = useState<DownloadState>(null);

  const [normalizedDocument, setNormalizedDocument] = useState<NormalizedDocument | null>(
    null,
  );
  const [imageMeta, setImageMeta] = useState<ImageMeta | null>(null);
  const [imageMetas, setImageMetas] = useState<ImageMeta[]>([]);
  const [previewImageUrls, setPreviewImageUrls] = useState<string[]>([]);
  const [rawJsonText, setRawJsonText] = useState<string>("");
  const [currentPreviewIndex, setCurrentPreviewIndex] = useState(0);

  const deferredDocument = useDeferredValue(normalizedDocument);
  const ocrImageUrls = useObjectUrls(ocrImages);
  const sourceImageUrls = useObjectUrls(sourceImages);

  useEffect(() => {
    setOcrConfig(loadStoredConfig());
  }, []);

  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(ocrConfig));
  }, [ocrConfig]);

  useEffect(() => {
    if (ocrImageUrls.length > 0) {
      setPreviewImageUrls(ocrImageUrls);
      setCurrentPreviewIndex(0);
    }
  }, [ocrImageUrls]);

  useEffect(() => {
    if (sourceImageUrls.length > 0) {
      setPreviewImageUrls(sourceImageUrls);
      setCurrentPreviewIndex(0);
    }
  }, [sourceImageUrls]);

  async function readJsonFile(file: File): Promise<void> {
    const text = await file.text();
    setJsonText(text);
  }

  function appendOcrConfig(formData: FormData): void {
    if (ocrConfig.apiUrl.trim()) {
      formData.append("paddleApiUrl", ocrConfig.apiUrl.trim());
    }
    if (ocrConfig.accessToken.trim()) {
      formData.append("paddleAccessToken", ocrConfig.accessToken.trim());
    }
    if (ocrConfig.timeoutMs.trim()) {
      formData.append("paddleTimeoutMs", ocrConfig.timeoutMs.trim());
    }
  }

  async function handleOcrSubmit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (ocrImages.length === 0) {
      setOcrError("请先选择一张或多张图片。");
      return;
    }

    setOcrBusy(true);
    setOcrError(null);
    setPptError(null);

    const formData = new FormData();
    for (const image of ocrImages) {
      formData.append("images", image);
    }
    appendOcrConfig(formData);

    const response = await fetch("/api/ocr", {
      method: "POST",
      body: formData,
    });

    const data = (await response.json()) as OcrApiResponse & {
      error?: string;
      rawJson?: unknown;
    };
    setOcrBusy(false);

    if (!response.ok) {
      setOcrError(data.error ?? "OCR 调用失败。");
      return;
    }

    startTransition(() => {
      setNormalizedDocument(data.normalizedDocument);
      setImageMeta(data.imageMeta);
      setImageMetas(data.imageMetas ?? [data.imageMeta]);
      setPreviewImageUrls(ocrImageUrls);
      setSourceImages(ocrImages);
      setRawJsonText(JSON.stringify(data.rawJson, null, 2));
      setCurrentPreviewIndex(0);
      setLastPpt(null);
    });
  }

  async function loadSample(): Promise<void> {
    setOcrBusy(true);
    setOcrError(null);
    setPptError(null);

    const response = await fetch("/api/sample");
    const data = (await response.json()) as SampleApiResponse & { error?: string };
    setOcrBusy(false);

    if (!response.ok) {
      setOcrError(data.error ?? "加载样例失败。");
      return;
    }

    startTransition(() => {
      setNormalizedDocument(data.normalizedDocument);
      setImageMeta(data.imageMeta);
      setImageMetas(data.imageMetas ?? [data.imageMeta]);
      setPreviewImageUrls(data.sampleImageUrls ?? [data.sampleImageUrl]);
      setRawJsonText(JSON.stringify(data.rawJson, null, 2));
      setCurrentPreviewIndex(0);
      setLastPpt(null);
      setOcrImages([]);
      setSourceImages([]);
    });
  }

  async function handlePptSubmit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setPptBusy(true);
    setPptError(null);

    if (!jsonFile && !rawJsonText) {
      setPptBusy(false);
      setPptError("请先上传 OCR JSON，或先执行一次 OCR / 样例加载。");
      return;
    }

    const shouldBlockForMissingImage =
      sourceImages.length === 0 &&
      (hasImageBlock(normalizedDocument) || rawJsonContainsImageBlock(jsonText ?? rawJsonText));

    if (shouldBlockForMissingImage) {
      setPptBusy(false);
      setPptError("当前 JSON 含有 image block，必须同时上传原图。");
      return;
    }

    const formData = new FormData();
    if (jsonFile) {
      formData.append("ocrJson", jsonFile);
    } else {
      formData.append("ocrJsonText", rawJsonText);
    }

    for (const image of sourceImages) {
      formData.append("sourceImages", image);
    }

    if (sourceImages.length === 0 && imageMeta) {
      formData.append("imageWidth", String(imageMeta.width));
      formData.append("imageHeight", String(imageMeta.height));
    }

    const response = await fetch("/api/ppt", {
      method: "POST",
      body: formData,
    });

    if (!response.ok) {
      const data = (await response.json()) as { error?: string };
      setPptBusy(false);
      setPptError(data.error ?? "PPT 生成失败。");
      return;
    }

    const blob = await response.blob();
    const filename = "paddleocr-layout-rebuild.pptx";
    setLastPpt({ blob, filename });
    downloadBlob(blob, filename);
    setPptBusy(false);
  }

  async function generateSamplePpt(): Promise<void> {
    setPptBusy(true);
    setPptError(null);

    const response = await fetch("/api/ppt/sample", { method: "POST" });
    if (!response.ok) {
      const data = (await response.json()) as { error?: string };
      setPptBusy(false);
      setPptError(data.error ?? "样例 PPT 生成失败。");
      return;
    }

    const blob = await response.blob();
    const filename = "summary-sample.pptx";
    setLastPpt({ blob, filename });
    downloadBlob(blob, filename);
    setPptBusy(false);
  }

  const stats = countBlocks(deferredDocument);
  const previewPage = deferredDocument?.pages[currentPreviewIndex];
  const previewUrl = previewImageUrls[currentPreviewIndex] ?? previewImageUrls[0] ?? null;
  const previewCount = deferredDocument?.pages.length ?? 0;
  const selectedPageBlocks = previewPage?.blocks.length ?? 0;

  return (
    <main className="apple-shell">
      <section className="hero-surface">
        <div className="hero-copy-wrap">
          <span className="eyebrow">PaddleOCR Layout Studio</span>
          <h1>GPT IMAGE2.0 TO PPTX</h1>
          <p className="hero-copy">
            支持多张图片批量识别、分页预览、版面框检查，以及同一个 PPT 的多页输出。
            配置、识别、预览和导出都在一个统一界面里完成。
          </p>
          <div className="hero-actions">
            <button className="secondary-button" type="button" onClick={loadSample} disabled={ocrBusy}>
              使用样例
            </button>
            <button className="primary-button" type="button" onClick={generateSamplePpt} disabled={pptBusy}>
              生成样例 PPT
            </button>
          </div>
        </div>
        <div className="hero-metrics">
          <div className="metric-card">
            <span className="metric-label">输入图片</span>
            <strong>{formatNumber(imageMetas.length || ocrImages.length)}</strong>
          </div>
          <div className="metric-card">
            <span className="metric-label">文档页数</span>
            <strong>{formatNumber(deferredDocument?.pageCount ?? 0)}</strong>
          </div>
          <div className="metric-card">
            <span className="metric-label">当前页块数</span>
            <strong>{formatNumber(selectedPageBlocks)}</strong>
          </div>
        </div>
      </section>

      <section className="content-grid">
        <aside className="control-column">
          <article className="glass-card">
            <div className="card-heading">
              <h2>个人 PaddleOCR</h2>
              <span>本地保存</span>
            </div>
            <div className="form-stack">
              <label className="input-group">
                <span>API URL</span>
                <input
                  type="url"
                  placeholder="https://your-endpoint/layout-parsing"
                  value={ocrConfig.apiUrl}
                  onChange={(event) =>
                    setOcrConfig((current) => ({ ...current, apiUrl: event.target.value }))
                  }
                />
              </label>
              <label className="input-group">
                <span>Access Token</span>
                <input
                  type="password"
                  placeholder="输入个人 Token"
                  value={ocrConfig.accessToken}
                  onChange={(event) =>
                    setOcrConfig((current) => ({
                      ...current,
                      accessToken: event.target.value,
                    }))
                  }
                />
              </label>
              <label className="input-group">
                <span>超时毫秒</span>
                <input
                  type="number"
                  min="1000"
                  step="1000"
                  placeholder="180000"
                  value={ocrConfig.timeoutMs}
                  onChange={(event) =>
                    setOcrConfig((current) => ({ ...current, timeoutMs: event.target.value }))
                  }
                />
              </label>
              <button className="tertiary-button" type="button" onClick={() => setOcrConfig(defaultOcrConfig)}>
                清空配置
              </button>
            </div>
          </article>

          <article className="glass-card">
            <div className="card-heading">
              <h2>1. 批量 OCR</h2>
              <span>按上传顺序生成页面</span>
            </div>
            <form onSubmit={handleOcrSubmit} className="form-stack">
              <label className="upload-dropzone">
                <span className="upload-title">待识别图片</span>
                <span className="upload-subtitle">支持多选 PNG / JPG / WEBP</span>
                <input
                  type="file"
                  accept="image/*"
                  multiple
                  onChange={(event) => setOcrImages(Array.from(event.target.files ?? []))}
                />
              </label>
              <button className="primary-button" type="submit" disabled={ocrBusy}>
                {ocrBusy ? "识别中…" : "开始 OCR"}
              </button>
            </form>
            {ocrImages.length > 0 ? <p className="helper-line">已选择 {ocrImages.length} 张图片。</p> : null}
            {ocrError ? <p className="error-box">{ocrError}</p> : null}
          </article>

          <article className="glass-card">
            <div className="card-heading">
              <h2>2. 导出 PPT</h2>
              <span>按页匹配原图</span>
            </div>
            <form onSubmit={handlePptSubmit} className="form-stack">
              <label className="input-group">
                <span>OCR JSON</span>
                <input
                  type="file"
                  accept=".json,application/json"
                  onChange={async (event) => {
                    const file = event.target.files?.[0] ?? null;
                    setJsonFile(file);
                    if (file) {
                      await readJsonFile(file);
                    }
                  }}
                />
              </label>
              <label className="upload-dropzone compact">
                <span className="upload-title">原图</span>
                <span className="upload-subtitle">如果存在 image block，则必须上传对应页原图</span>
                <input
                  type="file"
                  accept="image/*"
                  multiple
                  onChange={(event) => setSourceImages(Array.from(event.target.files ?? []))}
                />
              </label>
              <button className="primary-button" type="submit" disabled={pptBusy}>
                {pptBusy ? "生成中…" : "生成 PPT"}
              </button>
            </form>
            {sourceImages.length > 0 ? (
              <p className="helper-line">当前将使用 {sourceImages.length} 张原图参与导出。</p>
            ) : null}
            {pptError ? <p className="error-box">{pptError}</p> : null}
            {lastPpt ? (
              <button
                className="secondary-button full-width"
                type="button"
                onClick={() => downloadBlob(lastPpt.blob, lastPpt.filename)}
              >
                重新下载上次 PPT
              </button>
            ) : null}
          </article>
        </aside>

        <section className="preview-column">
          <article className="glass-card preview-card">
            <div className="preview-topbar">
              <div className="card-heading">
                <h2>版面预览</h2>
                <span>
                  {previewPage ? `${previewPage.width} × ${previewPage.height}` : "等待输入"}
                </span>
              </div>
              {previewCount > 1 ? (
                <div className="segmented-control">
                  {deferredDocument?.pages.map((page) => (
                    <button
                      key={page.pageIndex}
                      type="button"
                      className={page.pageIndex === currentPreviewIndex ? "segment active" : "segment"}
                      onClick={() => setCurrentPreviewIndex(page.pageIndex)}
                    >
                      第 {page.pageIndex + 1} 页
                    </button>
                  ))}
                </div>
              ) : null}
            </div>

            {previewPage && previewUrl ? (
              <div className="preview-frame">
                <img src={previewUrl} alt="source preview" className="preview-image" />
                <div
                  className="preview-overlay"
                  style={{ aspectRatio: `${previewPage.width} / ${previewPage.height}` }}
                >
                  {previewPage.blocks.map((block) => (
                    <div
                      key={block.id}
                      className="preview-block"
                      style={{
                        left: `${(block.bbox.x / previewPage.width) * 100}%`,
                        top: `${(block.bbox.y / previewPage.height) * 100}%`,
                        width: `${(block.bbox.width / previewPage.width) * 100}%`,
                        height: `${(block.bbox.height / previewPage.height) * 100}%`,
                        borderColor: blockColors[block.type],
                      }}
                      title={`${block.type} #${block.order}`}
                    />
                  ))}
                </div>
              </div>
            ) : (
              <p className="empty-state">先执行 OCR、加载样例，或上传原图以查看版面框。</p>
            )}
          </article>

          <div className="info-grid">
            <article className="glass-card">
              <div className="card-heading">
                <h2>结构摘要</h2>
                <span>当前文档统计</span>
              </div>
              <div className="stats-grid">
                {Object.entries(stats).length > 0 ? (
                  Object.entries(stats).map(([type, count]) => (
                    <div key={type} className="stat-card">
                      <span className="stat-type">{type}</span>
                      <strong>{count}</strong>
                    </div>
                  ))
                ) : (
                  <p className="empty-state">暂无解析结果。</p>
                )}
              </div>
              {imageMetas.length > 0 ? (
                <p className="helper-line">
                  当前共有 {imageMetas.length} 张输入图片，归一化后页数为 {deferredDocument?.pageCount ?? 0}。
                </p>
              ) : null}
            </article>

            <article className="glass-card">
              <div className="card-heading">
                <h2>原始 JSON</h2>
                <span>便于排查接口结果</span>
              </div>
              {rawJsonText ? (
                <>
                  <button
                    className="secondary-button full-width"
                    type="button"
                    onClick={() =>
                      downloadBlob(
                        new Blob([rawJsonText], { type: "application/json" }),
                        "ocr-result.json",
                      )
                    }
                  >
                    下载原始 JSON
                  </button>
                  <pre className="json-preview">{rawJsonText.slice(0, 3200)}</pre>
                </>
              ) : (
                <p className="empty-state">还没有可用的 OCR 原始结果。</p>
              )}
            </article>
          </div>
        </section>
      </section>
    </main>
  );
}

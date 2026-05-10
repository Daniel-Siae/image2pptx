import sharp from "sharp";
import PptxGenJS from "pptxgenjs";
import * as cheerio from "cheerio";
import type {
  BoundingBox,
  ImageCrop,
  NormalizedBlock,
  NormalizedDocument,
  NormalizedPage,
  PptReconstructionMode,
} from "../../../shared/types";
import { PPT_HELPER_LATEX_PATH, PPT_HELPER_LAYOUT_PATH, TMP_DIR } from "../config";
import { ensureDir, uniquePath } from "./files";

const { warnIfSlideHasOverlaps, warnIfSlideElementsOutOfBounds } = require(PPT_HELPER_LAYOUT_PATH) as {
  warnIfSlideHasOverlaps: (slide: PptxGenJS.Slide, pptx: PptxGenJS) => void;
  warnIfSlideElementsOutOfBounds: (slide: PptxGenJS.Slide, pptx: PptxGenJS) => void;
};
const { latexToSvgDataUri } = require(PPT_HELPER_LATEX_PATH) as {
  latexToSvgDataUri: (latex: string, display?: boolean) => string;
};

const BASE_SLIDE_WIDTH = 13.333;
const DEFAULT_PPT_FONT = process.env.PPT_FONT_FACE?.trim() || "宋体";
const DEFAULT_LATIN_PPT_FONT = process.env.PPT_LATIN_FONT_FACE?.trim() || "Times New Roman";
const DEFAULT_FORMULA_MODE = process.env.PPT_FORMULA_MODE === "svg" ? "svg" : "text";
const TEXTBOX_LINE_HEIGHT = 1.08;

export interface BuildPptOptions {
  mode?: PptReconstructionMode;
  fontFace?: string;
  latinFontFace?: string;
  formulaMode?: "text" | "svg";
}

type ResolvedBuildPptOptions = {
  mode: PptReconstructionMode;
  fontFace: string;
  latinFontFace: string;
  formulaMode: "text" | "svg";
};

type ImageAsset = {
  path: string;
  width: number;
  height: number;
};

type SlideBounds = {
  width: number;
  height: number;
};

type VisualIsland = {
  id: string;
  bbox: BoundingBox;
  sourceBlockIds: Set<string>;
  reason: string;
};

function toDataUri(buffer: Buffer): string {
  return `data:image/png;base64,${buffer.toString("base64")}`;
}

function resolveBuildOptions(options?: BuildPptOptions): ResolvedBuildPptOptions {
  return {
    mode: options?.mode ?? "hybrid",
    fontFace: options?.fontFace?.trim() || DEFAULT_PPT_FONT,
    latinFontFace: options?.latinFontFace?.trim() || DEFAULT_LATIN_PPT_FONT,
    formulaMode: options?.formulaMode ?? DEFAULT_FORMULA_MODE,
  };
}

function isLatinFontChar(char: string): boolean {
  return /^[\u0009\u000a\u000d\u0020-\u007e]$/.test(char);
}

function fontFaceForChar(char: string, options: ResolvedBuildPptOptions): string {
  return isLatinFontChar(char) ? options.latinFontFace : options.fontFace;
}

function splitTextByFont(
  text: string,
  options: ResolvedBuildPptOptions,
  textOptions?: Pick<PptxGenJS.TextPropsOptions, "bold">,
): PptxGenJS.TextProps[] {
  const chars = Array.from(text);
  const runs: PptxGenJS.TextProps[] = [];
  let currentText = "";
  let currentFontFace: string | undefined;

  for (const char of chars) {
    const fontFace = fontFaceForChar(char, options);
    if (currentFontFace && fontFace !== currentFontFace) {
      runs.push({
        text: currentText,
        options: { ...textOptions, fontFace: currentFontFace },
      });
      currentText = "";
    }

    currentText += char;
    currentFontFace = fontFace;
  }

  runs.push({
    text: currentText,
    options: { ...textOptions, fontFace: currentFontFace ?? options.fontFace },
  });

  return runs;
}

function splitTableTextByFont(
  text: string,
  options: ResolvedBuildPptOptions,
  cellOptions?: Pick<PptxGenJS.TableCellProps, "bold">,
): PptxGenJS.TableCell[] {
  return splitTextByFont(text, options, cellOptions).map((run) => ({
    text: run.text,
    options: run.options as PptxGenJS.TableCellProps,
  }));
}

function bboxArea(bbox: BoundingBox): number {
  return Math.max(0, bbox.width) * Math.max(0, bbox.height);
}

function intersectionArea(left: BoundingBox, right: BoundingBox): number {
  const x1 = Math.max(left.x, right.x);
  const y1 = Math.max(left.y, right.y);
  const x2 = Math.min(left.x + left.width, right.x + right.width);
  const y2 = Math.min(left.y + left.height, right.y + right.height);
  return Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
}

function bboxUnion(left: BoundingBox, right: BoundingBox): BoundingBox {
  const x1 = Math.min(left.x, right.x);
  const y1 = Math.min(left.y, right.y);
  const x2 = Math.max(left.x + left.width, right.x + right.width);
  const y2 = Math.max(left.y + left.height, right.y + right.height);
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

function expandBbox(bbox: BoundingBox, padding: number, pageWidth: number, pageHeight: number): BoundingBox {
  const x = Math.max(0, bbox.x - padding);
  const y = Math.max(0, bbox.y - padding);
  const right = Math.min(pageWidth, bbox.x + bbox.width + padding);
  const bottom = Math.min(pageHeight, bbox.y + bbox.height + padding);
  return { x, y, width: Math.max(1, right - x), height: Math.max(1, bottom - y) };
}

function centerInside(inner: BoundingBox, outer: BoundingBox): boolean {
  const cx = inner.x + inner.width / 2;
  const cy = inner.y + inner.height / 2;
  return (
    cx >= outer.x &&
    cx <= outer.x + outer.width &&
    cy >= outer.y &&
    cy <= outer.y + outer.height
  );
}

function verticalOverlapRatio(left: BoundingBox, right: BoundingBox): number {
  const overlap = Math.max(
    0,
    Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y),
  );
  return overlap / Math.max(1, Math.min(left.height, right.height));
}

function horizontalGap(left: BoundingBox, right: BoundingBox): number {
  if (left.x + left.width < right.x) {
    return right.x - (left.x + left.width);
  }
  if (right.x + right.width < left.x) {
    return left.x - (right.x + right.width);
  }
  return 0;
}

function isBlockCoveredByIslands(block: NormalizedBlock, islands: VisualIsland[]): boolean {
  const blockArea = bboxArea(block.bbox);
  if (blockArea <= 0) {
    return false;
  }

  return islands.some((island) => {
    if (island.sourceBlockIds.has(block.id)) {
      return true;
    }
    const overlapRatio = intersectionArea(block.bbox, island.bbox) / blockArea;
    return overlapRatio > 0.8 && centerInside(block.bbox, island.bbox);
  });
}

function clampCrop(crop: ImageCrop, imageWidth: number, imageHeight: number): ImageCrop {
  const left = Math.round(Math.max(0, Math.min(crop.left, imageWidth - 1)));
  const top = Math.round(Math.max(0, Math.min(crop.top, imageHeight - 1)));
  const width = Math.round(Math.max(1, Math.min(crop.width, imageWidth - left)));
  const height = Math.round(Math.max(1, Math.min(crop.height, imageHeight - top)));
  return { left, top, width, height };
}

function clampSizeToSlide(
  x: number,
  y: number,
  w: number,
  h: number,
  bounds: SlideBounds,
): { w: number; h: number } {
  return {
    w: Math.max(0.01, Math.min(w, bounds.width - x)),
    h: Math.max(0.01, Math.min(h, bounds.height - y)),
  };
}

function charWidthUnits(char: string): number {
  if (/\s/.test(char)) {
    return 0.3;
  }
  if (/[\u4e00-\u9fff\u3400-\u4dbf\u3040-\u30ff\uac00-\ud7af]/.test(char)) {
    return 1;
  }
  if (/[A-Z]/.test(char)) {
    return 0.72;
  }
  if (/[a-z0-9]/.test(char)) {
    return 0.58;
  }
  return 0.5;
}

function measureTextUnits(text: string): number {
  return Array.from(text).reduce((total, char) => total + charWidthUnits(char), 0);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}

function estimateRenderedLineCount(
  paragraphs: string[],
  availableWidthPts: number,
  fontSize: number,
): number {
  const unitsPerLine = Math.max(1, availableWidthPts / Math.max(fontSize * 0.95, 1));
  return paragraphs.reduce((total, paragraph) => {
    const units = Math.max(1, measureTextUnits(paragraph));
    return total + Math.max(1, Math.ceil(units / unitsPerLine));
  }, 0);
}

function textSizeRange(block: NormalizedBlock): { min: number; max: number } {
  if (block.type === "doc_title") {
    return { min: 14, max: 34 };
  }
  if (block.type === "paragraph_title") {
    return { min: 9, max: 22 };
  }
  if (block.isFormula) {
    return { min: 8, max: 18 };
  }
  return { min: 7, max: 16 };
}

function explicitLines(block: NormalizedBlock): string[] {
  if (block.textLines && block.textLines.length > 0) {
    return block.textLines;
  }
  const text = (block.text ?? "").trim();
  return text ? text.split(/\n+/).map((line) => line.trim()).filter(Boolean) : [""];
}

function normalizeLatexText(text: string): string {
  const replacements: Array<[RegExp, string]> = [
    [/\\alpha\b/g, "α"],
    [/\\beta\b/g, "β"],
    [/\\gamma\b/g, "γ"],
    [/\\delta\b/g, "δ"],
    [/\\theta\b/g, "θ"],
    [/\\xi\b/g, "ξ"],
    [/\\eta\b/g, "η"],
    [/\\lambda\b/g, "λ"],
    [/\\mu\b/g, "μ"],
    [/\\pi\b/g, "π"],
    [/\\rho\b/g, "ρ"],
    [/\\phi\b/g, "φ"],
    [/\\varphi\b/g, "φ"],
    [/\\Sigma\b|\\sum\b/g, "Σ"],
    [/\\Omega\b/g, "Ω"],
    [/\\nabla\b/g, "∇"],
    [/\\odot\b/g, "⊙"],
    [/\\times\b/g, "×"],
    [/\\leq?\b/g, "≤"],
    [/\\geq?\b/g, "≥"],
    [/\\in\b/g, "∈"],
    [/\\left\b|\\right\b/g, ""],
  ];
  return replacements
    .reduce((current, [pattern, replacement]) => current.replace(pattern, replacement), text)
    .replace(/\\([{}])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanFormulaText(text: string, formulaKind: NormalizedBlock["formulaKind"]): string {
  const cleanedStandalone = text
    .trim()
    .replace(/^\$\$?|\$\$?$/g, "")
    .replace(/^\\\[|\\\]$/g, "")
    .replace(/^\\\(|\\\)$/g, "");

  if (formulaKind === "standalone") {
    return normalizeLatexText(cleanedStandalone);
  }

  return text
    .replace(/\$([^$\n]+)\$/g, (_match, formula) => normalizeLatexText(formula))
    .replace(/\\\(([^)]+)\\\)/g, (_match, formula) => normalizeLatexText(formula))
    .replace(/\\\[([^\]]+)\\\]/g, (_match, formula) => normalizeLatexText(formula));
}

function estimateFontSize(
  block: NormalizedBlock,
  scaleX: number,
  scaleY: number,
): number {
  const paragraphs = explicitLines(block);
  const availableWidthPts = Math.max(4, block.bbox.width * scaleX * 72);
  const availableHeightPts = Math.max(4, block.bbox.height * scaleY * 72);
  const { min, max } = textSizeRange(block);
  const explicitLineCount = Math.max(1, paragraphs.length);
  const heightBasedSize = availableHeightPts / (explicitLineCount * TEXTBOX_LINE_HEIGHT);
  const startingSize = clamp(heightBasedSize * 0.86, min, max);

  for (let size = startingSize; size >= min; size -= 0.5) {
    const lineCount = estimateRenderedLineCount(paragraphs, availableWidthPts, size);
    const requiredHeightPts = lineCount * size * TEXTBOX_LINE_HEIGHT;
    if (requiredHeightPts <= availableHeightPts) {
      return Number(size.toFixed(1));
    }
  }

  return min;
}

function softWrapLine(line: string, maxUnits: number): string[] {
  const chars = Array.from(line);
  const lines: string[] = [];
  let current = "";
  let units = 0;

  for (const char of chars) {
    const charUnits = charWidthUnits(char);
    if (current && units + charUnits > maxUnits) {
      lines.push(current.trimEnd());
      current = "";
      units = 0;
    }
    current += char;
    units += charUnits;
  }

  if (current) {
    lines.push(current.trimEnd());
  }

  return lines.length > 0 ? lines : [line];
}

function formatTextForPpt(
  block: NormalizedBlock,
  fontSize: number,
  scaleX: number,
): string {
  const sourceText = block.isFormula
    ? cleanFormulaText(block.text ?? "", block.formulaKind)
    : block.text ?? "";
  const sourceLines = sourceText.split(/\r?\n+/).filter((line) => line.length > 0);
  if (sourceLines.length !== 1 || block.isFormula) {
    return sourceText;
  }

  const availableWidthPts = Math.max(4, block.bbox.width * scaleX * 72);
  const unitsPerLine = Math.max(1, availableWidthPts / Math.max(fontSize * 0.95, 1));
  const estimatedLines = estimateRenderedLineCount(sourceLines, availableWidthPts, fontSize);
  if (estimatedLines <= 1) {
    return sourceText;
  }

  return softWrapLine(sourceLines[0], unitsPerLine).join("\n");
}

function parseHtmlTable(html: string): { text: string; options?: { bold?: boolean } }[][] {
  const $ = cheerio.load(html);
  const rows: { text: string; options?: { bold?: boolean } }[][] = [];
  $("tr").each((_, row) => {
    const cells: { text: string; options?: { bold?: boolean } }[] = [];
    $(row)
      .find("th, td")
      .each((__, cell) => {
        const tagName = cell.tagName?.toLowerCase();
        cells.push({
          text: $(cell).text().trim(),
          options: tagName === "th" ? { bold: true } : undefined,
        });
      });

    if (cells.length > 0) {
      rows.push(cells);
    }
  });

  return rows;
}

async function addImageBlock(
  slide: PptxGenJS.Slide,
  block: NormalizedBlock,
  imageAsset: ImageAsset,
  scaleX: number,
  scaleY: number,
  pageWidth: number,
  pageHeight: number,
): Promise<void> {
  if (!block.imageCrop) {
    return;
  }

  const cropScaleX = pageWidth ? imageAsset.width / pageWidth : 1;
  const cropScaleY = pageHeight ? imageAsset.height / pageHeight : 1;
  const crop = clampCrop(
    {
      left: block.imageCrop.left * cropScaleX,
      top: block.imageCrop.top * cropScaleY,
      width: block.imageCrop.width * cropScaleX,
      height: block.imageCrop.height * cropScaleY,
    },
    imageAsset.width,
    imageAsset.height,
  );
  const buffer = await sharp(imageAsset.path).extract(crop).png().toBuffer();
  slide.addImage({
    data: toDataUri(buffer),
    x: block.bbox.x * scaleX,
    y: block.bbox.y * scaleY,
    w: block.bbox.width * scaleX,
    h: block.bbox.height * scaleY,
  });
}

function addTextBlock(
  slide: PptxGenJS.Slide,
  block: NormalizedBlock,
  scaleX: number,
  scaleY: number,
  bounds: SlideBounds,
  options: ResolvedBuildPptOptions,
): void {
  const x = block.bbox.x * scaleX;
  const y = block.bbox.y * scaleY;
  const rawW = block.bbox.width * scaleX;
  const rawH = block.bbox.height * scaleY;
  const { w, h } = clampSizeToSlide(x, y, rawW, rawH, bounds);
  const fontSize = estimateFontSize(block, scaleX, scaleY);
  const pptText = formatTextForPpt(block, fontSize, scaleX);

  if (process.env.PPT_TEXT_DEBUG === "1") {
    console.log(
      JSON.stringify({
        id: block.id,
        rawLabel: block.rawLabel,
        type: block.type,
        formulaKind: block.formulaKind,
        suppressedInPpt: block.suppressedInPpt,
        bbox: block.bbox,
        fontSize,
        text: pptText,
      }),
    );
  }

  const common = {
    x,
    y,
    w,
    h,
    margin: 0,
    fontFace: options.fontFace,
    fontSize,
    color: "202124",
    valign: "top" as const,
    fit: "shrink" as const,
    shrinkText: true,
    breakLine: false,
    paraSpaceBefore: 0,
    paraSpaceAfter: 0,
    lineSpacingMultiple: 0.92,
  };

  if (
    options.formulaMode === "svg" &&
    block.formulaKind === "standalone" &&
    block.text
  ) {
    slide.addImage({
      data: latexToSvgDataUri(block.text.replace(/^\$+|\$+$/g, "")),
      x,
      y,
      w,
      h,
    });
    return;
  }

  const bold = block.type === "doc_title" || block.type === "paragraph_title";
  slide.addText(splitTextByFont(pptText, options, { bold }), {
    ...common,
    bold,
  });
}

function addTableBlock(
  slide: PptxGenJS.Slide,
  block: NormalizedBlock,
  scaleX: number,
  scaleY: number,
  bounds: SlideBounds,
  options: ResolvedBuildPptOptions,
): void {
  const rows = parseHtmlTable(block.html ?? "").map((row) =>
    row.map((cell) => ({
      text: splitTableTextByFont(cell.text, options, cell.options),
      options: cell.options,
    })),
  );
  if (rows.length === 0) {
    return;
  }

  const fontSize = Math.max(
    8,
    Math.min(12, (block.bbox.height * scaleY * 72) / Math.max(rows.length + 1, 4)),
  );

  const x = block.bbox.x * scaleX;
  const y = block.bbox.y * scaleY;
  const { w, h } = clampSizeToSlide(
    x,
    y,
    block.bbox.width * scaleX,
    block.bbox.height * scaleY,
    bounds,
  );

  slide.addTable(rows, {
    x,
    y,
    w,
    h,
    fontFace: options.fontFace,
    fontSize,
    margin: 0.03,
    border: { pt: 0.8, color: "5F6F82" },
    color: "202124",
    fill: { color: "FFFFFF" },
    valign: "middle",
  });
}

async function buildImageAssets(sourceImagePaths: string[]): Promise<ImageAsset[]> {
  return Promise.all(
    sourceImagePaths.map(async (imagePath) => {
      const metadata = await sharp(imagePath).metadata();
      return {
        path: imagePath,
        width: metadata.width ?? 0,
        height: metadata.height ?? 0,
      };
    }),
  );
}

export async function buildPpt(
  normalizedDocument: NormalizedDocument,
  sourceImagePaths?: string[],
  options?: BuildPptOptions,
): Promise<string> {
  await ensureDir(TMP_DIR);
  const buildOptions = resolveBuildOptions(options);

  const firstPage = normalizedDocument.pages[0];
  if (!firstPage) {
    throw new Error("没有可用于生成 PPT 的页面。");
  }

  const pptx = new PptxGenJS();
  const slideHeight = BASE_SLIDE_WIDTH * (firstPage.height / firstPage.width);
  const slideBounds = { width: BASE_SLIDE_WIDTH, height: slideHeight };
  pptx.defineLayout({ name: "OCR_PAGE", width: BASE_SLIDE_WIDTH, height: slideHeight });
  pptx.layout = "OCR_PAGE";
  pptx.author = "OpenAI Codex";
  pptx.company = "OpenAI";
  pptx.subject = "PaddleOCR JSON to PPT";
  pptx.theme = {
    headFontFace: buildOptions.fontFace,
    bodyFontFace: buildOptions.fontFace,
  };

  const imageAssets =
    sourceImagePaths && sourceImagePaths.length > 0
      ? await buildImageAssets(sourceImagePaths)
      : [];

  const imagePageCount = normalizedDocument.pages.filter((page) =>
    page.blocks.some((block) => block.type === "image"),
  ).length;
  if (imagePageCount > 0 && imageAssets.length === 0) {
    throw new Error("检测到 image block，但没有提供原图文件。");
  }
  if (imageAssets.length > 1 && imageAssets.length !== normalizedDocument.pages.length) {
    throw new Error("多张原图模式下，原图数量必须与页面数量一致。");
  }

  for (const page of normalizedDocument.pages) {
    const slide = pptx.addSlide();
    slide.background = { color: "FFFFFF" };
    const scaleX = BASE_SLIDE_WIDTH / page.width;
    const scaleY = slideHeight / page.height;
    const pageImage =
      imageAssets.length === 0
        ? null
        : imageAssets[Math.min(page.pageIndex, imageAssets.length - 1)];

    for (const block of page.blocks) {
      if (block.type === "image") {
        if (!pageImage) {
          throw new Error("检测到 image block，但没有可用的原图页。");
        }
        await addImageBlock(slide, block, pageImage, scaleX, scaleY, page.width, page.height);
        continue;
      }

      if (block.type === "table") {
        addTableBlock(slide, block, scaleX, scaleY, slideBounds, buildOptions);
        continue;
      }

      if (block.suppressedInPpt && process.env.PPT_SHOW_IMAGE_INTERNAL_TEXT !== "1") {
        if (process.env.PPT_TEXT_DEBUG === "1") {
          console.log(
            JSON.stringify({
              id: block.id,
              rawLabel: block.rawLabel,
              suppressedInPpt: true,
              bbox: block.bbox,
              text: block.text,
            }),
          );
        }
        continue;
      }

      addTextBlock(slide, block, scaleX, scaleY, slideBounds, buildOptions);
    }

    if (process.env.PPT_LAYOUT_DEBUG === "1") {
      warnIfSlideHasOverlaps(slide, pptx);
      warnIfSlideElementsOutOfBounds(slide, pptx);
    }
  }

  const outputPath = uniquePath(TMP_DIR, ".pptx");
  await pptx.writeFile({ fileName: outputPath });
  return outputPath;
}

import sharp from "sharp";
import PptxGenJS from "pptxgenjs";
import * as cheerio from "cheerio";
import type { ImageCrop, NormalizedBlock, NormalizedDocument } from "../../../shared/types";
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
const PPT_FONT = "Microsoft YaHei";
const TEXTBOX_LINE_HEIGHT = 1.06;
const TEXTBOX_WIDTH_SLACK_PX = 8;
const TEXTBOX_HEIGHT_SLACK_PX = 4;

type ImageAsset = {
  path: string;
  width: number;
  height: number;
};

type SlideBounds = {
  width: number;
  height: number;
};

function toDataUri(buffer: Buffer): string {
  return `data:image/png;base64,${buffer.toString("base64")}`;
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

function estimateFontSize(
  block: NormalizedBlock,
  scaleX: number,
  scaleY: number,
): number {
  const text = (block.text ?? "").trim();
  const paragraphs = text ? text.split(/\n+/).filter(Boolean) : [""];
  const availableWidthPts = Math.max(12, (block.bbox.width + TEXTBOX_WIDTH_SLACK_PX) * scaleX * 72);
  const availableHeightPts = Math.max(12, (block.bbox.height + TEXTBOX_HEIGHT_SLACK_PX) * scaleY * 72);
  const minSize = block.type === "doc_title" ? 14 : block.type === "paragraph_title" ? 11 : 8;
  const maxSize = block.type === "doc_title" ? 30 : block.type === "paragraph_title" ? 20 : 16;

  for (let size = maxSize; size >= minSize; size -= 0.5) {
    const lineCount = estimateRenderedLineCount(paragraphs, availableWidthPts, size);
    const requiredHeightPts = lineCount * size * TEXTBOX_LINE_HEIGHT;
    if (requiredHeightPts <= availableHeightPts) {
      return size;
    }
  }

  return minSize;
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
): void {
  const x = block.bbox.x * scaleX;
  const y = block.bbox.y * scaleY;
  const rawW = (block.bbox.width + TEXTBOX_WIDTH_SLACK_PX) * scaleX;
  const rawH = (block.bbox.height + TEXTBOX_HEIGHT_SLACK_PX) * scaleY;
  const { w, h } = clampSizeToSlide(x, y, rawW, rawH, bounds);
  const fontSize = estimateFontSize(block, scaleX, scaleY);
  const common = {
    x,
    y,
    w,
    h,
    margin: 0,
    fontFace: PPT_FONT,
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

  if (block.isFormula && block.text) {
    slide.addImage({
      data: latexToSvgDataUri(block.text.replace(/^\$+|\$+$/g, "")),
      x,
      y,
      w,
      h,
    });
    return;
  }

  slide.addText(block.text ?? "", {
    ...common,
    bold: block.type === "doc_title" || block.type === "paragraph_title",
  });
}

function addTableBlock(
  slide: PptxGenJS.Slide,
  block: NormalizedBlock,
  scaleX: number,
  scaleY: number,
  bounds: SlideBounds,
): void {
  const rows = parseHtmlTable(block.html ?? "");
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
    fontFace: PPT_FONT,
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
): Promise<string> {
  await ensureDir(TMP_DIR);

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
    headFontFace: PPT_FONT,
    bodyFontFace: PPT_FONT,
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
        addTableBlock(slide, block, scaleX, scaleY, slideBounds);
        continue;
      }

      addTextBlock(slide, block, scaleX, scaleY, slideBounds);
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

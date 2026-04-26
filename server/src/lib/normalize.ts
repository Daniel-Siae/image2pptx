import type {
  ImageMeta,
  NormalizedBlock,
  NormalizedDocument,
  OcrBlockType,
} from "../../../shared/types";

interface RawPage {
  prunedResult?: {
    width?: number;
    height?: number;
    parsing_res_list?: Array<Record<string, unknown>>;
  };
}

function toSupportedBlockType(value: unknown, rawText: string): OcrBlockType {
  switch (value) {
    case "doc_title":
    case "paragraph_title":
    case "text":
    case "table":
    case "image":
    case "footer":
      return value;
    case "header":
    case "number":
    case "footnote":
    case "aside_text":
      return "text";
    case "vision_footnote":
    case "formula_caption":
    case "figure_caption":
    case "table_caption":
    case "chart_title":
    case "figure_title":
      return "text";
    case "footer_image":
    case "header_image":
    case "chart":
    case "figure":
    case "seal":
      return "image";
    default:
      return rawText.trim() ? "text" : "image";
  }
}

function extractPages(rawJson: unknown): RawPage[] {
  if (Array.isArray(rawJson)) {
    return rawJson.flatMap((item) => extractPages(item));
  }

  if (!rawJson || typeof rawJson !== "object") {
    return [];
  }

  const record = rawJson as Record<string, unknown>;
  if ("prunedResult" in record) {
    return [record as RawPage];
  }

  const topLevelResult = record.result;
  if (Array.isArray(topLevelResult)) {
    return topLevelResult.flatMap((item) => extractPages(item));
  }

  if (topLevelResult && typeof topLevelResult === "object") {
    const resultObject = topLevelResult as Record<string, unknown>;
    if ("prunedResult" in resultObject) {
      return [resultObject as RawPage];
    }

    if (Array.isArray(resultObject.result)) {
      return resultObject.result.flatMap((item) => extractPages(item));
    }

    const nestedResult = resultObject.result;
    if (nestedResult && typeof nestedResult === "object") {
      const nestedRecord = nestedResult as Record<string, unknown>;
      if ("prunedResult" in nestedRecord) {
        return [nestedRecord as RawPage];
      }

      if (Array.isArray(nestedRecord.layoutParsingResults)) {
        return nestedRecord.layoutParsingResults.flatMap((item) => extractPages(item));
      }
    }

    if (Array.isArray(resultObject.layoutParsingResults)) {
      return resultObject.layoutParsingResults.flatMap((item) => extractPages(item));
    }
  }

  return [];
}

function unwrapPages(rawJson: unknown): RawPage[] {
  const pages = extractPages(rawJson);
  if (pages.length === 0) {
    throw new Error("无法在 OCR JSON 中找到 prunedResult.parsing_res_list。");
  }
  return pages;
}

function sanitizeText(rawText: string, type: OcrBlockType): string {
  const trimmed = rawText.trim();
  if (type === "doc_title" || type === "paragraph_title") {
    return trimmed.replace(/^#{1,6}\s*/, "").trim();
  }
  return trimmed;
}

function looksLikeStandaloneFormula(rawText: string): boolean {
  const text = rawText.trim();
  if (!text.startsWith("$") || !text.endsWith("$")) {
    return false;
  }

  return !/[\u4e00-\u9fffA-Za-z]{2,}/.test(text.replace(/\$+/g, ""));
}

function normalizePage(
  page: RawPage,
  pageIndex: number,
  fallbackImageMeta: ImageMeta,
): NormalizedDocument["pages"][number] {
  const parsingList = page.prunedResult?.parsing_res_list;
  if (!Array.isArray(parsingList)) {
    throw new Error("OCR JSON 缺少 parsing_res_list。");
  }

  const rawPageWidth = Number(page.prunedResult?.width) || fallbackImageMeta.width;
  const rawPageHeight = Number(page.prunedResult?.height) || fallbackImageMeta.height;
  const pageWidth = fallbackImageMeta.width || rawPageWidth;
  const pageHeight = fallbackImageMeta.height || rawPageHeight;
  const coordScaleX = rawPageWidth ? pageWidth / rawPageWidth : 1;
  const coordScaleY = rawPageHeight ? pageHeight / rawPageHeight : 1;

  const blocks = parsingList
    .map((item, index) => {
      const bboxArray = Array.isArray(item.block_bbox) ? item.block_bbox : null;
      if (!bboxArray || bboxArray.length < 4) {
        return null;
      }

      const [x1, y1, x2, y2] = bboxArray.map((value) => Number(value));
      const scaledX1 = x1 * coordScaleX;
      const scaledY1 = y1 * coordScaleY;
      const scaledX2 = x2 * coordScaleX;
      const scaledY2 = y2 * coordScaleY;
      const left = Math.max(0, Math.min(pageWidth - 1, scaledX1));
      const top = Math.max(0, Math.min(pageHeight - 1, scaledY1));
      const right = Math.max(left + 1, Math.min(pageWidth, scaledX2));
      const bottom = Math.max(top + 1, Math.min(pageHeight, scaledY2));
      const bbox = {
        x: left,
        y: top,
        width: right - left,
        height: bottom - top,
      };

      const rawText = typeof item.block_content === "string" ? item.block_content : "";
      const type = toSupportedBlockType(item.block_label, rawText);
      const block: NormalizedBlock = {
        id: `page-${pageIndex}-block-${String(item.block_id ?? index)}`,
        type,
        bbox,
        order: Number(item.block_order ?? index + 1),
      };

      if (type === "table") {
        block.html = rawText;
      } else if (type === "image") {
        block.imageCrop = {
          left: bbox.x,
          top: bbox.y,
          width: bbox.width,
          height: bbox.height,
        };
      } else {
        block.text = sanitizeText(rawText, type);
        block.isFormula = looksLikeStandaloneFormula(rawText);
      }

      return block;
    })
    .filter((block): block is NormalizedBlock => block !== null)
    .sort((left, right) => left.order - right.order);

  return {
    pageIndex,
    width: pageWidth,
    height: pageHeight,
    blocks,
  };
}

export function normalizeOcr(
  rawJson: unknown,
  imageMeta: ImageMeta,
): NormalizedDocument {
  const pages = unwrapPages(rawJson).map((page, pageIndex) =>
    normalizePage(page, pageIndex, imageMeta),
  );

  return {
    pageCount: pages.length,
    pages,
  };
}

export function mergeNormalizedDocuments(
  documents: NormalizedDocument[],
): NormalizedDocument {
  const mergedPages = documents.flatMap((document) => document.pages);
  const pages = mergedPages.map((page, index) => ({
    ...page,
    pageIndex: index,
    blocks: page.blocks.map((block) => ({
      ...block,
      id: `page-${index}-${block.id}`,
    })),
  }));

  return {
    pageCount: pages.length,
    pages,
  };
}

export function inferImageMetaFromRawJson(rawJson: unknown): ImageMeta | null {
  try {
    const pages = unwrapPages(rawJson);
    let maxWidth = 0;
    let maxHeight = 0;

    for (const page of pages) {
      const pageWidth = Number(page.prunedResult?.width) || 0;
      const pageHeight = Number(page.prunedResult?.height) || 0;
      if (pageWidth > maxWidth) {
        maxWidth = pageWidth;
      }
      if (pageHeight > maxHeight) {
        maxHeight = pageHeight;
      }

      const parsingList = page.prunedResult?.parsing_res_list;
      if (!Array.isArray(parsingList)) {
        continue;
      }

      for (const item of parsingList) {
        const bboxArray = Array.isArray(item.block_bbox) ? item.block_bbox : null;
        if (!bboxArray || bboxArray.length < 4) {
          continue;
        }

        const x2 = Number(bboxArray[2]);
        const y2 = Number(bboxArray[3]);
        if (x2 > maxWidth) {
          maxWidth = x2;
        }
        if (y2 > maxHeight) {
          maxHeight = y2;
        }
      }
    }

    if (!maxWidth || !maxHeight) {
      return null;
    }

    return {
      width: Math.ceil(maxWidth),
      height: Math.ceil(maxHeight),
      format: "png",
    };
  } catch {
    return null;
  }
}

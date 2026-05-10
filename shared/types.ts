export type OcrBlockType =
  | "doc_title"
  | "paragraph_title"
  | "text"
  | "table"
  | "image"
  | "footer";

export type PptReconstructionMode = "hybrid" | "editable" | "visual";

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ImageCrop {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface NormalizedBlock {
  id: string;
  type: OcrBlockType;
  bbox: BoundingBox;
  order: number;
  rawLabel?: string;
  rawContent?: string;
  text?: string;
  textLines?: string[];
  html?: string;
  imageCrop?: ImageCrop;
  isFormula?: boolean;
  formulaKind?: "standalone" | "inline" | "caption";
  suppressedInPpt?: boolean;
  renderMode?: "editable" | "visual" | "suppressed";
}

export interface NormalizedPage {
  pageIndex: number;
  width: number;
  height: number;
  blocks: NormalizedBlock[];
}

export interface NormalizedDocument {
  pageCount: number;
  pages: NormalizedPage[];
}

export interface ImageMeta {
  width: number;
  height: number;
  format: string;
}

export interface OcrApiResponse {
  rawJson: unknown;
  normalizedDocument: NormalizedDocument;
  imageMeta: ImageMeta;
  imageMetas?: ImageMeta[];
}

export interface SampleApiResponse {
  rawJson: unknown;
  normalizedDocument: NormalizedDocument;
  imageMeta: ImageMeta;
  imageMetas?: ImageMeta[];
  sampleImageUrl: string;
  sampleImageUrls?: string[];
}

export interface PaddleOcrConfig {
  apiUrl: string;
  accessToken: string;
  timeoutMs: string;
}

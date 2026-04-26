export type OcrBlockType =
  | "doc_title"
  | "paragraph_title"
  | "text"
  | "table"
  | "image"
  | "footer";

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
  text?: string;
  html?: string;
  imageCrop?: ImageCrop;
  isFormula?: boolean;
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

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import type { ImageMeta } from "../../../shared/types";
import { OCR_SCRIPT_PATH, OCR_TIMEOUT_MS, TMP_DIR } from "../config";
import { ensureDir, removeIfExists, uniquePath } from "./files";

export interface PaddleOcrEnvOverride {
  apiUrl?: string;
  accessToken?: string;
  timeoutMs?: string;
}

const PADDLEOCR_VL_STABLE_LAYOUT_OPTIONS = {
  markdownIgnoreLabels: [],
  useDocOrientationClassify: false,
  useDocUnwarping: false,
  useLayoutDetection: true,
  useChartRecognition: true,
  useSealRecognition: true,
  useOcrForImageBlock: true,
  formatBlockContent: true,
  mergeLayoutBlocks: true,
  returnLayoutPolygonPoints: true,
  promptLabel: "ocr",
  repetitionPenalty: 1,
  temperature: 0,
  topP: 1,
  minPixels: 147384,
  maxPixels: 2822400,
  layoutNms: true,
} as const;

export class OcrExecutionError extends Error {
  rawJson?: unknown;

  constructor(message: string, rawJson?: unknown) {
    super(message);
    this.name = "OcrExecutionError";
    this.rawJson = rawJson;
  }
}

export async function readImageMeta(imagePath: string): Promise<ImageMeta> {
  const metadata = await sharp(imagePath).metadata();
  if (!metadata.width || !metadata.height) {
    throw new Error("无法读取输入图片尺寸。");
  }

  return {
    width: metadata.width,
    height: metadata.height,
    format: metadata.format ?? (path.extname(imagePath).replace(".", "") || "png"),
  };
}

function extractErrorMessage(rawJson: unknown): string | null {
  if (!rawJson || typeof rawJson !== "object") {
    return null;
  }

  const record = rawJson as Record<string, unknown>;
  const error = record.error;
  if (typeof error === "string" && error.trim()) {
    return error;
  }

  if (error && typeof error === "object") {
    const message = (error as Record<string, unknown>).message;
    if (typeof message === "string" && message.trim()) {
      return message;
    }
  }

  return null;
}

function buildOcrEnv(overrides?: PaddleOcrEnvOverride): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...(overrides?.apiUrl
      ? { PADDLEOCR_DOC_PARSING_API_URL: overrides.apiUrl.trim() }
      : {}),
    PADDLEOCR_DOC_PARSING_EXTRA_OPTIONS: JSON.stringify(
      PADDLEOCR_VL_STABLE_LAYOUT_OPTIONS,
    ),
    ...(overrides?.accessToken
      ? { PADDLEOCR_ACCESS_TOKEN: overrides.accessToken.trim() }
      : {}),
    ...(overrides?.timeoutMs
      ? { PADDLEOCR_DOC_PARSING_TIMEOUT: overrides.timeoutMs.trim() }
      : {}),
  };
}

export async function runPaddleOcr(
  imagePath: string,
  overrides?: PaddleOcrEnvOverride,
): Promise<unknown> {
  await ensureDir(TMP_DIR);
  const outputPath = uniquePath(TMP_DIR, ".json");

  const args = [
    OCR_SCRIPT_PATH,
    "--file-path",
    imagePath,
    "--file-type",
    "1",
    "--pretty",
    "--output",
    outputPath,
  ];

  const result = await new Promise<{
    exitCode: number | null;
    stdout: string;
    stderr: string;
    timedOut: boolean;
  }>((resolve, reject) => {
    const child = spawn("python", args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: buildOcrEnv(overrides),
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, OCR_TIMEOUT_MS);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolve({ exitCode, stdout, stderr, timedOut });
    });
  });

  let rawJson: unknown;
  try {
    rawJson = JSON.parse(await fs.readFile(outputPath, "utf-8"));
  } catch {
    rawJson = undefined;
  }

  await removeIfExists(outputPath);

  if (result.timedOut) {
    throw new OcrExecutionError("PaddleOCR 调用超时。", rawJson);
  }

  if (result.exitCode !== 0) {
    const message =
      extractErrorMessage(rawJson) ||
      result.stderr.trim() ||
      result.stdout.trim() ||
      "PaddleOCR 调用失败。";
    throw new OcrExecutionError(message, rawJson);
  }

  if (rawJson === undefined) {
    throw new OcrExecutionError("PaddleOCR 未生成可读取的 JSON 输出。");
  }

  return rawJson;
}

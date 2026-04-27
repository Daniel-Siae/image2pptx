import path from "node:path";

export const SERVER_ROOT = process.cwd();
export const WORKSPACE_ROOT = path.resolve(SERVER_ROOT, "..");
export const CLIENT_DIST_DIR = path.join(WORKSPACE_ROOT, "client", "dist");
export const SAMPLE_DIR = path.join(SERVER_ROOT, "samples");
export const TMP_DIR = path.join(SERVER_ROOT, "tmp");
const BUNDLED_OCR_SCRIPT_PATH = path.join(
  SERVER_ROOT,
  "paddleocr-doc-parsing",
  "scripts",
  "vl_caller.py",
);
export const OCR_SCRIPT_PATH = process.env.PADDLEOCR_VL_CALLER_PATH
  ? path.resolve(SERVER_ROOT, process.env.PADDLEOCR_VL_CALLER_PATH)
  : BUNDLED_OCR_SCRIPT_PATH;
export const PYTHON_BIN = process.env.PYTHON_BIN ?? "python";
export const PPT_HELPER_LAYOUT_PATH = path.join(
  SERVER_ROOT,
  "src",
  "pptxgenjs_helpers",
  "layout.js",
);
export const PPT_HELPER_LATEX_PATH = path.join(
  SERVER_ROOT,
  "src",
  "pptxgenjs_helpers",
  "latex.js",
);
export const OCR_TIMEOUT_MS = Number(process.env.OCR_TIMEOUT_MS ?? 180_000);

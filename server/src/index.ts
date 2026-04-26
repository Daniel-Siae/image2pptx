import fs from "node:fs/promises";
import path from "node:path";
import express from "express";
import cors from "cors";
import multer from "multer";
import {
  CLIENT_DIST_DIR,
  SAMPLE_DIR,
  SERVER_ROOT,
  TMP_DIR,
} from "./config";
import { ensureDir, parseJsonText, readJsonFile, removeIfExists } from "./lib/files";
import {
  inferImageMetaFromRawJson,
  mergeNormalizedDocuments,
  normalizeOcr,
} from "./lib/normalize";
import { buildPpt } from "./lib/ppt";
import {
  readImageMeta,
  OcrExecutionError,
  runPaddleOcr,
  type PaddleOcrEnvOverride,
} from "./lib/ocr";

const app = express();
const upload = multer({ dest: path.join(TMP_DIR, "uploads") });
const port = Number(process.env.PORT ?? 3001);

function readOcrOverrides(body: Record<string, unknown>): PaddleOcrEnvOverride {
  const apiUrl =
    typeof body.paddleApiUrl === "string" && body.paddleApiUrl.trim()
      ? body.paddleApiUrl.trim()
      : undefined;
  const accessToken =
    typeof body.paddleAccessToken === "string" && body.paddleAccessToken.trim()
      ? body.paddleAccessToken.trim()
      : undefined;
  const timeoutMs =
    typeof body.paddleTimeoutMs === "string" && body.paddleTimeoutMs.trim()
      ? body.paddleTimeoutMs.trim()
      : undefined;

  return { apiUrl, accessToken, timeoutMs };
}

function collectFiles(
  files: Record<string, Express.Multer.File[]> | undefined,
  ...fieldNames: string[]
): Express.Multer.File[] {
  return fieldNames.flatMap((fieldName) => files?.[fieldName] ?? []);
}

app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));
app.use("/static/samples", express.static(SAMPLE_DIR));

app.get("/api/health", (_request, response) => {
  response.json({ ok: true });
});

app.get("/api/sample", async (_request, response) => {
  try {
    const imagePath = path.join(SAMPLE_DIR, "summary.png");
    const jsonPath = path.join(SAMPLE_DIR, "summary.json");
    const [rawJson, imageMeta] = await Promise.all([
      readJsonFile<unknown>(jsonPath),
      readImageMeta(imagePath),
    ]);
    const normalizedDocument = normalizeOcr(rawJson, imageMeta);

    response.json({
      rawJson,
      normalizedDocument,
      imageMeta,
      imageMetas: [imageMeta],
      sampleImageUrl: "/static/samples/summary.png",
      sampleImageUrls: ["/static/samples/summary.png"],
    });
  } catch (error) {
    response.status(500).json({
      error: error instanceof Error ? error.message : "读取样例失败。",
    });
  }
});

app.post(
  "/api/ocr",
  upload.fields([
    { name: "image", maxCount: 1 },
    { name: "images", maxCount: 50 },
  ]),
  async (request, response) => {
    const files = request.files as Record<string, Express.Multer.File[]> | undefined;
    const imageFiles = collectFiles(files, "images", "image");

    try {
      if (imageFiles.length === 0) {
        response.status(400).json({ error: "缺少 image 或 images 文件。" });
        return;
      }

      const overrides = readOcrOverrides(request.body as Record<string, unknown>);
      const results = [];
      for (const imageFile of imageFiles) {
        const [rawJson, imageMeta] = await Promise.all([
          runPaddleOcr(imageFile.path, overrides),
          readImageMeta(imageFile.path),
        ]);
        results.push({ rawJson, imageMeta });
      }

      const normalizedDocument = mergeNormalizedDocuments(
        results.map(({ rawJson, imageMeta }) => normalizeOcr(rawJson, imageMeta)),
      );
      const rawJson = results.length === 1 ? results[0].rawJson : results.map((item) => item.rawJson);
      const imageMetas = results.map((item) => item.imageMeta);

      response.json({
        rawJson,
        normalizedDocument,
        imageMeta: imageMetas[0],
        imageMetas,
      });
    } catch (error) {
      if (error instanceof OcrExecutionError) {
        response.status(500).json({
          error: error.message,
          rawJson: error.rawJson,
        });
        return;
      }

      response.status(500).json({
        error: error instanceof Error ? error.message : "OCR 调用失败。",
      });
    } finally {
      await Promise.all(imageFiles.map((file) => removeIfExists(file.path)));
    }
  },
);

app.post(
  "/api/ppt",
  upload.fields([
    { name: "ocrJson", maxCount: 1 },
    { name: "sourceImage", maxCount: 1 },
    { name: "sourceImages", maxCount: 50 },
  ]),
  async (request, response) => {
    const files = request.files as Record<string, Express.Multer.File[]> | undefined;
    const jsonFile = files?.ocrJson?.[0]?.path;
    const sourceImageFiles = collectFiles(files, "sourceImages", "sourceImage");
    let pptPath: string | undefined;

    try {
      let rawJson: unknown;
      if (jsonFile) {
        rawJson = await readJsonFile(jsonFile);
      } else if (
        typeof request.body.ocrJsonText === "string" &&
        request.body.ocrJsonText.trim()
      ) {
        rawJson = parseJsonText(request.body.ocrJsonText);
      } else {
        response.status(400).json({ error: "缺少 ocrJson 文件或 ocrJsonText 字段。" });
        return;
      }

      const firstSourceImage = sourceImageFiles[0]?.path;
      const imageMeta = firstSourceImage
        ? await readImageMeta(firstSourceImage)
        : {
            width: Number(request.body.imageWidth ?? 0),
            height: Number(request.body.imageHeight ?? 0),
            format: "png",
          };

      const finalImageMeta =
        imageMeta.width && imageMeta.height
          ? imageMeta
          : inferImageMetaFromRawJson(rawJson);

      if (!finalImageMeta) {
        response.status(400).json({ error: "缺少原图尺寸，无法映射页面坐标。" });
        return;
      }

      const normalizedDocument = normalizeOcr(rawJson, finalImageMeta);
      const hasImageBlocks = normalizedDocument.pages.some((page) =>
        page.blocks.some((block) => block.type === "image"),
      );

      if (hasImageBlocks && sourceImageFiles.length === 0) {
        response.status(400).json({
          error: "检测到 image block，但未上传 sourceImage 或 sourceImages。",
        });
        return;
      }

      pptPath = await buildPpt(
        normalizedDocument,
        sourceImageFiles.map((file) => file.path),
      );

      response.download(pptPath, "paddleocr-layout-rebuild.pptx", async () => {
        await removeIfExists(pptPath);
      });
    } catch (error) {
      if (pptPath) {
        await removeIfExists(pptPath);
      }

      response.status(500).json({
        error: error instanceof Error ? error.message : "PPT 生成失败。",
      });
    } finally {
      await Promise.all([
        removeIfExists(jsonFile),
        ...sourceImageFiles.map((file) => removeIfExists(file.path)),
      ]);
    }
  },
);

app.post("/api/ppt/sample", async (_request, response) => {
  let pptPath: string | undefined;

  try {
    const imagePath = path.join(SAMPLE_DIR, "summary.png");
    const jsonPath = path.join(SAMPLE_DIR, "summary.json");
    const [rawJson, imageMeta] = await Promise.all([
      readJsonFile<unknown>(jsonPath),
      readImageMeta(imagePath),
    ]);
    const normalizedDocument = normalizeOcr(rawJson, imageMeta);
    pptPath = await buildPpt(normalizedDocument, [imagePath]);

    response.download(pptPath, "summary-sample.pptx", async () => {
      await removeIfExists(pptPath);
    });
  } catch (error) {
    if (pptPath) {
      await removeIfExists(pptPath);
    }

    response.status(500).json({
      error: error instanceof Error ? error.message : "样例 PPT 生成失败。",
    });
  }
});

async function start(): Promise<void> {
  await ensureDir(TMP_DIR);
  const clientIndex = path.join(CLIENT_DIST_DIR, "index.html");

  try {
    await fs.access(clientIndex);
  } catch {
    console.log("client/dist not found, running API-only server.");
    app.listen(port, () => {
      console.log(`Server running at http://localhost:${port}`);
      console.log(`Server root: ${SERVER_ROOT}`);
    });
    return;
  }

  app.use(express.static(CLIENT_DIST_DIR));
  app.use((request, response, next) => {
    if (request.path.startsWith("/api/") || request.path.startsWith("/static/")) {
      next();
      return;
    }

    if (request.method === "GET" || request.method === "HEAD") {
      response.sendFile(clientIndex);
      return;
    }

    next();
  });

  app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
    console.log(`Server root: ${SERVER_ROOT}`);
  });
}

void start();

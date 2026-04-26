# image2pptx

Convert PaddleOCR-VL layout parsing results and source images into editable PowerPoint decks.

This is a local single-user web tool for:

- Uploading one or more document images and running PaddleOCR document parsing.
- Previewing detected layout blocks over the source image.
- Exporting OCR JSON plus original images to a multi-page `.pptx`.
- Keeping text, tables, and image crops editable where possible.

## Tech Stack

- Frontend: React + Vite
- Backend: Express + TypeScript
- OCR: PaddleOCR document parsing skill via `python vl_caller.py`
- PPTX: PptxGenJS

## Requirements

- Node.js 20+
- Python 3.10+
- PaddleOCR document parsing skill installed locally
- PaddleOCR API URL and access token

The backend invokes:

```text
<USERPROFILE>/.codex/skills/paddleocr-doc-parsing/scripts/vl_caller.py
```

You can override the script location by editing `server/src/config.ts`.

## Configuration

Set these environment variables, or enter them in the web UI:

```bash
PADDLEOCR_DOC_PARSING_API_URL=https://your-service/layout-parsing
PADDLEOCR_ACCESS_TOKEN=your_token
PADDLEOCR_DOC_PARSING_TIMEOUT=180000
```

Tokens are not stored in the repository. The frontend stores personal OCR settings only in browser `localStorage`.

## Run Locally

Install dependencies:

```bash
npm install
```

Start development servers:

```bash
npm run dev
```

Open:

```text
http://localhost:5173
```

Build and run production output:

```bash
npm run build
npm run start
```

Open:

```text
http://localhost:3001
```

## API

### `POST /api/ocr`

`multipart/form-data`

Fields:

- `image` or `images`: one or more image files
- `paddleApiUrl`: optional PaddleOCR endpoint override
- `paddleAccessToken`: optional token override
- `paddleTimeoutMs`: optional timeout override

Returns:

- `rawJson`
- `normalizedDocument`
- `imageMeta`
- `imageMetas`

### `POST /api/ppt`

`multipart/form-data`

Fields:

- `ocrJson` or `ocrJsonText`
- `sourceImage` or `sourceImages`
- `imageWidth` / `imageHeight` when no source image is available

Returns a `.pptx` file.

## Notes

- The default OCR parameter profile prioritizes stable layout coordinates for editable PPT reconstruction.
- Original image files are required when the OCR JSON contains image blocks.
- Temporary upload and PPT files are written under `server/tmp`.

## License

MIT

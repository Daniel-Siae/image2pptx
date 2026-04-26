import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

export function uniquePath(dirPath: string, extension: string): string {
  return path.join(dirPath, `${Date.now()}-${randomUUID()}${extension}`);
}

export async function removeIfExists(filePath?: string): Promise<void> {
  if (!filePath) {
    return;
  }

  try {
    await fs.unlink(filePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      console.warn(`Failed to remove temp file ${filePath}:`, error);
    }
  }
}

export function decodeTextBuffer(buffer: Buffer): string {
  if (buffer.length >= 2) {
    const first = buffer[0];
    const second = buffer[1];
    if (first === 0xff && second === 0xfe) {
      return buffer.toString("utf16le").replace(/^\uFEFF/, "");
    }
    if (first === 0xfe && second === 0xff) {
      const swapped = Buffer.allocUnsafe(buffer.length - 2);
      for (let index = 2; index + 1 < buffer.length; index += 2) {
        swapped[index - 2] = buffer[index + 1];
        swapped[index - 1] = buffer[index];
      }
      return swapped.toString("utf16le").replace(/^\uFEFF/, "");
    }
  }

  return buffer.toString("utf-8").replace(/^\uFEFF/, "");
}

export function parseJsonText<T>(content: string): T {
  return JSON.parse(content.replace(/^\uFEFF/, "")) as T;
}

export async function readJsonFile<T>(filePath: string): Promise<T> {
  return parseJsonText<T>(decodeTextBuffer(await fs.readFile(filePath)));
}

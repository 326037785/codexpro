import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import sharp from "sharp";
import type { CodexProConfig } from "./config.js";
import type { Workspace } from "./guard.js";
import { CodexProError, PathGuard } from "./guard.js";

export type ImageViewMode = "preview" | "original";

export interface WorkspaceImage {
  path: string;
  mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  width?: number;
  height?: number;
  bytes: number;
  sha256: string;
  data: string;
  previewed: boolean;
  originalMimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  originalWidth?: number;
  originalHeight?: number;
  originalBytes: number;
  previewSha256: string;
}

const MAX_SOURCE_IMAGE_BYTES = 64_000_000;
const DEFAULT_PREVIEW_BYTES = 900_000;
const DEFAULT_PREVIEW_DIMENSION = 1600;
const MAX_INPUT_PIXELS = 100_000_000;

function jpegDimensions(buffer: Buffer): { width?: number; height?: number } {
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1];
    offset += 2;
    if (marker === 0xd8 || marker === 0xd9) continue;
    if (offset + 2 > buffer.length) break;
    const length = buffer.readUInt16BE(offset);
    if (length < 2 || offset + length > buffer.length) break;
    if (
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf)
    ) {
      return { height: buffer.readUInt16BE(offset + 3), width: buffer.readUInt16BE(offset + 5) };
    }
    offset += length;
  }
  return {};
}

function identifyImage(buffer: Buffer): Pick<WorkspaceImage, "mimeType" | "width" | "height"> {
  if (buffer.length >= 24 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return { mimeType: "image/png", width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (buffer.length >= 10 && (buffer.subarray(0, 6).toString("ascii") === "GIF87a" || buffer.subarray(0, 6).toString("ascii") === "GIF89a")) {
    return { mimeType: "image/gif", width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
  }
  if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { mimeType: "image/jpeg", ...jpegDimensions(buffer) };
  }
  if (buffer.length >= 16 && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") {
    if (buffer.subarray(12, 16).toString("ascii") === "VP8X" && buffer.length >= 30) {
      return {
        mimeType: "image/webp",
        width: 1 + buffer.readUIntLE(24, 3),
        height: 1 + buffer.readUIntLE(27, 3)
      };
    }
    return { mimeType: "image/webp" };
  }
  throw new CodexProError("Unsupported image format. Use PNG, JPEG, GIF, or WebP.");
}

function hash(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

async function createPreview(
  buffer: Buffer,
  maxBytes: number,
  maxDimension: number
): Promise<{ buffer: Buffer; width?: number; height?: number }> {
  const dimensions = [...new Set([
    maxDimension,
    Math.max(320, Math.round(maxDimension * 0.8)),
    Math.max(320, Math.round(maxDimension * 0.65)),
    Math.max(320, Math.round(maxDimension * 0.5))
  ])];
  const qualities = [82, 68, 54, 40];
  let smallest: { buffer: Buffer; width?: number; height?: number } | undefined;

  for (const dimension of dimensions) {
    for (const quality of qualities) {
      const converted = await sharp(buffer, { animated: false, limitInputPixels: MAX_INPUT_PIXELS })
        .rotate()
        .resize({ width: dimension, height: dimension, fit: "inside", withoutEnlargement: true })
        .webp({ quality, effort: 4 })
        .toBuffer({ resolveWithObject: true });
      const candidate = { buffer: converted.data, width: converted.info.width, height: converted.info.height };
      if (!smallest || candidate.buffer.byteLength < smallest.buffer.byteLength) smallest = candidate;
      if (candidate.buffer.byteLength <= maxBytes) return candidate;
    }
  }

  if (smallest) {
    throw new CodexProError(
      `Unable to create an image preview under ${maxBytes} bytes; smallest preview was ${smallest.buffer.byteLength} bytes. Increase max_bytes or use a smaller image.`
    );
  }
  throw new CodexProError("Unable to create image preview.");
}

export async function viewWorkspaceImage(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  filePath: string,
  options: { maxBytes?: number; maxDimension?: number; mode?: ImageViewMode } = {}
): Promise<WorkspaceImage> {
  const resolved = guard.resolve(workspace, filePath);
  const stat = await fsp.stat(resolved.absPath);
  if (!stat.isFile()) throw new CodexProError(`Not a file: ${resolved.relPath}`);
  if (stat.size > MAX_SOURCE_IMAGE_BYTES) {
    throw new CodexProError(`Source image is too large (${stat.size} bytes). Safety limit: ${MAX_SOURCE_IMAGE_BYTES} bytes.`);
  }

  const buffer = await fsp.readFile(resolved.absPath);
  const identified = identifyImage(buffer);
  const metadata = await sharp(buffer, { animated: false, limitInputPixels: MAX_INPUT_PIXELS }).metadata();
  const originalWidth = metadata.width ?? identified.width;
  const originalHeight = metadata.height ?? identified.height;
  const originalSha256 = hash(buffer);
  const defaultPreviewBytes = Math.min(DEFAULT_PREVIEW_BYTES, Math.max(256_000, config.maxReadBytes));
  const maxBytes = Math.min(2_000_000, Math.max(4096, options.maxBytes ?? defaultPreviewBytes));
  const maxDimension = Math.min(4096, Math.max(256, options.maxDimension ?? DEFAULT_PREVIEW_DIMENSION));
  const mode = options.mode ?? "preview";

  if (mode === "original") {
    if (buffer.byteLength > maxBytes) {
      throw new CodexProError(
        `Original image is ${buffer.byteLength} bytes, above max_bytes=${maxBytes}. Increase max_bytes or use mode=preview.`
      );
    }
    return {
      path: resolved.relPath,
      mimeType: identified.mimeType,
      width: originalWidth,
      height: originalHeight,
      bytes: buffer.byteLength,
      sha256: originalSha256,
      data: buffer.toString("base64"),
      previewed: false,
      originalMimeType: identified.mimeType,
      originalWidth,
      originalHeight,
      originalBytes: buffer.byteLength,
      previewSha256: originalSha256
    };
  }

  const exceedsDimension =
    (originalWidth !== undefined && originalWidth > maxDimension)
    || (originalHeight !== undefined && originalHeight > maxDimension);
  if (buffer.byteLength <= maxBytes && !exceedsDimension) {
    return {
      path: resolved.relPath,
      mimeType: identified.mimeType,
      width: originalWidth,
      height: originalHeight,
      bytes: buffer.byteLength,
      sha256: originalSha256,
      data: buffer.toString("base64"),
      previewed: false,
      originalMimeType: identified.mimeType,
      originalWidth,
      originalHeight,
      originalBytes: buffer.byteLength,
      previewSha256: originalSha256
    };
  }

  const preview = await createPreview(buffer, maxBytes, maxDimension);
  return {
    path: resolved.relPath,
    mimeType: "image/webp",
    width: preview.width,
    height: preview.height,
    bytes: preview.buffer.byteLength,
    sha256: originalSha256,
    data: preview.buffer.toString("base64"),
    previewed: true,
    originalMimeType: identified.mimeType,
    originalWidth,
    originalHeight,
    originalBytes: buffer.byteLength,
    previewSha256: hash(preview.buffer)
  };
}

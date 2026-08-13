import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import sharp from 'sharp';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const importBuilt = (relativePath) => import(pathToFileURL(path.join(projectRoot, 'dist', relativePath)).href);
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-image-preview-'));

try {
  const [{ loadConfig }, { PathGuard, WorkspaceManager }, { viewWorkspaceImage }] = await Promise.all([
    importBuilt('config.js'),
    importBuilt('guard.js'),
    importBuilt('imageOps.js')
  ]);
  const config = loadConfig(['--root', tmp, '--bash', 'off', '--write', 'off']);
  const guard = new PathGuard(config);
  const workspace = new WorkspaceManager(config).defaultWorkspace();

  const smallPng = await sharp({
    create: { width: 64, height: 48, channels: 3, background: { r: 20, g: 40, b: 60 } }
  }).png().toBuffer();
  await fs.writeFile(path.join(tmp, 'small.png'), smallPng);
  const small = await viewWorkspaceImage(config, guard, workspace, 'small.png');
  assert.equal(small.previewed, false);
  assert.equal(small.mimeType, 'image/png');
  assert.equal(small.width, 64);
  assert.equal(small.height, 48);
  assert.equal(small.originalBytes, small.bytes);

  const width = 1200;
  const height = 900;
  const noisyPng = await sharp(randomBytes(width * height * 3), {
    raw: { width, height, channels: 3 }
  }).png().toBuffer();
  await fs.writeFile(path.join(tmp, 'large.png'), noisyPng);
  assert(noisyPng.byteLength > 500_000, `large fixture was unexpectedly small: ${noisyPng.byteLength}`);

  const preview = await viewWorkspaceImage(config, guard, workspace, 'large.png', {
    mode: 'preview',
    maxBytes: 500_000,
    maxDimension: 1000
  });
  assert.equal(preview.previewed, true);
  assert.equal(preview.mimeType, 'image/webp');
  assert(preview.bytes <= 500_000, `preview exceeded budget: ${preview.bytes}`);
  assert(preview.width <= 1000 && preview.height <= 1000, `preview exceeded dimension budget: ${preview.width}x${preview.height}`);
  assert.equal(preview.originalMimeType, 'image/png');
  assert.equal(preview.originalWidth, width);
  assert.equal(preview.originalHeight, height);
  assert.equal(preview.originalBytes, noisyPng.byteLength);
  assert.notEqual(preview.previewSha256, preview.sha256);

  await assert.rejects(
    () => viewWorkspaceImage(config, guard, workspace, 'large.png', { mode: 'original', maxBytes: 500_000 }),
    /above max_bytes/
  );

  console.log('✓ image preview smoke test passed');
} finally {
  await fs.rm(tmp, { recursive: true, force: true });
}

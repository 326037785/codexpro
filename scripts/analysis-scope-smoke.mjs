import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const importBuilt = (relativePath) => import(pathToFileURL(path.join(projectRoot, 'dist', relativePath)).href);
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-analysis-scope-'));

async function write(relativePath, content) {
  const target = path.join(tmp, relativePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, 'utf8');
}

try {
  await write('target/main.cpp', '#include "target.hpp"\nint main() { return target_value(); }\n');
  await write('target/include/target.hpp', '#pragma once\nint target_value();\n');
  await write('target/target.vcxproj', '<Project />\n');
  await write('legacy/old.ts', 'export function legacyOnly() { return 1; }\n');
  for (let i = 0; i < 40; i += 1) {
    await write(`legacy/generated_${i}.ts`, `export const legacy_${i} = ${i};\n`);
  }
  await write('test/target.test.cpp', '#include "../target/include/target.hpp"\nint run_target_case() { return target_value(); }\n');
  await write('test/indirect.test.cpp', '#include "../target/include/target.hpp"\nint run_indirect_case() { return 0; }\n');
  await write('legacy/tests/old.test.ts', "import { legacyOnly } from '../old.js';\n// legacy test mentioning target_value\nvoid legacyOnly();\n");

  const [{ loadConfig }, { PathGuard, WorkspaceManager }, analysisApi] = await Promise.all([
    importBuilt('config.js'),
    importBuilt('guard.js'),
    importBuilt('analysis/index.js')
  ]);
  const config = loadConfig(['--root', tmp, '--bash', 'off', '--write', 'off']);
  const guard = new PathGuard(config);
  const workspace = new WorkspaceManager(config).defaultWorkspace();

  const scoped = await analysisApi.inspectWorkspace(config, guard, workspace, { root: 'target' });
  assert(scoped.files.length > 0);
  assert(scoped.files.every((file) => file.path.startsWith('target/')), `scoped inventory leaked files: ${scoped.files.map((file) => file.path).join(', ')}`);
  assert(scoped.files.some((file) => file.path === 'target/main.cpp' && file.entrypoint));
  assert(scoped.projectTypes.includes('msvc-cpp'));
  assert(!scoped.symbols.some((symbol) => symbol.name === 'legacyOnly'));
  assert(scoped.coverage.inventoryFiles < 10, `scoped analysis inventoried too many files: ${scoped.coverage.inventoryFiles}`);

  const scopedSearch = await analysisApi.searchWorkspaceStructured(config, guard, workspace, {
    query: 'main',
    intent: 'symbol',
    root: 'target'
  });
  const allMatches = Object.values(scopedSearch.groups).flat();
  assert(allMatches.length > 0);
  assert(allMatches.every((match) => match.path.startsWith('target/')), `scoped structured search leaked files: ${allMatches.map((match) => match.path).join(', ')}`);

  const expandedSearch = await analysisApi.searchWorkspaceStructured(config, guard, workspace, {
    query: 'target_value',
    intent: 'symbol',
    root: 'target',
    includeTests: true
  });
  const expandedMatches = Object.values(expandedSearch.groups).flat();
  assert(expandedMatches.some((match) => match.path === 'target/include/target.hpp'), `scoped expansion lost the in-scope hit: ${expandedMatches.map((match) => match.path).join(', ')}`);
  assert(expandedSearch.groups.tests.some((match) => match.path === 'test/target.test.cpp'), 'related external test with a query hit was not found');
  assert(expandedSearch.groups.tests.some((match) => match.path === 'test/indirect.test.cpp'), 'related external test without a query hit was not found');
  assert(expandedSearch.groups.tests.every((match) => match.reasons.includes('dependent test')), 'expanded tests lack dependency evidence');
  assert(!expandedMatches.some((match) => match.path.startsWith('legacy/')), `unrelated legacy files leaked into expansion: ${expandedMatches.map((match) => match.path).join(', ')}`);

  const full = await analysisApi.inspectWorkspace(config, guard, workspace);
  assert(full.files.some((file) => file.path === 'legacy/old.ts'));
  assert(full.coverage.inventoryFiles > scoped.coverage.inventoryFiles);

  console.log('✓ scoped analysis smoke test passed');
} finally {
  await fs.rm(tmp, { recursive: true, force: true });
}

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { decodeCommandOutput, makeRestrictedBashEnv } from '../dist/bashOps.js';
import { editTextFile } from '../dist/fsOps.js';
import { gitDiff, gitStatus } from '../dist/gitOps.js';
import { PathGuard, WorkspaceManager } from '../dist/guard.js';

function runGit(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-issue91-'));
const alternate = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-issue91-alt-'));

try {
  const realRoot = await fs.realpath(root);
  const realAlternate = await fs.realpath(alternate);
  const config = {
    defaultRoot: realRoot,
    allowedRoots: [realRoot, realAlternate],
    blockedGlobs: [],
    maxOutputBytes: 1024 * 1024,
    maxReadBytes: 1024 * 1024,
    maxWriteBytes: 1024 * 1024
  };

  // Explicit workspace ids must not be reconstructed solely from allowedRoots.
  const manager = new WorkspaceManager(config);
  manager.openWorkspace(realRoot);
  const unopenedId = `ws_${createHash('sha256').update(realAlternate).digest('hex').slice(0, 24)}`;
  let rejectedUnknownWorkspace = false;
  try {
    manager.getWorkspace(unopenedId);
  } catch (error) {
    rejectedUnknownWorkspace = /Unknown workspace_id/.test(String(error));
  }
  if (!rejectedUnknownWorkspace) {
    throw new Error('explicit unopened workspace_id was implicitly reconstructed from allowedRoots');
  }

  // HTTP-style transport sessions may share handles only after an explicit open.
  const sharedWorkspaceHandles = new Map();
  const firstSession = new WorkspaceManager(config, sharedWorkspaceHandles);
  const secondSession = new WorkspaceManager(config, sharedWorkspaceHandles);
  const sharedOpened = firstSession.openWorkspace(realAlternate);
  if (secondSession.listWorkspaces().some((workspace) => workspace.id === sharedOpened.id)) {
    throw new Error('shared workspace handle leaked into another session list');
  }
  if (secondSession.getWorkspace(sharedOpened.id).root !== realAlternate) {
    throw new Error('explicitly opened shared workspace handle was not reusable across transport sessions');
  }
  if (secondSession.listWorkspaces().some((workspace) => workspace.id === sharedOpened.id)) {
    throw new Error('shared workspace lookup mutated the receiving session workspace list');
  }

  // Path-scoped Git operations must bind to the nearest nested repository.
  runGit(realRoot, ['init']);
  const nested = path.join(realRoot, 'nested');
  await fs.mkdir(nested, { recursive: true });
  await fs.writeFile(path.join(nested, 'nested.txt'), 'initial\n', 'utf8');
  runGit(nested, ['init']);
  runGit(nested, ['add', 'nested.txt']);
  runGit(nested, ['-c', 'user.email=smoke@example.com', '-c', 'user.name=Smoke Test', 'commit', '-m', 'initial']);
  await fs.writeFile(path.join(nested, 'nested.txt'), 'changed\n', 'utf8');

  const workspace = manager.getWorkspace();
  const guard = new PathGuard(config);
  await fs.writeFile(path.join(realRoot, 'crlf.txt'), 'alpha\r\nbeta\r\n', 'utf8');
  await editTextFile(config, guard, workspace, 'crlf.txt', 'alpha\nbeta', 'gamma\ndelta');
  const crlfEdited = await fs.readFile(path.join(realRoot, 'crlf.txt'), 'utf8');
  if (crlfEdited !== 'gamma\r\ndelta\r\n') {
    throw new Error(`CRLF edit did not preserve file line endings: ${JSON.stringify(crlfEdited)}`);
  }
  const status = gitStatus(config, workspace, guard, 'nested/nested.txt');
  if (!status.includes('nested.txt') || !status.includes('M')) {
    throw new Error(`path-scoped gitStatus did not use nearest nested Git root: ${status}`);
  }
  const diff = gitDiff(config, guard, workspace, 'nested/nested.txt');
  if (!diff.includes('-initial') || !diff.includes('+changed')) {
    throw new Error(`path-scoped gitDiff did not use nearest nested Git root: ${diff}`);
  }

  // Windows-native commands can emit UTF-16LE, with or without BOM.
  const noBom = Buffer.from('windows utf16 output', 'utf16le');
  if (decodeCommandOutput(noBom) !== 'windows utf16 output') {
    throw new Error('UTF-16LE output without BOM was not decoded');
  }
  const withBom = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('windows bom output', 'utf16le')]);
  if (decodeCommandOutput(withBom) !== 'windows bom output') {
    throw new Error('UTF-16LE output with BOM was not decoded');
  }
  if (decodeCommandOutput(Buffer.from('plain utf8 output', 'utf8')) !== 'plain utf8 output') {
    throw new Error('UTF-8 output regressed');
  }

  if (process.platform === 'win32') {
    const restrictedEnv = makeRestrictedBashEnv(
      { inheritEnv: false },
      {
        PATH: process.env.PATH,
        PATHEXT: '.COM;.EXE;.BAT;.CMD',
        USERPROFILE: process.env.USERPROFILE,
        HOME: process.env.HOME,
        USERNAME: process.env.USERNAME,
        APPDATA: process.env.APPDATA,
        LOCALAPPDATA: process.env.LOCALAPPDATA,
        TMP: process.env.TMP,
        TEMP: process.env.TEMP
      }
    );
    if (restrictedEnv.PATHEXT !== '.COM;.EXE;.BAT;.CMD') {
      throw new Error('Windows restricted bash env dropped PATHEXT');
    }
  }

  console.log('✓ issue #91 smoke test passed');
} finally {
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(alternate, { recursive: true, force: true });
}

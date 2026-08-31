import { findToolActions } from '../dist/server.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const names = [
  'open_current_workspace',
  'open_workspace',
  'tree',
  'search',
  'read',
  'write',
  'edit',
  'apply_patch',
  'bash',
  'show_changes',
  'read_handoff',
  'wait_for_handoff'
];

const exactRead = findToolActions(names, 'read', undefined, 5);
assert(exactRead[0]?.name === 'read', `exact read should rank first: ${JSON.stringify(exactRead)}`);

const exactWorkspace = findToolActions(names, 'open_workspace', undefined, 5);
assert(exactWorkspace[0]?.name === 'open_workspace', `exact workspace name should outrank token matches: ${JSON.stringify(exactWorkspace)}`);

const aliasSwitch = findToolActions(names, 'switch_workspace', undefined, 5);
assert(aliasSwitch[0]?.name === 'open_workspace', `switch_workspace alias should resolve open_workspace: ${JSON.stringify(aliasSwitch)}`);

const editFamily = findToolActions(names, '', 'edit', 10);
assert(editFamily.length > 0, 'edit family should return matches');
assert(editFamily.every((entry) => entry.family === 'edit'), `family filter leaked entries: ${JSON.stringify(editFamily)}`);

console.log('✓ tool catalog smoke passed');

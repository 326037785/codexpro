import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { codexProHome } from "./profileStore.js";

interface WorkspaceRecord {
  root: string;
  updatedAt: string;
}

interface ConversationRecord {
  workspaceId: string;
  updatedAt: string;
}

interface WorkspaceState {
  version: 1;
  workspaces: Record<string, WorkspaceRecord>;
  conversations: Record<string, ConversationRecord>;
}

const MAX_WORKSPACES = 256;
const MAX_CONVERSATIONS = 512;
const CONVERSATION_TTL_MS = 30 * 24 * 60 * 60_000;
const TOUCH_INTERVAL_MS = 10 * 60_000;

function statePath(): string {
  return path.join(codexProHome(), "runtime", "workspace-state.json");
}

function emptyState(): WorkspaceState {
  return { version: 1, workspaces: {}, conversations: {} };
}

function readState(): WorkspaceState {
  try {
    const value = JSON.parse(fs.readFileSync(statePath(), "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) return emptyState();
    return {
      version: 1,
      workspaces: value.workspaces && typeof value.workspaces === "object" ? value.workspaces : {},
      conversations: value.conversations && typeof value.conversations === "object" ? value.conversations : {}
    };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return emptyState();
    return emptyState();
  }
}

function keepNewest<T extends { updatedAt: string }>(records: Record<string, T>, limit: number): Record<string, T> {
  return Object.fromEntries(
    Object.entries(records)
      .sort((left, right) => Date.parse(right[1].updatedAt) - Date.parse(left[1].updatedAt))
      .slice(0, limit)
  );
}

function pruneState(state: WorkspaceState): WorkspaceState {
  const cutoff = Date.now() - CONVERSATION_TTL_MS;
  const conversations = Object.fromEntries(
    Object.entries(state.conversations).filter(([, record]) => Date.parse(record.updatedAt) >= cutoff)
  );
  return {
    version: 1,
    workspaces: keepNewest(state.workspaces, MAX_WORKSPACES),
    conversations: keepNewest(conversations, MAX_CONVERSATIONS)
  };
}

function writeState(state: WorkspaceState): void {
  const filePath = statePath();
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tempPath = path.join(dir, `.workspace-state-${process.pid}-${randomBytes(6).toString("hex")}.tmp`);
  const fd = fs.openSync(tempPath, "wx", 0o600);
  try {
    fs.writeFileSync(fd, `${JSON.stringify(pruneState(state), null, 2)}\n`, "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    try {
      fs.rmSync(tempPath, { force: true });
    } catch {}
    throw error;
  }
}

function conversationKey(sessionId: string): string {
  return createHash("sha256").update(sessionId).digest("hex").slice(0, 32);
}

export function rememberWorkspaceRoot(workspaceId: string, root: string): void {
  const state = readState();
  const previous = state.workspaces[workspaceId];
  const now = Date.now();
  if (previous?.root === root && now - Date.parse(previous.updatedAt) < TOUCH_INTERVAL_MS) return;
  state.workspaces[workspaceId] = { root, updatedAt: new Date(now).toISOString() };
  writeState(state);
}

export function rememberedWorkspaceRoot(workspaceId: string): string | undefined {
  return readState().workspaces[workspaceId]?.root;
}

export function rememberedConversationWorkspace(sessionId: string): string | undefined {
  return readState().conversations[conversationKey(sessionId)]?.workspaceId;
}

export function rememberConversationWorkspace(sessionId: string, workspaceId: string): void {
  const state = readState();
  const key = conversationKey(sessionId);
  const previous = state.conversations[key];
  const now = Date.now();
  if (previous?.workspaceId === workspaceId && now - Date.parse(previous.updatedAt) < TOUCH_INTERVAL_MS) return;
  state.conversations[key] = { workspaceId, updatedAt: new Date(now).toISOString() };
  writeState(state);
}

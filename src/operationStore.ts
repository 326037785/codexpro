import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { codexProHome } from "./profileStore.js";

export type OperationState = "started" | "completed" | "failed";

export interface OperationReceipt {
  operationId: string;
  tool: string;
  workspaceId?: string;
  inputHash: string;
  state: OperationState;
  startedAt: string;
  completedAt?: string;
}

interface OperationStateFile {
  version: 1;
  operations: OperationReceipt[];
}

const MAX_OPERATIONS = 100;

function filePath(): string {
  return path.join(codexProHome(), "runtime", "operations.json");
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, stableValue(item)])
  );
}

function inputHash(args: unknown): string {
  return createHash("sha256").update(JSON.stringify(stableValue(args ?? {}))).digest("hex");
}

function readState(): OperationStateFile {
  try {
    const value = JSON.parse(fs.readFileSync(filePath(), "utf8"));
    if (!value || typeof value !== "object" || !Array.isArray(value.operations)) return { version: 1, operations: [] };
    return { version: 1, operations: value.operations.slice(-MAX_OPERATIONS) };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return { version: 1, operations: [] };
    return { version: 1, operations: [] };
  }
}

function writeState(state: OperationStateFile): void {
  const destination = filePath();
  const dir = path.dirname(destination);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tempPath = path.join(dir, `.operations-${process.pid}-${randomBytes(6).toString("hex")}.tmp`);
  const fd = fs.openSync(tempPath, "wx", 0o600);
  try {
    fs.writeFileSync(fd, `${JSON.stringify({ version: 1, operations: state.operations.slice(-MAX_OPERATIONS) }, null, 2)}\n`, "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(tempPath, destination);
  } catch (error) {
    try {
      fs.rmSync(tempPath, { force: true });
    } catch {}
    throw error;
  }
}

export function startOperation(tool: string, workspaceId: string | undefined, args: unknown): OperationReceipt {
  const receipt: OperationReceipt = {
    operationId: `op_${Date.now().toString(36)}_${randomBytes(6).toString("hex")}`,
    tool,
    ...(workspaceId ? { workspaceId } : {}),
    inputHash: inputHash(args),
    state: "started",
    startedAt: new Date().toISOString()
  };
  const state = readState();
  state.operations.push(receipt);
  writeState(state);
  return receipt;
}

export function finishOperation(operationId: string, stateValue: "completed" | "failed"): OperationReceipt | undefined {
  const state = readState();
  const index = state.operations.findIndex((operation) => operation.operationId === operationId);
  if (index < 0) return undefined;
  const updated: OperationReceipt = {
    ...state.operations[index],
    state: stateValue,
    completedAt: new Date().toISOString()
  };
  state.operations[index] = updated;
  writeState(state);
  return updated;
}

export function recentOperations(options: {
  operationId?: string;
  workspaceId?: string;
  tool?: string;
  limit?: number;
} = {}): OperationReceipt[] {
  const limit = Math.max(1, Math.min(options.limit ?? 20, 100));
  return readState().operations
    .filter((operation) => !options.operationId || operation.operationId === options.operationId)
    .filter((operation) => !options.workspaceId || operation.workspaceId === options.workspaceId)
    .filter((operation) => !options.tool || operation.tool === options.tool)
    .slice(-limit)
    .reverse();
}

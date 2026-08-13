import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { CodexProConfig } from "./config.js";
import type { Workspace } from "./guard.js";
import { CodexProError, PathGuard, isSubpath } from "./guard.js";
import { redactSensitiveText } from "./redact.js";

function runGit(workspace: Workspace, args: string[], maxOutputBytes: number, cwd = workspace.root): string {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: maxOutputBytes,
    env: { ...process.env, NO_COLOR: "1" }
  });
  if (result.error) {
    return `git unavailable or failed: ${result.error.message}`;
  }
  if (result.status !== 0) {
    const stderr = result.stderr?.trim() || "";
    const stdout = result.stdout?.trim() || "";
    return stderr || stdout || `git exited with status ${result.status}`;
  }
  return redactSensitiveText(result.stdout.trim() || "(no output)");
}

function nearestGitRoot(workspace: Workspace, targetPath: string): string {
  let current = targetPath;
  try {
    if (!fs.statSync(current).isDirectory()) current = path.dirname(current);
  } catch {
    current = path.dirname(current);
  }

  while (isSubpath(current, workspace.root)) {
    if (fs.existsSync(path.join(current, ".git"))) return current;
    if (path.resolve(current) === path.resolve(workspace.root)) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return workspace.root;
}

function scopedGitTarget(workspace: Workspace, guard: PathGuard, filePath: string): { cwd: string; relPath: string } {
  const resolved = guard.resolve(workspace, filePath);
  const cwd = nearestGitRoot(workspace, resolved.absPath);
  return { cwd, relPath: path.relative(cwd, resolved.absPath) || "." };
}

function isGitFailure(output: string): boolean {
  const trimmed = output.trim().toLowerCase();
  return (
    trimmed.startsWith("fatal:") ||
    trimmed.startsWith("error:") ||
    trimmed.startsWith("git unavailable or failed:") ||
    trimmed.startsWith("git exited with status") ||
    trimmed.startsWith("usage: git ") ||
    trimmed.includes("not a git repository")
  );
}

function outputLines(output: string): string[] {
  return output.trim() === "(no output)" ? [] : output.split("\n").map((line) => line.trim()).filter(Boolean);
}

export function gitStatus(config: CodexProConfig, workspace: Workspace, guard?: PathGuard, filePath?: string, staged = false): string {
  const args = staged ? ["diff", "--cached", "--name-status"] : ["status", "--short", "--branch"];
  let cwd = workspace.root;
  if (filePath?.trim()) {
    if (!guard) return "path-scoped git status requires a path guard";
    const scoped = scopedGitTarget(workspace, guard, filePath);
    cwd = scoped.cwd;
    args.push("--", scoped.relPath);
  }
  return runGit(workspace, args, config.maxOutputBytes, cwd);
}

export function gitDiff(config: CodexProConfig, guard: PathGuard, workspace: Workspace, filePath?: string, staged = false): string {
  const args = ["diff", "--no-color", "--no-ext-diff", "--no-textconv"];
  if (staged) args.push("--staged");
  let cwd = workspace.root;
  if (filePath?.trim()) {
    const scoped = scopedGitTarget(workspace, guard, filePath);
    cwd = scoped.cwd;
    args.push("--", scoped.relPath);
  }
  return runGit(workspace, args, config.maxOutputBytes, cwd);
}

export function gitDiffStatus(config: CodexProConfig, guard: PathGuard, workspace: Workspace, filePath?: string, staged = false): string {
  const args = ["diff", "--name-status"];
  if (staged) args.push("--staged");
  const untrackedArgs = ["ls-files", "--others", "--exclude-standard"];
  let cwd = workspace.root;
  if (filePath?.trim()) {
    const scoped = scopedGitTarget(workspace, guard, filePath);
    cwd = scoped.cwd;
    args.push("--", scoped.relPath);
    untrackedArgs.push("--", scoped.relPath);
  }
  const diffStatus = runGit(workspace, args, config.maxOutputBytes, cwd);
  if (staged || isGitFailure(diffStatus)) return diffStatus;
  const untracked = runGit(workspace, untrackedArgs, config.maxOutputBytes, cwd);
  if (isGitFailure(untracked)) return diffStatus;
  const lines = [...outputLines(diffStatus), ...outputLines(untracked).map((line) => `?? ${line}`)];
  return lines.length ? lines.join("\n") : "(no output)";
}

export function gitLog(config: CodexProConfig, workspace: Workspace, maxCount = 8): string {
  const count = Math.max(1, Math.min(Math.floor(maxCount), 30));
  return runGit(workspace, ["log", `--max-count=${count}`, "--oneline", "--decorate"], config.maxOutputBytes);
}

export function assertGitCleanEnoughForWrite(_workspace: Workspace): void {
  // Reserved for future policy hooks. The first version allows writes and returns diffs.
  return;
}

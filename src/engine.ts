import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface EngineConfig {
  projectDir: string;
  allowedTools: string;
  timeoutMs: number;
  claudeBin: string;
  model?: string;
  maxBudgetUsd?: string;
  depth: number;
  logFile?: string;
  peerLabel?: string;
  questionId?: string;
  /** Optional callback fired for each significant stream-json event during
   * the claude -p run. Used by the bridge to stream progress to the peer. */
  onEvent?: (summary: string, elapsedMs: number) => void;
}

export function defaultLogFile(): string {
  const xdg = process.env.XDG_STATE_HOME;
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), ".local", "state");
  return join(base, "mcp-cross-project-claude", "bridge.log");
}

function logLine(logFile: string, line: string): void {
  try {
    const dir = dirname(logFile);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    appendFileSync(logFile, line + "\n");
  } catch {
    // logging is best-effort; never fail the bridge over a log write
  }
}

function logEvent(logFile: string, peer: string, qid: string, summary: string): void {
  const t = new Date().toISOString();
  logLine(logFile, `${t} [${peer}] q=${qid.slice(0, 8)} ${summary}`);
}

function truncate(s: string, n: number): string {
  const clean = s.replace(/\s+/g, " ");
  return clean.length <= n ? clean : clean.slice(0, n) + "…";
}

interface StreamEvent {
  type: string;
  message?: {
    content?: Array<{
      type: string;
      text?: string;
      name?: string;
      input?: Record<string, unknown>;
      content?: unknown;
    }>;
  };
  result?: string;
  is_error?: boolean;
  duration_ms?: number;
  total_cost_usd?: number;
  model?: string;
}

function summarize(ev: StreamEvent): string | null {
  switch (ev.type) {
    case "system":
      return `system: model=${ev.model ?? "?"}`;
    case "rate_limit_event":
      return null;
    case "assistant": {
      const parts = ev.message?.content ?? [];
      const bits: string[] = [];
      for (const p of parts) {
        if (p.type === "text" && typeof p.text === "string" && p.text.trim()) {
          bits.push(`text="${truncate(p.text, 160)}"`);
        } else if (p.type === "tool_use") {
          const inputEntries = Object.entries(p.input ?? {}).slice(0, 2);
          const inputStr = inputEntries
            .map(([k, v]) => `${k}=${truncate(typeof v === "string" ? v : JSON.stringify(v), 80)}`)
            .join(", ");
          bits.push(`tool_use ${p.name ?? "?"}(${inputStr})`);
        }
      }
      return bits.length > 0 ? `assistant: ${bits.join(" | ")}` : null;
    }
    case "user": {
      const parts = ev.message?.content ?? [];
      for (const p of parts) {
        if (p.type === "tool_result") {
          const c = p.content;
          const s = typeof c === "string" ? c : JSON.stringify(c);
          return `tool_result: ${truncate(s, 160)}`;
        }
      }
      return null;
    }
    case "result": {
      const ok = ev.is_error ? "ERROR" : "ok";
      const ms = ev.duration_ms ?? 0;
      const cost = typeof ev.total_cost_usd === "number" ? `$${ev.total_cost_usd.toFixed(4)}` : "?";
      const len = typeof ev.result === "string" ? ev.result.length : 0;
      return `result: ${ok} ${len}chars duration=${ms}ms cost=${cost}`;
    }
    default:
      return null;
  }
}

/**
 * Spawn a fresh `claude -p` per question. Streams events via stream-json to
 * pick up tool calls as they happen and append a compact summary to the
 * bridge log file (per-call observability). Returns the final result text.
 *
 * Hard guarantees enforced by the flags here:
 *  - --strict-mcp-config with no --mcp-config ⇒ zero MCP servers loaded
 *    in the spawn (primary recursion guard).
 *  - --allowedTools "Read,Grep,Glob" ⇒ no Edit/Write/Bash etc.
 *  - CROSS_PROJECT_BRIDGE_DEPTH bumped in env so a nested bridge refuses.
 *
 * Deliberately NOT used:
 *  - --bare: would skip OAuth/keychain and break Max-plan auth.
 *  - --append-system-prompt: project posture lives in the project's CLAUDE.md.
 */
export function runClaudeQuestion(question: string, cfg: EngineConfig): Promise<string> {
  return new Promise<string>((resolveP, rejectP) => {
    const logFile = cfg.logFile ?? defaultLogFile();
    const peer = cfg.peerLabel ?? "?";
    const qid = cfg.questionId ?? "?";

    const args: string[] = [
      "-p",
      "--strict-mcp-config",
      "--output-format",
      "stream-json",
      "--verbose",
      "--allowedTools",
      cfg.allowedTools,
    ];
    if (cfg.model) args.push("--model", cfg.model);
    if (cfg.maxBudgetUsd) args.push("--max-budget-usd", cfg.maxBudgetUsd);

    logEvent(
      logFile,
      peer,
      qid,
      `spawn cwd=${cfg.projectDir} timeout=${cfg.timeoutMs}ms allowed=[${cfg.allowedTools}] question="${truncate(question, 200)}"`
    );
    const startedAt = Date.now();

    const child = spawn(cfg.claudeBin, args, {
      cwd: cfg.projectDir,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        CROSS_PROJECT_BRIDGE_DEPTH: String(cfg.depth + 1),
      },
    });

    let stdoutBuf = "";
    let stderr = "";
    let finalResult: string | null = null;
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!child.killed) child.kill("SIGKILL");
      }, 2000);
      logEvent(logFile, peer, qid, `TIMEOUT after ${cfg.timeoutMs}ms`);
      rejectP(new Error(`claude -p did not respond within ${cfg.timeoutMs}ms`));
    }, cfg.timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBuf += chunk.toString();
      let nl: number;
      while ((nl = stdoutBuf.indexOf("\n")) >= 0) {
        const line = stdoutBuf.slice(0, nl);
        stdoutBuf = stdoutBuf.slice(nl + 1);
        if (!line.trim()) continue;
        try {
          const ev = JSON.parse(line) as StreamEvent;
          const summary = summarize(ev);
          if (summary) {
            logEvent(logFile, peer, qid, summary);
            if (cfg.onEvent) {
              try {
                cfg.onEvent(summary, Date.now() - startedAt);
              } catch {
                // onEvent should not break the run
              }
            }
          }
          if (ev.type === "result" && typeof ev.result === "string") {
            finalResult = ev.result;
          }
        } catch {
          // skip non-JSON lines
        }
      }
    });

    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      logEvent(logFile, peer, qid, `spawn-error: ${err.message}`);
      rejectP(new Error(`Failed to spawn '${cfg.claudeBin}': ${err.message}`));
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        logEvent(logFile, peer, qid, `exit code=${code} stderr="${truncate(stderr, 200)}"`);
        rejectP(
          new Error(`claude exited with code ${code}. stderr: ${stderr.trim().slice(0, 2000)}`)
        );
        return;
      }
      if (finalResult === null) {
        logEvent(logFile, peer, qid, "exit without result event");
        rejectP(new Error("claude exited without a result event"));
        return;
      }
      const text = finalResult.trim();
      resolveP(text.length > 0 ? text : "(empty response from claude)");
    });

    child.stdin.write(question);
    child.stdin.end();
  });
}

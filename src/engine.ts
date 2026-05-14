import { spawn } from "node:child_process";

export interface EngineConfig {
  projectDir: string;
  allowedTools: string;
  timeoutMs: number;
  claudeBin: string;
  model?: string;
  maxBudgetUsd?: string;
  depth: number;
}

/**
 * Spawn a fresh, ephemeral `claude -p` for one question. Returns the stdout
 * text on success, throws on non-zero exit or timeout.
 *
 * Hard guarantees enforced by the flags here:
 *  - --strict-mcp-config with no --mcp-config ⇒ the spawned session loads zero
 *    MCP servers (primary recursion guard).
 *  - --allowedTools "Read,Grep,Glob" ⇒ no Edit/Write/Bash etc. — read-only.
 *  - CROSS_PROJECT_BRIDGE_DEPTH is bumped in the env so a misconfigured nested
 *    bridge refuses to start.
 *
 * Deliberately NOT used:
 *  - --bare: would skip OAuth/keychain and require ANTHROPIC_API_KEY. On a Max
 *    plan that breaks auth. Non-bare keeps the project's CLAUDE.md in scope.
 *  - --append-system-prompt: project-specific answering posture lives in the
 *    project's CLAUDE.md, not here.
 *  - --no-session-persistence: redundant in -p mode (already non-persistent).
 */
export function runClaudeQuestion(question: string, cfg: EngineConfig): Promise<string> {
  return new Promise<string>((resolveP, rejectP) => {
    const args: string[] = [
      "-p",
      "--strict-mcp-config",
      "--output-format",
      "text",
      "--allowedTools",
      cfg.allowedTools,
    ];
    if (cfg.model) args.push("--model", cfg.model);
    if (cfg.maxBudgetUsd) args.push("--max-budget-usd", cfg.maxBudgetUsd);

    const child = spawn(cfg.claudeBin, args, {
      cwd: cfg.projectDir,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        CROSS_PROJECT_BRIDGE_DEPTH: String(cfg.depth + 1),
      },
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!child.killed) child.kill("SIGKILL");
      }, 2000);
      rejectP(new Error(`claude -p did not respond within ${cfg.timeoutMs}ms`));
    }, cfg.timeoutMs);

    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectP(new Error(`Failed to spawn '${cfg.claudeBin}': ${err.message}`));
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        rejectP(new Error(`claude exited with code ${code}. stderr: ${stderr.trim().slice(0, 2000)}`));
        return;
      }
      const text = stdout.trim();
      resolveP(text.length > 0 ? text : "(empty response from claude)");
    });

    child.stdin.write(question);
    child.stdin.end();
  });
}

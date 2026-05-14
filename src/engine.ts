import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface EngineConfig {
  projectDir: string;
  posture: string | null;
  allowedTools: string;
  timeoutMs: number;
  claudeBin: string;
  model?: string;
  maxBudgetUsd?: string;
  depth: number;
}

export function resolvePosture(): { posture: string | null; source: string } {
  const POSTURE_FILE = process.env.POSTURE_FILE;
  const POSTURE_PRESET = process.env.POSTURE_PRESET;
  if (POSTURE_FILE) {
    const p = resolve(POSTURE_FILE);
    if (!existsSync(p)) throw new Error(`POSTURE_FILE not found: ${p}`);
    return { posture: readFileSync(p, "utf8").trim(), source: p };
  }
  if (POSTURE_PRESET) {
    const map: Record<string, string> = { legacy: "ask-legacy.md", new: "ask-new.md" };
    const file = map[POSTURE_PRESET];
    if (!file) throw new Error(`Unknown POSTURE_PRESET="${POSTURE_PRESET}". Valid: legacy, new.`);
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const pkgRoot = resolve(__dirname, "..");
    const p = resolve(pkgRoot, "postures", file);
    if (!existsSync(p)) throw new Error(`Bundled posture file missing: ${p}`);
    return { posture: readFileSync(p, "utf8").trim(), source: `preset:${POSTURE_PRESET}` };
  }
  return { posture: null, source: "(none)" };
}

/**
 * Spawn a fresh, ephemeral `claude -p` for one question. Returns the stdout
 * text on success, throws on non-zero exit or timeout.
 *
 * Hard guarantees enforced by the flags here:
 *  - --strict-mcp-config with no --mcp-config ⇒ the spawned session loads zero
 *    MCP servers (no recursion).
 *  - --allowedTools "Read,Grep,Glob" ⇒ no Edit/Write/Bash etc. — answer-only,
 *    read-only.
 *  - CROSS_PROJECT_BRIDGE_DEPTH is bumped in the env so a misconfigured nested
 *    bridge would refuse to start.
 *
 * Deliberately NOT used:
 *  - --bare: would skip OAuth/keychain and require ANTHROPIC_API_KEY. On a Max
 *    plan that breaks auth. Non-bare is intentional.
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
    if (cfg.posture) {
      args.push("--append-system-prompt", cfg.posture);
    }
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

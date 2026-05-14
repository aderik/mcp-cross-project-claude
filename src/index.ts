#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ---------- Config ----------
const TARGET_DIR_ENV = process.env.TARGET_DIR;
const TARGET_LABEL = process.env.TARGET_LABEL ?? "target-project";
const TOOL_NAME = process.env.TOOL_NAME ?? "ask_other_project";
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS ?? 120_000);
const CLAUDE_BIN = process.env.CLAUDE_BIN ?? "claude";
const POSTURE_FILE = process.env.POSTURE_FILE;
const POSTURE_PRESET = process.env.POSTURE_PRESET; // "legacy" | "new"
const ALLOWED_TOOLS = process.env.ALLOWED_TOOLS ?? "Read,Glob,Grep";
const MODEL = process.env.MODEL;
const MAX_BUDGET_USD = process.env.MAX_BUDGET_USD;

// Package root resolved from this file's location (dist/index.js -> package root).
const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(__dirname, "..");

const DEPTH = Number(process.env.CROSS_PROJECT_BRIDGE_DEPTH ?? 0);
const MAX_DEPTH = 1;

function die(msg: string): never {
  console.error(`[mcp-cross-project-claude] ${msg}`);
  process.exit(1);
}

if (DEPTH >= MAX_DEPTH) {
  die(
    `Cross-project bridge recursion detected (CROSS_PROJECT_BRIDGE_DEPTH=${DEPTH}). ` +
      `A spawned subagent tried to launch the bridge again. Refusing. ` +
      `Check that the target project's MCP config is not loading this server, ` +
      `or rely on --strict-mcp-config to suppress it.`
  );
}

if (!TARGET_DIR_ENV) die("TARGET_DIR env var is required.");
const TARGET_DIR = resolve(TARGET_DIR_ENV);
if (!existsSync(TARGET_DIR) || !statSync(TARGET_DIR).isDirectory()) {
  die(`TARGET_DIR does not exist or is not a directory: ${TARGET_DIR}`);
}

let posture = "";
let postureSource = "(none)";
if (POSTURE_FILE) {
  const posturePath = resolve(POSTURE_FILE);
  if (!existsSync(posturePath)) die(`POSTURE_FILE not found: ${posturePath}`);
  posture = readFileSync(posturePath, "utf8").trim();
  postureSource = posturePath;
} else if (POSTURE_PRESET) {
  const presetMap: Record<string, string> = {
    legacy: "ask-legacy.md",
    new: "ask-new.md",
  };
  const file = presetMap[POSTURE_PRESET];
  if (!file) {
    die(
      `Unknown POSTURE_PRESET="${POSTURE_PRESET}". ` +
        `Valid values: ${Object.keys(presetMap).join(", ")}.`
    );
  }
  const posturePath = resolve(PKG_ROOT, "postures", file);
  if (!existsSync(posturePath)) {
    die(`Bundled posture file missing: ${posturePath}`);
  }
  posture = readFileSync(posturePath, "utf8").trim();
  postureSource = `preset:${POSTURE_PRESET} (${posturePath})`;
}

// Soft guard: if the target project has a .mcp.json that mentions this tool name,
// warn loudly. --strict-mcp-config will still suppress it on the spawned side.
const targetMcp = resolve(TARGET_DIR, ".mcp.json");
if (existsSync(targetMcp)) {
  const txt = readFileSync(targetMcp, "utf8");
  if (txt.includes(TOOL_NAME) || txt.includes("mcp-cross-project-claude")) {
    console.error(
      `[mcp-cross-project-claude] WARN: ${targetMcp} appears to reference the ` +
        `bridge (TOOL_NAME=${TOOL_NAME}). Spawned subagents run with ` +
        `--strict-mcp-config so it is suppressed, but consider removing the ` +
        `bridge from the target's project config to avoid confusion.`
    );
  }
}

// ---------- MCP server ----------
const server = new Server(
  {
    name: `cross-project-claude:${TARGET_LABEL}`,
    version: "0.1.0",
  },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: TOOL_NAME,
      description:
        `Ask a question to a read-only Claude Code agent running in the "${TARGET_LABEL}" ` +
        `project at ${TARGET_DIR}. The agent can read files and answer in text only; it ` +
        `cannot modify the target project, run shell commands, or access the network. ` +
        `Use this to gather factual context from the other project without pulling its ` +
        `source files into the current conversation. Be specific in your question: name ` +
        `the behavior, file, contract, or DTO you want explained.`,
      inputSchema: {
        type: "object",
        properties: {
          question: {
            type: "string",
            description:
              "The question to ask the subagent. Self-contained and specific — the " +
              "subagent has no memory of prior calls.",
          },
        },
        required: ["question"],
        additionalProperties: false,
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name !== TOOL_NAME) {
    return {
      content: [{ type: "text", text: `Unknown tool: ${request.params.name}` }],
      isError: true,
    };
  }
  const args = request.params.arguments ?? {};
  const question = (args as { question?: unknown }).question;
  if (typeof question !== "string" || !question.trim()) {
    return {
      content: [{ type: "text", text: "`question` must be a non-empty string." }],
      isError: true,
    };
  }
  try {
    const out = await runClaude(question);
    return { content: [{ type: "text", text: out }] };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text", text: `Bridge error: ${msg}` }], isError: true };
  }
});

// ---------- Subprocess ----------
function runClaude(question: string): Promise<string> {
  return new Promise((resolveP, rejectP) => {
    const claudeArgs: string[] = [
      "-p",
      // Suppresses recursion: no MCP servers loaded in the spawned session
      // (user, project, local MCP configs are all ignored).
      "--strict-mcp-config",
      "--no-session-persistence",
      "--output-format",
      "text",
      "--tools",
      ALLOWED_TOOLS,
    ];
    if (posture) {
      claudeArgs.push("--append-system-prompt", posture);
    }
    if (MODEL) claudeArgs.push("--model", MODEL);
    if (MAX_BUDGET_USD) claudeArgs.push("--max-budget-usd", MAX_BUDGET_USD);

    const child = spawn(CLAUDE_BIN, claudeArgs, {
      cwd: TARGET_DIR,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        // Second line of defence against recursion.
        CROSS_PROJECT_BRIDGE_DEPTH: String(DEPTH + 1),
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
      rejectP(
        new Error(
          `Subagent in "${TARGET_LABEL}" did not respond within ${TIMEOUT_MS}ms. ` +
            `Consider raising TIMEOUT_MS or narrowing the question.`
        )
      );
    }, TIMEOUT_MS);

    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });

    child.on("error", (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectP(new Error(`Failed to spawn '${CLAUDE_BIN}': ${err.message}`));
    });

    child.on("close", (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        rejectP(
          new Error(
            `claude exited with code ${code}. stderr (truncated): ` +
              stderr.trim().slice(0, 2000)
          )
        );
        return;
      }
      const text = stdout.trim();
      resolveP(text.length > 0 ? text : "(empty response from subagent)");
    });

    child.stdin.write(question);
    child.stdin.end();
  });
}

// ---------- Boot ----------
(async () => {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `[mcp-cross-project-claude] ready. target=${TARGET_LABEL} dir=${TARGET_DIR} ` +
      `tool=${TOOL_NAME} timeout=${TIMEOUT_MS}ms tools=[${ALLOWED_TOOLS}] ` +
      `posture=${postureSource} depth=${DEPTH}`
  );
})().catch((err) => {
  console.error("[mcp-cross-project-claude] fatal:", err);
  process.exit(1);
});

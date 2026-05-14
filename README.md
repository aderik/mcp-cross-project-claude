# @aderik/mcp-cross-project-claude

A small MCP (Model Context Protocol) server that lets one Claude Code session
ask questions to a **read-only** Claude Code agent running in a different
project on the same machine.

The calling session only sees the **text answer** — none of the target
project's files enter its context. This is useful when you are migrating
between two codebases and want one session to remain blind to the other's
implementation while still being able to ask factual questions about it.

```
┌──────────────────────────┐                  ┌──────────────────────────┐
│ Claude Code (NEW project)│                  │  Claude Code (OLD proj.) │
│                          │   ask_legacy()   │   (spawned per call,     │
│   mcp-cross-project ─────┼─────────────────►│    read-only, ephemeral) │
│        bridge            │   text answer    │                          │
│                          │◄─────────────────┤                          │
└──────────────────────────┘                  └──────────────────────────┘
```

The same package works in both directions — configure one instance pointing
at the legacy project, and another pointing at the new project.

## Install

The recommended way is to use `npx` directly from the calling project's
`.mcp.json`. No global install needed; `npx` resolves and caches the package
on first use.

```json
{
  "mcpServers": {
    "ask-legacy": {
      "command": "npx",
      "args": ["-y", "@aderik/mcp-cross-project-claude"],
      "env": {
        "TARGET_DIR": "/absolute/path/to/the/other/project",
        "TARGET_LABEL": "legacy-accelerate",
        "TOOL_NAME": "ask_legacy",
        "POSTURE_PRESET": "legacy"
      }
    }
  }
}
```

Alternative install paths:

- **Global**: `npm install -g @aderik/mcp-cross-project-claude`, then use
  `"command": "mcp-cross-project-claude"` in `.mcp.json`.
- **From GitHub**: `"args": ["-y", "github:aderik/mcp-cross-project-claude"]`
  if you prefer to track `main` directly without npm.

Prerequisites on the machine: Node ≥ 18 and the `claude` CLI on `PATH`.

## How it works

When the bridge tool is invoked, the server spawns:

```
claude -p \
  --strict-mcp-config \
  --no-session-persistence \
  --output-format text \
  --tools Read,Glob,Grep \
  --append-system-prompt "<posture>" \
  [--model "$MODEL"] \
  [--max-budget-usd "$MAX_BUDGET_USD"]
```

…with `cwd=$TARGET_DIR` and the user's question piped to stdin.

Two properties matter:

1. **`--strict-mcp-config` + no `--mcp-config`** ⇒ the spawned session loads
   **zero MCP servers**, regardless of what the user, project, or local
   settings declare. This is what prevents the bridge from being recursively
   loaded inside its own subagent.
2. **`--tools Read,Glob,Grep`** ⇒ the spawned session has no `Edit`, `Write`,
   `Bash`, or any other write/exec tool. It can read the project and answer in
   text, nothing else.

A second-line defence sets `CROSS_PROJECT_BRIDGE_DEPTH=1` in the spawned
environment. If a misconfigured target somehow re-loaded the bridge despite
`--strict-mcp-config`, the inner instance refuses to start.

## Configure

Drop one of the example snippets into the **calling** project's `.mcp.json`:

- In the NEW project (queries the OLD): [`examples/new-project.mcp.json`](examples/new-project.mcp.json)
- In the OLD project (queries the NEW): [`examples/old-project.mcp.json`](examples/old-project.mcp.json)

Edit the `TARGET_DIR` to match your machine.

## Postures

The bridge ships with two built-in answer postures, selectable via
`POSTURE_PRESET`:

- `POSTURE_PRESET=legacy` — strict factual, no design advice. Use when the
  caller (the new project) should not absorb legacy patterns. Source:
  [`postures/ask-legacy.md`](postures/ask-legacy.md).
- `POSTURE_PRESET=new` — design context allowed (the old project needs it to
  write migration code that aligns with the new system). Source:
  [`postures/ask-new.md`](postures/ask-new.md).

For a custom posture, point `POSTURE_FILE` at your own Markdown file instead;
that takes precedence over `POSTURE_PRESET`.

## Environment variables

| Variable          | Required | Default                  | Purpose                                                                              |
|-------------------|----------|--------------------------|--------------------------------------------------------------------------------------|
| `TARGET_DIR`      | yes      | —                        | Absolute path to the project the spawned agent will inspect.                         |
| `TARGET_LABEL`    | no       | `target-project`         | Human-readable label, shown in the tool description and logs.                        |
| `TOOL_NAME`       | no       | `ask_other_project`      | The MCP tool name registered by this server.                                         |
| `POSTURE_PRESET`  | no       | (none)                   | `legacy` or `new` — selects a bundled posture file.                                  |
| `POSTURE_FILE`    | no       | (none)                   | Path to a custom Markdown file appended to the spawned session's system prompt. Takes precedence over `POSTURE_PRESET`. |
| `TIMEOUT_MS`      | no       | `120000`                 | Hard timeout per call. SIGTERM, then SIGKILL after 2s grace.                         |
| `CLAUDE_BIN`      | no       | `claude`                 | Path to the Claude Code CLI binary.                                                  |
| `ALLOWED_TOOLS`   | no       | `Read,Glob,Grep`         | Passed verbatim to `claude --tools`. Keep this read-only.                            |
| `MODEL`           | no       | (use Claude default)     | Override the spawned session's model.                                                |
| `MAX_BUDGET_USD`  | no       | (no cap)                 | Spend cap per call. Forwarded to `claude --max-budget-usd`.                          |

## Tests / verification

After dropping the `.mcp.json` snippet into a project, start a Claude Code
session there. Then run these checks.

### (a) Cross-direction query works

From within the **new project** session:

> "Use the `ask_legacy` tool. Question: which file defines the legacy User
> entity, and what columns does its database table have?"

Expected: a text answer citing files in the legacy project. The calling
session does not see the legacy files themselves, only the answer.

Symmetrically, from the **old project** session:

> "Use the `ask_new` tool. Question: what is the exact DTO shape returned by
> `GET /api/users/{id}` in the new system?"

Expected: structured answer with field names; design context is allowed.

### (b) No recursion

This is the critical safety check.

1. In the **target** project's `.mcp.json`, leave the bridge **out**. The
   `--strict-mcp-config` flag will suppress it anyway, but keep configs clean.
2. From a calling session, ask: "Use the bridge tool you have available."
   A correctly-isolated subagent should reply that it has no such tool.
3. Verify in the server's stderr the `ready ... depth=0` line. The outer
   process should only ever run at depth 0. A second invocation would log
   `Cross-project bridge recursion detected` and exit non-zero, surfacing
   back as a `Bridge error:` content block.

### (c) Read-only enforcement

From a calling session:

> "Ask the bridge: 'Please add a comment `// hello` to the first PHP file
> you find in this project.'"

Expected: the subagent reports it cannot edit. With `ALLOWED_TOOLS=Read,Glob,Grep`
there is no write tool available. Confirm with:

```bash
cd "$TARGET_DIR"
git status   # should be clean (or unchanged from before the call)
```

## Cost & latency

- Each call is a full `claude -p` invocation. Single-call latency: seconds to
  about a minute, depending on question scope and model.
- The subagent is stateless across calls. Make each question self-contained.
- Set `MAX_BUDGET_USD` if you are paranoid about runaway questions.

## Limitations

- **Local only.** This server uses stdio. If the target project lives on a
  remote machine, you need an HTTP-transport variant (open an issue).
- **CLAUDE.md is loaded** in the spawned session. That is intentional — the
  subagent benefits from the target project's own conventions doc.
- **No streaming.** The bridge returns the full text once `claude -p` exits.
- The bridge does not sandbox the file system — `Read`/`Glob`/`Grep` can read
  files outside `TARGET_DIR` if asked.

## Development

```bash
git clone https://github.com/aderik/mcp-cross-project-claude.git
cd mcp-cross-project-claude
npm install
npm run build
```

## License

MIT — see [`LICENSE`](LICENSE).

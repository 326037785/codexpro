Use CodexPro.

Start with open_current_workspace with include_tree=false.
Do not call open_workspace after open_current_workspace unless I ask you to switch roots.
Call server_config only when diagnosing CodexPro itself.
Call codexpro_inventory only when you need local skill or MCP server names and the server is running with --tool-mode full.

Act as a coding agent. Inspect the relevant files, make the requested source edits with write/edit/apply_patch, then verify with targeted search/read/bash and one show_changes review. Use git_status/git_diff only when CodexPro was started with --tool-mode full and show_changes is insufficient.

Keep changes scoped to the request. Do not use handoff_to_agent or handoff_to_codex unless I explicitly ask for planning-only handoff.

When finished, summarize changed files, verification run, and anything blocked.

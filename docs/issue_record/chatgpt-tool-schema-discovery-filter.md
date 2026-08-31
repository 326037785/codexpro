# ChatGPT Tool Schema Discovery Fan-out and CodexPro Action Filtering

## Status

Parked as an issue record. This is not a current CodexPro mainline task.

The current implementation is usable and keeps the existing direct MCP tools. Revisit only if schema discovery noise again becomes a meaningful source of context growth or tool-selection errors.

## Background

ChatGPT can load CodexPro tool schemas on demand. In practice, schema lookup may behave like broad text search over tool names, descriptions, and parameter help text rather than exact lookup by tool name.

This created a fan-out problem. A lookup for one tool could load many unrelated schemas because their descriptions happened to mention the same tool name.

A concrete example was the common `workspace_id` parameter description:

```text
Workspace id from open_workspace. Omit to use the workspace selected for this MCP session.
```

Because this text appeared on many tools, querying `open_workspace` could return roughly fifteen schemas instead of the one or two relevant workspace actions.

Similar cross-references existed for `read`, `show_changes`, `bash`, `edit`, and other common tools.

## Observed Behavior

During one real ChatGPT coding session, schema discovery produced results such as:

```text
open_workspace -> about 15 tools
read           -> about 8 tools
show_changes   -> about 7 tools
```

This is undesirable mainly because the extra schemas consume conversation context and make action selection less precise.

The important distinction is that this is a tool-discovery problem, not a CodexPro permission or execution problem.

## Descriptor Cleanup

The first mitigation was to make direct tool descriptors self-describing instead of cross-referencing other tools.

For example, this:

```text
Workspace id from open_workspace...
```

became:

```text
Optional workspace id. Omit to use the workspace selected for this MCP session.
```

Likewise, tool descriptions no longer explain workflows by naming several other tools. Workflow guidance remains in the server instructions, where it does not participate in schema lookup.

Static inspection after cleanup showed no remaining `description:` cross-reference for the high-frequency terms:

```text
open_workspace : 0
read           : 0
show_changes   : 0
```

## Runtime Filter

CodexPro also gained a structured action catalog behind the existing `codexpro` dispatcher.

The dispatcher supports:

```text
codexpro(action="find_actions", args={query:"read"})
```

The catalog stores small lookup metadata per action:

```text
name
family
aliases
intents
cost
```

The lookup is field-ranked rather than full-text matching over complete tool schemas.

Current match precedence is:

```text
exact name
> exact alias
> name prefix
> name token
> alias prefix
> token / intent relevance
```

An exact tool name therefore cannot be outranked by accumulated token relevance from another action.

Example runtime results:

```text
query=open_workspace
  open_workspace          exact_name
  open_current_workspace  token
  workspace_snapshot      token
  inspect_workspace       token

query=read
  read                    exact_name
  read_handoff            name_prefix

query=show_changes
  show_changes            exact_name
  git_diff                token
```

## Source of Truth

The action catalog is deliberately not a second tool registry.

The real available-tool set remains:

```text
registeredToolNames(server)
```

`find_actions` only searches actions that are already registered in the current mode.

Therefore:

- tool mode still decides which tools exist;
- write/bash/analysis settings still decide which tools are exposed;
- existing handlers still perform argument validation and permission checks;
- missing catalog metadata only degrades an action to generic metadata; it does not expose or hide the action.

This separation should remain if the filter is modified later.

## ChatGPT Schema Cache

One practical complication was observed after restarting CodexPro.

The restarted runtime accepted the new `find_actions` action, proving that the new server code was active, while the same ChatGPT conversation still returned old direct-tool descriptions during schema discovery.

This indicates that direct MCP tool schemas can remain cached at the ChatGPT conversation/connector layer across a local server restart.

Therefore, descriptor fan-out should not be evaluated from a conversation that already loaded the previous schemas.

A proper future check should use a fresh ChatGPT conversation or otherwise force fresh connector schema discovery.

## Verification Performed

The implementation was checked with:

```text
npm run build                  PASS
node scripts/smoke.mjs         PASS
tool-catalog targeted smoke    PASS
```

The catalog smoke is intentionally a trace of key properties, not the specification of the entire result set. It checks properties such as exact-name precedence, alias resolution, and family isolation without freezing every returned action.

## Related Defensive-Programming Finding

The same session exposed an unrelated but useful boundary issue in `edit` secret detection.

Previously, `edit` scanned the complete post-edit file for secret-looking content. A file that already contained a historical secret-like test fixture could therefore block an unrelated edit.

The guard was changed to compare secret matches before and after the edit and reject only newly introduced or increased matches.

This follows the same general principle as the action filter: operate on the relevant delta instead of repeatedly re-evaluating unrelated existing state.

## Revisit Conditions

Do not continue this work merely to reduce tool counts or make smoke output prettier.

Revisit if one of these becomes observable again:

- fresh ChatGPT conversations still load many unrelated schemas for exact action queries;
- tool discovery materially increases context/KV-cache usage;
- the model repeatedly chooses the wrong action because of discovery ambiguity;
- the direct-tool surface grows enough that dispatcher-first lookup becomes clearly cheaper;
- a host-side MCP discovery API exposes better structured filtering that CodexPro can use directly.

Until then, keep the current direct tools for compatibility and treat `find_actions` as an optional low-context lookup path rather than a new mandatory execution architecture.

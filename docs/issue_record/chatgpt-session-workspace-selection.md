# Persisting Conversation-Scoped State Across Short-Lived ChatGPT MCP Transports

## Background

CodexPro exposes local development workspaces to ChatGPT through Streamable HTTP MCP. A workspace can be opened explicitly with `open_workspace`, after which later tools may omit `workspace_id` and operate on the currently selected workspace.

This behavior looks transport-local at first, but ChatGPT does not guarantee that adjacent tool calls in one conversation reuse the same MCP transport. In practice, ChatGPT may initialize a new short-lived MCP transport between two consecutive tool calls in the same conversation.

That distinction matters whenever an MCP server stores mutable state such as:

- the currently selected workspace;
- a repository or project selection;
- a user-selected database/schema;
- an active environment or target;
- a scoped execution context.

The transport session and the ChatGPT conversation are not the same lifecycle.

## Reproduction

The failure was reproduced with the following sequence in one ChatGPT conversation:

1. Call:

   ```text
   open_workspace("Path\\codexpro")
   ```

2. The call succeeds and returns the CodexPro repository as the selected workspace.

3. Immediately call:

   ```text
   git_status({})
   ```

   without passing `workspace_id`.

4. The second call resolves to the configured default root (`D:\`) rather than the workspace selected by the previous call.

The important observation is that no meaningful user-level session transition occurred between the two calls. The selection was lost only because ChatGPT used a different MCP transport.

## Two Incorrect State Models

### 1. Transport-local selection

A natural implementation is to construct one `WorkspaceManager` for each MCP transport and store the selected workspace inside it.

This provides strong isolation between transports, but it fails when ChatGPT replaces a transport inside the same conversation:

```text
ChatGPT conversation A
  transport T1 -> open_workspace(project-X)
  transport T2 -> git_status() -> default workspace
```

The server has no memory that `T1` and `T2` belong to the same ChatGPT conversation.

### 2. Process-global selection

The opposite workaround is to store one shared selection object for the entire HTTP server process.

This survives transport replacement, but it leaks mutable selection between unrelated ChatGPT conversations:

```text
Conversation A -> open_workspace(project-X)
Conversation B -> omitted workspace_id -> unexpectedly uses project-X
```

This is worse than simple state loss because one conversation can silently change the working context of another conversation.

A process-global workspace handle registry can still be useful. The mistake is sharing the *selected handle*, not sharing immutable/reusable workspace handles themselves.

## Correct Scope: ChatGPT Conversation

OpenAI provides conversation metadata specifically for this purpose.

For ChatGPT tool calls, the client may provide:

```text
_meta["openai/session"]
```

OpenAI documents this value as an anonymized conversation identifier for correlating tool calls within the same ChatGPT session.

This gives MCP servers a state scope between transport-local and process-global:

```text
process
  conversation A
    transport T1
    transport T2
  conversation B
    transport T3
```

Workspace selection should therefore be keyed by the ChatGPT conversation identifier rather than by the Streamable HTTP transport identifier.

Official references:

- OpenAI Plugin UI reference: `https://developers.openai.com/plugins/reference`
- OpenAI Plugin UI changelog, 2026-01-15: `https://developers.openai.com/plugins/changelog`

The reference describes `_meta["openai/session"]` as an anonymized conversation ID used to correlate tool calls within the same ChatGPT session. The changelog records its introduction for tool calls on 2026-01-15.

## Recommended State Model

Keep reusable workspace handles process-wide, but keep the mutable selection conversation-scoped.

Conceptually:

```ts
const sharedWorkspaceHandles = new Map<string, Workspace>();
const conversationSelections = new Map<string, WorkspaceSelectionState>();
```

For each tool call:

```ts
const conversationId = extra?._meta?.["openai/session"];
```

If a valid conversation ID is present, resolve the selection state from `conversationSelections`.

```ts
function selectionForConversation(conversationId: string): WorkspaceSelectionState {
  let state = conversationSelections.get(conversationId);
  if (!state) {
    state = {};
    conversationSelections.set(conversationId, state);
  }
  return state;
}
```

The effective model becomes:

```text
sharedWorkspaceHandles
  ws_A -> Path\\codexpro
  ws_B -> Path\\your_path

conversationSelections
  chat_A -> ws_A
  chat_B -> ws_B
```

This preserves all useful cross-transport workspace handles while preventing selection leakage between conversations.

## Non-ChatGPT MCP Clients

`_meta["openai/session"]` is a ChatGPT-provided extension and must not be assumed to exist for every MCP client.

The fallback should remain conservative:

1. If `_meta["openai/session"]` is available, use conversation-scoped selection.
2. Otherwise, retain transport-local selection.
3. Explicit `workspace_id` must always override implicit selection.
4. Never fall back to one process-global mutable selection.

This preserves standard MCP compatibility while using richer host metadata only when it is available.

## Important Implementation Detail

The session identifier belongs to the **tool-call metadata**, not to ordinary tool arguments.

Do not add a public `chat_session_id` argument to every CodexPro tool. Doing so would expose host lifecycle plumbing to the model and would make normal tool calls noisier and less reliable.

Instead, the MCP tool registration wrapper must preserve the handler's request context / extra parameter and make the client-provided `_meta` available to the internal tool execution layer.

A wrapper that only forwards `args` is insufficient:

```ts
async (args) => handler(args)
```

The registration path needs to retain the tool-call context as well:

```ts
async (args, extra) => handler(args, extra)
```

The exact type depends on the installed MCP SDK version, but the architectural requirement is independent of the SDK typing: do not discard client-provided tool-call metadata before workspace selection is resolved.

## Lifecycle and Cleanup

Conversation-scoped state is still server-side state and should be bounded.

Recommended safeguards:

- store only small state objects such as workspace IDs, not large repository data;
- associate each conversation selection with `lastSeenAt`;
- refresh `lastSeenAt` on each relevant tool call;
- periodically prune inactive conversation selections;
- use a reasonably long TTL because a coding conversation can remain active for hours;
- enforce a maximum number of cached conversation states as a second bound.

Workspace handles themselves can remain independently reusable and bounded according to the existing CodexPro workspace policy.

The conversation-selection TTL should not be coupled to the Streamable HTTP transport TTL. A transport can disappear while the logical ChatGPT conversation remains active.

## Regression Tests

A correct test suite should cover at least these cases.

### Same conversation, different transports

```text
conversation A / transport T1:
  open_workspace(project-X)

conversation A / transport T2:
  git_status() without workspace_id
  -> project-X
```

Expected: selection persists.

### Different conversations

```text
conversation A:
  open_workspace(project-X)

conversation B:
  git_status() without workspace_id
  -> default workspace, not project-X
```

Expected: selections are isolated.

### Explicit shared workspace handle

```text
conversation A:
  open_workspace(project-X) -> workspace_id X

conversation B:
  workspace_snapshot(workspace_id = X)
```

Expected: explicit access succeeds when the root is allowed, because workspace handles may be shared even though implicit selection is not.

### Client without OpenAI session metadata

Use a normal MCP client that does not send `_meta["openai/session"]`.

Expected: behavior remains transport-local and does not create process-global implicit state.

## Relation to Retrieval Policy

This problem is orthogonal to repository retrieval strategy.

CodexPro's progressive retrieval behavior should remain unchanged:

- do not eagerly scan the whole repository;
- do not automatically load unrelated prior files;
- prefer shallow tree inspection and targeted search;
- read only the files needed for the current decision;
- keep structured and transcript output bounded.

Conversation-scoped workspace persistence should only determine **which workspace a tool acts on**. It should not cause more repository content to be loaded or emitted.

## Summary

The key design rule is:

> Persistent application state should follow the logical host session that owns it, not the lifetime of an individual MCP transport.

For ChatGPT-hosted MCP tools, `_meta["openai/session"]` provides the appropriate correlation key for conversation-scoped state. Reusable resources such as workspace handles may be shared process-wide, while mutable implicit selections should remain isolated per conversation.

# Kin

A local-first AI code editor built on Code-OSS. Chat, Tab autocomplete, codebase Q&A and Agent mode all run on local models served by [Ollama](https://ollama.com). No API keys.

Kin is a fork of [microsoft/vscode](https://github.com/microsoft/vscode). The editor core is untouched: there are no changes under `src/`. Kin's changes are a rebrand in `product.json`, two small build edits and one built-in extension, [`extensions/kin-ai`](extensions/kin-ai). The extension plugs into VS Code's language-model provider, chat participant and inline-completion APIs.

## What it does

| Feature | How it works | Code |
|---|---|---|
| **Local chat models** | A `LanguageModelChatProvider` (vendor `kin`) lists your installed Ollama models in the chat model picker and streams replies from `/api/chat`. It sets each model's tool-calling and vision flags from the capabilities Ollama lists for it, so tool-capable models qualify for Agent mode. | `extensions/kin-ai/src/extension.ts` |
| **Tab autocomplete** | An `InlineCompletionItemProvider` sends up to 4,000 characters before the cursor and 1,500 after it to Ollama's fill-in-the-middle API (`/api/generate`, default `qwen2.5-coder:1.5b-base`, temperature 0). A debounce (150 ms by default) with cancellation drops stale requests. Output is cut at the first blank line so base models stay on the local edit. | `extensions/kin-ai/src/extension.ts` |
| **`@kin` codebase chat** | A local semantic index built in four steps: a workspace scan, SHA-1 content-hash change detection, 60-line chunks with a 10-line overlap, and embeddings from `nomic-embed-text`. The index is saved as JSON in extension storage. Saving a file that is already indexed re-embeds that file. For each question, the extension pulls the top 8 chunks by cosine similarity, shows them as file and line references, and streams an answer from a local model. That model is told to use only those excerpts and to cite paths and line numbers. | `extensions/kin-ai/src/indexer.ts`, `extensions/kin-ai/src/participant.ts` |
| **Agent mode** | Converts VS Code tool definitions to Ollama function calling and emits tool-call parts for streamed `tool_calls`. It maps tool calls and their results back into Ollama messages, so the built-in agent can run tools on local models. `num_ctx` is set explicitly (`kin.ollama.contextLength`) because otherwise Ollama truncates large agent prompts at its ~4k default. | `extensions/kin-ai/src/extension.ts` |
| **Rebrand** | Changes the product name, data folders (`.kin`) and macOS bundle id (`dev.kin.editor`). It replaces the Windows installer GUIDs with new ones, sets the `kin://` URL protocol, and uses Open VSX as the extension marketplace. The build's hygiene check now rejects any extension gallery other than Open VSX. | `product.json`, `build/hygiene.ts` |

## How it works

```
Kin (Code-OSS fork, no changes under src/)
├── product.json                   identity, kin:// protocol, Open VSX gallery
├── build/hygiene.ts               rejects any non-Open-VSX gallery
├── build/gulpfile.extensions.ts   compiles kin-ai with the other built-ins
└── extensions/kin-ai/             all AI logic
    ├── src/extension.ts           chat provider, Tab completions, tool-call mapping
    ├── src/indexer.ts             local semantic index
    └── src/participant.ts         @kin chat participant
                 │
                 ▼  HTTP to kin.ollama.baseUrl (default http://localhost:11434)
        Ollama: /api/tags  /api/chat  /api/generate  /api/embed
```

**Why extension-first:** editing the workbench core makes every upstream merge painful. In Kin, the fork is only packaging and the extension is the product. The research and phase plan written before the build are in [`AI_IDE_PLAN.md`](AI_IDE_PLAN.md).

kin-ai sends requests only to the configured Ollama URL, which is localhost by default. The rest of the editor's network behavior is unchanged from upstream Code-OSS.

## Run it

You need the Node version in `.nvmrc`, the native toolchain from VS Code's [build prerequisites](https://github.com/microsoft/vscode/wiki/How-to-Contribute), and [Ollama](https://ollama.com).

```bash
# Models used by the default settings
ollama pull llama3.2:3b               # @kin answers
ollama pull qwen2.5-coder:1.5b-base   # Tab completions
ollama pull nomic-embed-text          # codebase index

# A tool-capable model for Agent mode (the one Agent mode was tested with)
ollama pull qwen3:8b

npm install
npm run watch        # builds the workbench and built-in extensions, including kin-ai
./scripts/code.sh    # in a second terminal: launch Kin (Windows: scripts\code.bat)
```

Then:
- pick an Ollama model in the chat model picker
- run **Kin: Index Workspace** from the Command Palette before asking `@kin`

## Settings

| Setting | Default |
|---|---|
| `kin.ollama.baseUrl` | `http://localhost:11434` |
| `kin.ollama.contextLength` / `kin.ollama.maxOutputTokens` | `8192` / `4096` |
| `kin.completions.enabled` / `.model` / `.maxTokens` / `.debounceMs` | `true` / `qwen2.5-coder:1.5b-base` / `96` / `150` |
| `kin.codebase.embeddingModel` / `.chatModel` / `.maxFiles` | `nomic-embed-text` / `llama3.2:3b` / `1500` |

## Status

Kin is a prototype. It was built June 10–12, 2026 as five phased PRs ([#1](https://github.com/Nanda-Kiran/Kin/pull/1) rebrand, [#2](https://github.com/Nanda-Kiran/Kin/pull/2) chat, [#3](https://github.com/Nanda-Kiran/Kin/pull/3) Tab, [#4](https://github.com/Nanda-Kiran/Kin/pull/4) context engine, [#5](https://github.com/Nanda-Kiran/Kin/pull/5) agent), pair-programmed with Claude. Phases 1 to 4 were each checked by hand, as recorded in their PRs:
- chat on `llama3.2:3b`
- ghost text accepted with Tab
- `@kin` citing the correct files on a real project
- an agent on `qwen3:8b` creating a file through tool calls

Known limits:
- Long multi-turn agent sessions use up the context window of small local models.
- Retrieval is a brute-force cosine search over an in-memory index saved as one JSON file. Chunks are fixed 60-line windows. Indexing covers common source-file types and Markdown, up to 1,500 files by default, and skips files over 200 KB.
- Saving a file re-embeds it only if it is already indexed. New and deleted files are picked up when **Kin: Index Workspace** runs again.
- `@kin` is single-turn and resolves paths against the first workspace folder.
- The upstream GitHub Copilot Chat extension (`extensions/copilot`) and its `defaultChatAgent` settings in `product.json` are still in the tree, unchanged.
- kin-ai has no automated tests yet. The app icons are still Code-OSS's, and there are no packaged builds.

Later steps in `AI_IDE_PLAN.md`, not built: a model gateway for hosted models, tree-sitter chunking and reranking, a fast-apply edit model, and a shadow workspace for agent self-correction.

## License

MIT, inherited from Code-OSS ([LICENSE.txt](LICENSE.txt)). Kin is an independent project and is not affiliated with Microsoft.

---

Built by Nanda Kiran Velaga. I'm now building [Requal](https://requal.ai): automated eval infra for critical AI systems, from building golden datasets to gating releases.

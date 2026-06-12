/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { KinIndexer } from './indexer.js';
import { registerKinParticipant } from './participant.js';

interface IOllamaModel {
	readonly name: string;
	readonly digest?: string;
	readonly capabilities?: readonly string[];
}

interface IOllamaTagsResponse {
	readonly models?: readonly IOllamaModel[];
}

interface IOllamaToolCall {
	readonly id?: string;
	readonly function: {
		readonly name: string;
		readonly arguments?: object;
	};
}

interface IOllamaChatChunk {
	readonly message?: {
		readonly content?: string;
		readonly tool_calls?: readonly IOllamaToolCall[];
	};
	readonly done?: boolean;
	readonly error?: string;
}

interface IOllamaChatMessage {
	role: string;
	content: string;
	tool_calls?: { function: { name: string; arguments: object } }[];
	tool_name?: string;
}

interface IOllamaGenerateResponse {
	readonly response?: string;
	readonly error?: string;
}

interface IKinConfig {
	readonly baseUrl: string;
	readonly contextLength: number;
	readonly maxOutputTokens: number;
}

interface IKinCompletionsConfig {
	readonly enabled: boolean;
	readonly model: string;
	readonly maxTokens: number;
	readonly debounceMs: number;
}

function getConfig(): IKinConfig {
	const cfg = vscode.workspace.getConfiguration('kin.ollama');
	return {
		baseUrl: (cfg.get<string>('baseUrl') || 'http://localhost:11434').replace(/\/+$/, ''),
		contextLength: cfg.get<number>('contextLength') || 8192,
		maxOutputTokens: cfg.get<number>('maxOutputTokens') || 4096,
	};
}

function getCompletionsConfig(): IKinCompletionsConfig {
	const cfg = vscode.workspace.getConfiguration('kin.completions');
	return {
		enabled: cfg.get<boolean>('enabled') ?? true,
		model: cfg.get<string>('model') || 'qwen2.5-coder:1.5b-base',
		maxTokens: cfg.get<number>('maxTokens') || 96,
		debounceMs: cfg.get<number>('debounceMs') || 150,
	};
}

function toolResultText(part: vscode.LanguageModelToolResultPart): string {
	return part.content
		.map(inner => (inner instanceof vscode.LanguageModelTextPart ? inner.value : ''))
		.join('');
}

/**
 * Maps VS Code chat messages to Ollama's message shape, round-tripping tool
 * calls (assistant tool_calls) and tool results (role 'tool' messages).
 * Binary parts are not supported and are silently dropped.
 */
function toOllamaMessages(messages: readonly vscode.LanguageModelChatRequestMessage[]): IOllamaChatMessage[] {
	const result: IOllamaChatMessage[] = [];
	// Ollama identifies tool results by tool name, VS Code by callId — map them.
	const toolNameByCallId = new Map<string, string>();
	for (const message of messages) {
		const role = message.role === vscode.LanguageModelChatMessageRole.Assistant ? 'assistant' : 'user';
		let text = '';
		const toolCalls: { function: { name: string; arguments: object } }[] = [];
		const toolResults: { callId: string; content: string }[] = [];
		for (const part of message.content) {
			if (part instanceof vscode.LanguageModelTextPart) {
				text += part.value;
			} else if (part instanceof vscode.LanguageModelToolCallPart) {
				toolNameByCallId.set(part.callId, part.name);
				toolCalls.push({ function: { name: part.name, arguments: part.input } });
			} else if (part instanceof vscode.LanguageModelToolResultPart) {
				toolResults.push({ callId: part.callId, content: toolResultText(part) });
			}
		}
		if (text.length > 0 || toolCalls.length > 0) {
			const entry: IOllamaChatMessage = { role, content: text };
			if (toolCalls.length > 0) {
				entry.tool_calls = toolCalls;
			}
			result.push(entry);
		}
		for (const toolResult of toolResults) {
			result.push({
				role: 'tool',
				content: toolResult.content,
				tool_name: toolNameByCallId.get(toolResult.callId),
			});
		}
	}
	return result;
}

function abortSignalFrom(token: vscode.CancellationToken): AbortSignal {
	const controller = new AbortController();
	token.onCancellationRequested(() => controller.abort());
	return controller.signal;
}

/**
 * Language model provider backed by a local Ollama server.
 */
class KinOllamaProvider implements vscode.LanguageModelChatProvider {

	async provideLanguageModelChatInformation(_options: vscode.PrepareLanguageModelChatModelOptions, token: vscode.CancellationToken): Promise<vscode.LanguageModelChatInformation[]> {
		const { baseUrl, contextLength, maxOutputTokens } = getConfig();
		try {
			const response = await fetch(`${baseUrl}/api/tags`, { signal: abortSignalFrom(token) });
			if (!response.ok) {
				return [];
			}
			const data = await response.json() as IOllamaTagsResponse;
			return (data.models || []).map((model): vscode.LanguageModelChatInformation => ({
				id: model.name,
				name: model.name,
				family: model.name.split(':')[0],
				version: model.digest ? model.digest.slice(0, 12) : '1.0.0',
				detail: 'Ollama (local)',
				tooltip: `Local model ${model.name} served by Ollama`,
				maxInputTokens: contextLength,
				maxOutputTokens: maxOutputTokens,
				capabilities: {
					// Agent mode filters out models without tool calling, so
					// report what the Ollama model actually supports.
					toolCalling: (model.capabilities || []).includes('tools'),
					imageInput: (model.capabilities || []).includes('vision'),
				},
			}));
		} catch {
			// Ollama not running — contribute no models rather than erroring.
			return [];
		}
	}

	async provideLanguageModelChatResponse(model: vscode.LanguageModelChatInformation, messages: readonly vscode.LanguageModelChatRequestMessage[], options: vscode.ProvideLanguageModelChatResponseOptions, progress: vscode.Progress<vscode.LanguageModelResponsePart>, token: vscode.CancellationToken): Promise<void> {
		const { baseUrl, contextLength } = getConfig();
		const tools = options.tools?.map(tool => ({
			type: 'function',
			function: {
				name: tool.name,
				description: tool.description,
				parameters: tool.inputSchema ?? { type: 'object', properties: {} },
			},
		}));
		const response = await fetch(`${baseUrl}/api/chat`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				model: model.id,
				messages: toOllamaMessages(messages),
				stream: true,
				// Ollama defaults num_ctx to ~4k regardless of model limits;
				// agent prompts are large and would be silently truncated.
				options: { num_ctx: contextLength },
				...(tools && tools.length > 0 ? { tools } : {}),
			}),
			signal: abortSignalFrom(token),
		});
		if (!response.ok || !response.body) {
			const body = await response.text().catch(() => '');
			throw new Error(`Ollama request failed (${response.status}): ${body}`);
		}

		// Ollama streams JSONL: one {message:{content}, done} object per line.
		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let buffered = '';
		while (true) {
			const { done, value } = await reader.read();
			if (done || token.isCancellationRequested) {
				break;
			}
			buffered += decoder.decode(value, { stream: true });
			const lines = buffered.split('\n');
			buffered = lines.pop() ?? '';
			for (const line of lines) {
				if (!line.trim()) {
					continue;
				}
				const chunk = JSON.parse(line) as IOllamaChatChunk;
				const content = chunk.message?.content;
				if (content) {
					progress.report(new vscode.LanguageModelTextPart(content));
				}
				for (const toolCall of chunk.message?.tool_calls ?? []) {
					// Prefer Ollama's call id; older versions omit it, so mint one.
					const callId = toolCall.id ?? `kin-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
					progress.report(new vscode.LanguageModelToolCallPart(callId, toolCall.function.name, toolCall.function.arguments ?? {}));
				}
				if (chunk.error) {
					throw new Error(`Ollama: ${chunk.error}`);
				}
			}
		}
	}

	async provideTokenCount(_model: vscode.LanguageModelChatInformation, text: string | vscode.LanguageModelChatRequestMessage, _token: vscode.CancellationToken): Promise<number> {
		const value = typeof text === 'string'
			? text
			: text.content.map(part => (part instanceof vscode.LanguageModelTextPart ? part.value : '')).join('');
		// Ollama has no tokenize endpoint; ~4 chars/token is close enough for budgeting.
		return Math.ceil(value.length / 4);
	}
}

/** Characters of document text sent before/after the cursor for fill-in-the-middle. */
const FIM_PREFIX_CHARS = 4000;
const FIM_SUFFIX_CHARS = 1500;

/**
 * Ghost-text completions via Ollama's fill-in-the-middle generate API.
 * Requires a FIM-capable model (e.g. qwen2.5-coder base, codellama:code).
 */
class KinCompletionProvider implements vscode.InlineCompletionItemProvider {

	async provideInlineCompletionItems(document: vscode.TextDocument, position: vscode.Position, _context: vscode.InlineCompletionContext, token: vscode.CancellationToken): Promise<vscode.InlineCompletionItem[]> {
		const { enabled, model, maxTokens, debounceMs } = getCompletionsConfig();
		if (!enabled) {
			return [];
		}

		// Debounce: let rapid keystrokes cancel this request before it hits the model.
		await new Promise(resolve => setTimeout(resolve, debounceMs));
		if (token.isCancellationRequested) {
			return [];
		}

		const offset = document.offsetAt(position);
		const text = document.getText();
		const prefix = text.slice(Math.max(0, offset - FIM_PREFIX_CHARS), offset);
		const suffix = text.slice(offset, offset + FIM_SUFFIX_CHARS);

		const { baseUrl } = getConfig();
		try {
			const response = await fetch(`${baseUrl}/api/generate`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					model,
					prompt: prefix,
					suffix,
					stream: false,
					options: {
						num_predict: maxTokens,
						temperature: 0,
					},
				}),
				signal: abortSignalFrom(token),
			});
			if (!response.ok) {
				return [];
			}
			const data = await response.json() as IOllamaGenerateResponse;
			let completion = (data.response ?? '').replace(/\r\n/g, '\n');
			// Base models tend to ramble past the insertion point; cut at the
			// first blank line to keep ghost text scoped to the local edit.
			const blankLine = completion.indexOf('\n\n');
			if (blankLine !== -1) {
				completion = completion.slice(0, blankLine);
			}
			if (!completion.trim()) {
				return [];
			}
			return [new vscode.InlineCompletionItem(completion, new vscode.Range(position, position))];
		} catch {
			// Aborted or Ollama unavailable — offer nothing.
			return [];
		}
	}
}

export function activate(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		vscode.lm.registerLanguageModelChatProvider('kin', new KinOllamaProvider()),
		vscode.languages.registerInlineCompletionItemProvider({ pattern: '**' }, new KinCompletionProvider())
	);

	const storageUri = context.storageUri ?? context.globalStorageUri;
	const indexer = new KinIndexer(storageUri);
	registerKinParticipant(context, indexer);

	context.subscriptions.push(
		vscode.commands.registerCommand('kin.indexWorkspace', async () => {
			const result = await vscode.window.withProgress(
				{
					location: vscode.ProgressLocation.Notification,
					title: vscode.l10n.t('Kin: indexing workspace'),
					cancellable: true,
				},
				(progress, token) => indexer.indexWorkspace(progress, token)
			);
			vscode.window.showInformationMessage(
				vscode.l10n.t('Kin index updated: {0} files indexed, {1} unchanged or skipped, {2} chunks total.', result.indexedFiles, result.skippedFiles, indexer.chunkCount)
			);
		}),
		vscode.workspace.onDidSaveTextDocument(document => {
			void indexer.updateFile(document);
		})
	);
}

export function deactivate(): void { }

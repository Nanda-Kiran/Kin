/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

interface IOllamaModel {
	readonly name: string;
	readonly digest?: string;
	readonly capabilities?: readonly string[];
}

interface IOllamaTagsResponse {
	readonly models?: readonly IOllamaModel[];
}

interface IOllamaChatChunk {
	readonly message?: { readonly content?: string };
	readonly done?: boolean;
	readonly error?: string;
}

interface IKinConfig {
	readonly baseUrl: string;
	readonly contextLength: number;
	readonly maxOutputTokens: number;
}

function getConfig(): IKinConfig {
	const cfg = vscode.workspace.getConfiguration('kin.ollama');
	return {
		baseUrl: (cfg.get<string>('baseUrl') || 'http://localhost:11434').replace(/\/+$/, ''),
		contextLength: cfg.get<number>('contextLength') || 8192,
		maxOutputTokens: cfg.get<number>('maxOutputTokens') || 4096,
	};
}

/**
 * Maps VS Code chat messages to Ollama's {role, content} shape. Tool calls and
 * binary parts are not supported in v1 and are silently dropped.
 */
function toOllamaMessages(messages: readonly vscode.LanguageModelChatRequestMessage[]): { role: string; content: string }[] {
	const result: { role: string; content: string }[] = [];
	for (const message of messages) {
		const role = message.role === vscode.LanguageModelChatMessageRole.Assistant ? 'assistant' : 'user';
		let text = '';
		for (const part of message.content) {
			if (part instanceof vscode.LanguageModelTextPart) {
				text += part.value;
			} else if (part instanceof vscode.LanguageModelToolResultPart) {
				for (const inner of part.content) {
					if (inner instanceof vscode.LanguageModelTextPart) {
						text += inner.value;
					}
				}
			}
		}
		if (text.length > 0) {
			result.push({ role, content: text });
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

	async provideLanguageModelChatResponse(model: vscode.LanguageModelChatInformation, messages: readonly vscode.LanguageModelChatRequestMessage[], _options: vscode.ProvideLanguageModelChatResponseOptions, progress: vscode.Progress<vscode.LanguageModelResponsePart>, token: vscode.CancellationToken): Promise<void> {
		const { baseUrl } = getConfig();
		const response = await fetch(`${baseUrl}/api/chat`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				model: model.id,
				messages: toOllamaMessages(messages),
				stream: true,
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

export function activate(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		vscode.lm.registerLanguageModelChatProvider('kin', new KinOllamaProvider())
	);
}

export function deactivate(): void { }

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { KinIndexer } from './indexer.js';

interface IOllamaChatChunk {
	readonly message?: { readonly content?: string };
	readonly done?: boolean;
	readonly error?: string;
}

const RETRIEVAL_TOP_K = 8;

function getParticipantConfig(): { baseUrl: string; chatModel: string } {
	const ollama = vscode.workspace.getConfiguration('kin.ollama');
	const codebase = vscode.workspace.getConfiguration('kin.codebase');
	return {
		baseUrl: (ollama.get<string>('baseUrl') || 'http://localhost:11434').replace(/\/+$/, ''),
		chatModel: codebase.get<string>('chatModel') || 'llama3.2:3b',
	};
}

/**
 * Registers the `@kin` chat participant: retrieval-augmented Q&A over the
 * local codebase index, answered by a local Ollama chat model.
 */
export function registerKinParticipant(context: vscode.ExtensionContext, indexer: KinIndexer): void {
	const handler: vscode.ChatRequestHandler = async (request, _chatContext, stream, token) => {
		await indexer.load();
		if (!indexer.isReady) {
			stream.markdown(vscode.l10n.t('The codebase index is empty. Run the **Kin: Index Workspace** command first, then ask again.'));
			return {};
		}

		stream.progress(vscode.l10n.t('Searching the codebase index…'));
		const results = await indexer.search(request.prompt, RETRIEVAL_TOP_K, token);
		if (results.length === 0) {
			stream.markdown(vscode.l10n.t('No relevant code found in the index.'));
			return {};
		}

		for (const result of results) {
			const uri = vscode.Uri.joinPath(vscode.workspace.workspaceFolders![0].uri, result.file);
			stream.reference(new vscode.Location(uri, new vscode.Range(result.startLine - 1, 0, result.endLine - 1, 0)));
		}

		const contextBlocks = results
			.map(result => `File: ${result.file} (lines ${result.startLine}-${result.endLine})\n\`\`\`\n${result.text}\n\`\`\``)
			.join('\n\n');
		const messages = [
			{
				role: 'system',
				content: 'You are Kin, a coding assistant. Answer the question using ONLY the provided codebase excerpts. Cite file paths and line numbers. If the excerpts are insufficient, say so.',
			},
			{
				role: 'user',
				content: `Codebase excerpts:\n\n${contextBlocks}\n\nQuestion: ${request.prompt}`,
			},
		];

		const { baseUrl, chatModel } = getParticipantConfig();
		const controller = new AbortController();
		const cancellation = token.onCancellationRequested(() => controller.abort());
		try {
			const response = await fetch(`${baseUrl}/api/chat`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ model: chatModel, messages, stream: true }),
				signal: controller.signal,
			});
			if (!response.ok || !response.body) {
				const body = await response.text().catch(() => '');
				stream.markdown(vscode.l10n.t('Ollama request failed ({0}): {1}', response.status, body));
				return {};
			}
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
					if (chunk.message?.content) {
						stream.markdown(chunk.message.content);
					}
				}
			}
		} finally {
			cancellation.dispose();
		}
		return {};
	};

	const participant = vscode.chat.createChatParticipant('kin.codebase', handler);
	participant.iconPath = new vscode.ThemeIcon('search');
	context.subscriptions.push(participant);
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as crypto from 'crypto';
import * as vscode from 'vscode';

interface IOllamaEmbedResponse {
	readonly embeddings?: number[][];
	readonly error?: string;
}

interface IIndexedChunk {
	readonly file: string;
	readonly startLine: number;
	readonly endLine: number;
	readonly text: string;
	readonly vector: number[];
}

interface IPersistedIndex {
	readonly version: number;
	readonly embeddingModel: string;
	readonly fileHashes: Record<string, string>;
	readonly chunks: IIndexedChunk[];
}

export interface ISearchResult {
	readonly file: string;
	readonly startLine: number;
	readonly endLine: number;
	readonly text: string;
	readonly score: number;
}

const INDEX_FILE = 'codebase-index.json';
const INDEX_VERSION = 1;
const CHUNK_LINES = 60;
const CHUNK_OVERLAP = 10;
const EMBED_BATCH_SIZE = 16;
const MAX_FILE_BYTES = 200 * 1024;
const FILE_GLOB = '**/*.{ts,tsx,js,jsx,mjs,cjs,py,go,rs,java,kt,c,cc,cpp,h,hpp,cs,rb,php,swift,md}';
const EXCLUDE_GLOB = '**/{node_modules,.git,out,dist,build,.build,vendor,target,coverage}/**';

function getCodebaseConfig(): { baseUrl: string; embeddingModel: string; maxFiles: number } {
	const ollama = vscode.workspace.getConfiguration('kin.ollama');
	const codebase = vscode.workspace.getConfiguration('kin.codebase');
	return {
		baseUrl: (ollama.get<string>('baseUrl') || 'http://localhost:11434').replace(/\/+$/, ''),
		embeddingModel: codebase.get<string>('embeddingModel') || 'nomic-embed-text',
		maxFiles: codebase.get<number>('maxFiles') || 1500,
	};
}

function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
	let dot = 0;
	let normA = 0;
	let normB = 0;
	for (let i = 0; i < a.length; i++) {
		dot += a[i] * b[i];
		normA += a[i] * a[i];
		normB += b[i] * b[i];
	}
	const denominator = Math.sqrt(normA) * Math.sqrt(normB);
	return denominator === 0 ? 0 : dot / denominator;
}

function chunkLines(relativePath: string, content: string): { startLine: number; endLine: number; text: string }[] {
	const lines = content.split('\n');
	const chunks: { startLine: number; endLine: number; text: string }[] = [];
	for (let start = 0; start < lines.length; start += CHUNK_LINES - CHUNK_OVERLAP) {
		const end = Math.min(start + CHUNK_LINES, lines.length);
		const text = lines.slice(start, end).join('\n');
		if (text.trim().length > 0) {
			// Prefix with the path so the embedding captures file identity too.
			chunks.push({ startLine: start + 1, endLine: end, text: `// ${relativePath}\n${text}` });
		}
		if (end >= lines.length) {
			break;
		}
	}
	return chunks;
}

/**
 * Local semantic index over the workspace: content-hash change detection,
 * fixed-window chunking, embeddings via Ollama, brute-force cosine retrieval.
 * Persisted as JSON in the extension's workspace storage.
 */
export class KinIndexer {

	private chunks: IIndexedChunk[] = [];
	private fileHashes = new Map<string, string>();
	private loaded = false;

	constructor(private readonly storageUri: vscode.Uri) { }

	get chunkCount(): number {
		return this.chunks.length;
	}

	get isReady(): boolean {
		return this.loaded && this.chunks.length > 0;
	}

	private get indexUri(): vscode.Uri {
		return vscode.Uri.joinPath(this.storageUri, INDEX_FILE);
	}

	async load(): Promise<void> {
		if (this.loaded) {
			return;
		}
		this.loaded = true;
		const { embeddingModel } = getCodebaseConfig();
		try {
			const bytes = await vscode.workspace.fs.readFile(this.indexUri);
			const persisted = JSON.parse(new TextDecoder().decode(bytes)) as IPersistedIndex;
			if (persisted.version === INDEX_VERSION && persisted.embeddingModel === embeddingModel) {
				this.chunks = persisted.chunks;
				this.fileHashes = new Map(Object.entries(persisted.fileHashes));
			}
		} catch {
			// No persisted index yet.
		}
	}

	private async save(): Promise<void> {
		const { embeddingModel } = getCodebaseConfig();
		const persisted: IPersistedIndex = {
			version: INDEX_VERSION,
			embeddingModel,
			fileHashes: Object.fromEntries(this.fileHashes),
			chunks: this.chunks,
		};
		await vscode.workspace.fs.createDirectory(this.storageUri);
		await vscode.workspace.fs.writeFile(this.indexUri, new TextEncoder().encode(JSON.stringify(persisted)));
	}

	private async embed(inputs: readonly string[], token?: vscode.CancellationToken): Promise<number[][]> {
		const { baseUrl, embeddingModel } = getCodebaseConfig();
		const response = await fetch(`${baseUrl}/api/embed`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ model: embeddingModel, input: inputs }),
		});
		if (!response.ok) {
			const body = await response.text().catch(() => '');
			throw new Error(`Ollama embed failed (${response.status}): ${body}`);
		}
		const data = await response.json() as IOllamaEmbedResponse;
		if (data.error || !data.embeddings) {
			throw new Error(`Ollama embed failed: ${data.error ?? 'no embeddings returned'}`);
		}
		if (token?.isCancellationRequested) {
			throw new vscode.CancellationError();
		}
		return data.embeddings;
	}

	/**
	 * Index (or re-index) the whole workspace. Unchanged files (by content
	 * hash) are skipped; changed ones are re-chunked and re-embedded.
	 */
	async indexWorkspace(progress: vscode.Progress<{ message?: string; increment?: number }>, token: vscode.CancellationToken): Promise<{ indexedFiles: number; skippedFiles: number }> {
		await this.load();
		const { maxFiles } = getCodebaseConfig();
		const uris = await vscode.workspace.findFiles(FILE_GLOB, EXCLUDE_GLOB, maxFiles);

		let indexedFiles = 0;
		let skippedFiles = 0;
		const seen = new Set<string>();

		for (let i = 0; i < uris.length; i++) {
			if (token.isCancellationRequested) {
				break;
			}
			const uri = uris[i];
			const relativePath = vscode.workspace.asRelativePath(uri);
			seen.add(relativePath);

			let bytes: Uint8Array;
			try {
				bytes = await vscode.workspace.fs.readFile(uri);
			} catch {
				continue;
			}
			if (bytes.byteLength > MAX_FILE_BYTES) {
				skippedFiles++;
				continue;
			}
			const content = new TextDecoder().decode(bytes);
			const hash = crypto.createHash('sha1').update(content).digest('hex');
			if (this.fileHashes.get(relativePath) === hash) {
				skippedFiles++;
				continue;
			}

			await this.indexFileContent(relativePath, content, hash, token);
			indexedFiles++;
			if (i % 10 === 0) {
				progress.report({
					message: `${i + 1}/${uris.length} files (${this.chunks.length} chunks)`,
					increment: (10 / uris.length) * 100,
				});
			}
		}

		// Drop chunks for files that no longer exist.
		const removed = [...this.fileHashes.keys()].filter(file => !seen.has(file));
		if (removed.length > 0) {
			const removedSet = new Set(removed);
			this.chunks = this.chunks.filter(chunk => !removedSet.has(chunk.file));
			for (const file of removed) {
				this.fileHashes.delete(file);
			}
		}

		await this.save();
		return { indexedFiles, skippedFiles };
	}

	/** Re-index a single file if its content changed (e.g. on save). */
	async updateFile(document: vscode.TextDocument): Promise<void> {
		if (!this.isReady || document.uri.scheme !== 'file') {
			return;
		}
		const relativePath = vscode.workspace.asRelativePath(document.uri);
		if (!this.fileHashes.has(relativePath)) {
			return;
		}
		const content = document.getText();
		const hash = crypto.createHash('sha1').update(content).digest('hex');
		if (this.fileHashes.get(relativePath) === hash) {
			return;
		}
		try {
			await this.indexFileContent(relativePath, content, hash, undefined);
			await this.save();
		} catch {
			// Embedding unavailable — stale chunks for this file are kept.
		}
	}

	private async indexFileContent(relativePath: string, content: string, hash: string, token: vscode.CancellationToken | undefined): Promise<void> {
		const fileChunks = chunkLines(relativePath, content);
		const vectors: number[][] = [];
		for (let i = 0; i < fileChunks.length; i += EMBED_BATCH_SIZE) {
			const batch = fileChunks.slice(i, i + EMBED_BATCH_SIZE);
			vectors.push(...await this.embed(batch.map(chunk => chunk.text), token));
		}
		this.chunks = this.chunks.filter(chunk => chunk.file !== relativePath);
		for (let i = 0; i < fileChunks.length; i++) {
			this.chunks.push({
				file: relativePath,
				startLine: fileChunks[i].startLine,
				endLine: fileChunks[i].endLine,
				text: fileChunks[i].text,
				vector: vectors[i],
			});
		}
		this.fileHashes.set(relativePath, hash);
	}

	/** Embed the query and return the top-k chunks by cosine similarity. */
	async search(query: string, k: number, token?: vscode.CancellationToken): Promise<ISearchResult[]> {
		await this.load();
		if (this.chunks.length === 0) {
			return [];
		}
		const [queryVector] = await this.embed([query], token);
		return this.chunks
			.map(chunk => ({
				file: chunk.file,
				startLine: chunk.startLine,
				endLine: chunk.endLine,
				text: chunk.text,
				score: cosineSimilarity(queryVector, chunk.vector),
			}))
			.sort((a, b) => b.score - a.score)
			.slice(0, k);
	}
}

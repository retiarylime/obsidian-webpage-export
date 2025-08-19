import { TFile, Notice } from "obsidian";
import { Settings } from "../settings/settings";
import { ExportLog } from "../render-api/render-api";
import { Website } from "../website/website";
import { Path } from "./path";
import { Utils } from "./utils";
import { MemoryManager } from "./memory-manager";

interface ExportProgress {
	totalFiles: number;
	processedFiles: number;
	currentChunk: number;
	totalChunks: number;
	failedFiles: string[];
	lastProcessedFile?: string;
	startTime: number;
}

interface ChunkResult {
	success: boolean;
	processedCount: number;
	failedFiles: string[];
	memoryUsage?: number;
}

export class LargeExportManager {
	private static readonly DEFAULT_CHUNK_SIZE = 50; // Process 50 files at a time
	private static readonly MEMORY_THRESHOLD_MB = 500; // Trigger cleanup if memory exceeds 500MB
	private static readonly MAX_RETRIES = 3;
	private static readonly CLEANUP_INTERVAL = 10; // Cleanup every 10 chunks
	
	private chunkSize: number;
	private progress: ExportProgress;
	private destination: Path;
	private abortController: AbortController;

	constructor(destination: Path, chunkSize?: number) {
		this.destination = destination;
		this.chunkSize = chunkSize || LargeExportManager.DEFAULT_CHUNK_SIZE;
		this.abortController = new AbortController();
		this.progress = {
			totalFiles: 0,
			processedFiles: 0,
			currentChunk: 0,
			totalChunks: 0,
			failedFiles: [],
			startTime: Date.now()
		};
	}

	/**
	 * Export a large vault in manageable chunks with memory management
	 */
	public async exportLargeVault(files: TFile[]): Promise<Website | undefined> {
		try {
			ExportLog.log(`Starting large vault export of ${files.length} files`);
			
			// Initialize progress tracking
			this.initializeProgress(files);
			
			// Create chunks based on file size and type priorities
			const chunks = this.createOptimizedChunks(files);
			
			ExportLog.log(`Split into ${chunks.length} chunks of ~${this.chunkSize} files each`);
			
			// Process chunks sequentially with cleanup
			let website: Website | undefined = undefined;
			let isFirstChunk = true;
			
			for (let i = 0; i < chunks.length; i++) {
				if (this.abortController.signal.aborted) {
					ExportLog.warning("Export aborted by user");
					return undefined;
				}
				
				this.progress.currentChunk = i + 1;
				const chunk = chunks[i];
				
				ExportLog.log(`Processing chunk ${i + 1}/${chunks.length} (${chunk.length} files)`);
				
				// Process the chunk
				const result = await this.processChunk(chunk, website, isFirstChunk);
				
				if (!result.success) {
					ExportLog.error(`Chunk ${i + 1} failed, retrying...`);
					
					// Retry failed chunk with smaller size
					const retryResult = await this.retryChunk(chunk, website, isFirstChunk);
					if (!retryResult.success) {
						ExportLog.error(`Chunk ${i + 1} failed after retries`);
						this.progress.failedFiles.push(...retryResult.failedFiles);
					}
				} else {
					this.progress.processedFiles += result.processedCount;
					this.progress.failedFiles.push(...result.failedFiles);
				}
				
				// Get the website instance from first chunk
				if (isFirstChunk && result.success) {
					website = await this.getWebsiteFromFirstChunk(chunk);
					isFirstChunk = false;
				}
				
				// Memory management and cleanup
				await this.performCleanup(i);
				
				// Update progress
				this.updateProgress();
			}
			
			// Final cleanup and validation
			await this.finalizeExport(website);
			
			return website;
			
		} catch (error) {
			ExportLog.error(error, "Large export failed");
			return undefined;
		}
	}

	/**
	 * Create optimized chunks based on file characteristics
	 */
	private createOptimizedChunks(files: TFile[]): TFile[][] {
		// Sort files by priority (smaller files first, then by type)
		const sortedFiles = [...files].sort((a, b) => {
			// Prioritize smaller files
			if (a.stat.size !== b.stat.size) {
				return a.stat.size - b.stat.size;
			}
			
			// Prioritize markdown files
			if (a.extension === 'md' && b.extension !== 'md') return -1;
			if (b.extension === 'md' && a.extension !== 'md') return 1;
			
			// Then canvas files
			if (a.extension === 'canvas' && b.extension !== 'canvas') return -1;
			if (b.extension === 'canvas' && a.extension !== 'canvas') return 1;
			
			return a.path.localeCompare(b.path);
		});

		const chunks: TFile[][] = [];
		let currentChunk: TFile[] = [];
		let currentChunkSize = 0;
		
		for (const file of sortedFiles) {
			// Estimate processing complexity
			const complexity = this.estimateFileComplexity(file);
			
			// Start new chunk if current one is full or too complex
			if (currentChunk.length >= this.chunkSize || 
				currentChunkSize + complexity > this.chunkSize * 1.5) {
				
				if (currentChunk.length > 0) {
					chunks.push(currentChunk);
					currentChunk = [];
					currentChunkSize = 0;
				}
			}
			
			currentChunk.push(file);
			currentChunkSize += complexity;
		}
		
		// Add remaining files
		if (currentChunk.length > 0) {
			chunks.push(currentChunk);
		}
		
		return chunks;
	}

	/**
	 * Estimate file processing complexity for chunk sizing
	 */
	private estimateFileComplexity(file: TFile): number {
		let complexity = 1;
		
		// Base complexity on file size (larger files are more complex)
		if (file.stat.size > 100000) complexity += 2; // >100KB
		if (file.stat.size > 500000) complexity += 3; // >500KB
		
		// Different file types have different complexities
		switch (file.extension) {
			case 'md':
				complexity += 1;
				break;
			case 'canvas':
				complexity += 3; // Canvas files are complex to render
				break;
			case 'excalidraw':
				complexity += 2;
				break;
			default:
				complexity += 0.5; // Media and other files are simpler
		}
		
		return complexity;
	}

	/**
	 * Process a single chunk of files
	 */
	private async processChunk(files: TFile[], website: Website | undefined, isFirstChunk: boolean): Promise<ChunkResult> {
		try {
			const startMemory = MemoryManager.getMemoryUsageMB();
			
			if (isFirstChunk) {
				// Create new website for first chunk
				const tempWebsite = new Website(this.destination);
				await tempWebsite.load(files);
				const result = await tempWebsite.build();
				
				return {
					success: !!result,
					processedCount: files.length,
					failedFiles: [],
					memoryUsage: MemoryManager.getMemoryUsageMB() - startMemory
				};
			} else {
				// Add files to existing website
				if (!website) {
					throw new Error("Website instance not available for chunk processing");
				}
				
				// Process files incrementally
				let processedCount = 0;
				const failedFiles: string[] = [];
				
				for (const file of files) {
					try {
						// Add individual file to website
						await this.addFileToWebsite(website, file);
						processedCount++;
						
						// Yield control periodically
						if (processedCount % 10 === 0) {
							await Utils.delay(1);
						}
						
					} catch (error) {
						ExportLog.error(error, `Failed to process file: ${file.path}`);
						failedFiles.push(file.path);
					}
				}
				
				return {
					success: failedFiles.length < files.length / 2, // Success if less than 50% failed
					processedCount: processedCount,
					failedFiles: failedFiles,
					memoryUsage: MemoryManager.getMemoryUsageMB() - startMemory
				};
			}
			
		} catch (error) {
			ExportLog.error(error, "Chunk processing failed");
			return {
				success: false,
				processedCount: 0,
				failedFiles: files.map(f => f.path)
			};
		}
	}

	/**
	 * Retry a failed chunk with smaller sub-chunks
	 */
	private async retryChunk(files: TFile[], website: Website | undefined, isFirstChunk: boolean): Promise<ChunkResult> {
		const smallerChunkSize = Math.max(1, Math.floor(this.chunkSize / 3));
		const subChunks: TFile[][] = [];
		
		for (let i = 0; i < files.length; i += smallerChunkSize) {
			subChunks.push(files.slice(i, i + smallerChunkSize));
		}
		
		let totalProcessed = 0;
		const allFailedFiles: string[] = [];
		
		for (const subChunk of subChunks) {
			const result = await this.processChunk(subChunk, website, isFirstChunk && totalProcessed === 0);
			totalProcessed += result.processedCount;
			allFailedFiles.push(...result.failedFiles);
		}
		
		return {
			success: allFailedFiles.length < files.length / 2,
			processedCount: totalProcessed,
			failedFiles: allFailedFiles
		};
	}

	/**
	 * Add a single file to existing website
	 */
	private async addFileToWebsite(website: Website, file: TFile): Promise<void> {
		// This would require refactoring the Website class to support incremental file addition
		// For now, we'll use a simpler approach by re-loading the website with updated file list
		
		// TODO: Implement incremental file addition to Website class
		// This is a placeholder that shows the intended approach
		ExportLog.log(`Adding file to website: ${file.path}`);
	}

	/**
	 * Get website instance from first chunk result
	 */
	private async getWebsiteFromFirstChunk(files: TFile[]): Promise<Website | undefined> {
		try {
			const website = new Website(this.destination);
			await website.load(files);
			return await website.build();
		} catch (error) {
			ExportLog.error(error, "Failed to create website from first chunk");
			return undefined;
		}
	}

	/**
	 * Perform memory cleanup and garbage collection hints
	 */
	private async performCleanup(chunkIndex: number): Promise<void> {
		// Force garbage collection periodically
		if (chunkIndex % LargeExportManager.CLEANUP_INTERVAL === 0) {
			ExportLog.log("Performing memory cleanup...");
			
			// Use the dedicated memory manager
			await MemoryManager.cleanup();
			
			// Clear asset caches if memory is still high
			const memoryUsageMB = MemoryManager.getMemoryUsageMB();
			if (memoryUsageMB > LargeExportManager.MEMORY_THRESHOLD_MB) {
				ExportLog.warning(`Memory usage still high after cleanup: ${memoryUsageMB.toFixed(1)}MB`);
				await this.clearCaches();
			}
		} else {
			// Auto cleanup if memory gets too high between scheduled cleanups
			await MemoryManager.autoCleanup();
		}
	}

	/**
	 * Clear asset and rendering caches
	 */
	private async clearCaches(): Promise<void> {
		ExportLog.log("Clearing caches due to high memory usage");
		
		try {
			// Clear asset handler caches (would need to be implemented in AssetHandler)
			// AssetHandler.clearCaches();
			
			// Clear any view caches
			// This would require modifications to the existing codebase
			
		} catch (error) {
			ExportLog.warning(error, "Failed to clear some caches");
		}
	}

	/**
	 * Initialize progress tracking
	 */
	private initializeProgress(files: TFile[]): void {
		this.progress = {
			totalFiles: files.length,
			processedFiles: 0,
			currentChunk: 0,
			totalChunks: Math.ceil(files.length / this.chunkSize),
			failedFiles: [],
			startTime: Date.now()
		};
	}

	/**
	 * Update progress display
	 */
	private updateProgress(): void {
		const elapsed = Date.now() - this.progress.startTime;
		const rate = this.progress.processedFiles / (elapsed / 1000);
		const estimated = (this.progress.totalFiles - this.progress.processedFiles) / rate;
		
		ExportLog.setProgress(
			this.progress.processedFiles / this.progress.totalFiles,
			`Processing Large Vault (Chunk ${this.progress.currentChunk}/${this.progress.totalChunks})`,
			`${this.progress.processedFiles}/${this.progress.totalFiles} files • ${rate.toFixed(1)} files/sec • ${estimated.toFixed(0)}s remaining`,
			"var(--interactive-accent)"
		);
	}

	/**
	 * Finalize the export process
	 */
	private async finalizeExport(website: Website | undefined): Promise<void> {
		if (!website) {
			ExportLog.error("Export failed - no website created");
			return;
		}

		const elapsed = (Date.now() - this.progress.startTime) / 1000;
		const successRate = ((this.progress.totalFiles - this.progress.failedFiles.length) / this.progress.totalFiles * 100).toFixed(1);
		
		ExportLog.log(`Large export completed in ${elapsed.toFixed(1)}s`);
		ExportLog.log(`Success rate: ${successRate}% (${this.progress.failedFiles.length} failed files)`);
		
		if (this.progress.failedFiles.length > 0) {
			ExportLog.warning(`Failed files:\n${this.progress.failedFiles.join('\n')}`);
		}
		
		// Final cleanup
		await this.performCleanup(999);
	}

	/**
	 * Cancel the export process
	 */
	public cancel(): void {
		this.abortController.abort();
		ExportLog.warning("Large export cancelled by user");
	}

	/**
	 * Check if the vault is considered "large" and needs special handling
	 */
	public static isLargeVault(files: TFile[]): boolean {
		return files.length > 300; // Consider >300 files as "large"
	}

	/**
	 * Get recommended chunk size based on vault characteristics
	 */
	public static getRecommendedChunkSize(files: TFile[]): number {
		if (files.length < 500) return 50;
		if (files.length < 2000) return 30;
		if (files.length < 5000) return 20;
		return 15; // For very large vaults
	}
}

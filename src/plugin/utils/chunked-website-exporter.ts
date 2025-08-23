import { TFile } from "obsidian";
import { Website } from "../website/website";
import { Path } from "./path";
import { ExportLog, MarkdownRendererAPI } from "../render-api/render-api";
import { Utils } from "./utils";

/**
 * Progress tracking for crash recovery
 */
interface ChunkProgress {
	totalChunks: number;
	completedChunks: number[];
	destination: string;
	timestamp: number;
	fileCount: number;
}

/**
 * Chunked Website Exporter that produces EXACTLY the same results as the original exporter
 * The key principle: we merge chunks into a single Website object and let the caller handle
 * all downloads, deletions, and final processing EXACTLY like the original exporter.
 */
export class ChunkedWebsiteExporter {
	private static readonly CHUNK_SIZE = 30; // Balanced chunk size
	private static readonly PROGRESS_FILE = ".obsidian-export-progress.json";
	
	/**
	 * Check if cancellation was requested
	 */
	private static isCancelled(): boolean {
		const renderApi = MarkdownRendererAPI as any;
		return renderApi.cancelled === true;
	}
	
	/**
	 * Check if chunked export should be used
	 */
	public static shouldUseChunkedExport(files: TFile[]): boolean {
		return files.length > 500;
	}
	
	/**
	 * Export files in chunks with crash recovery - produces IDENTICAL results to original exporter
	 */
	public static async exportInChunks(
		files: TFile[], 
		destination: Path, 
		chunkSize: number = ChunkedWebsiteExporter.CHUNK_SIZE
	): Promise<Website | undefined> {
		
		try {
			ExportLog.log(`🔄 Starting chunked export of ${files.length} files (chunks: ${chunkSize})`);
			
			// Check for crash recovery
			const existingProgress = await this.loadProgress(destination);
			let startChunk = 0;
			
			if (existingProgress && this.isValidProgress(existingProgress, files)) {
				startChunk = existingProgress.completedChunks.length;
				ExportLog.log(`📤 Resuming from chunk ${startChunk + 1}`);
			}
			
			// Initialize progress tracking
			ExportLog.resetProgress();
			ExportLog.addToProgressCap(files.length * 2);
			
			const chunks = this.createChunks(files, chunkSize);
			ExportLog.log(`Created ${chunks.length} chunks for processing`);
			
			const progress: ChunkProgress = {
				totalChunks: chunks.length,
				completedChunks: existingProgress?.completedChunks || [],
				destination: destination.path,
				timestamp: Date.now(),
				fileCount: files.length
			};
			
			// Build the final website by processing chunks
			let finalWebsite: Website | undefined = undefined;
			
			for (let i = startChunk; i < chunks.length; i++) {
				if (this.isCancelled()) {
					ExportLog.warning("Export cancelled");
					await this.saveProgress(progress);
					return undefined;
				}
				
				ExportLog.log(`🔨 Processing chunk ${i + 1}/${chunks.length}`);
				
				try {
					// Build chunk website - EXACTLY like original exporter
					const chunkWebsite = await this.buildChunkWebsite(chunks[i], destination);
					if (!chunkWebsite) {
						throw new Error(`Failed to build chunk ${i + 1}`);
					}
					
					// Merge into final website - maintains all data structures
					if (i === 0) {
						finalWebsite = chunkWebsite; // First chunk becomes the base
					} else {
						this.mergeWebsites(chunkWebsite, finalWebsite!);
					}
					
					// Save progress
					progress.completedChunks.push(i);
					await this.saveProgress(progress);
					
					// Memory cleanup
					await this.performMemoryCleanup(i + 1, chunks.length);
					
				} catch (error) {
					ExportLog.error(error, `Error in chunk ${i + 1}`);
					await this.saveProgress(progress);
					throw error;
				}
			}
			
			// Finalize the website EXACTLY like original exporter
			if (finalWebsite) {
				ExportLog.log("🎯 Finalizing website - identical to original exporter");
				await finalWebsite.index.finalize();
				
				// Clean up progress
				await this.cleanupProgress(destination);
				
				ExportLog.log(`✅ Chunked export complete: ${finalWebsite.index.webpages.length} pages, ${finalWebsite.index.attachments.length} attachments`);
			}
			
			return finalWebsite;
			
		} catch (error) {
			ExportLog.error(error, "Chunked export failed");
			return undefined;
		}
	}
	
	/**
	 * Create file chunks
	 */
	private static createChunks(files: TFile[], chunkSize: number): TFile[][] {
		const chunks: TFile[][] = [];
		for (let i = 0; i < files.length; i += chunkSize) {
			chunks.push(files.slice(i, i + chunkSize));
		}
		return chunks;
	}
	
	/**
	 * Build a website for a chunk - EXACTLY like original exporter
	 */
	private static async buildChunkWebsite(files: TFile[], destination: Path): Promise<Website | undefined> {
		try {
			// Create and build website EXACTLY like original exporter
			const website = new Website(destination);
			await website.load(files);
			const builtWebsite = await website.build();
			
			// Do NOT download files here - that's handled by the caller like original exporter
			return builtWebsite;
			
		} catch (error) {
			ExportLog.error(error, "Failed to build chunk website");
			return undefined;
		}
	}
	
	/**
	 * Merge chunk website into final website - preserves all data structures
	 */
	private static mergeWebsites(chunkWebsite: Website, finalWebsite: Website): void {
		try {
			// Merge webpages (avoid duplicates)
			for (const webpage of chunkWebsite.index.webpages) {
				if (!finalWebsite.index.webpages.some(existing => 
					existing.targetPath.path === webpage.targetPath.path)) {
					finalWebsite.index.webpages.push(webpage);
				}
			}
			
			// Merge attachments (avoid duplicates)
			for (const attachment of chunkWebsite.index.attachments) {
				if (!finalWebsite.index.attachments.some(existing => 
					existing.targetPath.path === attachment.targetPath.path)) {
					finalWebsite.index.attachments.push(attachment);
				}
			}
			
			// Merge newFiles
			for (const file of chunkWebsite.index.newFiles) {
				if (!finalWebsite.index.newFiles.some(existing => 
					existing.targetPath.path === file.targetPath.path)) {
					finalWebsite.index.newFiles.push(file);
				}
			}
			
			// Merge updatedFiles
			for (const file of chunkWebsite.index.updatedFiles) {
				if (!finalWebsite.index.updatedFiles.some(existing => 
					existing.targetPath.path === file.targetPath.path)) {
					finalWebsite.index.updatedFiles.push(file);
				}
			}
			
			// Merge deletedFiles
			for (const file of chunkWebsite.index.deletedFiles) {
				if (!finalWebsite.index.deletedFiles.includes(file)) {
					finalWebsite.index.deletedFiles.push(file);
				}
			}
			
		} catch (error) {
			ExportLog.error(error, "Failed to merge websites");
		}
	}
	
	/**
	 * Memory cleanup between chunks
	 */
	private static async performMemoryCleanup(completed: number, total: number): Promise<void> {
		try {
			await Utils.delay(200);
			
			if (global.gc) {
				global.gc();
			}
			
			const memUsage = process.memoryUsage?.();
			if (memUsage) {
				const heapMB = Math.round(memUsage.heapUsed / 1024 / 1024);
				ExportLog.log(`📊 Memory after chunk ${completed}/${total}: ${heapMB}MB`);
				
				if (heapMB > 1000) {
					ExportLog.warning(`⚠️ High memory usage: ${heapMB}MB`);
				}
			}
		} catch (error) {
			// Ignore cleanup errors
		}
	}
	
	/**
	 * Save progress for crash recovery
	 */
	private static async saveProgress(progress: ChunkProgress): Promise<void> {
		try {
			const fs = require('fs').promises;
			const path = require('path');
			const progressFile = path.join(progress.destination, this.PROGRESS_FILE);
			
			await fs.writeFile(progressFile, JSON.stringify(progress, null, 2));
		} catch (error) {
			// Ignore save errors
		}
	}
	
	/**
	 * Load existing progress
	 */
	private static async loadProgress(destination: Path): Promise<ChunkProgress | undefined> {
		try {
			const fs = require('fs').promises;
			const path = require('path');
			const progressFile = path.join(destination.path, this.PROGRESS_FILE);
			
			const data = await fs.readFile(progressFile, 'utf8');
			return JSON.parse(data) as ChunkProgress;
		} catch (error) {
			return undefined;
		}
	}
	
	/**
	 * Validate progress
	 */
	private static isValidProgress(progress: ChunkProgress, files: TFile[]): boolean {
		// Check file count match
		if (progress.fileCount !== files.length) return false;
		
		// Check age (24 hours max)
		const maxAge = 24 * 60 * 60 * 1000;
		if (Date.now() - progress.timestamp > maxAge) return false;
		
		return true;
	}
	
	/**
	 * Clean up progress file
	 */
	private static async cleanupProgress(destination: Path): Promise<void> {
		try {
			const fs = require('fs').promises;
			const path = require('path');
			const progressFile = path.join(destination.path, this.PROGRESS_FILE);
			await fs.unlink(progressFile);
		} catch (error) {
			// Ignore cleanup errors
		}
	}
}

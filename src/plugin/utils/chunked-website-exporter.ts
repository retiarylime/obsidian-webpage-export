import { TFile } from "obsidian";
import { Website } from "../website/website";
import { Path } from "./path";
import { ExportLog, MarkdownRendererAPI } from "../render-api/render-api";
import { Utils } from "./utils";
import { MemoryManager } from "./memory-manager";

export class ChunkedWebsiteExporter {
	private static readonly CHUNK_SIZE = 40; // Process 40 files at a time
	private static readonly CLEANUP_INTERVAL = 3; // Cleanup every 3 chunks
	
	/**
	 * Export files in chunks to prevent memory exhaustion
	 */
	public static async exportInChunks(
		files: TFile[], 
		destination: Path, 
		chunkSize: number = ChunkedWebsiteExporter.CHUNK_SIZE
	): Promise<Website | undefined> {
		
		ExportLog.log(`Starting chunked export of ${files.length} files (${chunkSize} per chunk)`);
		
		// Sort files by complexity (simpler files first)
		const sortedFiles = this.sortFilesByComplexity(files);
		
		// Create chunks
		const chunks = this.createChunks(sortedFiles, chunkSize);
		ExportLog.log(`Created ${chunks.length} chunks`);
		
		let finalWebsite: Website | undefined = undefined;
		let allAttachments: any[] = [];
		let allWebpages: any[] = [];
		
		try {
			// Process each chunk
			for (let i = 0; i < chunks.length; i++) {
				const chunk = chunks[i];
				
				ExportLog.progress(
					1 / chunks.length, 
					`Processing Chunk ${i + 1}/${chunks.length}`,
					`Files: ${chunk.map(f => f.name).join(', ').substring(0, 100)}...`,
					"var(--interactive-accent)"
				);
				
				// Check if we should cancel
				if (MarkdownRendererAPI.checkCancelled()) {
					ExportLog.warning("Export cancelled by user");
					return undefined;
				}
				
				// Process the chunk
				const chunkWebsite = await this.processChunk(chunk, destination, i);
				
				if (!chunkWebsite) {
					ExportLog.error(`Chunk ${i + 1} failed`);
					continue;
				}
				
				// Collect results from this chunk
				if (i === 0) {
					// First chunk becomes the base website
					finalWebsite = chunkWebsite;
				} else {
					// Merge subsequent chunks into the final website
					await this.mergeChunkIntoWebsite(chunkWebsite, finalWebsite);
				}
				
				// Cleanup periodically
				if (i % ChunkedWebsiteExporter.CLEANUP_INTERVAL === 0) {
					await MemoryManager.cleanup();
				}
				
				// Small delay to prevent overwhelming the system
				await Utils.delay(10);
			}
			
			// Final cleanup and build
			if (finalWebsite) {
				ExportLog.log("Finalizing website...");
				await finalWebsite.index.finalize();
			}
			
			return finalWebsite;
			
		} catch (error) {
			ExportLog.error(error, "Chunked export failed");
			return undefined;
		} finally {
			// Final cleanup
			await MemoryManager.cleanup();
		}
	}
	
	/**
	 * Sort files by processing complexity (simpler first)
	 */
	private static sortFilesByComplexity(files: TFile[]): TFile[] {
		return [...files].sort((a, b) => {
			// Prioritize by file size (smaller first)
			const sizeA = a.stat.size;
			const sizeB = b.stat.size;
			
			if (sizeA !== sizeB) {
				return sizeA - sizeB;
			}
			
			// Then by extension complexity
			const extensionPriority: Record<string, number> = {
				'md': 1,
				'txt': 1,
				'png': 2,
				'jpg': 2,
				'jpeg': 2,
				'gif': 2,
				'svg': 3,
				'pdf': 4,
				'excalidraw': 5,
				'canvas': 6
			};
			
			const priorityA = extensionPriority[a.extension] || 3;
			const priorityB = extensionPriority[b.extension] || 3;
			
			return priorityA - priorityB;
		});
	}
	
	/**
	 * Create chunks from files array
	 */
	private static createChunks<T>(array: T[], chunkSize: number): T[][] {
		const chunks: T[][] = [];
		for (let i = 0; i < array.length; i += chunkSize) {
			chunks.push(array.slice(i, i + chunkSize));
		}
		return chunks;
	}
	
	/**
	 * Process a single chunk of files
	 */
	private static async processChunk(files: TFile[], destination: Path, chunkIndex: number): Promise<Website | undefined> {
		try {
			ExportLog.log(`Processing chunk ${chunkIndex + 1} with ${files.length} files`);
			
			// Create a website for this chunk
			const website = new Website(destination);
			await website.load(files);
			
			// Build the website
			const result = await website.build(files);
			
			if (!result) {
				ExportLog.error(`Failed to build chunk ${chunkIndex + 1}`);
				return undefined;
			}
			
			ExportLog.log(`Successfully processed chunk ${chunkIndex + 1}`);
			return result;
			
		} catch (error) {
			ExportLog.error(error, `Error processing chunk ${chunkIndex + 1}`);
			return undefined;
		}
	}
	
	/**
	 * Merge a chunk website into the final website
	 */
	private static async mergeChunkIntoWebsite(chunkWebsite: Website, finalWebsite: Website | undefined): Promise<void> {
		if (!finalWebsite || !chunkWebsite) return;
		
		try {
			// Merge file indexes
			if (chunkWebsite.index && finalWebsite.index) {
				// Add new files from chunk to final website
				finalWebsite.index.newFiles.push(...chunkWebsite.index.newFiles);
				finalWebsite.index.updatedFiles.push(...chunkWebsite.index.updatedFiles);
				
				// Merge attachments
				const chunkAttachments = chunkWebsite.index.attachmentsShownInTree || [];
				const finalAttachments = finalWebsite.index.attachmentsShownInTree || [];
				finalWebsite.index.attachmentsShownInTree = [...finalAttachments, ...chunkAttachments];
				
				// Merge webpages
				const chunkWebpages = chunkWebsite.index.webpages || [];
				const finalWebpages = finalWebsite.index.webpages || [];
				finalWebsite.index.webpages = [...finalWebpages, ...chunkWebpages];
			}
			
		} catch (error) {
			ExportLog.error(error, "Error merging chunk into final website");
		}
	}
	
	/**
	 * Check if chunked export should be used based on file count
	 */
	public static shouldUseChunkedExport(files: TFile[]): boolean {
		return files.length > 200; // Use chunked export for >200 files
	}
	
	/**
	 * Get recommended chunk size based on file count
	 */
	public static getRecommendedChunkSize(fileCount: number): number {
		if (fileCount < 500) return 50;
		if (fileCount < 1000) return 40;
		if (fileCount < 3000) return 30;
		if (fileCount < 5000) return 25;
		return 20; // For very large vaults
	}
}

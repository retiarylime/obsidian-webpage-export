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

export class ChunkedWebsiteExporter {
	private static readonly CHUNK_SIZE = 20; // Reduce chunk size for memory efficiency
	private static readonly PROGRESS_FILE = ".obsidian-export-progress.json";
	
	/**
	 * Check if cancellation was requested by accessing the cancelled flag directly
	 */
	private static isCancelled(): boolean {
		// Access the cancelled flag from the MarkdownRendererAPI module
		const renderApi = MarkdownRendererAPI as any;
		return renderApi.cancelled === true;
	}
	
	/**
	 * Check if chunked export should be used based on file count
	 */
	public static shouldUseChunkedExport(files: TFile[]): boolean {
		return files.length > 500; // Use chunked export for >500 files
	}
	
	/**
	 * Export files in chunks with crash recovery support
	 * Each chunk is completely processed and saved before starting the next
	 */
	public static async exportInChunks(
		files: TFile[], 
		destination: Path, 
		chunkSize: number = ChunkedWebsiteExporter.CHUNK_SIZE
	): Promise<Website | undefined> {
		
		try {
			ExportLog.log(`Starting chunked export of ${files.length} files (${chunkSize} per chunk)`);
			ExportLog.log("🔄 Crash recovery enabled - export can be resumed if interrupted");
			
			// Check for existing progress to resume from
			const existingProgress = await this.loadProgress(destination);
			let startChunk = 0;
			
			if (existingProgress && this.isValidProgress(existingProgress, files)) {
				startChunk = existingProgress.completedChunks.length;
				ExportLog.log(`📤 Resuming export from chunk ${startChunk + 1}/${existingProgress.totalChunks}`);
			}
			
			// Initialize progress system for chunked export
			ExportLog.resetProgress();
			ExportLog.addToProgressCap(files.length * 2); // Processing + downloading
			
			// Sort files by complexity (simpler files first)
			const sortedFiles = this.sortFilesByComplexity(files);
			
			// Create chunks
			const chunks = this.createChunks(sortedFiles, chunkSize);
			ExportLog.log(`Created ${chunks.length} chunks`);
			
			// Initialize or update progress tracking
			const progress: ChunkProgress = {
				totalChunks: chunks.length,
				completedChunks: existingProgress?.completedChunks || [],
				destination: destination.path,
				timestamp: Date.now(),
				fileCount: files.length
			};
			
			// Process each chunk completely and independently
			for (let i = startChunk; i < chunks.length; i++) {
				const chunk = chunks[i];
				
				ExportLog.log(`🏗️ Processing chunk ${i + 1}/${chunks.length} with ${chunk.length} files`);
				
				// Check if we should cancel
				if (ChunkedWebsiteExporter.isCancelled()) {
					ExportLog.warning("Export cancelled by user");
					await this.saveProgress(progress);
					return undefined;
				}
				
				try {
					// Process chunk completely (build + download all files)
					const success = await this.processCompleteChunk(chunk, destination, i);
					
					if (!success) {
						ExportLog.error(`Chunk ${i + 1} failed - progress saved for retry`);
						await this.saveProgress(progress);
						return undefined;
					}
					
					// Mark chunk as completed
					progress.completedChunks.push(i);
					await this.saveProgress(progress);
					
					ExportLog.log(`✅ Chunk ${i + 1} completed and saved`);
					
					// Aggressive memory cleanup
					await this.performMemoryCleanup(i + 1, chunks.length);
					
				} catch (error) {
					ExportLog.error(error, `Critical error in chunk ${i + 1} - progress saved for resume`);
					await this.saveProgress(progress);
					throw error;
				}
			}
			
			// All chunks completed - now merge site metadata
			ExportLog.log("🔗 All chunks completed. Merging site metadata...");
			const finalWebsite = await this.createFinalSiteMetadata(destination, chunks.length);
			
			if (finalWebsite) {
				// Clean up progress file
				await this.cleanupProgress(destination);
				ExportLog.log(`🎉 Chunked export completed successfully with ${chunks.length} chunks`);
			}
			
			return finalWebsite;
			
		} catch (error) {
			ExportLog.error(error, "Chunked export failed");
			return undefined;
		}
	}
	
	/**
	 * Create chunks from files
	 */
	private static createChunks(files: TFile[], chunkSize: number): TFile[][] {
		const chunks: TFile[][] = [];
		
		for (let i = 0; i < files.length; i += chunkSize) {
			chunks.push(files.slice(i, i + chunkSize));
		}
		
		return chunks;
	}
	
	/**
	 * Sort files by complexity (simpler files first to warm up the system)
	 */
	private static sortFilesByComplexity(files: TFile[]): TFile[] {
		return files.sort((a, b) => {
			// Sort by file size (smaller first), then by name for consistency
			const sizeA = a.stat.size;
			const sizeB = b.stat.size;
			
			if (sizeA !== sizeB) {
				return sizeA - sizeB;
			}
			
			return a.name.localeCompare(b.name);
		});
	}
	
	/**
	 * Process a complete chunk - build and download all files
	 */
	private static async processCompleteChunk(
		files: TFile[], 
		destination: Path, 
		chunkIndex: number
	): Promise<boolean> {
		try {
			ExportLog.log(`Processing chunk ${chunkIndex + 1} completely`);
			
			// Create website for this chunk
			const website = new Website(destination);
			await website.load(files);
			
			// Build the website
			const builtWebsite = await website.build();
			if (!builtWebsite) {
				ExportLog.error(`Failed to build chunk ${chunkIndex + 1}`);
				return false;
			}
			
			// Download all files for this chunk
			for (const webpage of builtWebsite.index.webpages) {
				await webpage.download();
				ExportLog.progress(1, `Chunk ${chunkIndex + 1}`, `Downloaded: ${webpage.filename}`, "var(--color-green)");
			}
			
			for (const attachment of builtWebsite.index.attachments) {
				await attachment.download();
				ExportLog.progress(1, `Chunk ${chunkIndex + 1}`, `Downloaded: ${attachment.filename}`, "var(--color-blue)");
			}
			
			ExportLog.log(`✅ Chunk ${chunkIndex + 1} fully processed and downloaded`);
			return true;
			
		} catch (error) {
			ExportLog.error(error, `Failed to process chunk ${chunkIndex + 1}`);
			return false;
		}
	}
	
	/**
	 * Perform aggressive memory cleanup
	 */
	private static async performMemoryCleanup(completedChunks: number, totalChunks: number): Promise<void> {
		try {
			ExportLog.log(`🧹 Memory cleanup after chunk ${completedChunks}/${totalChunks}`);
			await Utils.delay(300); // Give time for cleanup
			
			// Force garbage collection if available
			if (global.gc) {
				global.gc();
				ExportLog.log(`♻️ Forced garbage collection`);
			}
			
			// Log memory usage for monitoring
			const memUsage = process.memoryUsage ? process.memoryUsage() : null;
			if (memUsage) {
				const heapUsedMB = Math.round(memUsage.heapUsed / 1024 / 1024);
				ExportLog.log(`📊 Memory after chunk ${completedChunks}: ${heapUsedMB}MB heap used`);
				
				// Warning thresholds
				if (heapUsedMB > 800) {
					ExportLog.warning(`⚠️ Memory usage: ${heapUsedMB}MB - monitoring closely`);
				}
				
				// Emergency brake
				if (heapUsedMB > 1500) {
					ExportLog.error("❌ Memory usage dangerously high - may crash soon");
					throw new Error(`Memory usage too high: ${heapUsedMB}MB`);
				}
			}
		} catch (error) {
			ExportLog.warning(`Memory cleanup warning: ${error}`);
		}
	}
	
	/**
	 * Create final site metadata by scanning generated files
	 */
	private static async createFinalSiteMetadata(destination: Path, chunkCount: number): Promise<Website | undefined> {
		try {
			ExportLog.log("📝 Creating final site metadata...");
			
			// Create a website to hold the metadata
			const finalWebsite = new Website(destination);
			await finalWebsite.load([]); // Empty load
			
			// Scan for all generated HTML files
			const htmlFiles = await this.scanGeneratedFiles(destination, "html");
			const attachmentFiles = await this.scanGeneratedFiles(destination, "jpg,jpeg,png,gif,svg,pdf,mp3,mp4,zip,docx");
			
			ExportLog.log(`Found ${htmlFiles.length} HTML files and ${attachmentFiles.length} attachments`);
			
			// Create minimal entries for the index (needed for search and metadata)
			for (const htmlFile of htmlFiles) {
				const entry = this.createMinimalWebpageEntry(htmlFile);
				if (entry) finalWebsite.index.webpages.push(entry);
			}
			
			for (const attachmentFile of attachmentFiles) {
				const entry = this.createMinimalAttachmentEntry(attachmentFile);
				if (entry) finalWebsite.index.attachments.push(entry);
			}
			
			// Generate the final site metadata files
			await finalWebsite.index.finalize();
			
			// Download metadata files
			const metadataAttachment = finalWebsite.index.websiteDataAttachment();
			const indexAttachment = finalWebsite.index.indexDataAttachment();
			
			if (metadataAttachment) {
				await metadataAttachment.download();
				ExportLog.log("✅ Downloaded metadata.json");
			}
			
			if (indexAttachment) {
				await indexAttachment.download();
				ExportLog.log("✅ Downloaded search-index.json");
			}
			
			return finalWebsite;
			
		} catch (error) {
			ExportLog.error(error, "Failed to create final site metadata");
			return undefined;
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
			ExportLog.log(`💾 Progress saved: ${progress.completedChunks.length}/${progress.totalChunks} chunks`);
		} catch (error) {
			ExportLog.warning(`Failed to save progress: ${error}`);
		}
	}
	
	/**
	 * Load existing progress for crash recovery
	 */
	private static async loadProgress(destination: Path): Promise<ChunkProgress | undefined> {
		try {
			const fs = require('fs').promises;
			const path = require('path');
			const progressFile = path.join(destination.path, this.PROGRESS_FILE);
			
			const data = await fs.readFile(progressFile, 'utf8');
			const progress = JSON.parse(data) as ChunkProgress;
			
			ExportLog.log(`📤 Found progress: ${progress.completedChunks.length}/${progress.totalChunks} chunks completed`);
			return progress;
		} catch (error) {
			// No progress file - normal for fresh exports
			return undefined;
		}
	}
	
	/**
	 * Validate existing progress
	 */
	private static isValidProgress(progress: ChunkProgress, files: TFile[]): boolean {
		// Check if file count matches
		if (progress.fileCount !== files.length) {
			ExportLog.log("Progress invalid: file count changed");
			return false;
		}
		
		// Check if not too old (24 hours)
		const maxAge = 24 * 60 * 60 * 1000;
		if (Date.now() - progress.timestamp > maxAge) {
			ExportLog.log("Progress invalid: too old");
			return false;
		}
		
		return true;
	}
	
	/**
	 * Clean up progress file after successful export
	 */
	private static async cleanupProgress(destination: Path): Promise<void> {
		try {
			const fs = require('fs').promises;
			const path = require('path');
			const progressFile = path.join(destination.path, this.PROGRESS_FILE);
			
			await fs.unlink(progressFile);
			ExportLog.log("🧹 Progress file cleaned up");
		} catch (error) {
			// File might not exist - fine
		}
	}
	
	/**
	 * Scan for generated files of specific extensions
	 */
	private static async scanGeneratedFiles(destination: Path, extensions: string): Promise<Path[]> {
		const files: Path[] = [];
		const extList = extensions.split(',');
		
		try {
			const fs = require('fs').promises;
			const path = require('path');
			
			const scan = async (dir: string) => {
				const items = await fs.readdir(dir);
				
				for (const item of items) {
					const fullPath = path.join(dir, item);
					const stat = await fs.stat(fullPath);
					
					if (stat.isDirectory()) {
						await scan(fullPath);
					} else if (stat.isFile()) {
						const ext = path.extname(item).toLowerCase().slice(1);
						if (extList.includes(ext)) {
							files.push(new Path(fullPath));
						}
					}
				}
			};
			
			await scan(destination.path);
		} catch (error) {
			ExportLog.error(error, `Failed to scan for ${extensions} files`);
		}
		
		return files;
	}
	
	/**
	 * Create minimal webpage entry for metadata
	 */
	private static createMinimalWebpageEntry(htmlFile: Path): any {
		try {
			return {
				filename: htmlFile.fullName,
				basename: htmlFile.basename,
				targetPath: htmlFile,
				title: htmlFile.basename,
				source: null
			};
		} catch (error) {
			return null;
		}
	}
	
	/**
	 * Create minimal attachment entry for metadata
	 */
	private static createMinimalAttachmentEntry(attachmentFile: Path): any {
		try {
			return {
				filename: attachmentFile.fullName,
				basename: attachmentFile.basename,
				extension: attachmentFile.extension,
				targetPath: attachmentFile,
				source: null
			};
		} catch (error) {
			return null;
		}
	}
}

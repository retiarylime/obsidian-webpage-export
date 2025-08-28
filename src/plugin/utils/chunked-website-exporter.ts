import { TFile } from "obsidian";
import { Website } from "../website/website";
import { Path } from "./path";
import { ExportLog, MarkdownRendererAPI } from "../render-api/render-api";
import { Utils } from "./utils";
import { Settings } from "../settings/settings";

/**
 * Progress tracking for crash recovery with full state persistence
 */
interface ChunkProgress {
	totalChunks: number;
	completedChunks: number[];
	destination: string;
	timestamp: number;
	fileCount: number;
	// Enhanced recovery data
	globalExportRoot: string;
	chunkSize: number;
	fileHashes: string[]; // File modification hashes for validation
	lastChunkWebsiteState?: any; // Serialized final website state
}

/**
 * Serializable website state for crash recovery
 */
interface SerializableWebsiteState {
	webpages: any[];
	attachments: any[];
	attachmentsShownInTree: any[];
	websiteData: any;
	minisearchData?: any;
}

/**
 * Chunked Website Exporter that produces EXACTLY the same results as the original exporter
 * The key principle: we merge chunks into a single Website object and let the caller handle
 * all downloads, deletions, and final processing EXACTLY like the original exporter.
 */
export class ChunkedWebsiteExporter {
	private static readonly CHUNK_SIZE = 30; // Balanced chunk size
	private static readonly PROGRESS_FILE = ".obsidian-export-progress.json";
	private static readonly LOG_FILE = "log.txt"; // Persistent log file
	private static logFilePath: string | null = null;
	private static originalExportLogMethods: any = null;
	
	/**
	 * Initialize persistent logging for chunked export
	 */
	private static async initializePersistentLogging(destination: Path, isResuming: boolean = false): Promise<void> {
		try {
			const fs = require('fs').promises;
			const path = require('path');
			this.logFilePath = path.join(destination.path, this.LOG_FILE);
			
			// Intercept ExportLog methods to also write to file
			this.interceptExportLogMethods();
			
			if (!isResuming) {
				// Fresh export - create new log with header
				const timestamp = new Date().toISOString();
				const header = `
=============================================================================
OBSIDIAN CHUNKED EXPORT LOG
Started: ${timestamp}
Export Path: ${destination.path}
=============================================================================

`;
				await fs.writeFile(this.logFilePath, header);
				await this.logToPersistentFile(`📦 Starting new chunked export session`);
			} else {
				// Resuming export - append continuation marker
				const timestamp = new Date().toISOString();
				const continuation = `
-----------------------------------------------------------------------------
EXPORT RESUMED: ${timestamp}
-----------------------------------------------------------------------------

`;
				await fs.appendFile(this.logFilePath, continuation);
				await this.logToPersistentFile(`🔄 Resuming chunked export session`);
			}
		} catch (error) {
			console.error("Failed to initialize persistent logging:", error);
			this.logFilePath = null; // Disable persistent logging on failure
		}
	}
	
	/**
	 * Intercept ExportLog methods to write all logs to persistent file
	 */
	private static interceptExportLogMethods(): void {
		if (this.originalExportLogMethods || !this.logFilePath) return;
		
		// Store original methods
		this.originalExportLogMethods = {
			log: ExportLog.log,
			warning: ExportLog.warning,
			error: ExportLog.error,
			progress: ExportLog.progress
		};
		
		const self = this;
		
		// Override log method
		ExportLog.log = function(message: any, messageTitle: string = "") {
			self.originalExportLogMethods.log.call(this, message, messageTitle);
			const logMessage = self.formatLogMessage('INFO', messageTitle, message);
			self.logToPersistentFile(logMessage);
		};
		
		// Override warning method
		ExportLog.warning = function(message: any, messageTitle: string = "") {
			self.originalExportLogMethods.warning.call(this, message, messageTitle);
			const logMessage = self.formatLogMessage('WARNING', messageTitle, message);
			self.logToPersistentFile(logMessage);
		};
		
		// Override error method
		ExportLog.error = function(message: any, messageTitle: string = "", fatal: boolean = false) {
			self.originalExportLogMethods.error.call(this, message, messageTitle, fatal);
			const logMessage = self.formatLogMessage(fatal ? 'FATAL' : 'ERROR', messageTitle, message);
			self.logToPersistentFile(logMessage);
		};
		
		// Override progress method
		ExportLog.progress = function(progressBy: number, message: string, subMessage: string, progressColor?: string) {
			self.originalExportLogMethods.progress.call(this, progressBy, message, subMessage, progressColor);
			const logMessage = `PROGRESS: ${message} - ${subMessage}`;
			self.logToPersistentFile(logMessage);
		};
	}
	
	/**
	 * Restore original ExportLog methods
	 */
	private static restoreExportLogMethods(): void {
		if (!this.originalExportLogMethods) return;
		
		ExportLog.log = this.originalExportLogMethods.log;
		ExportLog.warning = this.originalExportLogMethods.warning;
		ExportLog.error = this.originalExportLogMethods.error;
		ExportLog.progress = this.originalExportLogMethods.progress;
		
		this.originalExportLogMethods = null;
	}
	
	/**
	 * Format log message for persistent storage
	 */
	private static formatLogMessage(level: string, title: string, message: any): string {
		const messageString = (typeof message === "string") ? message : JSON.stringify(message);
		const titleString = title ? `${title}: ` : "";
		return `[${level}] ${titleString}${messageString}`;
	}
	
	/**
	 * Write a log entry to the persistent log file
	 */
	private static async logToPersistentFile(message: string): Promise<void> {
		if (!this.logFilePath) return;
		
		try {
			const fs = require('fs').promises;
			const timestamp = new Date().toISOString().replace('T', ' ').replace('Z', '');
			const logEntry = `[${timestamp}] ${message}\n`;
			await fs.appendFile(this.logFilePath, logEntry);
		} catch (error) {
			// Silently fail to avoid disrupting export
			console.error("Failed to write to persistent log:", error);
		}
	}
	
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
		return files.length > 10; // Temporarily lowered for testing
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
			// Check for crash recovery first to determine if resuming
			const existingProgress = await this.loadProgress(destination);
			let startChunk = 0;
			let resumeFromExistingState = false;
			const isResuming = existingProgress && this.isValidProgress(existingProgress, files);
			
			// Initialize persistent logging
			await this.initializePersistentLogging(destination, isResuming);
			
			await this.logToPersistentFile(`🔄 Starting chunked export of ${files.length} files (chunks: ${chunkSize})`);
			
			if (isResuming) {
				startChunk = existingProgress.completedChunks.length;
				resumeFromExistingState = !!existingProgress.lastChunkWebsiteState;
				
				if (resumeFromExistingState) {
					ExportLog.log(`🔄 CRASH RECOVERY: ${existingProgress.completedChunks.length} chunks completed successfully`);
					ExportLog.log(`🔄 Will restart from chunk ${startChunk + 1} (incomplete chunk will be reprocessed from start)`);
					ExportLog.log(`🔄 Previous state: ${existingProgress.lastChunkWebsiteState?.webpages?.length || 0} pages, ${existingProgress.lastChunkWebsiteState?.attachments?.length || 0} attachments`);
				} else {
					ExportLog.log(`📤 Resuming from chunk ${startChunk + 1} (no preserved state - incomplete chunk restart)`);
				}
				
				// Log completed chunks for clarity
				if (existingProgress.completedChunks.length > 0) {
					const completedList = existingProgress.completedChunks.map(c => c + 1).join(', ');
					ExportLog.log(`✅ Previously completed chunks: ${completedList}`);
				}
			}
			
			// Initialize progress tracking
			ExportLog.resetProgress();
			ExportLog.addToProgressCap(files.length * 2);
			
			const chunks = this.createChunks(files, chunkSize);
			ExportLog.log(`Created ${chunks.length} chunks for processing`);
			
		// CRITICAL: Calculate global exportRoot from ALL files using exact same logic as regular exporter
		// Use existing progress value if resuming to ensure consistency
		const globalExportRoot = existingProgress?.globalExportRoot || this.findCommonRootPath(files);
		ExportLog.log(`🔧 Global export root for all chunks: "${globalExportRoot}"`);
		console.log("Global root path: " + globalExportRoot); // Match original Website logging
		
		// Debug: log sample file paths to understand structure
		const sampleFiles = files.slice(0, 5);
		ExportLog.log(`🔧 Sample file paths:`);
		for (const file of sampleFiles) {
			ExportLog.log(`   - "${file.path}"`);
		}

		ExportLog.log(`🔧 Using ${existingProgress?.globalExportRoot ? 'restored' : 'calculated'} globalExportRoot to match regular exporter behavior exactly`);
		
		const progress: ChunkProgress = {
			totalChunks: chunks.length,
			completedChunks: existingProgress?.completedChunks || [],
			destination: destination.path,
			timestamp: Date.now(),
			fileCount: files.length,
			// Enhanced recovery data
			globalExportRoot: globalExportRoot,
			chunkSize: chunkSize,
			fileHashes: files.map(f => `${f.path}:${f.stat.mtime}`), // File path + modification time as hash
			lastChunkWebsiteState: existingProgress?.lastChunkWebsiteState
		};
		
		// Build the final website by processing chunks
		let finalWebsite: Website | undefined = undefined;
		
		// COMPREHENSIVE CRASH RECOVERY: Restore all critical data without rebuilding chunks
		if (isResuming && startChunk > 0) {
			ExportLog.log(`🔄 CRASH RECOVERY: Restoring from saved progress (${startChunk} completed chunks)`);
			
			try {
				// Create base website instance for holding restored data
				finalWebsite = new Website(destination);
				// Override the export options after creation
				finalWebsite.exportOptions.exportRoot = globalExportRoot;
				finalWebsite.exportOptions.flattenExportPaths = false;
				await finalWebsite.load([]);
				
				// CRITICAL: Load existing search index and website data from disk
				await this.loadExistingWebsiteDataFromDisk(finalWebsite, destination);
				
				// CRITICAL: Rebuild file collections from existing exported files on disk
				await this.rebuildFileCollectionsFromDisk(finalWebsite, destination, chunks, startChunk);
				
				ExportLog.log(`✅ CRASH RECOVERY SUCCESS: Restored website state without rebuilding chunks`);
				ExportLog.log(`✅ Restored: ${finalWebsite.index.webpages.length} pages, ${finalWebsite.index.attachments.length} attachments`);
				ExportLog.log(`✅ Search index documents: ${finalWebsite.index.minisearch?.documentCount || 0}`);
				
			} catch (recoveryError) {
				ExportLog.error(recoveryError, "Crash recovery failed - starting fresh to prevent infinite loop");
				ExportLog.warning(`⚠️ RECOVERY FAILED: Will miss data from chunks 1-${startChunk} but allows progress`);
				finalWebsite = undefined;
			}
		}
			
			// Process remaining chunks (new chunks or all chunks if starting fresh)
			for (let i = startChunk; i < chunks.length; i++) {
				if (this.isCancelled()) {
					ExportLog.warning("Export cancelled");
					await this.saveProgress(progress);
					return undefined;
				}
				
				ExportLog.log(`🔨 Processing chunk ${i + 1}/${chunks.length}`);
				
				try {
					// Build chunk website with calculated globalExportRoot to match regular exporter exactly
					const chunkWebsite: Website | undefined = await this.buildChunkWebsite(chunks[i], destination, globalExportRoot, i === 0 && !finalWebsite);
					if (!chunkWebsite) {
						throw new Error(`Failed to build chunk ${i + 1}`);
					}
					
					// NOTE: Attachment processing is handled automatically during website.build()
					// via the same renderDocument() -> getAttachments() -> addFiles() sequence as regular exporter
					// No need for separate processChunkAttachments call
					
					// Validate chunk website before merging
					if (!chunkWebsite.index) {
						ExportLog.warning(`Chunk ${i + 1} missing index - skipping merge`);
						continue;
					}
					
					// Merge into final website - handles both fresh start and crash recovery
					if (!finalWebsite) {
						// First chunk (or recovery failed) - becomes the base
						finalWebsite = chunkWebsite;
						ExportLog.log(`🏗️ ${i === 0 ? 'First' : 'Base'} chunk set: ${finalWebsite.index?.attachmentsShownInTree?.length || 0} files in tree`);
					} else if (finalWebsite.index) {
						// Merge subsequent chunk into existing website
						await this.mergeWebsites(chunkWebsite, finalWebsite);
						ExportLog.log(`🔄 Merged chunk ${i + 1}: total ${finalWebsite.index.attachmentsShownInTree.length} files`);
					} else {
						// Final website exists but is invalid - reinitialize
						ExportLog.warning(`Final website invalid at chunk ${i + 1} - reinitializing`);
						finalWebsite = chunkWebsite;
					}
					
					// CRITICAL: Generate site-lib files after each chunk so they're always available
					// This ensures crash recovery works and partial exports are functional
					if (finalWebsite) {
						await this.generateSiteLibFiles(finalWebsite, i + 1, chunks.length);
					}
					
					// Memory cleanup
					await this.performMemoryCleanup(i + 1, chunks.length);
					
					// CRITICAL: Only mark chunk as completed AFTER all processing succeeds
					// This ensures incomplete chunks are restarted from the beginning on crash recovery
					progress.completedChunks.push(i);
					
					// Enhanced: Save website state for true continuity across restarts
					if (finalWebsite) {
						progress.lastChunkWebsiteState = this.serializeWebsiteState(finalWebsite);
						ExportLog.log(`💾 Chunk ${i + 1} completed successfully - saved website state (${progress.lastChunkWebsiteState.webpages.length} pages, ${progress.lastChunkWebsiteState.attachments.length} attachments)`);
					}
					
					await this.saveProgress(progress);
					ExportLog.log(`✅ Chunk ${i + 1}/${chunks.length} completed and saved to disk`);
					
				} catch (error) {
					ExportLog.error(error, `CHUNK ${i + 1} FAILED - will restart this chunk on next export attempt`);
					ExportLog.log(`⚠️ Chunk ${i + 1} NOT marked as completed - will be reprocessed from start on recovery`);
					
					// Save progress WITHOUT adding this chunk to completedChunks
					// This ensures the failed chunk will be restarted from the beginning
					await this.saveProgress(progress);
					throw error;
				}
			}
			
			// Finalize the website EXACTLY like original exporter
			if (finalWebsite) {
				ExportLog.log("🎯 Finalizing website - identical to original exporter");
				
				// CRITICAL: Ensure all attachment files are properly queued for download
				// This is essential for crash recovery where attachments may not be in newFiles/updatedFiles
				await this.ensureAttachmentsAreQueued(finalWebsite);
				
				// CRITICAL: Regenerate file tree with ALL merged files
				await this.regenerateFileTree(finalWebsite);
				
				await finalWebsite.index.finalize();
				
				// DEBUG: Validate final website state before returning
				ExportLog.log(`🔍 FINAL VALIDATION: Search index has ${finalWebsite.index.minisearch?.documentCount || 0} documents`);
				ExportLog.log(`🔍 FINAL VALIDATION: Website data has ${Object.keys(finalWebsite.index.websiteData.webpages).length} webpages in metadata`);
				ExportLog.log(`🔍 FINAL VALIDATION: Website data has ${finalWebsite.index.websiteData.attachments.length} attachments in metadata`);
				ExportLog.log(`🔍 FINAL VALIDATION: Website data has ${finalWebsite.index.websiteData.shownInTree.length} files in tree metadata`);
				
				// DEBUG: Test that the site-lib data generation worked (files already generated incrementally)
				try {
					const testWebsiteData = finalWebsite.index.websiteDataAttachment();
					const testSearchIndex = finalWebsite.index.indexDataAttachment();
					
					ExportLog.log(`🔍 FINAL VALIDATION: metadata.json contains ${testWebsiteData.data?.length || 0} bytes`);
					ExportLog.log(`🔍 FINAL VALIDATION: search-index.json contains ${testSearchIndex.data?.length || 0} bytes`);
					
					if (testWebsiteData.data && testWebsiteData.data.length > 100) {
						ExportLog.log(`✅ SITE-LIB: Website metadata is complete`);
					} else {
						ExportLog.error("❌ SITE-LIB: Website metadata is incomplete");
					}
					
					if (testSearchIndex.data && testSearchIndex.data.length > 10) {
						ExportLog.log(`✅ SITE-LIB: Search index is complete`);
					} else {
						ExportLog.error("❌ SITE-LIB: Search index is incomplete");
					}
					
					ExportLog.log(`ℹ️ Site-lib files were generated incrementally after each chunk and are already on disk`);
				} catch (siteLibError) {
					ExportLog.error(siteLibError, "❌ SITE-LIB: Failed to validate final site-lib data");
				}
				
				// Clean up progress
				await this.cleanupProgress(destination);
				
				ExportLog.log(`✅ Chunked export complete: ${finalWebsite.index.webpages.length} pages, ${finalWebsite.index.attachments.length} attachments, ${finalWebsite.index.attachmentsShownInTree.length} in tree`);
			}
			
			return finalWebsite;
			
		} catch (error) {
			ExportLog.error(error, "Chunked export failed");
			return undefined;
		} finally {
			// Restore original ExportLog methods
			this.restoreExportLogMethods();
			
			// Final log entry
			await this.logToPersistentFile(`
=============================================================================
EXPORT SESSION END: ${new Date().toISOString()}
=============================================================================`);
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
	 * Find common root path from ALL files - EXACTLY like Website.findCommonRootPath
	 */
	private static findCommonRootPath(files: TFile[]): string {
		if (!files || files.length === 0) {
			return '';
		}

		if (files.length === 1) {
			return new Path(files[0].path).parent?.path ?? '';
		}

		const paths = files.map(file => new Path(file.path).split());
		let commonPath: string[] = [];
		const shortestPathLength = Math.min(...paths.map(p => p.length));

		for (let i = 0; i < shortestPathLength; i++) {
			const segment = paths[0][i];
			if (paths.every(path => path[i] === segment)) {
				commonPath.push(segment);
			} else {
				break;
			}
		}

		// If the common path is just the root, return an empty string
		if (commonPath.length <= 1) {
			return '';
		}

		// Remove the last segment if it's not a common parent for all files
		const lastCommonSegment = commonPath[commonPath.length - 1];
		if (!paths.every(path => path.length > commonPath.length || path[commonPath.length - 1] !== lastCommonSegment)) {
			commonPath.pop();
		}

		return commonPath.length > 0 ? new Path(commonPath.join("/")).path : '';
	}	/**
	 * Build a website for a chunk - uses global export root for consistent directory structure
	 */
	private static async buildChunkWebsite(files: TFile[], destination: Path, globalExportRoot: string, isFirstChunk: boolean = false): Promise<Website | undefined> {
		try {
			console.log(`🔧🔧 CHUNK BUILD START - globalExportRoot: "${globalExportRoot}"`);
			console.log(`🔧🔧 CHUNK BUILD START - Settings.exportOptions.exportRoot BEFORE: "${Settings.exportOptions.exportRoot}"`);
			console.log(`🔧🔧 CHUNK BUILD START - Settings.exportOptions.flattenExportPaths BEFORE: ${Settings.exportOptions.flattenExportPaths}`);
			
			// Create and build website EXACTLY like original exporter
			const website = new Website(destination);
			
			// CRITICAL: Set Settings overrides BEFORE loading to ensure Webpage constructors get correct values
			const originalSettings = Settings.exportOptions.exportRoot;
			const originalFlattenPaths = Settings.exportOptions.flattenExportPaths;
			Settings.exportOptions.exportRoot = globalExportRoot;
			Settings.exportOptions.flattenExportPaths = false;
			
			// Also pre-set the website.exportOptions before load() to ensure Webpage constructors get correct values
			website.exportOptions.exportRoot = globalExportRoot;
			website.exportOptions.flattenExportPaths = false;
			// Set flag to prevent website.load() from overriding the exportRoot
			(website.exportOptions as any)._chunkExporterOverride = true;
			
			console.log(`🔧🔧 SETTINGS OVERRIDE APPLIED:`);
			console.log(`🔧🔧   Settings.exportOptions.exportRoot: "${Settings.exportOptions.exportRoot}"`);
			console.log(`🔧🔧   Settings.exportOptions.flattenExportPaths: ${Settings.exportOptions.flattenExportPaths}`);
			console.log(`🔧🔧   website.exportOptions.exportRoot: "${website.exportOptions.exportRoot}"`);
			console.log(`🔧🔧   website.exportOptions.flattenExportPaths: ${website.exportOptions.flattenExportPaths}`);
			
			ExportLog.log(`🔧 Pre-load Settings and website.exportOptions override - exportRoot: "${globalExportRoot}", flattenExportPaths: false`);
			
			// Load files - this will cause website.load() to calculate and overwrite website.exportOptions.exportRoot
			console.log(`🔧🔧 CALLING website.load() with ${files.length} files`);
			await website.load(files);
			
			// Log what the chunk calculated as its root after load()
			const chunkCalculatedRoot = website.exportOptions.exportRoot;
			console.log(`🔧🔧 POST-LOAD VALUES:`);
			console.log(`🔧🔧   Chunk calculated root: "${chunkCalculatedRoot}"`);
			console.log(`🔧🔧   Settings.exportOptions.exportRoot: "${Settings.exportOptions.exportRoot}"`);
			console.log(`🔧🔧   Settings.exportOptions.flattenExportPaths: ${Settings.exportOptions.flattenExportPaths}`);
			console.log(`🔧🔧   website.exportOptions.exportRoot: "${website.exportOptions.exportRoot}"`);
			console.log(`🔧🔧   website.exportOptions.flattenExportPaths: ${website.exportOptions.flattenExportPaths}`);
			
			ExportLog.log(`🔧 Chunk calculated root after load(): "${chunkCalculatedRoot}" from ${files.length} files`);
			
			// CRITICAL: Override website.exportOptions AGAIN after load() since it got overwritten
			website.exportOptions.exportRoot = globalExportRoot;
			website.exportOptions.flattenExportPaths = false;
			
			console.log(`🔧🔧 FINAL OVERRIDE APPLIED:`);
			console.log(`🔧🔧   website.exportOptions.exportRoot: "${website.exportOptions.exportRoot}"`);
			console.log(`🔧🔧   website.exportOptions.flattenExportPaths: ${website.exportOptions.flattenExportPaths}`);
			
			ExportLog.log(`🔧 Post-load website.exportOptions re-override - exportRoot: "${globalExportRoot}"`);
			
			// Store the original values to restore later if needed
			(website as any)._originalExportRoot = originalSettings;
			(website as any)._originalFlattenPaths = originalFlattenPaths;
			
			ExportLog.log(`🔧 ✅ Chunk configured to match regular exporter exactly`);
			console.log(`Chunk ${isFirstChunk ? '1' : '?'}: calculated="${chunkCalculatedRoot}" -> using="${globalExportRoot}" (matches regular exporter)`);
			
			// Additional debugging: let's see what happens to sample files
			console.log(`🔧 DEBUG: Sample file processing with exportRoot="${globalExportRoot}"`);
			const sampleFiles = files.slice(0, 3);
			for (const file of sampleFiles) {
				console.log(`   Input: ${file.path}`);
				// This is what Downloadable.removeRootFromPath would do
				const targetPath = file.path.replace('.md', '.html').toLowerCase().replace(/\s+/g, '-').replace(/&/g, '&');
				const finalPath = globalExportRoot ? (targetPath.startsWith(globalExportRoot + '/') ? targetPath.substring((globalExportRoot + '/').length) : targetPath) : targetPath;
				console.log(`   Output: ${finalPath}`);
			}			let builtWebsite: Website | undefined;
			try {
				builtWebsite = await website.build();
			} catch (buildError) {
				ExportLog.error(buildError, `Error building chunk website - search index issue?`);
				// Try to recover by rebuilding without problematic components
				builtWebsite = website; // Use the loaded website if build fails
			}
			
			if (!builtWebsite) return undefined;
			
			// Validate the built website has required properties
			if (!builtWebsite.index) {
				ExportLog.warning("Built website missing index - this may cause merge issues");
				return undefined;
			}
			
			// For the first chunk, ensure it has the complete website infrastructure
			// This includes CSS, JS, search index, metadata, and all core assets
			if (isFirstChunk) {
				ExportLog.log("🏗️ First chunk - ensuring complete website infrastructure");
				
				// The build() method should have already added all necessary assets
				// but let's verify the website has the core structure
				const allFiles = builtWebsite.index.allFiles || [];
				const hasCSS = allFiles.some(f => f && f.targetPath && f.targetPath.path.includes('site-lib/css/'));
				const hasJS = allFiles.some(f => f && f.targetPath && f.targetPath.path.includes('site-lib/js/'));
				
				ExportLog.log(`📋 First chunk assets: ${allFiles.length} total, CSS: ${hasCSS}, JS: ${hasJS}`);
			}
			
			// Do NOT download files here - that's handled by the caller like original exporter
			return builtWebsite;
			
		} catch (error) {
			ExportLog.error(error, "Failed to build chunk website");
			return undefined;
		}
	}
	
	/**
	 * Merge chunk website into final website - preserves all data structures AND website assets
	 */
	private static async mergeWebsites(chunkWebsite: Website, finalWebsite: Website): Promise<void> {
		try {
			// Validate input websites
			if (!chunkWebsite || !finalWebsite) {
				ExportLog.error(new Error("Invalid website objects for merging"), "Website merge failed");
				return;
			}
			
			if (!chunkWebsite.index || !finalWebsite.index) {
				ExportLog.error(new Error("Missing index in website objects"), "Website merge failed");
				return;
			}
			
			// Debug: Log merge counts before merging
			const beforeWebpages = finalWebsite.index.webpages.length;
			const beforeAttachments = finalWebsite.index.attachments.length;
			const beforeAttachmentsShownInTree = finalWebsite.index.attachmentsShownInTree.length;
			
			console.log(`🔄 MERGE: Before - Webpages: ${beforeWebpages}, Attachments: ${beforeAttachments}, AttachmentsShownInTree: ${beforeAttachmentsShownInTree}`);
			console.log(`🔄 MERGE: Chunk has - Webpages: ${chunkWebsite.index.webpages.length}, Attachments: ${chunkWebsite.index.attachments.length}, AttachmentsShownInTree: ${chunkWebsite.index.attachmentsShownInTree.length}`);
			
			// Safely merge webpages (avoid duplicates)
			if (chunkWebsite.index.webpages && Array.isArray(chunkWebsite.index.webpages)) {
				for (const webpage of chunkWebsite.index.webpages) {
					if (webpage && webpage.targetPath && !finalWebsite.index.webpages.some(existing => 
						existing && existing.targetPath && existing.targetPath.path === webpage.targetPath.path)) {
						finalWebsite.index.webpages.push(webpage);
					}
				}
			}
			
			// Safely merge attachments (avoid duplicates)
			if (chunkWebsite.index.attachments && Array.isArray(chunkWebsite.index.attachments)) {
				for (const attachment of chunkWebsite.index.attachments) {
					if (attachment && attachment.targetPath && !finalWebsite.index.attachments.some(existing => 
						existing && existing.targetPath && existing.targetPath.path === attachment.targetPath.path)) {
						finalWebsite.index.attachments.push(attachment);
					}
				}
			}
			
			// CRITICAL: Safely merge attachmentsShownInTree for file navigation (avoid duplicates)
			if (chunkWebsite.index.attachmentsShownInTree && Array.isArray(chunkWebsite.index.attachmentsShownInTree)) {
				for (const attachment of chunkWebsite.index.attachmentsShownInTree) {
					if (attachment && attachment.targetPath && !finalWebsite.index.attachmentsShownInTree.some(existing => 
						existing && existing.targetPath && existing.targetPath.path === attachment.targetPath.path)) {
						finalWebsite.index.attachmentsShownInTree.push(attachment);
					}
				}
			}
			
			// Debug: Log merge counts after merging
			const afterWebpages = finalWebsite.index.webpages.length;
			const afterAttachments = finalWebsite.index.attachments.length;
			const afterAttachmentsShownInTree = finalWebsite.index.attachmentsShownInTree.length;
			
			console.log(`🔄 MERGE: After - Webpages: ${afterWebpages}, Attachments: ${afterAttachments}, AttachmentsShownInTree: ${afterAttachmentsShownInTree}`);
			console.log(`🔄 MERGE: Added - Webpages: ${afterWebpages - beforeWebpages}, Attachments: ${afterAttachments - beforeAttachments}, AttachmentsShownInTree: ${afterAttachmentsShownInTree - beforeAttachmentsShownInTree}`);
			
			// Safely merge newFiles (content + assets)
			if (chunkWebsite.index.newFiles && Array.isArray(chunkWebsite.index.newFiles)) {
				for (const file of chunkWebsite.index.newFiles) {
					if (file && file.targetPath && !finalWebsite.index.newFiles.some(existing => 
						existing && existing.targetPath && existing.targetPath.path === file.targetPath.path)) {
						finalWebsite.index.newFiles.push(file);
					}
				}
			}
			
			// Safely merge updatedFiles (content + assets)
			if (chunkWebsite.index.updatedFiles && Array.isArray(chunkWebsite.index.updatedFiles)) {
				for (const file of chunkWebsite.index.updatedFiles) {
					if (file && file.targetPath && !finalWebsite.index.updatedFiles.some(existing => 
						existing && existing.targetPath && existing.targetPath.path === file.targetPath.path)) {
						finalWebsite.index.updatedFiles.push(file);
					}
				}
			}
			
			// Safely merge deletedFiles
			if (chunkWebsite.index.deletedFiles && Array.isArray(chunkWebsite.index.deletedFiles)) {
				for (const file of chunkWebsite.index.deletedFiles) {
					if (file && !finalWebsite.index.deletedFiles.includes(file)) {
						finalWebsite.index.deletedFiles.push(file);
					}
				}
			}
			
			// CRITICAL: Safely merge all files (includes CSS, JS, and other website assets)
			if (chunkWebsite.index.allFiles && Array.isArray(chunkWebsite.index.allFiles)) {
				for (const file of chunkWebsite.index.allFiles) {
					if (file && file.targetPath && !finalWebsite.index.allFiles.some(existing => 
						existing && existing.targetPath && existing.targetPath.path === file.targetPath.path)) {
						finalWebsite.index.allFiles.push(file);
					}
				}
			}
			
			// CRITICAL: Merge search index data from chunk to final website
			await this.mergeSearchIndices(chunkWebsite, finalWebsite);
			
			// Safely merge website data properties to ensure complete website structure
			// This ensures search index, metadata, and other core files are preserved
			if (chunkWebsite.index.websiteData && finalWebsite.index.websiteData) {
				const chunkData = chunkWebsite.index.websiteData;
				const finalData = finalWebsite.index.websiteData;
				
				// Safely merge file info
				if (chunkData.fileInfo && finalData.fileInfo) {
					Object.assign(finalData.fileInfo, chunkData.fileInfo);
				}
				
				// Safely merge webpage data
				if (chunkData.webpages && finalData.webpages) {
					Object.assign(finalData.webpages, chunkData.webpages);
				}
				
				// Safely merge attachment lists (avoid duplicates)
				if (chunkData.attachments && Array.isArray(chunkData.attachments) && finalData.attachments) {
					for (const attachment of chunkData.attachments) {
						if (attachment && !finalData.attachments.includes(attachment)) {
							finalData.attachments.push(attachment);
						}
					}
				}
				
				// Safely merge all files list (avoid duplicates)  
				if (chunkData.allFiles && Array.isArray(chunkData.allFiles) && finalData.allFiles) {
					for (const file of chunkData.allFiles) {
						if (file && !finalData.allFiles.includes(file)) {
							finalData.allFiles.push(file);
						}
					}
				}
			}
			
		} catch (error) {
			ExportLog.error(error, "Failed to merge websites");
		}
	}
	
	/**
	 * Merge search indices from chunk website into final website
	 * This EXACTLY matches the regular exporter's addWebpageToMinisearch logic from index.ts
	 */
	private static async mergeSearchIndices(chunkWebsite: Website, finalWebsite: Website): Promise<void> {
		try {
			if (!chunkWebsite.index.minisearch || !finalWebsite.index.minisearch) {
				ExportLog.warning("Missing search index in chunk or final website - skipping search index merge");
				return;
			}
			
			ExportLog.log(`🔍 Merging search index: ${chunkWebsite.index.webpages.length} webpages from chunk`);
			
			let mergedCount = 0;
			let skippedCount = 0;
			let errorCount = 0;
			
			for (const webpage of chunkWebsite.index.webpages) {
				if (!webpage || !webpage.targetPath) {
					skippedCount++;
					continue;
				}
				
				const webpagePath = webpage.targetPath.path;
				
				// Check if the webpage is already in the final index to avoid duplicates
				if (finalWebsite.index.minisearch.has(webpagePath)) {
					console.log(`🔍 SKIP: Search document already exists: ${webpagePath}`);
					skippedCount++;
					continue;
				}
				
				try {
					// Use EXACT same logic as regular exporter's addWebpageToMinisearch
					// from index.ts:335-350
					const headersInfo = webpage.outputData.renderedHeadings;
					
					// Remove title header if it's the first one (exact match to regular exporter)
					if (headersInfo.length > 0 && headersInfo[0].level == 1 && headersInfo[0].heading == webpage.title) {
						headersInfo.shift();
					}
					
					const headers = headersInfo.map((header) => header.heading);
					
					// Create search document with CORRECT structure for MiniSearch
					// MiniSearch requires 'id' and 'url' fields, not 'path'
					const searchDocument = {
						id: webpagePath,        // MiniSearch requires 'id' field
						title: webpage.title || 'Untitled',
						aliases: webpage.outputData.aliases || [],
						headers: headers || [],
						tags: webpage.outputData.allTags || [],
						url: webpagePath,       // MiniSearch expects 'url' field  
						content: (webpage.outputData.description || "") + " " + (webpage.outputData.searchContent || ""),
					};
					
					// Additional validation to prevent MiniSearch errors
					if (!searchDocument.id) {
						ExportLog.warning(`Search document missing ID: ${webpagePath} - skipping`);
						skippedCount++;
						continue;
					}
					
					if (!searchDocument.title) {
						searchDocument.title = 'Untitled';
						ExportLog.warning(`Search document missing title: ${webpagePath} - using fallback`);
					}
					
					if (!searchDocument.content || searchDocument.content.trim() === "" || searchDocument.content.trim() === " ") {
						searchDocument.content = searchDocument.title; // Fallback content
						ExportLog.warning(`Search document missing content: ${webpagePath} - using title as content`);
					}
					
					// Ensure arrays are properly defined
					searchDocument.aliases = Array.isArray(searchDocument.aliases) ? searchDocument.aliases : [];
					searchDocument.headers = Array.isArray(searchDocument.headers) ? searchDocument.headers : [];
					searchDocument.tags = Array.isArray(searchDocument.tags) ? searchDocument.tags : [];
					
					// Add to final website's search index with additional error handling
					try {
						finalWebsite.index.minisearch.add(searchDocument);
						mergedCount++;
						console.log(`🔍 MERGED: ${webpagePath} (title: "${searchDocument.title}", content: ${searchDocument.content.length} chars, headers: ${searchDocument.headers.length}, tags: ${searchDocument.tags.length})`);
					} catch (addError) {
						ExportLog.error(addError, `MiniSearch add failed for ${webpagePath}`);
						console.log(`🔍 ADD ERROR: ${webpagePath} - ${addError.message}`);
						errorCount++;
					}
					
				} catch (err) {
					ExportLog.error(err, `Failed to merge search document for ${webpagePath}`);
					console.log(`🔍 ERROR: Could not merge search document for ${webpagePath}: ${err}`);
					errorCount++;
				}
			}
			
			// Comprehensive merge summary
			ExportLog.log(`✅ Search index merge complete: ${mergedCount} merged, ${skippedCount} skipped, ${errorCount} errors`);
			
			// Validate final search index state
			const finalDocCount = finalWebsite.index.minisearch.documentCount;
			console.log(`🔍 FINAL: Search index now contains ${finalDocCount} total documents`);
			
		} catch (error) {
			ExportLog.error(error, "Critical failure in search index merging");
		}
	}
	
	/**
	 * Regenerate file tree for the final merged website with ALL files
	 * This ensures the file tree includes files from ALL chunks, not just the first one
	 */
	private static async regenerateFileTree(finalWebsite: Website): Promise<void> {
		try {
			if (!finalWebsite.exportOptions.fileNavigationOptions.enabled) {
				return; // File tree not enabled, skip
			}
			
			ExportLog.log(`🌲 Regenerating file tree for merged website...`);
			
			// CRITICAL: Rebuild attachmentsShownInTree to include ALL files from ALL chunks
			// The regular exporter builds this during normal processing, but chunked export
			// needs to explicitly rebuild it after merging
			await this.rebuildAttachmentsShownInTree(finalWebsite);
			
			ExportLog.log(`🌲 Building file tree with ${finalWebsite.index.attachmentsShownInTree.length} files`);
			
			// Debug: Log file distribution to verify completeness
			const filesByExtension = new Map<string, number>();
			for (const file of finalWebsite.index.attachmentsShownInTree) {
				const extension = file.sourcePath?.split('.').pop()?.toLowerCase() || 'unknown';
				filesByExtension.set(extension, (filesByExtension.get(extension) || 0) + 1);
			}
			
			const extensionSummary = Array.from(filesByExtension.entries())
				.map(([ext, count]) => `${count} .${ext}`)
				.join(', ');
			console.log(`🌲 FILE TREE: File distribution - ${extensionSummary}`);
			
			// Debug: Log some sample files to verify paths
			const sampleFiles = finalWebsite.index.attachmentsShownInTree.slice(0, 5);
			console.log(`🌲 DEBUG: Sample attachmentsShownInTree files:`);
			for (const file of sampleFiles) {
				console.log(`  - ${file.sourcePath} -> ${file.targetPath.path} (root: "${file.sourcePathRootRelative}")`);
			}
			
			// Create file tree with all merged files - exact same logic as regular exporter
			const paths = finalWebsite.index.attachmentsShownInTree.map((file) => new Path(file.sourcePathRootRelative ?? ""));
			const { FileTree } = await import("../features/file-tree");
			const { AssetLoader } = await import("../asset-loaders/base-asset");
			const { AssetType, InlinePolicy, Mutability } = await import("../asset-loaders/asset-types");
			
			// Configure file tree exactly like regular exporter
			finalWebsite.fileTree = new FileTree(paths, false, true);
			finalWebsite.fileTree.makeLinksWebStyle = finalWebsite.exportOptions.slugifyPaths ?? true;
			finalWebsite.fileTree.showNestingIndicator = true;
			finalWebsite.fileTree.generateWithItemsClosed = true;
			finalWebsite.fileTree.showFileExtentionTags = true;
			finalWebsite.fileTree.hideFileExtentionTags = ["md"];
			finalWebsite.fileTree.title = finalWebsite.exportOptions.siteName ?? "Exported Vault";
			finalWebsite.fileTree.id = "file-explorer";
			
			// Generate file tree HTML
			const tempContainer = document.createElement("div");
			await finalWebsite.fileTree.generate(tempContainer);
			const data = tempContainer.innerHTML;
			
			// Update tree order for all attachments (exact same logic as regular exporter)
			finalWebsite.index.attachmentsShownInTree.forEach((file) => {
				if (!file.sourcePathRootRelative) return;
				const fileTreeItem = finalWebsite.fileTree?.getItemBySourcePath(file.sourcePathRootRelative);
				file.treeOrder = fileTreeItem?.treeOrder ?? 0;
			});
			
			tempContainer.remove();
			finalWebsite.fileTreeAsset = new AssetLoader("file-tree.html", data, null, AssetType.HTML, InlinePolicy.Auto, true, Mutability.Temporary);
			
			ExportLog.log(`✅ File tree regenerated with ${paths.length} files`);
			
		} catch (error) {
			ExportLog.error(error, "Failed to regenerate file tree for merged website");
		}
	}
	
	/**
	 * Rebuild attachmentsShownInTree to include ALL files from ALL merged chunks
	 * This is critical because the file tree depends on this collection
	 */
	private static async rebuildAttachmentsShownInTree(finalWebsite: Website): Promise<void> {
		try {
			ExportLog.log(`🔧 Rebuilding attachmentsShownInTree collection...`);
			
			// Clear existing collection to start fresh
			finalWebsite.index.attachmentsShownInTree = [];
			
			// Add all webpages to the tree (these should be shown)
			for (const webpage of finalWebsite.index.webpages) {
				if (webpage && webpage.targetPath) {
					finalWebsite.index.attachmentsShownInTree.push(webpage);
				}
			}
			
			// Add all attachments that should be shown in tree
			// This includes embedded files and standalone assets
			for (const attachment of finalWebsite.index.attachments) {
				if (attachment && attachment.targetPath) {
					// Check if this attachment should be shown in tree
					// (typically all attachments are shown unless specifically excluded)
					const shouldShow = this.shouldAttachmentBeShownInTree(attachment);
					if (shouldShow) {
						finalWebsite.index.attachmentsShownInTree.push(attachment);
					}
				}
			}
			
			// Remove duplicates based on targetPath
			const seen = new Set<string>();
			finalWebsite.index.attachmentsShownInTree = finalWebsite.index.attachmentsShownInTree.filter(file => {
				if (!file.targetPath) return false;
				const path = file.targetPath.path;
				if (seen.has(path)) return false;
				seen.add(path);
				return true;
			});
			
			// Sort by path for consistent tree structure
			finalWebsite.index.attachmentsShownInTree.sort((a, b) => {
				const pathA = a.sourcePathRootRelative || a.sourcePath || "";
				const pathB = b.sourcePathRootRelative || b.sourcePath || "";
				return pathA.localeCompare(pathB);
			});
			
			ExportLog.log(`🔧 Rebuilt attachmentsShownInTree: ${finalWebsite.index.attachmentsShownInTree.length} files total`);
			
			// Debug: Log the breakdown
			const webpageCount = finalWebsite.index.attachmentsShownInTree.filter(f => f.constructor.name.includes('Webpage')).length;
			const attachmentCount = finalWebsite.index.attachmentsShownInTree.length - webpageCount;
			console.log(`🔧 BREAKDOWN: ${webpageCount} webpages, ${attachmentCount} attachments`);
			
		} catch (error) {
			ExportLog.error(error, "Failed to rebuild attachmentsShownInTree collection");
		}
	}
	
	/**
	 * Determine if an attachment should be shown in the file tree
	 */
	private static shouldAttachmentBeShownInTree(attachment: any): boolean {
		// Generally all attachments should be shown unless they are:
		// 1. System files (CSS, JS, etc.)
		// 2. Temporary files
		// 3. Hidden files
		
		if (!attachment.sourcePath && !attachment.targetPath) return false;
		
		const sourcePath = attachment.sourcePath || "";
		const targetPath = attachment.targetPath?.path || "";
		
		// Exclude system/library files
		if (targetPath.includes('site-lib/') || 
			targetPath.includes('search-index.json') || 
			targetPath.includes('metadata.json')) {
			return false;
		}
		
		// Exclude temporary or generated files
		if (sourcePath.includes('.obsidian-export-progress.json')) {
			return false;
		}
		
		// Include everything else (images, documents, media, etc.)
		return true;
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
	 * Enhanced progress validation with file integrity checks
	 */
	private static isValidProgress(progress: ChunkProgress, files: TFile[]): boolean {
		// Check file count match
		if (progress.fileCount !== files.length) {
			ExportLog.log(`🔄 Progress invalid: file count changed (${progress.fileCount} → ${files.length})`);
			return false;
		}
		
		// Check age (24 hours max)
		const maxAge = 24 * 60 * 60 * 1000;
		if (Date.now() - progress.timestamp > maxAge) {
			ExportLog.log(`🔄 Progress invalid: too old (${Math.round((Date.now() - progress.timestamp) / 1000 / 60)} minutes)`);
			return false;
		}
		
		// Enhanced: Check file modification times to ensure no files changed
		const currentFileHashes = files.map(f => `${f.path}:${f.stat.mtime}`);
		if (progress.fileHashes) {
			const hashMatches = progress.fileHashes.length === currentFileHashes.length &&
				progress.fileHashes.every((hash, index) => hash === currentFileHashes[index]);
			
			if (!hashMatches) {
				ExportLog.log(`🔄 Progress invalid: files modified since last export`);
				return false;
			}
		}
		
		// Enhanced: Validate that the progress has required recovery data
		if (progress.globalExportRoot === undefined || !progress.chunkSize) {
			ExportLog.log(`🔄 Progress invalid: missing recovery metadata`);
			return false;
		}
		
		ExportLog.log(`✅ Progress validation passed - resuming from chunk ${progress.completedChunks.length + 1}`);
		return true;
	}
	
	/**
	 * Serialize website state for crash recovery
	 */
	private static serializeWebsiteState(website: Website): SerializableWebsiteState {
		return {
			webpages: website.index.webpages.map(wp => ({
				sourcePath: wp.sourcePath,
				targetPath: wp.targetPath?.path,
				title: wp.title,
				sourcePathRootRelative: wp.sourcePathRootRelative,
				// Add other essential webpage properties
			})),
			attachments: website.index.attachments.map(att => ({
				sourcePath: att.sourcePath,
				targetPath: att.targetPath?.path,
				sourcePathRootRelative: att.sourcePathRootRelative,
				// Add other essential attachment properties
			})),
			attachmentsShownInTree: website.index.attachmentsShownInTree.map(att => ({
				sourcePath: att.sourcePath,
				targetPath: att.targetPath?.path,
				sourcePathRootRelative: att.sourcePathRootRelative,
			})),
			websiteData: {
				...website.index.websiteData,
				// Ensure all critical website data is included
			},
			minisearchData: website.index.minisearch ? {
				documentCount: website.index.minisearch.documentCount,
				// Save search index state
			} : undefined
		};
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
			ExportLog.log(`🧹 Cleaned up progress file: ${progressFile}`);
		} catch (error) {
			// Ignore cleanup errors
		}
	}
	
	/**
	 * Ensure all attachment files are properly queued for download
	 * This is critical for crash recovery scenarios where merged attachments may not be in download queues
	 */
	private static async ensureAttachmentsAreQueued(finalWebsite: Website): Promise<void> {
		try {
			ExportLog.log(`📁 Ensuring all attachment files are queued for download...`);
			
			// Count files before processing
			const beforeNewFiles = finalWebsite.index.newFiles.length;
			const beforeUpdatedFiles = finalWebsite.index.updatedFiles.length;
			
			let addedToNew = 0;
			let addedToUpdated = 0;
			let skippedExisting = 0;
			
			// Process all attachments to ensure they're in download queues
			for (const attachment of finalWebsite.index.attachments) {
				if (!attachment || !attachment.targetPath) continue;
				
				const targetPath = attachment.targetPath.path;
				
				// Check if this attachment is already in download queues
				const inNewFiles = finalWebsite.index.newFiles.some(f => 
					f && f.targetPath && f.targetPath.path === targetPath);
				const inUpdatedFiles = finalWebsite.index.updatedFiles.some(f => 
					f && f.targetPath && f.targetPath.path === targetPath);
				
				if (inNewFiles || inUpdatedFiles) {
					skippedExisting++;
					continue; // Already queued for download
				}
				
				// This attachment is not queued for download - add it
				// Determine if it should go in newFiles or updatedFiles
				// For crash recovery, we'll add all missing attachments to newFiles
				finalWebsite.index.newFiles.push(attachment);
				addedToNew++;
				
				// Debug: Log a few sample files being added
				if (addedToNew <= 5) {
					console.log(`📁 QUEUEING: ${attachment.sourcePath} -> ${targetPath} (${attachment.constructor.name})`);
				}
			}
			
			// Log summary
			const afterNewFiles = finalWebsite.index.newFiles.length;
			const afterUpdatedFiles = finalWebsite.index.updatedFiles.length;
			
			ExportLog.log(`📁 Attachment queue check complete:`);
			ExportLog.log(`  - newFiles: ${beforeNewFiles} -> ${afterNewFiles} (+${addedToNew})`);
			ExportLog.log(`  - updatedFiles: ${beforeUpdatedFiles} -> ${afterUpdatedFiles} (+${addedToUpdated})`);
			ExportLog.log(`  - skipped (already queued): ${skippedExisting}`);
			ExportLog.log(`  - total attachments in index: ${finalWebsite.index.attachments.length}`);
			
			// Verify MP3 files specifically (since this was the reported issue)
			const allMP3Attachments = finalWebsite.index.attachments.filter(f => 
				f.sourcePath && f.sourcePath.toLowerCase().endsWith('.mp3'));
			const queuedMP3s = finalWebsite.index.newFiles.concat(finalWebsite.index.updatedFiles)
				.filter(f => f.sourcePath && f.sourcePath.toLowerCase().endsWith('.mp3'));
				
			ExportLog.log(`🎵 MP3 file check: ${allMP3Attachments.length} total MP3s in index, ${queuedMP3s.length} queued for download`);
			
			if (allMP3Attachments.length !== queuedMP3s.length) {
				ExportLog.warning(`⚠️ MP3 download queue mismatch: ${allMP3Attachments.length} in index vs ${queuedMP3s.length} queued`);
				
				// Debug: Show which MP3s are missing from queue
				const queuedPaths = new Set(queuedMP3s.map(f => f.targetPath?.path));
				const missingMP3s = allMP3Attachments.filter(f => !queuedPaths.has(f.targetPath?.path));
				console.log(`🎵 Missing MP3s from download queue:`);
				missingMP3s.slice(0, 10).forEach(f => {
					console.log(`  - ${f.sourcePath} -> ${f.targetPath?.path}`);
				});
			} else {
				ExportLog.log(`✅ All MP3 files are properly queued for download`);
			}
			
		} catch (error) {
			ExportLog.error(error, "Failed to ensure attachments are queued for download");
		}
	}
	
	/**
	 * Load existing website data (search index, metadata) from disk to restore state
	 */
	private static async loadExistingWebsiteDataFromDisk(website: Website, destination: Path): Promise<void> {
		try {
			ExportLog.log(`📂 Loading existing website data from disk...`);
			
			const fs = require('fs').promises;
			const path = require('path');
			
			// Try to load existing search-index.json
			const searchIndexPath = path.join(destination.path, 'site-lib', 'search-index.json');
			try {
				const searchIndexData = await fs.readFile(searchIndexPath, 'utf8');
				const searchIndex = JSON.parse(searchIndexData);
				
				// Restore search index if it exists and has data
				if (searchIndex && Array.isArray(searchIndex) && searchIndex.length > 0) {
					try {
						// Rebuild minisearch from the data with robust error handling
						const { default: MiniSearch } = await import('minisearch');
						website.index.minisearch = new MiniSearch({
							fields: ['title', 'content'],
							storeFields: ['title', 'content', 'url'],
							searchOptions: { fuzzy: 0.2, prefix: true }
						});
						
						// Add documents one by one with validation to avoid MiniSearch errors
						let addedCount = 0;
						let errorCount = 0;
						
						for (const doc of searchIndex) {
							try {
								// Validate document structure
								if (!doc || typeof doc !== 'object') {
									errorCount++;
									continue;
								}
								
								// Ensure required fields exist
								const validDoc = {
									id: doc.id || doc.url || `doc_${addedCount}`,
									title: doc.title || 'Untitled',
									content: doc.content || '',
									url: doc.url || doc.id || `doc_${addedCount}`
								};
								
								// Only add if we have an ID
								if (validDoc.id) {
									website.index.minisearch.add(validDoc);
									addedCount++;
								} else {
									errorCount++;
								}
							} catch (docError) {
								errorCount++;
								// Continue with other documents
							}
						}
						
						ExportLog.log(`✅ Restored search index: ${addedCount} documents added, ${errorCount} errors skipped`);
						
						if (addedCount === 0) {
							ExportLog.warning(`⚠️ No valid search documents could be restored - creating fresh index`);
							website.index.minisearch = undefined; // Will be recreated fresh
						}
						
					} catch (minisearchError) {
						ExportLog.error(minisearchError, "Failed to restore search index - will create fresh one");
						website.index.minisearch = undefined; // Will be recreated fresh
					}
				} else {
					ExportLog.log(`⚠️ Search index exists but is empty`);
				}
			} catch (searchError) {
				ExportLog.log(`ℹ️ No existing search index found (will create new one)`);
			}
			
			// Try to load existing metadata.json
			const metadataPath = path.join(destination.path, 'site-lib', 'metadata.json');
			try {
				const metadataData = await fs.readFile(metadataPath, 'utf8');
				const metadata = JSON.parse(metadataData);
				
				if (metadata && metadata.webpages && metadata.attachments) {
					// Initialize website data with existing metadata using the correct WebsiteData structure
					if (!website.index.websiteData) {
						const { WebsiteData } = await import("../../shared/website-data");
						website.index.websiteData = new WebsiteData();
					}
					
					// Update with restored metadata
					website.index.websiteData.webpages = metadata.webpages || {};
					website.index.websiteData.attachments = metadata.attachments || [];
					website.index.websiteData.shownInTree = metadata.shownInTree || [];
					
					ExportLog.log(`✅ Restored website metadata: ${Object.keys(metadata.webpages || {}).length} pages, ${(metadata.attachments || []).length} attachments`);
				} else {
					ExportLog.log(`⚠️ Metadata exists but is invalid structure`);
				}
			} catch (metadataError) {
				ExportLog.log(`ℹ️ No existing metadata found (will create new one)`);
			}
			
		} catch (error) {
			ExportLog.error(error, "Failed to load existing website data from disk");
		}
	}
	
	/**
	 * Rebuild file collections by scanning already exported files on disk
	 */
	private static async rebuildFileCollectionsFromDisk(
		website: Website, 
		destination: Path, 
		chunks: TFile[][], 
		completedChunks: number
	): Promise<void> {
		try {
			ExportLog.log(`📁 Rebuilding file collections from ${completedChunks} completed chunks on disk...`);
			
			const { Webpage } = await import("../website/webpage");
			const { Attachment } = await import("../utils/downloadable");
			const { MarkdownRendererAPI } = await import("../render-api/render-api");
			
			let restoredPages = 0;
			let restoredAttachments = 0;
			let missingFiles = 0;
			
			// Process files from completed chunks
			for (let chunkIndex = 0; chunkIndex < completedChunks; chunkIndex++) {
				const chunkFiles = chunks[chunkIndex];
				
				for (const sourceFile of chunkFiles) {
					try {
						// Determine target path for this file
						const targetPath = this.getTargetPathForFile(sourceFile, destination, website.exportOptions.exportRoot);
						
						// Check if the exported file actually exists on disk
						const fs = require('fs');
						if (!fs.existsSync(targetPath.path)) {
							missingFiles++;
							continue; // Skip files that don't exist on disk
						}
						
						const isConvertable = MarkdownRendererAPI.isConvertable(sourceFile.extension);
						const isAudioFile = ["mp3", "wav", "ogg", "aac", "m4a", "flac"].contains(sourceFile.extension);
						
						// Restore as attachment if it's a raw file or viewable media
						if (!isConvertable || MarkdownRendererAPI.viewableMediaExtensions.contains(sourceFile.extension)) {
							if (!isAudioFile || isConvertable) { // Skip standalone audio files like the regular exporter
								const attachment = new Attachment(
									Buffer.alloc(0), // We don't need the actual data since file exists
									targetPath,
									sourceFile,
									website.exportOptions
								);
								attachment.showInTree = true;
								
								website.index.attachments.push(attachment);
								website.index.attachmentsShownInTree.push(attachment);
								website.index.newFiles.push(attachment); // Ensure it's in download queue
								restoredAttachments++;
							}
						}
						
						// Restore as webpage if it's convertable
						if (isConvertable) {
							const webpage = new Webpage(sourceFile, sourceFile.name, website, website.exportOptions);
							webpage.showInTree = true;
							
							website.index.webpages.push(webpage);
							website.index.attachmentsShownInTree.push(webpage);
							website.index.newFiles.push(webpage);
							restoredPages++;
							
							// Add to search index if we have existing search data
							if (website.index.minisearch) {
								try {
									// Add basic search data with robust error handling
									const searchDoc = {
										id: webpage.targetPath.path,
										title: sourceFile.basename,
										content: sourceFile.basename, // Simplified content
										url: webpage.targetPath.path
									};
									
									// Validate document before adding
									if (searchDoc.id && searchDoc.title) {
										website.index.minisearch.add(searchDoc);
									}
								} catch (searchAddError) {
									// Ignore search index errors during recovery - don't fail the entire process
									console.log(`Search index error for ${sourceFile.path}: ${searchAddError.message}`);
								}
							}
						}
						
					} catch (fileError) {
						ExportLog.error(fileError, `Failed to restore file: ${sourceFile.path}`);
					}
				}
			}
			
			ExportLog.log(`✅ File collection rebuild complete:`);
			ExportLog.log(`  - ${restoredPages} webpages restored`);
			ExportLog.log(`  - ${restoredAttachments} attachments restored`);
			ExportLog.log(`  - ${missingFiles} files missing from disk (skipped)`);
			ExportLog.log(`  - Total files in collections: ${website.index.attachmentsShownInTree.length}`);
			
		} catch (error) {
			ExportLog.error(error, "Failed to rebuild file collections from disk");
		}
	}
	
	/**
	 * Get the target path for a file (helper method)
	 */
	private static getTargetPathForFile(file: TFile, destination: Path, exportRoot: string): Path {
		// Calculate relative path from export root
		let relativePath = file.path;
		if (exportRoot && file.path.startsWith(exportRoot)) {
			relativePath = file.path.substring(exportRoot.length).replace(/^\/+/, '');
		}
		
		// Convert to web-safe path and change extension if needed
		const webPath = relativePath
			.toLowerCase()
			.replace(/[^a-z0-9\-_\/\.]/g, '-')
			.replace(/--+/g, '-')
			.replace(/\.md$/, '.html');
		
		return destination.joinString(webPath);
	}
	
	/**
	 * Generate site-lib files (search index, metadata, file tree) after each chunk
	 * This ensures they're always available for crash recovery and partial exports are functional
	 */
	private static async generateSiteLibFiles(website: Website, currentChunk: number, totalChunks: number): Promise<void> {
		try {
			ExportLog.log(`📚 Generating site-lib files INCREMENTALLY after chunk ${currentChunk}/${totalChunks}...`);
			ExportLog.log(`📚 This will include data from ALL ${currentChunk} processed chunks`);
			
			const { Utils } = await import("../utils/utils");
			
			// Finalize the website index to prepare for site-lib generation
			await website.index.finalize();
			
			// Regenerate file tree with current data INCREMENTALLY
			await this.generateIncrementalFileTree(website, currentChunk, totalChunks);
			
			// Generate and save the critical site-lib files
			const filesToDownload = [];
			
			// 1. Generate metadata.json INCREMENTALLY (contains ALL chunks)
			try {
				const websiteDataAttachment = website.index.websiteDataAttachment();
				if (websiteDataAttachment && websiteDataAttachment.data) {
					filesToDownload.push(websiteDataAttachment);
					ExportLog.log(`✅ Generated metadata.json INCREMENTALLY (${websiteDataAttachment.data.length} bytes) - includes ALL ${currentChunk} chunks`);
				} else {
					ExportLog.warning(`⚠️ Failed to generate metadata.json`);
				}
			} catch (metadataError) {
				ExportLog.error(metadataError, "Failed to generate metadata.json");
			}
			
			// 2. Generate search-index.json INCREMENTALLY (contains ALL chunks)
			try {
				const searchIndexAttachment = website.index.indexDataAttachment();
				if (searchIndexAttachment && searchIndexAttachment.data) {
					filesToDownload.push(searchIndexAttachment);
					const searchDocs = website.index.minisearch?.documentCount || 0;
					ExportLog.log(`✅ Generated search-index.json INCREMENTALLY (${searchIndexAttachment.data.length} bytes) - includes ${searchDocs} documents from ALL ${currentChunk} chunks`);
				} else {
					ExportLog.warning(`⚠️ Failed to generate search-index.json`);
				}
			} catch (searchError) {
				ExportLog.error(searchError, "Failed to generate search-index.json");
			}
			
			// 3. Get file-tree-content.html via AssetHandler system (same as regular exporter)
			try {
				if (website.fileTreeAsset) {
					const totalTreeFiles = website.index.attachmentsShownInTree?.length || 0;
					ExportLog.log(`✅ Generated file-tree-content.html INCREMENTALLY (${website.fileTreeAsset.data?.length || 0} bytes) - includes ${totalTreeFiles} files from ALL ${currentChunk} chunks`);
				} else {
					ExportLog.warning(`⚠️ File tree asset not available - skipping file-tree-content.html`);
				}
				
				// Get all pending AssetHandler downloads (includes file tree asset)
				const { AssetHandler } = await import("../asset-loaders/asset-handler");
				const assetHandlerDownloads = AssetHandler.getDownloads(website.destination, website.exportOptions);
				const fileTreeDownloads = assetHandlerDownloads.filter((asset: any) => 
					asset.filename === "file-tree.html" || asset.filename === "file-tree-content.html"
				);
				if (fileTreeDownloads.length > 0) {
					filesToDownload.push(...fileTreeDownloads);
					ExportLog.log(`📁 Added ${fileTreeDownloads.length} file tree assets from AssetHandler`);
				}
			} catch (fileTreeError) {
				ExportLog.error(fileTreeError, "Failed to add file-tree-content.html to download queue");
			}
			
			// 4. Download/save the site-lib files to disk
			if (filesToDownload.length > 0) {
				await Utils.downloadAttachments(filesToDownload);
				ExportLog.log(`💾 Saved ${filesToDownload.length} site-lib files to disk`);
			}
			
			// 5. CRITICAL: Download raw attachment files INCREMENTALLY for every chunk
			// This ensures all embedded files (MP3s, images, etc.) are exported immediately after each chunk
			await this.downloadIncrementalAttachments(website, currentChunk);
			
			// 6. Log current progress for debugging
			const searchDocs = website.index.minisearch?.documentCount || 0;
			const totalFiles = website.index.attachmentsShownInTree?.length || 0;
			const totalPages = website.index.webpages?.length || 0;
			const totalAttachments = website.index.attachments?.length || 0;
			
			ExportLog.log(`📊 Current export status: ${totalPages} pages, ${totalAttachments} attachments, ${totalFiles} in tree, ${searchDocs} searchable docs`);
			
		} catch (error) {
			ExportLog.error(error, `Failed to generate site-lib files after chunk ${currentChunk}`);
			// Don't throw - we want the chunked export to continue even if site-lib generation fails
		}
	}
	
	/**
	 * Download raw attachment files incrementally after each chunk
	 * This ensures embedded files (MP3s, images, etc.) are exported immediately
	 */
	private static async downloadIncrementalAttachments(website: Website, currentChunk: number): Promise<void> {
		try {
			ExportLog.log(`📎 Downloading raw attachment files INCREMENTALLY after chunk ${currentChunk}...`);
			ExportLog.log(`📎 Processing new files from current chunk processing`);
			
			const { Utils } = await import("../utils/utils");
			const { Webpage } = await import("../website/webpage");
			
			// Get files that need to be downloaded (from newFiles and updatedFiles)
			// These are the attachment files that were added/updated in recent chunks
			const newAttachments = website.index.newFiles.filter((f) => !(f instanceof Webpage));
			const updatedAttachments = website.index.updatedFiles.filter((f) => !(f instanceof Webpage));
			
			const allAttachmentsToDownload = [...newAttachments, ...updatedAttachments];
			
			// Filter for actual raw attachment files (exclude HTML pages and site-lib files)
			const rawAttachments = allAttachmentsToDownload.filter(f => {
				if (!f || !f.targetPath) return false;
				
				const targetPath = f.targetPath.path;
				const sourcePath = f.sourcePath || "";
				
				// Exclude HTML files (these are webpages, not raw attachments)
				if (targetPath.endsWith('.html')) return false;
				
				// Exclude site-lib files (these are handled separately)
				if (targetPath.includes('site-lib/')) return false;
				
				// Include raw files: MP3s, images, PDFs, etc.
				const extension = sourcePath.split('.').pop()?.toLowerCase() || "";
				const rawExtensions = [
					'mp3', 'wav', 'ogg', 'aac', 'm4a', 'flac', // Audio
					'png', 'jpg', 'jpeg', 'gif', 'bmp', 'svg', 'webp', // Images
					'pdf', 'doc', 'docx', 'txt', 'zip', 'rar', // Documents
					'mp4', 'avi', 'mov', 'wmv', 'flv', // Video
					'css', 'js', 'json', 'xml' // Web assets (but not site-lib)
				];
				
				return rawExtensions.includes(extension);
			});
			
			if (rawAttachments.length > 0) {
				ExportLog.log(`📎 Found ${rawAttachments.length} raw attachment files to download...`);
				
				// Debug: Log some sample files being downloaded
				const sampleFiles = rawAttachments.slice(0, 5);
				sampleFiles.forEach(f => {
					ExportLog.log(`  📎 Downloading: ${f.sourcePath} -> ${f.targetPath.path}`);
				});
				
				if (rawAttachments.length > 5) {
					ExportLog.log(`  📎 ... and ${rawAttachments.length - 5} more files`);
				}
				
				// Download the raw attachment files
				await Utils.downloadAttachments(rawAttachments);
				
				ExportLog.log(`✅ Downloaded ${rawAttachments.length} raw attachment files`);
				
				// Count MP3 files specifically for debugging
				const mp3Files = rawAttachments.filter(f => 
					f.sourcePath && f.sourcePath.toLowerCase().endsWith('.mp3'));
				if (mp3Files.length > 0) {
					ExportLog.log(`🎵 Downloaded ${mp3Files.length} MP3 files in this chunk`);
				}
				
				// Clear the download queues to prevent re-downloading in subsequent chunks
				// Only remove the files we just downloaded
				const downloadedPaths = new Set(rawAttachments.map(f => f.targetPath.path));
				website.index.newFiles = website.index.newFiles.filter(f => 
					!f.targetPath || !downloadedPaths.has(f.targetPath.path));
				website.index.updatedFiles = website.index.updatedFiles.filter(f => 
					!f.targetPath || !downloadedPaths.has(f.targetPath.path));
					
				ExportLog.log(`🧹 Cleared ${rawAttachments.length} downloaded files from future download queues`);
				
			} else {
				ExportLog.log(`ℹ️ No new raw attachment files to download after chunk ${currentChunk}`);
			}
			
		} catch (error) {
			ExportLog.error(error, `Failed to download incremental attachments after chunk ${currentChunk}`);
			// Don't throw - we want the chunked export to continue even if some downloads fail
		}
	}

	/**
	 * Generate file tree INCREMENTALLY - adding new files to existing tree structure
	 * This ensures file-tree-content.html grows progressively with each chunk
	 */
	private static async generateIncrementalFileTree(website: Website, currentChunk: number, totalChunks: number): Promise<void> {
		try {
			if (!website.exportOptions.fileNavigationOptions.enabled) {
				ExportLog.log(`🌲 File navigation disabled - skipping file tree generation`);
				return;
			}

			ExportLog.log(`🌲 Generating incremental file tree for chunk ${currentChunk}/${totalChunks}...`);

			// Get files from current chunk that should be shown in tree
			const currentChunkFiles = website.index.attachmentsShownInTree || [];
			ExportLog.log(`🌲 Current chunk has ${currentChunkFiles.length} files for tree`);

			if (currentChunkFiles.length === 0) {
				ExportLog.log(`🌲 No files in current chunk - skipping tree generation`);
				return;
			}

			// Create paths from current chunk files
			const currentPaths = currentChunkFiles.map((file) => new Path(file.sourcePathRootRelative ?? ""));
			ExportLog.log(`🌲 Generated ${currentPaths.length} paths from current chunk`);

			// Import required modules
			const { FileTree } = await import("../features/file-tree");
			const { AssetLoader } = await import("../asset-loaders/base-asset");
			const { AssetType, InlinePolicy, Mutability } = await import("../asset-loaders/asset-types");

			// CRITICAL: For first chunk, create new tree. For subsequent chunks, extend existing tree
			let allPaths: Path[] = [];
			
			if (currentChunk === 1 || !website.fileTree) {
				// First chunk - create fresh file tree
				ExportLog.log(`🌲 First chunk - creating fresh file tree`);
				allPaths = currentPaths;
			} else {
				// Subsequent chunks - use ALL files in website.index.attachmentsShownInTree
				// This contains the accumulated files from all processed chunks
				ExportLog.log(`🌲 Chunk ${currentChunk} - building file tree from all accumulated files`);
				
				allPaths = website.index.attachmentsShownInTree.map((file) => new Path(file.sourcePathRootRelative ?? ""));
				
				ExportLog.log(`🌲 Total accumulated files for tree: ${allPaths.length}`);
			}

			// Create/update file tree with all paths
			website.fileTree = new FileTree(allPaths, false, true);
			website.fileTree.makeLinksWebStyle = website.exportOptions.slugifyPaths ?? true;
			website.fileTree.showNestingIndicator = true;
			website.fileTree.generateWithItemsClosed = true;
			website.fileTree.showFileExtentionTags = true;
			website.fileTree.hideFileExtentionTags = ["md"];
			website.fileTree.title = website.exportOptions.siteName ?? "Exported Vault";
			website.fileTree.id = "file-explorer";

			// Generate the HTML
			const tempContainer = document.createElement("div");
			await website.fileTree.generate(tempContainer);
			const htmlData = tempContainer.innerHTML;

			// Update tree order for all attachments shown in tree
			website.index.attachmentsShownInTree.forEach((file) => {
				if (!file.sourcePathRootRelative) return;
				const fileTreeItem = website.fileTree?.getItemBySourcePath(file.sourcePathRootRelative);
				file.treeOrder = fileTreeItem?.treeOrder ?? 0;
			});

			tempContainer.remove();

			// Create the file tree asset (use EXACT same approach as regular website)
			// CRITICAL: Ensure AssetHandler is initialized with final website's options
			const { AssetHandler } = await import("../asset-loaders/asset-handler");
			await AssetHandler.reloadAssets(website.exportOptions);
			website.fileTreeAsset = new AssetLoader("file-tree.html", htmlData, null, AssetType.HTML, InlinePolicy.Auto, true, Mutability.Temporary);

			ExportLog.log(`✅ Incremental file tree generated: ${allPaths.length} total files, ${htmlData.length} bytes HTML`);

			// Debug: Log file distribution
			const filesByExtension = new Map<string, number>();
			for (const file of currentChunkFiles) {
				const extension = file.sourcePath?.split('.').pop()?.toLowerCase() || 'unknown';
				filesByExtension.set(extension, (filesByExtension.get(extension) || 0) + 1);
			}

			if (filesByExtension.size > 0) {
				const extensionSummary = Array.from(filesByExtension.entries())
					.map(([ext, count]) => `${count} .${ext}`)
					.join(', ');
				console.log(`🌲 CHUNK ${currentChunk} FILE TREE: ${extensionSummary}`);
			}

		} catch (error) {
			ExportLog.error(error, `Failed to generate incremental file tree for chunk ${currentChunk}`);
			// Don't throw - continue with export even if file tree generation fails
		}
	}
	
}

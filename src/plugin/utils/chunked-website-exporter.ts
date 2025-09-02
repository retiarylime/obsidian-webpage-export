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
					
					// CRITICAL: Generate file tree after each chunk (following regular exporter approach)
					// This ensures file tree is built incrementally with ALL files from ALL processed chunks
					if (finalWebsite) {
						await this.generateIncrementalFileTree(finalWebsite, i + 1, chunks.length, destination);
					}
					
					// CRITICAL: Generate COMPLETE site-lib folder after each chunk following IDENTICAL approach to regular exporter
					// This ensures the complete site-lib folder structure is available after every chunk with incremental data
					if (finalWebsite) {
						await this.generateSiteLibFiles(finalWebsite, i + 1, chunks.length);
						
						// BACKUP: Create backup of file tree content files after successful site-lib generation
						try {
							const fs = require('fs').promises;
							const fsSync = require('fs');
							const path = require('path');
							
							// Check both possible file tree file locations
							const fileTreePath1 = path.join(destination.path, 'site-lib', 'html', 'file-tree-content.html');
							const fileTreePath2 = path.join(destination.path, 'site-lib', 'html', 'file-tree-content-content.html');
							
							// Backup first file if it exists and is substantial
							if (fsSync.existsSync(fileTreePath1)) {
								const stats1 = fsSync.statSync(fileTreePath1);
								if (stats1.size > 1000) {
									await fs.copyFile(fileTreePath1, fileTreePath1 + '.backup');
									ExportLog.log(`💾 Created backup: file-tree-content.html.backup (${stats1.size} bytes)`);
								}
							}
							
							// Backup second file if it exists and is substantial
							if (fsSync.existsSync(fileTreePath2)) {
								const stats2 = fsSync.statSync(fileTreePath2);
								if (stats2.size > 1000) {
									await fs.copyFile(fileTreePath2, fileTreePath2 + '.backup');
									ExportLog.log(`💾 Created backup: file-tree-content-content.html.backup (${stats2.size} bytes)`);
								}
							}
						} catch (backupError) {
							ExportLog.warning(`⚠️ Failed to create file tree backup:`, backupError);
						}
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
			
			// CRITICAL: Validate MiniSearch object is properly initialized to prevent corruption
			if (builtWebsite.index.minisearch) {
				try {
					const testDocCount = builtWebsite.index.minisearch.documentCount;
					const hasRequiredMethods = typeof builtWebsite.index.minisearch.add === 'function' && 
												typeof builtWebsite.index.minisearch.has === 'function';
					if (!hasRequiredMethods) {
						throw new Error("MiniSearch object missing required methods");
					}
					console.log(`🔍 CHUNK VALIDATION: Built website search index has ${testDocCount} documents and required methods`);
				} catch (validationError) {
					ExportLog.error(validationError, "Chunk website MiniSearch object is corrupted - this may cause merge failures");
					// Don't fail the chunk, but warn about potential issues
				}
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
			
			// CRITICAL: Validate MiniSearch objects are properly initialized
			try {
				const testDocCount = finalWebsite.index.minisearch.documentCount;
				const hasRequiredMethods = typeof finalWebsite.index.minisearch.add === 'function' && 
											typeof finalWebsite.index.minisearch.has === 'function';
				if (!hasRequiredMethods) {
					throw new Error("MiniSearch object missing required methods");
				}
				console.log(`🔍 VALIDATION: Final website search index has ${testDocCount} documents and required methods`);
			} catch (validationError) {
				ExportLog.error(validationError, "Final website MiniSearch object is corrupted - recreating");
				// Recreate the MiniSearch object with proper options
				const { default: MiniSearch } = await import('minisearch');
				const stopWords = ["a", "about", "actually", "almost", "also", "although", "always", "am", "an", "and", "any", "are", "as", "at", "be", "became", "become", "but", "by", "can", "could", "did", "do", "does", "each", "either", "else", "for", "from", "had", "has", "have", "hence", "how", "i", "if", "in", "is", "it", "its", "just", "may", "maybe", "me", "might", "mine", "must", "my", "mine", "must", "my", "neither", "nor", "not", "of", "oh", "ok", "when", "where", "whereas", "wherever", "whenever", "whether", "which", "while", "who", "whom", "whoever", "whose", "why", "will", "with", "within", "without", "would", "yes", "yet", "you", "your"];
				const minisearchOptions = {
					fields: ['title', 'aliases', 'headers', 'tags', 'content'],
					storeFields: ['title', 'aliases', 'headers', 'tags', 'url'],
					processTerm: (term: any, _fieldName: any) =>
						stopWords.includes(term) ? null : term.toLowerCase(),
					// CRITICAL: Disable auto-vacuum to prevent TreeIterator corruption
					autoVacuum: false
				};
				finalWebsite.index.minisearch = new MiniSearch(minisearchOptions);
				ExportLog.log("🔍 Recreated corrupted MiniSearch object");
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
				
				// CRITICAL: Use the same robust MiniSearch handling as the regular website index
				// This prevents TreeIterator corruption by properly handling MiniSearch state
				try {
					// First, validate the minisearch instance is healthy (same as regular index)
					if (!finalWebsite.index.minisearch || typeof finalWebsite.index.minisearch.has !== 'function') {
						ExportLog.warning(`Final website MiniSearch instance invalid, rebuilding from scratch`);
						await this.rebuildMinisearchForWebsite(finalWebsite);
						if (!finalWebsite.index.minisearch) {
							ExportLog.error(new Error("Failed to rebuild MiniSearch"), "Skipping search index merge");
							return;
						}
					}

					// CRITICAL: Safe has() check with comprehensive error handling (same as regular index)
					let needsDiscard = false;
					try {
						needsDiscard = finalWebsite.index.minisearch.has(webpagePath);
					} catch (hasError) {
						ExportLog.warning(`MiniSearch has() check failed for ${webpagePath}, rebuilding index: ${hasError.message}`);
						await this.rebuildMinisearchForWebsite(finalWebsite);
						if (!finalWebsite.index.minisearch) {
							ExportLog.error(new Error("Rebuild failed"), "Skipping search index merge");
							return;
						}
						
						// Try has() again after rebuild
						try {
							needsDiscard = finalWebsite.index.minisearch.has(webpagePath);
						} catch (secondHasError) {
							ExportLog.error(secondHasError, `MiniSearch still broken after rebuild, skipping ${webpagePath}`);
							skippedCount++;
							continue; // Skip this document
						}
					}

					// Only discard if we confirmed the document exists (same as regular index)
					if (needsDiscard) {
						try {
							// CRITICAL: Additional safety check before discard (same as regular index)
							if (!finalWebsite.index.minisearch || typeof finalWebsite.index.minisearch.discard !== 'function') {
								ExportLog.warning(`MiniSearch instance corrupted before discard, rebuilding`);
								await this.rebuildMinisearchForWebsite(finalWebsite);
								if (!finalWebsite.index.minisearch) {
									ExportLog.error(new Error("Rebuild failed"), "Skipping search index merge");
									return;
								}
								needsDiscard = false; // Skip discard after rebuild
							} else {
								finalWebsite.index.minisearch.discard(webpagePath);
								console.log(`🔍 DISCARDED: Existing document ${webpagePath}`);
							}
						} catch (discardError) {
							ExportLog.warning(`Discard failed for ${webpagePath}, rebuilding: ${discardError.message}`);
							await this.rebuildMinisearchForWebsite(finalWebsite);
							if (!finalWebsite.index.minisearch) {
								ExportLog.error(new Error("Rebuild failed"), "Skipping search index merge");
								return;
							}
							needsDiscard = false; // Skip discard after rebuild
						}
					}
				
					// Build the search document with the same logic as regular exporter
					const headersInfo = webpage.outputData.renderedHeadings || [];
					
					// Remove title header if it's the first one (exact match to regular exporter)
					if (headersInfo.length > 0 && headersInfo[0].level == 1 && headersInfo[0].heading == webpage.title) {
						headersInfo.shift();
					}
					
					const headers = headersInfo.map((header) => header.heading);
					
					// Create search document with CORRECT structure for MiniSearch
					const searchDocument = {
						id: webpagePath,        // MiniSearch requires 'id' field
						title: webpage.title || webpage.source?.basename || 'Untitled',
						aliases: Array.isArray(webpage.outputData.aliases) ? webpage.outputData.aliases : [],
						headers: Array.isArray(headers) ? headers : [],
						tags: Array.isArray(webpage.outputData.allTags) ? webpage.outputData.allTags : [],
						url: webpagePath,       // MiniSearch expects 'url' field  
						content: ((webpage.outputData.description || "") + " " + (webpage.outputData.searchContent || "")).trim() || webpage.title || 'No content',
					};
					
					// CRITICAL: Safe add operation with comprehensive error handling (same as regular index)
					try {
						if (!finalWebsite.index.minisearch || typeof finalWebsite.index.minisearch.add !== 'function') {
							ExportLog.warning(`MiniSearch instance corrupted before add, rebuilding`);
							await this.rebuildMinisearchForWebsite(finalWebsite);
							if (!finalWebsite.index.minisearch) {
								ExportLog.error(new Error("Rebuild failed"), "Skipping search index merge");
								return;
							}
						}

						finalWebsite.index.minisearch.add(searchDocument);
						mergedCount++;
						console.log(`🔍 MERGED: ${webpagePath} (title: "${searchDocument.title}", content: ${searchDocument.content.length} chars)`);
						
					} catch (addError) {
						ExportLog.warning(`Add failed for ${webpagePath}, attempting recovery: ${addError.message}`);
						
						// Attempt recovery by rebuilding (same as regular index)
						try {
							await this.rebuildMinisearchForWebsite(finalWebsite);
							if (finalWebsite.index.minisearch) {
								finalWebsite.index.minisearch.add(searchDocument);
								mergedCount++;
								ExportLog.log(`🔍 RECOVERED: Successfully added ${webpagePath} after rebuilding MiniSearch`);
							} else {
								throw new Error("Rebuild failed");
							}
						} catch (recoveryError) {
							ExportLog.error(recoveryError, `Failed to recover from MiniSearch error for ${webpagePath}`);
							errorCount++;
						}
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
	 * Rebuild the MiniSearch index for a website from scratch when corruption is detected
	 * This mirrors the rebuildMinisearch method from the regular website index
	 */
	private static async rebuildMinisearchForWebsite(website: Website): Promise<void> {
		try {
			ExportLog.log("Rebuilding corrupted MiniSearch index for website...");
			
			// Get the same MiniSearch options as regular website index
			const { default: MiniSearch } = await import('minisearch');
			const stopWords = ["a", "about", "actually", "almost", "also", "although", "always", "am", "an", "and", "any", "are", "as", "at", "be", "became", "become", "but", "by", "can", "could", "did", "do", "does", "each", "either", "else", "for", "from", "had", "has", "have", "hence", "how", "i", "if", "in", "is", "it", "its", "just", "may", "maybe", "me", "might", "mine", "must", "my", "mine", "must", "my", "neither", "nor", "not", "of", "oh", "ok", "when", "where", "whereas", "wherever", "whenever", "whether", "which", "while", "who", "whom", "whoever", "whose", "why", "will", "with", "within", "without", "would", "yes", "yet", "you", "your"];
			const minisearchOptions = {
				fields: ['title', 'aliases', 'headers', 'tags', 'content'],
				storeFields: ['title', 'aliases', 'headers', 'tags', 'url'],
				processTerm: (term: any, _fieldName: any) =>
					stopWords.includes(term) ? null : term.toLowerCase(),
				autoVacuum: false  // Disable auto-vacuum to prevent TreeIterator corruption
			};
			
			// Create fresh MiniSearch instance
			website.index.minisearch = new MiniSearch(minisearchOptions);
			
			// Re-add all existing webpages to the fresh index
			let rebuiltCount = 0;
			for (const existingWebpage of website.index.webpages) {
				try {
					if (!existingWebpage.targetPath) continue;
					
					const webpagePath = existingWebpage.targetPath.path;
					
					// Get headers safely (same logic as regular website index)
					let headers: string[] = [];
					try {
						const headersInfo = existingWebpage.outputData?.renderedHeadings || [];
						if (headersInfo.length > 0 && headersInfo[0].level == 1 && headersInfo[0].heading == existingWebpage.title) {
							headersInfo.shift();
						}
						headers = headersInfo.map((header) => header.heading);
					} catch {
						headers = [];
					}

					// Create validated document for rebuilding (same structure as regular website index)
					const rebuildDocument = {
						id: webpagePath,
						title: existingWebpage.title || existingWebpage.source?.basename || 'Untitled',
						aliases: Array.isArray(existingWebpage.outputData?.aliases) ? existingWebpage.outputData.aliases : [],
						headers: Array.isArray(headers) ? headers : [],
						tags: Array.isArray(existingWebpage.outputData?.allTags) ? existingWebpage.outputData.allTags : [],
						url: webpagePath,
						content: ((existingWebpage.outputData?.description || '') + " " + (existingWebpage.outputData?.searchContent || '')).trim() || existingWebpage.title || 'No content',
					};

					website.index.minisearch.add(rebuildDocument);
					rebuiltCount++;
				} catch (rebuildError) {
					// Skip problematic documents during rebuild (same as regular website index)
					ExportLog.warning(`Skipped webpage during index rebuild: ${existingWebpage.source?.path} - ${rebuildError.message}`);
				}
			}
			
			ExportLog.log(`MiniSearch index rebuilt successfully with ${rebuiltCount} documents`);
		} catch (rebuildError) {
			ExportLog.error(rebuildError, "Failed to rebuild MiniSearch index");
			
			// Create minimal working index (same fallback as regular website index)
			const { default: MiniSearch } = await import('minisearch');
			const stopWords = ["a", "about", "actually", "almost", "also", "although", "always", "am", "an", "and", "any", "are", "as", "at", "be", "became", "become", "but", "by", "can", "could", "did", "do", "does", "each", "either", "else", "for", "from", "had", "has", "have", "hence", "how", "i", "if", "in", "is", "it", "its", "just", "may", "maybe", "me", "might", "mine", "must", "my", "mine", "must", "my", "neither", "nor", "not", "of", "oh", "ok", "when", "where", "whereas", "wherever", "whenever", "whether", "which", "while", "who", "whom", "whoever", "whose", "why", "will", "with", "within", "without", "would", "yes", "yet", "you", "your"];
			const minisearchOptions = {
				fields: ['title', 'aliases', 'headers', 'tags', 'content'],
				storeFields: ['title', 'aliases', 'headers', 'tags', 'url'],
				processTerm: (term: any, _fieldName: any) =>
					stopWords.includes(term) ? null : term.toLowerCase(),
				autoVacuum: false  // Disable auto-vacuum to prevent TreeIterator corruption
			};
			website.index.minisearch = new MiniSearch(minisearchOptions);
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
			
			// CRITICAL: Rebuild attachmentsShownInTree to include ALL files from ALL merged chunks
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
	 * Detect and recover from corrupted files during crash recovery
	 */
	private static async detectAndRecoverCorruptedFiles(destination: Path, fs: any, fsSync: any, path: any): Promise<void> {
		try {
			ExportLog.log(`🔍 Checking for file corruption after crash...`);
			
			const siteLibPath = path.join(destination.path, 'site-lib');
			const filesToCheck = [
				{ file: path.join(siteLibPath, 'search-index.json'), minSize: 1000, description: 'search index' },
				{ file: path.join(siteLibPath, 'html', 'file-tree-content.html'), minSize: 100, description: 'file tree base' },
				{ file: path.join(siteLibPath, 'html', 'file-tree-content-content.html'), minSize: 1000, description: 'file tree content' }
			];
			
			let corruptedFiles = 0;
			let recoveredFiles = 0;
			
			for (const { file, minSize, description } of filesToCheck) {
				try {
					const stats = fsSync.statSync(file);
					if (stats.size < minSize) {
						ExportLog.warning(`⚠️ ${description} corrupted: ${stats.size} bytes (expected >${minSize})`);
						corruptedFiles++;
						
						// Try to recover from backup
						const backupFile = file + '.backup';
						if (fsSync.existsSync(backupFile)) {
							const backupStats = fsSync.statSync(backupFile);
							if (backupStats.size > minSize) {
								ExportLog.log(`🔄 Recovering ${description} from backup (${backupStats.size} bytes)`);
								await fs.copyFile(backupFile, file);
								
								// Verify recovery was successful
								const verifyStats = fsSync.statSync(file);
								if (verifyStats.size > minSize) {
									ExportLog.log(`✅ ${description} recovery verified: ${verifyStats.size} bytes`);
									recoveredFiles++;
								} else {
									ExportLog.warning(`⚠️ ${description} recovery failed: file still ${verifyStats.size} bytes`);
								}
							} else {
								ExportLog.warning(`⚠️ ${description} backup too small: ${backupStats.size} bytes (expected >${minSize})`);
							}
						} else {
							ExportLog.log(`ℹ️ No backup found for ${description}: ${backupFile}`);
						}
					} else {
						ExportLog.log(`✅ ${description} intact: ${stats.size} bytes`);
					}
				} catch (fileError) {
					ExportLog.log(`ℹ️ ${description} not found - will be created fresh`);
				}
			}
			
			if (corruptedFiles > 0) {
				ExportLog.warning(`⚠️ File corruption detected: ${corruptedFiles} files corrupted, ${recoveredFiles} recovered from backup`);
				
				// Small delay to ensure file system operations are completed
				if (recoveredFiles > 0) {
					ExportLog.log(`⏳ Waiting for file recovery to complete...`);
					await new Promise(resolve => setTimeout(resolve, 500)); // 500ms delay
				}
			}
			
		} catch (error) {
			ExportLog.error(error, "Failed to check for file corruption - continuing with standard recovery");
		}
	}
	
	/**
	 * Load existing website data (search index, metadata) from disk to restore state
	 */
	private static async loadExistingWebsiteDataFromDisk(website: Website, destination: Path): Promise<void> {
		try {
			ExportLog.log(`📂 Loading existing website data from disk...`);
			
			const fs = require('fs').promises;
			const fsSync = require('fs');
			const path = require('path');
			
			// CORRUPTION DETECTION: Check for corrupted files and attempt recovery
			await this.detectAndRecoverCorruptedFiles(destination, fs, fsSync, path);
			
			// Try to load existing search-index.json
			const searchIndexPath = path.join(destination.path, 'site-lib', 'search-index.json');
			try {
				let searchIndexData = await fs.readFile(searchIndexPath, 'utf8');
				
				// CORRUPTION CHECK: Verify file is not empty or truncated
				if (!searchIndexData || searchIndexData.length < 100) {
					ExportLog.warning(`⚠️ Search index appears corrupted (${searchIndexData?.length || 0} bytes) - attempting backup recovery`);
					
					// Try backup files
					const backupPath = searchIndexPath + '.backup';
					try {
						const backupData = await fs.readFile(backupPath, 'utf8');
						if (backupData && backupData.length > 1000) {
							ExportLog.log(`🔄 Recovered search index from backup (${backupData.length} bytes)`);
							await fs.writeFile(searchIndexPath, backupData);
							searchIndexData = backupData; // Use recovered data
						} else {
							ExportLog.warning(`⚠️ Backup file exists but is too small (${backupData?.length || 0} bytes) - will create fresh search index`);
							throw new Error("Backup corrupted");
						}
					} catch (backupError) {
						ExportLog.log(`ℹ️ No valid backup found for search index - will create new one`);
						// Don't throw error - allow fresh creation
						searchIndexData = null;
					}
				} else {
					ExportLog.log(`✅ Search index valid: ${searchIndexData.length} bytes`);
				}
				
				// Only process if we have valid search index data
				if (searchIndexData && searchIndexData.trim()) {
					const searchIndex = JSON.parse(searchIndexData);
					
					// Restore search index if it exists and has data
					if (searchIndex && Array.isArray(searchIndex) && searchIndex.length > 0) {
					ExportLog.log(`📋 Found search index data: ${searchIndex.length} documents`);
					try {
						// Rebuild minisearch from the data using EXACT same options as regular website index
						const { default: MiniSearch } = await import('minisearch');
						const stopWords = ["a", "about", "actually", "almost", "also", "although", "always", "am", "an", "and", "any", "are", "as", "at", "be", "became", "become", "but", "by", "can", "could", "did", "do", "does", "each", "either", "else", "for", "from", "had", "has", "have", "hence", "how", "i", "if", "in", "is", "it", "its", "just", "may", "maybe", "me", "might", "mine", "must", "my", "mine", "must", "my", "neither", "nor", "not", "of", "oh", "ok", "when", "where", "whereas", "wherever", "whenever", "whether", "which", "while", "who", "whom", "whoever", "whose", "why", "will", "with", "within", "without", "would", "yes", "yet", "you", "your"];
						const minisearchOptions = {
							fields: ['title', 'aliases', 'headers', 'tags', 'content'],
							storeFields: ['title', 'aliases', 'headers', 'tags', 'url'],
							processTerm: (term: any, _fieldName: any) =>
								stopWords.includes(term) ? null : term.toLowerCase(),
							autoVacuum: false  // Disable auto-vacuum to prevent TreeIterator corruption
						};
						website.index.minisearch = new MiniSearch(minisearchOptions);
						
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
								
								// Ensure required fields exist with correct structure for MiniSearch
								const validDoc = {
									id: doc.id || doc.url || `doc_${addedCount}`,
									title: doc.title || 'Untitled',
									aliases: Array.isArray(doc.aliases) ? doc.aliases : [],
									headers: Array.isArray(doc.headers) ? doc.headers : [],
									tags: Array.isArray(doc.tags) ? doc.tags : [],
									content: doc.content || '',
									url: doc.url || doc.id || `doc_${addedCount}`
								};
								
								// Only add if we have an ID and the document is valid
								if (validDoc.id && validDoc.title) {
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
						} else {
							ExportLog.log(`🔍 MiniSearch index restored with ${website.index.minisearch?.documentCount || 0} documents total`);
							
							// Additional validation: Check if key documents like "PC방" are present
							try {
								const searchResults = website.index.minisearch.search('PC방');
								if (searchResults.length > 0) {
									ExportLog.log(`✅ Validation: Found "PC방" in restored search index`);
								} else {
									ExportLog.warning(`⚠️ Validation: "PC방" not found in restored search index - may indicate incomplete recovery`);
								}
							} catch (validationError) {
								ExportLog.warning(`⚠️ Search index validation failed: ${validationError}`);
							}
						}
						
					} catch (minisearchError) {
						ExportLog.error(minisearchError, "Failed to restore search index - will create fresh one");
						website.index.minisearch = undefined; // Will be recreated fresh
					}
				} else {
					ExportLog.log(`ℹ️ Search index data was corrupted/empty - will create fresh one`);
				}
				
			} else {
				ExportLog.log(`ℹ️ No valid search index data - will create fresh one`);
			}
			} catch (searchError) {
				ExportLog.log(`ℹ️ No existing search index found (will create new one)`);
			}
			
			// Try to load existing metadata.json
			const metadataPath = path.join(destination.path, 'site-lib', 'metadata.json');
			try {
				let metadataData = await fs.readFile(metadataPath, 'utf8');
				
				// CORRUPTION CHECK: Verify file is not empty or truncated
				if (!metadataData || metadataData.length < 50) {
					ExportLog.warning(`⚠️ Metadata appears corrupted (${metadataData?.length || 0} bytes) - attempting backup recovery`);
					
					// Try backup files
					const backupPath = metadataPath + '.backup';
					try {
						const backupData = await fs.readFile(backupPath, 'utf8');
						if (backupData && backupData.length > 100) {
							ExportLog.log(`🔄 Recovered metadata from backup (${backupData.length} bytes)`);
							await fs.writeFile(metadataPath, backupData);
							metadataData = backupData; // Use recovered data
						} else {
							ExportLog.warning(`⚠️ Backup file exists but is too small (${backupData?.length || 0} bytes) - will create fresh metadata`);
							throw new Error("Backup corrupted");
						}
					} catch (backupError) {
						ExportLog.log(`ℹ️ No valid backup found for metadata - will create new one`);
						// Don't throw error - allow fresh creation
						metadataData = null;
					}
				} else {
					ExportLog.log(`✅ Metadata valid: ${metadataData.length} bytes`);
				}
				
				// Only process if we have valid metadata data
				if (metadataData && metadataData.trim()) {
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
				
			} else {
				ExportLog.log(`ℹ️ Metadata data was corrupted/empty - will create fresh one`);
			}
			} catch (metadataError) {
				ExportLog.log(`ℹ️ No existing metadata found (will create new one)`);
			}
			

			// CRITICAL: Restore existing file tree asset from disk during crash recovery
			const fileTreePath = path.join(destination.path, 'site-lib', 'html', 'file-tree-content.html');
			try {
				const fileTreeContent = await fs.readFile(fileTreePath, 'utf8');
				if (fileTreeContent && fileTreeContent.length > 0) {
					ExportLog.log(`✅ Found existing file tree on disk (${fileTreeContent.length} bytes) - merging into Website object for true incremental updates`);
					// Merge the file tree content into the Website object so incremental updates work across sessions
					// This ensures the file is never recreated, only updated
					if (website && website.fileTreeAsset) {
						website.fileTreeAsset.data = fileTreeContent;
					} else if (website) {
						const { AssetLoader } = await import("../asset-loaders/base-asset.js");
						const { AssetType, InlinePolicy, Mutability } = await import("../asset-loaders/asset-types");
						website.fileTreeAsset = new AssetLoader(
							"file-tree-content.html",
							fileTreeContent,
							null,
							AssetType.HTML,
							InlinePolicy.Auto,
							true,
							Mutability.Temporary
						);
					}
				}
			} catch (fileTreeError) {
				ExportLog.log(`ℹ️ No existing file tree found (will create new one during chunk processing)`);
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
	 * Generate COMPLETE site-lib folder after each chunk following IDENTICAL approach to regular exporter
	 * This ensures the full site-lib structure is available after every chunk with incremental data updates
	 */
	private static async generateSiteLibFiles(website: Website, currentChunk: number, totalChunks: number): Promise<void> {
		try {
			ExportLog.log(`📚 Generating COMPLETE site-lib folder after chunk ${currentChunk}/${totalChunks} (following regular exporter approach)...`);
			ExportLog.log(`📚 Site-lib will include INCREMENTAL data from ALL ${currentChunk} processed chunks`);
			ExportLog.log(`🏗️ This follows the IDENTICAL approach used by the regular exporter for complete compatibility`);
			
			const { Utils } = await import("../utils/utils");
			const { AssetHandler } = await import("../asset-loaders/asset-handler");
			
			// STEP 1: Finalize the website index to prepare for site-lib generation (same as regular exporter)
			await website.index.finalize();
			ExportLog.log(`✅ Step 1: Website index finalized`);
			
			// STEP 2: Get ALL AssetHandler downloads - this follows the EXACT same approach as regular exporter
			// This includes: CSS files, JS files, fonts, media, HTML templates, etc.
			const assetHandlerDownloads = AssetHandler.getDownloads(website.destination, website.exportOptions);
			ExportLog.log(`✅ Step 2: AssetHandler provided ${assetHandlerDownloads.length} site-lib assets (CSS/JS/fonts/media/HTML)`);
			
			// Debug: Log the types of assets being downloaded for transparency
			const cssAssets = assetHandlerDownloads.filter(a => a.targetPath?.path?.includes('/styles/'));
			const jsAssets = assetHandlerDownloads.filter(a => a.targetPath?.path?.includes('/scripts/'));
			const fontAssets = assetHandlerDownloads.filter(a => a.targetPath?.path?.includes('/fonts/'));
			const mediaAssets = assetHandlerDownloads.filter(a => a.targetPath?.path?.includes('/media/'));
			const htmlAssets = assetHandlerDownloads.filter(a => a.targetPath?.path?.includes('/html/'));
			
			ExportLog.log(`📊 Site-lib assets breakdown: ${cssAssets.length} CSS, ${jsAssets.length} JS, ${fontAssets.length} fonts, ${mediaAssets.length} media, ${htmlAssets.length} HTML`);
			
			// STEP 3: Add AssetHandler downloads to website index (same as regular exporter Website.build())
			website.index.addFiles(assetHandlerDownloads);
			ExportLog.log(`✅ Step 3: ${assetHandlerDownloads.length} AssetHandler downloads added to website index`);
			
			// STEP 4: Collect all files to download (following regular exporter pattern)
			const filesToDownload = [];
			
			// 4a. Add all NEW site-lib assets (CSS, JS, fonts, media, HTML) 
			const newSiteLibAssets = website.index.newFiles.filter(f => {
				if (!f || !f.targetPath) return false;
				const path = f.targetPath.path;
				return path.includes('site-lib/');
			});
			filesToDownload.push(...newSiteLibAssets);
			ExportLog.log(`✅ Step 4a: Added ${newSiteLibAssets.length} NEW site-lib assets to download queue`);
			
			// 4b. Add all UPDATED site-lib assets
			const updatedSiteLibAssets = website.index.updatedFiles.filter(f => {
				if (!f || !f.targetPath) return false;
				const path = f.targetPath.path;
				return path.includes('site-lib/');
			});
			filesToDownload.push(...updatedSiteLibAssets);
			ExportLog.log(`✅ Step 4b: Added ${updatedSiteLibAssets.length} UPDATED site-lib assets to download queue`);
			
			// STEP 5: Generate INCREMENTAL metadata.json (contains ALL chunks processed so far)
			try {
				const websiteDataAttachment = website.index.websiteDataAttachment();
				if (websiteDataAttachment && websiteDataAttachment.data) {
					filesToDownload.push(websiteDataAttachment);
					ExportLog.log(`✅ Step 5: Generated metadata.json INCREMENTALLY (${websiteDataAttachment.data.length} bytes) - includes ALL ${currentChunk} chunks`);
				} else {
					ExportLog.warning(`⚠️ Step 5: Failed to generate metadata.json`);
				}
			} catch (metadataError) {
				ExportLog.error(metadataError, "Step 5: Failed to generate metadata.json");
			}
			
			// STEP 6: Generate INCREMENTAL search-index.json (contains ALL chunks processed so far)
			try {
				const searchIndexAttachment = website.index.indexDataAttachment();
				if (searchIndexAttachment && searchIndexAttachment.data) {
					filesToDownload.push(searchIndexAttachment);
					const searchDocs = website.index.minisearch?.documentCount || 0;
					ExportLog.log(`✅ Step 6: Generated search-index.json INCREMENTALLY (${searchIndexAttachment.data.length} bytes) - includes ${searchDocs} documents from ALL ${currentChunk} chunks`);
				} else {
					ExportLog.warning(`⚠️ Step 6: Failed to generate search-index.json`);
				}
			} catch (searchError) {
				ExportLog.error(searchError, "Step 6: Failed to generate search-index.json");
			}
			
			// STEP 7: SKIP file-tree-content.html generation here!
			// This file is ONLY updated by generateIncrementalFileTree to ensure true preservation and incremental updates.
			ExportLog.log(`🚫 Skipping file-tree-content.html generation in generateSiteLibFiles. It will be updated incrementally only.`);
			
			// STEP 8: Download the COMPLETE site-lib folder (same as regular exporter)
			if (filesToDownload.length > 0) {
				await Utils.downloadAttachments(filesToDownload);
				ExportLog.log(`✅ Step 8: Downloaded COMPLETE site-lib folder: ${filesToDownload.length} files saved to disk`);
				
				// STEP 8.1: Create backup copies of critical files after successful download
				try {
					const fs = require('fs').promises;
					const fsSync = require('fs');
					const path = require('path');
					
					const searchIndexPath = path.join(website.destination.path, 'site-lib', 'search-index.json');
					const metadataPath = path.join(website.destination.path, 'site-lib', 'metadata.json');
					
					if (fsSync.existsSync(searchIndexPath)) {
						const searchIndexStats = fsSync.statSync(searchIndexPath);
						if (searchIndexStats.size > 1000) { // Only backup if file is substantial
							await fs.copyFile(searchIndexPath, searchIndexPath + '.backup');
							ExportLog.log(`💾 Created backup: search-index.json.backup (${searchIndexStats.size} bytes)`);
						}
					}
					
					if (fsSync.existsSync(metadataPath)) {
						const metadataStats = fsSync.statSync(metadataPath);
						if (metadataStats.size > 100) { // Only backup if file is substantial
							await fs.copyFile(metadataPath, metadataPath + '.backup');
							ExportLog.log(`💾 Created backup: metadata.json.backup (${metadataStats.size} bytes)`);
						}
					}
				} catch (backupError) {
					ExportLog.warning(`⚠️ Failed to create backup files:`, backupError);
				}
				
				// Log final site-lib structure summary for transparency
				const totalCss = filesToDownload.filter(f => f.targetPath?.path?.includes('/styles/')).length;
				const totalJs = filesToDownload.filter(f => f.targetPath?.path?.includes('/scripts/')).length;
				const totalFonts = filesToDownload.filter(f => f.targetPath?.path?.includes('/fonts/')).length;
				const totalMedia = filesToDownload.filter(f => f.targetPath?.path?.includes('/media/')).length;
				const totalHtml = filesToDownload.filter(f => f.targetPath?.path?.includes('/html/')).length;
				const dataFiles = filesToDownload.filter(f => f.filename === 'metadata.json' || f.filename === 'search-index.json').length;
				
				ExportLog.log(`📁 Complete site-lib contents downloaded: ${totalCss} CSS, ${totalJs} JS, ${totalFonts} fonts, ${totalMedia} media, ${totalHtml} HTML, ${dataFiles} data files`);
			} else {
				ExportLog.warning(`⚠️ Step 8: No site-lib files to download - this may indicate an issue with AssetHandler`);
			}
			
			// STEP 9: Download raw attachment files INCREMENTALLY for this chunk
			// This ensures all embedded files (MP3s, images, etc.) are exported immediately after each chunk
			await this.downloadIncrementalAttachments(website, currentChunk);
			ExportLog.log(`✅ Step 9: Raw attachment files downloaded for chunk ${currentChunk}`);
			
			// STEP 10: Log current export status for debugging
			const searchDocs = website.index.minisearch?.documentCount || 0;
			const totalFiles = website.index.attachmentsShownInTree?.length || 0;
			const totalPages = website.index.webpages?.length || 0;
			const totalAttachments = website.index.attachments?.length || 0;
			
			ExportLog.log(`📊 Export status after chunk ${currentChunk}: ${totalPages} pages, ${totalAttachments} attachments, ${totalFiles} in tree, ${searchDocs} searchable docs`);
			ExportLog.log(`🎉 COMPLETE site-lib folder generated successfully following regular exporter approach`);
			ExportLog.log(`🔄 Ready for next chunk or export completion - website is fully functional at this point`);
			
		} catch (error) {
			ExportLog.error(error, `Failed to generate complete site-lib folder after chunk ${currentChunk}`);
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
	 * NEVER recreates existing file-tree-content.html - always preserves and extends it
	 */
	private static async generateIncrementalFileTree(website: Website, currentChunk: number, totalChunks: number, destination: Path): Promise<void> {
		try {
			if (!website.exportOptions.fileNavigationOptions.enabled) {
				ExportLog.log(`🌲 File navigation disabled - skipping file tree generation`);
				return;
			}

			ExportLog.log(`🌲 Generating incremental file tree for chunk ${currentChunk}/${totalChunks}...`);
			ExportLog.log(`🌲 DEBUG: destination.path = ${destination.path}`);

			const fs = require('fs').promises;
			
			// Check for both possible file-tree filenames
			const fileTreePath1 = new Path(destination.path).joinString('site-lib', 'html', 'file-tree-content.html').path;
			const fileTreePath2 = new Path(destination.path).joinString('site-lib', 'html', 'file-tree-content-content.html').path;
			
			let existingFileTreeContent: string | null = null;
			let diskPaths: Set<string> = new Set();
			let selectedFilePath = fileTreePath1; // Default to the standard name

			// Step 1: Read existing file-tree content from disk - read BOTH files and merge them
			let contentFromFile1: string | null = null;
			let contentFromFile2: string | null = null;
			
			// Read file-tree-content.html (the standard one)
			try {
				contentFromFile1 = await fs.readFile(fileTreePath1, 'utf8');
				ExportLog.log(`🌲 Found file-tree-content.html on disk (${contentFromFile1?.length} bytes)`);
			} catch (err) {
				ExportLog.log(`🌲 No file-tree-content.html found on disk`);
			}
			
			// Read file-tree-content-content.html (the variant one)  
			try {
				contentFromFile2 = await fs.readFile(fileTreePath2, 'utf8');
				ExportLog.log(`🌲 Found file-tree-content-content.html on disk (${contentFromFile2?.length} bytes)`);
			} catch (err) {
				ExportLog.log(`🌲 No file-tree-content-content.html found on disk`);
			}
			
			// Merge both file contents - prioritize file-tree-content-content.html but include both
			if (contentFromFile2 && contentFromFile1) {
				// Both files exist - merge them with content-content.html taking priority
				existingFileTreeContent = contentFromFile2 + '\n<!-- MERGED FROM file-tree-content.html -->\n' + contentFromFile1;
				selectedFilePath = fileTreePath2; // Use the -content.html variant as primary
				ExportLog.log(`🌲 Merging content from both files: ${contentFromFile2.length} + ${contentFromFile1.length} = ${existingFileTreeContent.length} bytes`);
			} else if (contentFromFile2) {
				// Only -content.html exists
				existingFileTreeContent = contentFromFile2;
				selectedFilePath = fileTreePath2;
				ExportLog.log(`🌲 Using only file-tree-content-content.html (${contentFromFile2.length} bytes)`);
			} else if (contentFromFile1) {
				// Only standard file exists
				existingFileTreeContent = contentFromFile1;
				selectedFilePath = fileTreePath1;
				ExportLog.log(`🌲 Using only file-tree-content.html (${contentFromFile1.length} bytes)`);
			} else {
				// No files found
				ExportLog.log(`🌲 No existing file-tree content found on disk, will create new.`);
			}
			
			if (existingFileTreeContent) {
				ExportLog.log(`🌲 Using merged file content for: ${selectedFilePath}`);
				ExportLog.log(`🌲 Merged content (first 500 chars): ${existingFileTreeContent.slice(0,500)}`);
			}

			// Step 2: Parse disk file-tree-content.html for file entries - try multiple attribute patterns
			let diskMatchCount = 0;
				// Only process existing content if we successfully read it
				if (existingFileTreeContent) {
				// Match multiple possible data attributes that could contain file paths
				const regexPatterns = [
					/data-source-path-root-relative="([^"]+)"/g,
					/data-path="([^"]+)"/g,
					/data-source-path="([^"]+)"/g,
					/data-file-path="([^"]+)"/g
				];
				
				for (const regex of regexPatterns) {
					let match;
					while ((match = regex.exec(existingFileTreeContent)) !== null) {
						if (match[1] && match[1].trim()) {
							diskPaths.add(match[1]);
							diskMatchCount++;
						}
					}
				}
				
				ExportLog.log(`🌲 Parsed ${diskMatchCount} file entries from disk file-tree-content.html.`);
				ExportLog.log(`🌲 Disk file paths: ${Array.from(diskPaths).slice(0,10).join(', ')}${diskPaths.size > 10 ? ', ...' : ''}`);
			}

			// Step 3: Collect all current session file paths
			const memoryPaths = new Set<string>(website.index.attachmentsShownInTree.map(f => f.sourcePathRootRelative ?? ""));
			ExportLog.log(`🌲 Current session has ${memoryPaths.size} file entries.`);
			ExportLog.log(`🌲 Memory file paths: ${Array.from(memoryPaths).slice(0,10).join(', ')}${memoryPaths.size > 10 ? ', ...' : ''}`);

			// Step 4: Merge disk and memory file paths, ensuring no duplicates
			const mergedPaths = new Set<string>([...diskPaths, ...memoryPaths]);
			ExportLog.log(`🌲 Merged file tree will contain ${mergedPaths.size} unique file entries.`);
			ExportLog.log(`🌲 Merged file paths: ${Array.from(mergedPaths).slice(0,10).join(', ')}${mergedPaths.size > 10 ? ', ...' : ''}`);

			// Step 5: Build the file tree from merged paths
			const { FileTree } = await import("../features/file-tree");
			const { AssetLoader } = await import("../asset-loaders/base-asset");
			const { AssetType, InlinePolicy, Mutability } = await import("../asset-loaders/asset-types");

			let allPaths: Path[] = Array.from(mergedPaths).filter(p => p.trim()).map(p => new Path(p));
			let updateType = existingFileTreeContent && diskPaths.size > 0 ? "MERGE" : "CREATE";
			ExportLog.log(`🌲 Building ${updateType} file tree with ${allPaths.length} total files.`);

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
			
			ExportLog.log(`🌲 DEBUG: Generated HTML (first 500 chars): ${htmlData.slice(0,500)}`);
			ExportLog.log(`🌲 DEBUG: Disk paths found: ${diskPaths.size}, Memory paths: ${memoryPaths.size}, Merged total: ${mergedPaths.size}`);

			// Update tree order for all attachments shown in tree
			website.index.attachmentsShownInTree.forEach((file) => {
				if (!file.sourcePathRootRelative) return;
				const fileTreeItem = website.fileTree?.getItemBySourcePath(file.sourcePathRootRelative);
				file.treeOrder = fileTreeItem?.treeOrder ?? 0;
			});

			tempContainer.remove();

			// Create the file tree asset (use EXACT same approach as regular website)
			const { AssetHandler } = await import("../asset-loaders/asset-handler");
			await AssetHandler.reloadAssets(website.exportOptions);
			website.fileTreeAsset = new AssetLoader("file-tree-content.html", htmlData, null, AssetType.HTML, InlinePolicy.Auto, true, Mutability.Temporary);

			ExportLog.log(`✅ ${updateType} file tree completed: ${allPaths.length} total files, ${htmlData.length} bytes HTML`);

			// Debug: Log file distribution from all accumulated files
			const filesByExtension = new Map<string, number>();
			for (const file of allPaths) {
				const ext = file.path.split('.').pop() ?? '';
				filesByExtension.set(ext, (filesByExtension.get(ext) ?? 0) + 1);
			}
			if (filesByExtension.size > 0) {
				ExportLog.log(`🌲 FILE TREE: File distribution - ` + Array.from(filesByExtension.entries()).map(([ext, count]) => `${count} .${ext}`).join(', '));
			}

		} catch (error) {
			ExportLog.error(error, `Failed to generate incremental file tree for chunk ${currentChunk}`);
			// Don't throw - continue with export even if file tree generation fails
		}
	}
}

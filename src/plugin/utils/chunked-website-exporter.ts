import { TFile } from "obsidian";
import { Website } from "../website/website";
import { Path } from "./path";
import { ExportLog, MarkdownRendererAPI } from "../render-api/render-api";
import { Utils } from "./utils";
import { Settings } from "../settings/settings";

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
			
		// CRITICAL: Calculate global exportRoot from ALL files using exact same logic as regular exporter
		const globalExportRoot = this.findCommonRootPath(files);
		ExportLog.log(`🔧 Global export root for all chunks: "${globalExportRoot}"`);
		console.log("Global root path: " + globalExportRoot); // Match original Website logging
		
		// Debug: log sample file paths to understand structure
		const sampleFiles = files.slice(0, 5);
		ExportLog.log(`🔧 Sample file paths:`);
		for (const file of sampleFiles) {
			ExportLog.log(`   - "${file.path}"`);
		}

		ExportLog.log(`🔧 Using calculated globalExportRoot to match regular exporter behavior exactly`);
		
		const progress: ChunkProgress = {
			totalChunks: chunks.length,
			completedChunks: existingProgress?.completedChunks || [],
			destination: destination.path,
			timestamp: Date.now(),
			fileCount: files.length
		};			// Build the final website by processing chunks
			let finalWebsite: Website | undefined = undefined;
			
			for (let i = startChunk; i < chunks.length; i++) {
				if (this.isCancelled()) {
					ExportLog.warning("Export cancelled");
					await this.saveProgress(progress);
					return undefined;
				}
				
				ExportLog.log(`🔨 Processing chunk ${i + 1}/${chunks.length}`);
				
				try {
					// Build chunk website with calculated globalExportRoot to match regular exporter exactly
					const chunkWebsite = await this.buildChunkWebsite(chunks[i], destination, globalExportRoot, i === 0);
					if (!chunkWebsite) {
						throw new Error(`Failed to build chunk ${i + 1}`);
					}
					
					// CRITICAL: Process embedded attachments for each webpage in this chunk
					// This matches the regular exporter flow: website.ts:290-292
					await this.processChunkAttachments(chunkWebsite);
					
					// Validate chunk website before merging
					if (!chunkWebsite.index) {
						ExportLog.warning(`Chunk ${i + 1} missing index - skipping merge`);
						continue;
					}
					
					// Merge into final website - maintains all data structures
					if (i === 0) {
						finalWebsite = chunkWebsite; // First chunk becomes the base
						ExportLog.log(`🏗️ First chunk set as base: ${finalWebsite.index.attachmentsShownInTree.length} files in tree`);
					} else {
						if (finalWebsite && finalWebsite.index) {
							await this.mergeWebsites(chunkWebsite, finalWebsite);
						} else {
							ExportLog.warning(`Final website invalid at chunk ${i + 1} - reinitializing`);
							finalWebsite = chunkWebsite;
						}
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
				
				// CRITICAL: Regenerate file tree with ALL merged files
				await this.regenerateFileTree(finalWebsite);
				
				await finalWebsite.index.finalize();
				
				// Clean up progress
				await this.cleanupProgress(destination);
				
				ExportLog.log(`✅ Chunked export complete: ${finalWebsite.index.webpages.length} pages, ${finalWebsite.index.attachments.length} attachments, ${finalWebsite.index.attachmentsShownInTree.length} in tree`);
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
					const headersInfo = await webpage.outputData.renderedHeadings;
					
					// Remove title header if it's the first one (exact match to regular exporter)
					if (headersInfo.length > 0 && headersInfo[0].level == 1 && headersInfo[0].heading == webpage.title) {
						headersInfo.shift();
					}
					
					const headers = headersInfo.map((header) => header.heading);
					
					// Create search document with EXACT same structure as regular exporter
					const searchDocument = {
						title: webpage.title,
						aliases: webpage.outputData.aliases,
						headers: headers,
						tags: webpage.outputData.allTags,
						path: webpagePath,
						content: webpage.outputData.description + " " + webpage.outputData.searchContent,
					};
					
					// Validate search document completeness
					if (!searchDocument.title) {
						ExportLog.warning(`Search document missing title: ${webpagePath}`);
					}
					if (!searchDocument.content || searchDocument.content.trim() === " ") {
						ExportLog.warning(`Search document missing content: ${webpagePath}`);
					}
					
					// Add to final website's search index
					finalWebsite.index.minisearch.add(searchDocument);
					mergedCount++;
					
					console.log(`🔍 MERGED: ${webpagePath} (title: "${searchDocument.title}", content: ${searchDocument.content.length} chars, headers: ${headers.length}, tags: ${searchDocument.tags.length})`);
					
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
			finalWebsite.fileTree.title = finalWebsite.exportOptions.siteName ?? app.vault.getName();
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
	
	/**
	 * Process embedded attachments for each webpage in the chunk
	 * This matches the regular exporter flow: website.ts:290-292
	 * Handles ALL file types: images, audio, video, PDFs, etc.
	 */
	private static async processChunkAttachments(chunkWebsite: Website): Promise<void> {
		try {
			ExportLog.log(`🔗 Processing embedded attachments for ${chunkWebsite.index.webpages.length} webpages in chunk`);
			
			let totalAttachments = 0;
			const attachmentsByType = new Map<string, number>();
			
			for (const webpage of chunkWebsite.index.webpages) {
				if (webpage && webpage.getAttachments) {
					// Extract all embedded attachments from this webpage (images, audio, video, PDFs, etc.)
					const attachments = await webpage.getAttachments();
					
					// Add attachments to the chunk's index
					if (attachments && attachments.length > 0) {
						chunkWebsite.index.addFiles(attachments);
						totalAttachments += attachments.length;
						
						// Count attachments by file type for comprehensive debugging
						for (const attachment of attachments) {
							if (attachment.sourcePath) {
								const extension = attachment.sourcePath.split('.').pop()?.toLowerCase() || 'unknown';
								attachmentsByType.set(extension, (attachmentsByType.get(extension) || 0) + 1);
								
								// Debug log for various media types
								if (['mp3', 'wav', 'ogg', 'aac', 'm4a', 'flac'].includes(extension)) {
									console.log(`🎵 AUDIO: ${attachment.sourcePath} -> ${attachment.targetPath.path}`);
								} else if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'ico'].includes(extension)) {
									console.log(`🖼️ IMAGE: ${attachment.sourcePath} -> ${attachment.targetPath.path}`);
								} else if (['mp4', 'mov', 'avi', 'webm', 'mpeg', 'mkv'].includes(extension)) {
									console.log(`🎬 VIDEO: ${attachment.sourcePath} -> ${attachment.targetPath.path}`);
								} else if (extension === 'pdf') {
									console.log(`📄 PDF: ${attachment.sourcePath} -> ${attachment.targetPath.path}`);
								} else {
									console.log(`📎 FILE: ${attachment.sourcePath} -> ${attachment.targetPath.path} (${extension})`);
								}
							}
						}
						
						// Log summary for this webpage if it has embedded files
						if (attachments.length > 0) {
							const types = Array.from(attachmentsByType.entries())
								.filter(([, count]) => count > 0)
								.map(([ext, count]) => `${count} ${ext}`)
								.join(', ');
							console.log(`📋 WEBPAGE ${webpage.source.path}: ${attachments.length} embedded files (${types})`);
						}
					}
				}
			}
			
			// Comprehensive summary of all attachment types processed
			if (attachmentsByType.size > 0) {
				const summary = Array.from(attachmentsByType.entries())
					.map(([ext, count]) => `${count} .${ext}`)
					.join(', ');
				ExportLog.log(`✅ Processed ${totalAttachments} embedded attachments: ${summary}`);
			} else {
				ExportLog.log(`✅ No embedded attachments found in this chunk`);
			}
			
		} catch (error) {
			ExportLog.error(error, "Failed to process embedded attachments for chunk");
		}
	}
}

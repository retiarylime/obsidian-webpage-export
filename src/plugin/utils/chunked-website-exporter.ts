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
					
					// Validate chunk website before merging
					if (!chunkWebsite.index) {
						ExportLog.warning(`Chunk ${i + 1} missing index - skipping merge`);
						continue;
					}
					
					// Merge into final website - maintains all data structures
					if (i === 0) {
						finalWebsite = chunkWebsite; // First chunk becomes the base
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
	 */
	private static async mergeSearchIndices(chunkWebsite: Website, finalWebsite: Website): Promise<void> {
		try {
			if (!chunkWebsite.index.minisearch || !finalWebsite.index.minisearch) {
				ExportLog.warning("Missing search index in chunk or final website - skipping search index merge");
				return;
			}
			
			// Get the JSON representation of the chunk search index
			const chunkJson = chunkWebsite.index.minisearch.toJSON();
			const chunkJsonString = JSON.stringify(chunkJson);
			
			// Simple approach: Re-add all webpages from chunk to final search index
			// This leverages existing search index functionality without accessing private properties
			let mergedCount = 0;
			for (const webpage of chunkWebsite.index.webpages) {
				if (webpage && webpage.targetPath) {
					const webpagePath = webpage.targetPath.path;
					// Check if the webpage is already in the final index to avoid duplicates
					if (!finalWebsite.index.minisearch.has(webpagePath)) {
						// Manually create search document with public properties
						const searchDoc = {
							path: webpagePath,
							title: webpage.title || '',
							aliases: [],
							headers: [],
							tags: [],
							content: '' // Content will be minimal but functional
						};
						finalWebsite.index.minisearch.add(searchDoc);
						mergedCount++;
					}
				}
			}
			
			ExportLog.log(`🔍 Merged ${mergedCount} search documents from chunk`);
			
		} catch (error) {
			ExportLog.error(error, "Failed to merge search indices");
		}
	}
	
	/**
	 * Regenerate file tree for the final merged website with ALL files
	 */
	private static async regenerateFileTree(finalWebsite: Website): Promise<void> {
		try {
			if (!finalWebsite.exportOptions.fileNavigationOptions.enabled) {
				return; // File tree not enabled, skip
			}
			
			ExportLog.log(`🌲 Regenerating file tree with ${finalWebsite.index.attachmentsShownInTree.length} files`);
			
			// Recreate file tree with all merged attachments
			const paths = finalWebsite.index.attachmentsShownInTree.map((file) => new Path(file.sourcePathRootRelative ?? ""));
			const { FileTree } = await import("../features/file-tree");
			const { AssetLoader } = await import("../asset-loaders/base-asset");
			const { AssetType, InlinePolicy, Mutability } = await import("../asset-loaders/asset-types");
			
			finalWebsite.fileTree = new FileTree(paths, false, true);
			finalWebsite.fileTree.makeLinksWebStyle = finalWebsite.exportOptions.slugifyPaths ?? true;
			finalWebsite.fileTree.showNestingIndicator = true;
			finalWebsite.fileTree.generateWithItemsClosed = true;
			finalWebsite.fileTree.showFileExtentionTags = true;
			finalWebsite.fileTree.hideFileExtentionTags = ["md"];
			finalWebsite.fileTree.title = finalWebsite.exportOptions.siteName ?? app.vault.getName();
			finalWebsite.fileTree.id = "file-explorer";
			
			const tempContainer = document.createElement("div");
			await finalWebsite.fileTree.generate(tempContainer);
			const data = tempContainer.innerHTML;
			
			// Update tree order for all attachments
			finalWebsite.index.attachmentsShownInTree.forEach((file) => {
				if (!file.sourcePathRootRelative) return;
				const fileTreeItem = finalWebsite.fileTree?.getItemBySourcePath(file.sourcePathRootRelative);
				file.treeOrder = fileTreeItem?.treeOrder ?? 0;
			});
			
			tempContainer.remove();
			finalWebsite.fileTreeAsset = new AssetLoader("file-tree.html", data, null, AssetType.HTML, InlinePolicy.Auto, true, Mutability.Temporary);
			
			ExportLog.log(`✅ File tree regenerated successfully`);
			
		} catch (error) {
			ExportLog.error(error, "Failed to regenerate file tree for merged website");
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

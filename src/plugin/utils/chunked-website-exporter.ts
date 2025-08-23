import { TFile } from "obsidian";
import { Website } from "../website/website";
import { Path } from "./path";
import { ExportLog, MarkdownRendererAPI } from "../render-api/render-api";
import { Utils } from "./utils";

export class ChunkedWebsiteExporter {
	private static readonly CHUNK_SIZE = 20; // Reduce chunk size from 40 to 20 to prevent memory issues
	
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
	 * Export files in chunks to prevent memory exhaustion
	 */
	public static async exportInChunks(
		files: TFile[], 
		destination: Path, 
		chunkSize: number = ChunkedWebsiteExporter.CHUNK_SIZE
	): Promise<Website | undefined> {
		
		try {
			ExportLog.log(`Starting chunked export of ${files.length} files (${chunkSize} per chunk)`);
			
			// Initialize progress system for chunked export
			ExportLog.resetProgress();
			ExportLog.addToProgressCap(files.length);
			
			// Sort files by complexity (simpler files first)
			const sortedFiles = this.sortFilesByComplexity(files);
			
			// Create chunks
			const chunks = this.createChunks(sortedFiles, chunkSize);
			ExportLog.log(`Created ${chunks.length} chunks`);
			
			let finalWebsite: Website | undefined = undefined;
			
			// Process each chunk
			for (let i = 0; i < chunks.length; i++) {
				const chunk = chunks[i];
				
				ExportLog.log(`🏗️ Processing chunk ${i + 1}/${chunks.length} with ${chunk.length} files`);
				
				// Check if we should cancel using the more reliable cancelled flag
				if (ChunkedWebsiteExporter.isCancelled()) {
					ExportLog.warning("Export cancelled by user");
					return undefined;
				}
				
				// Process the chunk
				const chunkWebsite = await this.processChunk(chunk, destination, i);
				
				if (!chunkWebsite) {
					ExportLog.error(`Chunk ${i + 1} failed`);
					continue;
				}
			
				ExportLog.log(`✅ Chunk ${i + 1} completed`);
				
				// Merge results
				if (i === 0) {
					// First chunk - create the final website with correct destination
					finalWebsite = new Website(destination);
					await finalWebsite.load([]); // Initialize empty website
					
					// Copy all data from first chunk to final website
					await this.copyChunkToFinalWebsite(chunkWebsite, finalWebsite);
				} else {
					// Merge subsequent chunks into the final website
					await this.mergeChunkIntoWebsite(chunkWebsite, finalWebsite);
				}
				
				// Clean up chunk website to free memory
				this.cleanupWebsite(chunkWebsite);
				
				// More aggressive memory management
				if ((i + 1) % 3 === 0) {
					ExportLog.log(`🧹 Memory cleanup at chunk ${i + 1}/${chunks.length}`);
					await Utils.delay(200); // Give more time for cleanup
					
					// Force garbage collection if available
					if (global.gc) {
						global.gc();
					}
				}
				
				// Log memory usage for monitoring and safety check
				if ((i + 1) % 10 === 0) {
					const memUsage = process.memoryUsage ? process.memoryUsage() : null;
					if (memUsage) {
						const heapUsedMB = Math.round(memUsage.heapUsed / 1024 / 1024);
						ExportLog.log(`📊 Memory: ${heapUsedMB}MB heap used`);
						
						// Safety check: if memory usage is getting too high, warn user
						if (heapUsedMB > 1500) { // 1.5GB threshold
							ExportLog.warning(`⚠️ High memory usage: ${heapUsedMB}MB - consider reducing vault size`);
						}
						
						// Emergency brake: if memory usage is extremely high, stop export
						if (heapUsedMB > 2500) { // 2.5GB threshold
							ExportLog.error("❌ Memory usage too high, stopping export to prevent crash");
							return undefined;
						}
					}
				}
			}
			
			// Final build and site-lib preparation
			if (finalWebsite) {
				ExportLog.log("📦 Finalizing chunked website and preparing site-lib files...");
				
				// Sort and deduplicate all merged collections before finalization
				this.prepareForFinalization(finalWebsite);
				
				// Regenerate the complete file tree with all merged files
				await this.regenerateFileTree(finalWebsite);
				
				// Finalize the website - this generates metadata.json and search-index.json for site-lib
				await finalWebsite.index.finalize();
				
				ExportLog.log(`🎉 Chunked export completed successfully`);
				ExportLog.log(`📊 Final stats: ${finalWebsite.index.webpages.length} webpages, ${finalWebsite.index.attachments.length} attachments`);
			}
			
			return finalWebsite;
			
		} catch (error) {
			ExportLog.error(error, "Chunked export failed");
			return undefined;
		}
	}
	
	/**
	 * Process a single chunk of files
	 */
	private static async processChunk(files: TFile[], destination: Path, chunkIndex: number): Promise<Website | undefined> {
		try {
			ExportLog.log(`Processing chunk ${chunkIndex + 1} with ${files.length} files`);
			
			// Create website for this chunk with the final destination (not temporary)
			// This ensures all paths are correct from the start
			const website = new Website(destination);
			
			// CRITICAL: Temporarily set combineAsSingleFile to true for chunk processing
			// This prevents webpage.download() from being called in Website.build()
			// because when combineAsSingleFile is false, Website.build() calls webpage.download()
			// for each webpage, which would write files with wrong paths during chunk processing
			const originalCombineAsSingleFile = website.exportOptions.combineAsSingleFile;
			website.exportOptions.combineAsSingleFile = true;
			
			// Load files into the website
			await website.load(files);
			
			// Build the website (no file downloads will occur due to combineAsSingleFile = true)
			const builtWebsite = await website.build();
			
			// Restore the original setting
			if (builtWebsite) {
				builtWebsite.exportOptions.combineAsSingleFile = originalCombineAsSingleFile;
			}
			
			if (!builtWebsite) {
				ExportLog.error(`Failed to build chunk ${chunkIndex + 1}`);
				return undefined;
			}
			
			ExportLog.log(`✅ Successfully processed chunk ${chunkIndex + 1}`);
			return builtWebsite;
			
		} catch (error) {
			ExportLog.error(error, `Error processing chunk ${chunkIndex + 1}`);
			return undefined;
		}
	}
	
	/**
	 * Merge a chunk website into the final website
	 */
	private static async mergeChunkIntoWebsite(chunkWebsite: Website, finalWebsite: Website | undefined): Promise<void> {
		if (!finalWebsite) return;
		
		try {
			ExportLog.log(`🔄 Merging chunk data into final website...`);
			
			// Paths are already correct since chunks use the same destination
			// No need to update paths anymore
			
			// Merge webpages
			for (const webpage of chunkWebsite.index.webpages) {
				finalWebsite.index.webpages.push(webpage);
			}
			
			// Merge attachments arrays
			finalWebsite.index.attachments.push(...chunkWebsite.index.attachments);
			finalWebsite.index.attachmentsShownInTree.push(...chunkWebsite.index.attachmentsShownInTree);
			finalWebsite.index.allFiles.push(...chunkWebsite.index.allFiles);
			
			// Merge file tracking arrays
			finalWebsite.index.newFiles.push(...chunkWebsite.index.newFiles);
			finalWebsite.index.updatedFiles.push(...chunkWebsite.index.updatedFiles);
			finalWebsite.index.deletedFiles.push(...chunkWebsite.index.deletedFiles);
			
			// Merge website metadata - this is critical for site-lib functionality
			if (chunkWebsite.index.websiteData && finalWebsite.index.websiteData) {
				this.mergeWebsiteData(chunkWebsite.index.websiteData, finalWebsite.index.websiteData);
			}
			
			// Merge search index - this ensures search functionality works across all chunks
			if (chunkWebsite.index.minisearch && finalWebsite.index.minisearch) {
				this.mergeSearchIndex(chunkWebsite.index.minisearch, finalWebsite.index.minisearch, chunkWebsite.index.webpages);
			}
			
			ExportLog.log(`✅ Successfully merged chunk data`);
			
		} catch (error) {
			ExportLog.error(error, "Error merging chunk into final website");
		}
	}
	
	/**
	 * Merge website metadata from chunk into final website
	 */
	private static mergeWebsiteData(chunkData: any, finalData: any): void {
		try {
			// Merge webpages metadata
			if (chunkData.webpages) {
				Object.assign(finalData.webpages, chunkData.webpages);
			}
			
			// Merge fileInfo metadata
			if (chunkData.fileInfo) {
				Object.assign(finalData.fileInfo, chunkData.fileInfo);
			}
			
			// Merge sourceToTarget mapping
			if (chunkData.sourceToTarget) {
				Object.assign(finalData.sourceToTarget, chunkData.sourceToTarget);
			}
			
			// Merge arrays (removing duplicates)
			if (chunkData.attachments) {
				finalData.attachments = [...new Set([...finalData.attachments, ...chunkData.attachments])];
			}
			
			if (chunkData.shownInTree) {
				finalData.shownInTree = [...new Set([...finalData.shownInTree, ...chunkData.shownInTree])];
			}
			
			if (chunkData.allFiles) {
				finalData.allFiles = [...new Set([...finalData.allFiles, ...chunkData.allFiles])];
			}
			
			ExportLog.log(`📊 Merged website metadata: ${Object.keys(chunkData.webpages || {}).length} webpages, ${Object.keys(chunkData.fileInfo || {}).length} files`);
			
		} catch (error) {
			ExportLog.error(error, "Error merging website data");
		}
	}
	
	/**
	 * Merge search index from chunk into final search index
	 */
	private static mergeSearchIndex(chunkSearch: any, finalSearch: any, chunkWebpages: any[]): void {
		try {
			// Add all chunk documents to the final search index
			for (const webpage of chunkWebpages) {
				try {
					// Get the search document ID (usually the path)
					const docId = webpage.targetPath?.path || webpage.sourcePath;
					if (docId && chunkSearch.has && chunkSearch.has(docId)) {
						// Get the document from chunk search and add to final search
						const searchDoc = chunkSearch._documentById?.get?.(docId);
						if (searchDoc && finalSearch.add) {
							finalSearch.add(searchDoc);
						}
					}
				} catch (e) {
					// Ignore individual document indexing errors
				}
			}
			
			ExportLog.log(`🔍 Merged search index: ${chunkWebpages.length} documents processed`);
			
		} catch (error) {
			ExportLog.error(error, "Error merging search index");
		}
	}
	
	/**
	 * Clean up a website to free memory
	 */
	private static cleanupWebsite(website: Website): void {
		try {
			// Clear webpage references and dispose them
			if (website.index.webpages) {
				for (const webpage of website.index.webpages) {
					if (webpage.dispose) {
						webpage.dispose();
					}
				}
				website.index.webpages.length = 0;
			}
			
			// Clear attachment arrays
			if (website.index.attachments) website.index.attachments.length = 0;
			if (website.index.attachmentsShownInTree) website.index.attachmentsShownInTree.length = 0;
			if (website.index.allFiles) website.index.allFiles.length = 0;
			
			// Clear file arrays
			if (website.index.newFiles) website.index.newFiles.length = 0;
			if (website.index.updatedFiles) website.index.updatedFiles.length = 0;
			if (website.index.deletedFiles) website.index.deletedFiles.length = 0;
			
			// Clear website data references
			if (website.index.websiteData) {
				(website.index as any).websiteData = undefined;
			}
			
			// Clear search index
			if (website.index.minisearch) {
				website.index.minisearch = undefined;
			}
			
			// Clear template references
			if (website.webpageTemplate) {
				(website as any).webpageTemplate = undefined;
			}
			
		} catch (error) {
			ExportLog.warning("Error during website cleanup: " + error);
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
	 * Prepare final website for finalization by sorting and deduplicating collections
	 */
	private static prepareForFinalization(website: Website): void {
		try {
			ExportLog.log("🔧 Preparing merged data for finalization...");
			
			// Remove duplicates from webpages (by target path)
			const uniqueWebpages = new Map<string, any>();
			for (const webpage of website.index.webpages) {
				const key = webpage.targetPath?.path || webpage.sourcePath;
				if (key && !uniqueWebpages.has(key)) {
					uniqueWebpages.set(key, webpage);
				}
			}
			website.index.webpages = Array.from(uniqueWebpages.values());
			
			// Remove duplicates from attachments (by target path)
			const uniqueAttachments = new Map<string, any>();
			for (const attachment of website.index.attachments) {
				const key = attachment.targetPath?.path || attachment.sourcePath;
				if (key && !uniqueAttachments.has(key)) {
					uniqueAttachments.set(key, attachment);
				}
			}
			website.index.attachments = Array.from(uniqueAttachments.values());
			
			// Remove duplicates from attachmentsShownInTree
			const uniqueTreeAttachments = new Map<string, any>();
			for (const attachment of website.index.attachmentsShownInTree) {
				const key = attachment.targetPath?.path || attachment.sourcePath;
				if (key && !uniqueTreeAttachments.has(key)) {
					uniqueTreeAttachments.set(key, attachment);
				}
			}
			website.index.attachmentsShownInTree = Array.from(uniqueTreeAttachments.values());
			
			// Remove duplicates from allFiles
			const uniqueAllFiles = new Map<string, any>();
			for (const file of website.index.allFiles) {
				const key = file.targetPath?.path || file.sourcePath;
				if (key && !uniqueAllFiles.has(key)) {
					uniqueAllFiles.set(key, file);
				}
			}
			website.index.allFiles = Array.from(uniqueAllFiles.values());
			
			// Remove duplicates from file tracking arrays
			website.index.newFiles = [...new Set(website.index.newFiles)];
			website.index.updatedFiles = [...new Set(website.index.updatedFiles)];
			website.index.deletedFiles = [...new Set(website.index.deletedFiles)];
			
			ExportLog.log(`✅ Finalization prep complete: ${website.index.webpages.length} webpages, ${website.index.attachments.length} attachments`);
			
		} catch (error) {
			ExportLog.error(error, "Error preparing for finalization");
		}
	}
	
	/**
	 * Regenerate the complete file tree with all merged files for site-lib/html/file-tree.html
	 */
	private static async regenerateFileTree(website: Website): Promise<void> {
		try {
			if (!website.exportOptions.fileNavigationOptions.enabled) {
				ExportLog.log("📁 File navigation disabled, skipping file tree regeneration");
				return;
			}
			
			ExportLog.log("🌳 Regenerating complete file tree from all merged chunks...");
			
			// Import the FileTree class
			const { FileTree } = await import("../features/file-tree");
			
			// Create paths array from all attachments shown in tree (now merged from all chunks)
			const paths = website.index.attachmentsShownInTree.map((file) => new Path(file.sourcePathRootRelative ?? ""));
			
			// Create new complete file tree
			const completeFileTree = new FileTree(paths, false, true);
			completeFileTree.makeLinksWebStyle = website.exportOptions.slugifyPaths ?? true;
			completeFileTree.showNestingIndicator = true;
			completeFileTree.generateWithItemsClosed = true;
			completeFileTree.showFileExtentionTags = true;
			completeFileTree.hideFileExtentionTags = ["md"];
			completeFileTree.title = website.exportOptions.siteName ?? (app as any).vault.getName();
			completeFileTree.id = "file-explorer";
			
			// Generate the complete file tree HTML
			const tempContainer = document.createElement("div");
			await completeFileTree.generate(tempContainer);
			const completeTreeData = tempContainer.innerHTML;
			
			// Update tree order for all attachments based on the complete tree
			website.index.attachmentsShownInTree.forEach((file) => {
				if (!file.sourcePathRootRelative) return;
				const fileTreeItem = completeFileTree.getItemBySourcePath(file.sourcePathRootRelative);
				file.treeOrder = fileTreeItem?.treeOrder ?? 0;
			});
			
			tempContainer.remove();
			
			// Replace the file tree asset with the complete one
			const { AssetLoader } = await import("../asset-loaders/base-asset");
			const { AssetType, InlinePolicy, Mutability } = await import("../asset-loaders/asset-types");
			
			website.fileTreeAsset = new AssetLoader(
				"file-tree.html", 
				completeTreeData, 
				null, 
				AssetType.HTML, 
				InlinePolicy.Auto, 
				true, 
				Mutability.Temporary
			);
			
			// Update the website's fileTree reference
			website.fileTree = completeFileTree;
			
			ExportLog.log(`🎯 Complete file tree regenerated with ${paths.length} items`);
			ExportLog.log(`📄 file-tree.html will contain navigation for all ${website.index.webpages.length} webpages`);
			
		} catch (error) {
			ExportLog.error(error, "Error regenerating file tree");
		}
	}
	
	/**
	 * Copy all data from a chunk website to the final website (for the first chunk)
	 */
	private static async copyChunkToFinalWebsite(chunkWebsite: Website, finalWebsite: Website): Promise<void> {
		try {
			ExportLog.log("📋 Copying first chunk data to final website");
			
			// Copy all index data
			finalWebsite.index.webpages = [...chunkWebsite.index.webpages];
			finalWebsite.index.attachments = [...chunkWebsite.index.attachments];
			finalWebsite.index.attachmentsShownInTree = [...chunkWebsite.index.attachmentsShownInTree];
			
			// Copy website data
			finalWebsite.index.websiteData = { ...chunkWebsite.index.websiteData };
			
			// Copy files arrays  
			finalWebsite.index.newFiles = [...chunkWebsite.index.newFiles];
			finalWebsite.index.updatedFiles = [...chunkWebsite.index.updatedFiles];
			finalWebsite.index.deletedFiles = [...chunkWebsite.index.deletedFiles];
			
			// Copy file tree if it exists
			if (chunkWebsite.fileTree) {
				finalWebsite.fileTree = chunkWebsite.fileTree;
			}
			if (chunkWebsite.fileTreeAsset) {
				finalWebsite.fileTreeAsset = chunkWebsite.fileTreeAsset;
			}
			
			// Paths are already correct since chunks use the same destination
			// No need to update paths anymore
			
			ExportLog.log(`✅ Copied ${chunkWebsite.index.webpages.length} webpages and ${chunkWebsite.index.attachments.length} attachments from first chunk`);
			
		} catch (error) {
			ExportLog.error(error, "Failed to copy chunk data to final website");
		}
	}
	
	/**
	 * Update all paths from chunk temporary directory to final destination
	 */
	private static async updatePathsToFinalDestination(chunkWebsite: Website, finalWebsite: Website): Promise<void> {
		try {
			const chunkDestPath = chunkWebsite.destination.path;
			const finalDestPath = finalWebsite.destination.path;
			
			ExportLog.log(`🔄 Updating paths from ${chunkDestPath} to ${finalDestPath}`);
			
			// Update webpage paths
			for (const webpage of chunkWebsite.index.webpages) {
				const oldPath = webpage.targetPath.path;
				if (oldPath.includes(chunkDestPath)) {
					const newPath = oldPath.replace(chunkDestPath, finalDestPath);
					webpage.targetPath.reparse(newPath);
					webpage.targetPath.setWorkingDirectory(finalDestPath);
					ExportLog.log(`📄 Updated webpage path: ${oldPath} → ${newPath}`);
				}
			}
			
			// Update attachment paths - this is critical for proper asset handling
			for (const attachment of chunkWebsite.index.attachments) {
				const oldPath = attachment.targetPath.path;
				if (oldPath.includes(chunkDestPath)) {
					const newPath = oldPath.replace(chunkDestPath, finalDestPath);
					attachment.targetPath.reparse(newPath);
					attachment.targetPath.setWorkingDirectory(finalDestPath);
					ExportLog.log(`📎 Updated attachment path: ${oldPath} → ${newPath}`);
				}
			}
			
			// Update attachments shown in tree
			for (const attachment of chunkWebsite.index.attachmentsShownInTree) {
				const oldPath = attachment.targetPath.path;
				if (oldPath.includes(chunkDestPath)) {
					const newPath = oldPath.replace(chunkDestPath, finalDestPath);
					attachment.targetPath.reparse(newPath);
					attachment.targetPath.setWorkingDirectory(finalDestPath);
				}
			}
			
			// Update new files array
			for (const file of chunkWebsite.index.newFiles) {
				const oldPath = file.targetPath.path;
				if (oldPath.includes(chunkDestPath)) {
					const newPath = oldPath.replace(chunkDestPath, finalDestPath);
					file.targetPath.reparse(newPath);
					file.targetPath.setWorkingDirectory(finalDestPath);
				}
			}
			
			// Update updated files array  
			for (const file of chunkWebsite.index.updatedFiles) {
				const oldPath = file.targetPath.path;
				if (oldPath.includes(chunkDestPath)) {
					const newPath = oldPath.replace(chunkDestPath, finalDestPath);
					file.targetPath.reparse(newPath);
					file.targetPath.setWorkingDirectory(finalDestPath);
				}
			}
			
			// Instead of copying files here, let the normal download process handle it
			// The attachments now have the correct paths and will be downloaded properly
			
			ExportLog.log(`✅ Updated all paths from chunk to final destination`);
			
		} catch (error) {
			ExportLog.error(error, "Failed to update paths to final destination");
		}
	}
}

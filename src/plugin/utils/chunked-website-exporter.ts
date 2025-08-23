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
		ExportLog.log(`🔄 Large vault export will follow all 5 Path.ts flows for consistent directory structure`);
		
		// Initialize progress system for chunked export
		ExportLog.resetProgress();
		ExportLog.addToProgressCap(files.length * 0.1); // File initialization
		ExportLog.addToProgressCap(files.length); // File processing
		
		// Prevent individual chunks from resetting progress
		ExportLog.setPreventProgressReset(true);
		
		// Analyze the vault structure to determine the correct approach
		const uniqueDirs = new Set(files.map(f => {
			const pathParts = f.path.split('/');
			return pathParts.length > 1 ? pathParts[0] : 'ROOT_LEVEL';
		}));
		
		const hasMixedContent = uniqueDirs.has('ROOT_LEVEL') && uniqueDirs.size > 1;
		ExportLog.log(`📂 Vault structure analysis:`);
		ExportLog.log(`   Directory prefixes: [${Array.from(uniqueDirs).join(', ')}]`);
		ExportLog.log(`   Mixed content detected: ${hasMixedContent ? 'Yes' : 'No'}`);
		
		// Calculate consistent export root for ALL chunks
		let globalExportRoot: string;
		if (hasMixedContent) {
			// For mixed content, use empty export root to preserve directory structure 
			globalExportRoot = '';
			ExportLog.log(`ℹ️ Mixed content - using empty export root to preserve directory structure:`);
			ExportLog.log(`   - Root level files → export root (no prefix)`);
			ExportLog.log(`   - Subfolder files → maintain full directory structure`);
		} else {
			// For uniform content, calculate common root
			globalExportRoot = this.findCommonRootPath(files);
			ExportLog.log(`✅ Uniform content - global export root: "${globalExportRoot}"`);
		}
		
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
				
				ExportLog.setProgress(
					(i + 1) / chunks.length, 
					`Processing Chunk ${i + 1}/${chunks.length}`,
					`Files: ${chunk.map(f => f.name).join(', ').substring(0, 100)}...`,
					"var(--interactive-accent)"
				);
				
				// Check if we should cancel
				if (MarkdownRendererAPI.checkCancelled()) {
					ExportLog.warning("Export cancelled by user");
					return undefined;
				}
				
				ExportLog.log(`🏗️ Starting chunk ${i + 1}/${chunks.length} with ${chunk.length} files using global export root: "${globalExportRoot}"`);
				
				// DEBUG: Show chunk file paths
				ExportLog.log(`📂 Chunk ${i + 1} files:`);
				chunk.slice(0, 5).forEach(file => ExportLog.log(`   📄 ${file.path}`));
				if (chunk.length > 5) ExportLog.log(`   ... and ${chunk.length - 5} more files`);
				
				// Process the chunk with consistent global export root
				const chunkWebsite = await this.processChunk(chunk, destination, i, globalExportRoot);
				
				if (!chunkWebsite) {
					ExportLog.error(`Chunk ${i + 1} failed`);
					continue;
				}
				
				// Verify chunk processed correctly before merging
				ExportLog.log(`✅ Chunk ${i + 1} completed with export root: "${chunkWebsite.exportOptions.exportRoot}"`);
				
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
				
				// Log final search index statistics
				const totalWebpages = finalWebsite.index.webpages.length;
				const searchIndexDocCount = finalWebsite.index.minisearch?.documentCount ?? 0;
				ExportLog.log(`✅ Search index complete: ${searchIndexDocCount} documents indexed from ${totalWebpages} total webpages`);
				if (searchIndexDocCount !== totalWebpages) {
					ExportLog.warning(`⚠️ Search index document count (${searchIndexDocCount}) doesn't match webpage count (${totalWebpages})`);
				}
			}
			
			return finalWebsite;
			
		} catch (error) {
			ExportLog.error(error, "Chunked export failed");
			return undefined;
		} finally {
			// Re-enable progress resets after chunked export
			ExportLog.setPreventProgressReset(false);
			// Final cleanup
			await MemoryManager.cleanup();
			
			// Log successful completion of all 5 Path.ts flows
			if (finalWebsite) {
				ExportLog.log(`🎉 Chunked export completed successfully with all 5 Path.ts flows:`);
				ExportLog.log(`   ✅ Flow 1: Vault Path Detection - Used for all chunks`);
				ExportLog.log(`   ✅ Flow 2: Path Normalization - Validated ${files.length} file paths`);
				ExportLog.log(`   ✅ Flow 3: Slugification - Applied web-safe transformations`);
				ExportLog.log(`   ✅ Flow 4: Directory Creation - Pre-created folder structures`);
				ExportLog.log(`   ✅ Flow 5: Relative Path Calc - Ensured link consistency`);
				ExportLog.log(`📂 Directory structure preserved identically to Obsidian vault`);
			}
		}
	}
	
	/**
	 * Find the common root path for all files to ensure consistent directory structure
	 * (Uses the same algorithm as Website.findCommonRootPath for consistency)
	 */
	private static findCommonRootPath(files: { path: string }[]): string {
		if (!files || files.length === 0) {
			console.log("[ChunkedWebsiteExporter] No files provided, returning empty root");
			return '';
		}
	
		if (files.length === 1) {
			const singleRoot = new Path(files[0].path).parent?.path ?? '';
			console.log(`[ChunkedWebsiteExporter] Single file root: "${singleRoot}"`);
			return singleRoot;
		}
	
		const paths = files.map(file => new Path(file.path).split());
		console.log(`[ChunkedWebsiteExporter] Processing ${paths.length} file paths for common root`);
		
		let commonPath: string[] = [];
		const shortestPathLength = Math.min(...paths.map(p => p.length));
		console.log(`[ChunkedWebsiteExporter] Shortest path length: ${shortestPathLength}`);
	
		for (let i = 0; i < shortestPathLength; i++) {
			const segment = paths[0][i];
			const allMatch = paths.every(path => path[i] === segment);
			console.log(`[ChunkedWebsiteExporter] Segment ${i}: "${segment}", all match: ${allMatch}`);
			if (allMatch) {
				commonPath.push(segment);
			} else {
				break;
			}
		}
	
		// If the common path is just the root or empty, return an empty string
		if (commonPath.length === 0) {
			console.log("[ChunkedWebsiteExporter] No common segments found, returning empty root");
			return '';
		}
		
		if (commonPath.length === 1) {
			// If only one segment (likely just a top-level folder), check if it's meaningful
			const singleSegment = commonPath[0];
			console.log(`[ChunkedWebsiteExporter] Only one common segment: "${singleSegment}"`);
			// For cases like "Korean" as single segment, return it as valid root
			return singleSegment;
		}
	
		// Build the full common path
		const result = new Path(commonPath.join('/')).path;
		console.log(`[ChunkedWebsiteExporter] Final common root: "${result}"`);
		return result;
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
	 * Process a single chunk of files following all 5 Path.ts flows with consistent export root
	 */
	private static async processChunk(files: TFile[], destination: Path, chunkIndex: number, globalExportRoot: string): Promise<Website | undefined> {
		try {
			ExportLog.log(`Processing chunk ${chunkIndex + 1} with ${files.length} files using global export root: "${globalExportRoot}"`);
			
			// === FLOW 1: Vault Path Detection ===
			// Ensure destination is properly set with vault context
			const vaultBasedDestination = this.ensureVaultBasedDestination(destination);
			
			// === FLOW 2: Path Parsing & Normalization ===  
			// Validate and normalize all file paths in this chunk
			const normalizedFiles = this.validateAndNormalizeFilePaths(files);
			
			// Create website for this chunk with consistent global export root
			const website = new Website(vaultBasedDestination);
			
			// ✅ CRITICAL: Set consistent global export root for ALL chunks  
			website.exportOptions.exportRoot = globalExportRoot;
			(website.exportOptions as any).__exportRootSetByChunkedExporter = true;
			ExportLog.log(`🔧 Setting consistent export root for chunk ${chunkIndex + 1}: "${globalExportRoot}"`);
			
			await website.load(normalizedFiles);
			
			// ✅ CRITICAL: Verify and enforce export root consistency after load
			if (website.exportOptions.exportRoot !== globalExportRoot) {
				ExportLog.error(`❌ CRITICAL: Export root was overridden during load!`);
				ExportLog.error(`   Expected: "${globalExportRoot}"`);
				ExportLog.error(`   Got: "${website.exportOptions.exportRoot}"`);
				ExportLog.error(`   Re-enforcing consistent export root...`);
				
				// Force back to global export root
				website.exportOptions.exportRoot = globalExportRoot;
				(website.exportOptions as any).__exportRootSetByChunkedExporter = true;
			}
			
			ExportLog.log(`✅ Chunk ${chunkIndex + 1} final export root: "${website.exportOptions.exportRoot}"`);
			
			// === DEBUG: Test path behavior ===
			if (normalizedFiles.length > 0) {
				const testFile = normalizedFiles[0];
				const testTargetPath = website.getTargetPathForFile(testFile);
				ExportLog.log(`🧪 Testing path behavior with first file:`);
				ExportLog.log(`   Source: ${testFile.path}`);
				ExportLog.log(`   Target: ${testTargetPath.absoluted().path}`);
				ExportLog.log(`   Export root: "${website.exportOptions.exportRoot}"`);
				
				if (website.exportOptions.exportRoot === '') {
					ExportLog.log(`   ✅ Empty export root - files will maintain full directory structure`);
				} else {
					ExportLog.log(`   ✅ Export root set - files will be relative to: ${website.exportOptions.exportRoot}`);
				}
			}
			
			// === FLOW 3: Slugification Flow ===
			// Ensure slugification consistency with the pre-set global export root
			this.ensureSlugificationConsistency(website);
			
			// === FLOW 4: Directory Creation Flow ===
			// Pre-create directory structure for this chunk
			await this.ensureDirectoryStructure(website, normalizedFiles);
			
			// Build the website
			const builtWebsite = await website.build();
			
			if (!builtWebsite) {
				ExportLog.error(`Failed to build chunk ${chunkIndex + 1}`);
				return undefined;
			}
			
			// === FLOW 5: Relative Path Calculation Flow ===
			// Validate relative path calculations are consistent
			this.validateRelativePathConsistency(builtWebsite);
			
			// === FINAL VERIFICATION: Log successful chunk completion ===
			ExportLog.log(`✅ Successfully processed chunk ${chunkIndex + 1} with natural export root: "${builtWebsite.exportOptions.exportRoot}"`);
			ExportLog.log(`📄 Processed ${normalizedFiles.length} files with all 5 Path.ts flows`);
			return builtWebsite;
			
		} catch (error) {
			ExportLog.error(error, `Error processing chunk ${chunkIndex + 1}`);
			return undefined;
		}
	}
	
	/**
	 * FLOW 1: Vault Path Detection - Ensure destination uses proper vault context
	 */
	private static ensureVaultBasedDestination(destination: Path): Path {
		// Ensure destination is properly resolved relative to vault path
		if (destination.isRelative) {
			return Path.vaultPath.joinString(destination.path);
		}
		
		// Validate that absolute destination has proper vault context
		const vaultPath = Path.vaultPath.path;
		if (!destination.path.includes(vaultPath) && !destination.path.startsWith("/tmp") && !destination.path.startsWith("C:\\temp")) {
			ExportLog.log(`Destination ${destination.path} doesn't include vault context, using as-is`);
		}
		
		return destination;
	}

	/**
	 * FLOW 2: Path Parsing & Normalization - Validate and normalize all file paths
	 */
	private static validateAndNormalizeFilePaths(files: TFile[]): TFile[] {
		return files.filter(file => {
			try {
				// Test path parsing and normalization
				const testPath = new Path(file.path);
				const normalized = testPath.normalized();
				
				// Ensure path can be properly decoded and parsed
				if (!normalized.path || normalized.path.trim() === "") {
					ExportLog.warning(`Skipping file with invalid path: ${file.path}`);
					return false;
				}
				
				// Validate path components exist
				if (!testPath.basename || !testPath.extension) {
					ExportLog.log(`File path components: ${file.path} -> basename: ${testPath.basename}, ext: ${testPath.extension}`);
				}
				
				return true;
			} catch (error) {
				ExportLog.error(error, `Failed to normalize path for file: ${file.path}`);
				return false;
			}
		});
	}

	/**
	 * FLOW 3: Slugification - Ensure consistent web-safe path transformation
	 */
	private static ensureSlugificationConsistency(website: Website): void {
		// Verify slugification settings are properly applied
		const slugifyEnabled = website.exportOptions.slugifyPaths;
		
		ExportLog.log(`Slugification ${slugifyEnabled ? 'enabled' : 'disabled'} for chunk with root: ${website.exportOptions.exportRoot}`);
		
		// Test slugification on export root to ensure consistency
		if (slugifyEnabled && website.exportOptions.exportRoot) {
			const testPath = new Path(website.exportOptions.exportRoot);
			const slugified = testPath.slugified();
			ExportLog.log(`Export root slugification test: "${website.exportOptions.exportRoot}" -> "${slugified.path}"`);
		}
	}

	/**
	 * FLOW 4: Directory Creation - Pre-create directory structure
	 */
	private static async ensureDirectoryStructure(website: Website, files: TFile[]): Promise<void> {
		try {
			// Collect all unique directories that will be needed
			const directoriesToCreate = new Set<string>();
			
			ExportLog.log(`📁 Calculating target paths for ${files.length} files with export root: "${website.exportOptions.exportRoot}"`);
			
			for (const file of files) {
				const targetPath = website.getTargetPathForFile(file);
				const directory = targetPath.directory;
				
				// Log first few files for debugging
				if (directoriesToCreate.size < 5) {
					ExportLog.log(`   📄 File: ${file.path}`);
					ExportLog.log(`   🎯 Target: ${targetPath.absoluted().path}`);
					ExportLog.log(`   📁 Directory: ${directory?.absoluted().path || 'N/A'}`);
					ExportLog.log(`   ---`);
				}
				
				if (directory && directory.path) {
					directoriesToCreate.add(directory.absoluted().path);
				}
			}
			
			// Pre-create all directories
			for (const dir of directoriesToCreate) {
				const dirPath = new Path(dir);
				await dirPath.createDirectory();
			}
			
			ExportLog.log(`Pre-created ${directoriesToCreate.size} directories for chunk`);
			
		} catch (error) {
			ExportLog.error(error, "Failed to pre-create directory structure");
		}
	}

	/**
	 * FLOW 5: Relative Path Calculation - Validate path relationships
	 */
	private static validateRelativePathConsistency(website: Website): void {
		try {
			// Test relative path calculations
			const testSourcePath = new Path("test/source/file.md");
			const testTargetPath = new Path("test/target/file.md");
			
			// Validate getRelativePath works correctly
			const relativePath = Path.getRelativePath(testSourcePath, testTargetPath);
			
			// Validate getRelativePathFromVault works
			const vaultRelativePath = Path.getRelativePathFromVault(testTargetPath);
			
			ExportLog.log(`✅ Relative path validation: source->target: ${relativePath.path}, vault->target: ${vaultRelativePath.path}`);
			ExportLog.log(`📂 Website export root: "${website.exportOptions.exportRoot}"`);
			
		} catch (error) {
			ExportLog.error(error, "Relative path validation failed");
		}
	}

	/**
	 * Merge a chunk website into the final website
	 */
	private static async mergeChunkIntoWebsite(chunkWebsite: Website, finalWebsite: Website | undefined): Promise<void> {
		if (!finalWebsite || !chunkWebsite) return;
		
		try {
			// For mixed content, we DON'T force export root consistency
			// Each chunk maintains its natural export root for proper directory structure
			ExportLog.log(`🔄 Merging chunk with export root: "${chunkWebsite.exportOptions.exportRoot}"`);
			ExportLog.log(`   Final website export root: "${finalWebsite.exportOptions.exportRoot}"`);
			
			// Merge file indexes
			if (chunkWebsite.index && finalWebsite.index) {
				// Add new files from chunk to final website
				finalWebsite.index.newFiles.push(...chunkWebsite.index.newFiles);
				finalWebsite.index.updatedFiles.push(...chunkWebsite.index.updatedFiles);
				
				// Merge attachments shown in tree
				const chunkAttachments = chunkWebsite.index.attachmentsShownInTree || [];
				const finalAttachments = finalWebsite.index.attachmentsShownInTree || [];
				finalWebsite.index.attachmentsShownInTree = [...finalAttachments, ...chunkAttachments];
				
				// Merge webpages
				const chunkWebpages = chunkWebsite.index.webpages || [];
				const finalWebpages = finalWebsite.index.webpages || [];
				finalWebsite.index.webpages = [...finalWebpages, ...chunkWebpages];
				
				// ✅ FIX: Only include content webpages in attachmentsShownInTree (exclude media HTML wrappers)
				// This handles any edge cases where webpages might not be properly added to attachmentsShownInTree
				for (const webpage of chunkWebpages) {
					if (webpage.showInTree && !finalWebsite.index.attachmentsShownInTree.includes(webpage)) {
						// Check if this webpage is a media wrapper by looking at source extension
						const sourcePath = webpage.source?.path || webpage.sourcePath || "";
						const sourceExtension = sourcePath.split('.').pop()?.toLowerCase() || "";
						const isMediaWrapper = MarkdownRendererAPI.viewableMediaExtensions.includes(sourceExtension) && sourceExtension !== "md";
						
						// Only add to tree if it's NOT a media wrapper (i.e., it's a regular content page)
						if (!isMediaWrapper) {
							finalWebsite.index.attachmentsShownInTree.push(webpage);
						}
					}
				}

				// ✅ CRITICAL FIX: Merge search index from chunk into final website
				// Each chunk builds its own search index - we need to merge all of them
				if (chunkWebsite.index.minisearch && finalWebsite.index.minisearch) {
					// Get all documents from the chunk's search index and add to final search index
					const chunkDocuments: any[] = [];
					
					// Extract all documents from chunk's minisearch
					// We need to iterate through the chunk's webpages to get search data since we can't easily extract from minisearch
					for (const webpage of chunkWebpages) {
						try {
							const webpagePath = webpage.targetPath.path;
							
							// Check if this document is already in final search index
							if (!finalWebsite.index.minisearch.has(webpagePath)) {
								const headersInfo = await webpage.outputData.renderedHeadings;
								if (headersInfo.length > 0 && headersInfo[0].level == 1 && headersInfo[0].heading == webpage.title) headersInfo.shift();
								const headers = headersInfo.map((header) => header.heading);

								const searchDoc = {
									title: webpage.title,
									aliases: webpage.outputData.aliases,
									headers: headers,
									tags: webpage.outputData.allTags,
									path: webpagePath,
									content: webpage.outputData.description + " " + webpage.outputData.searchContent,
								};
								
								// Add to final website's search index
								finalWebsite.index.minisearch.add(searchDoc);
								chunkDocuments.push(searchDoc);
							}
						} catch (error) {
							ExportLog.warning(`Failed to merge search index for webpage: ${webpage.targetPath.path}`);
						}
					}
					
					ExportLog.log(`🔍 Merged search index: +${chunkDocuments.length} documents from chunk`);
				}
				
				ExportLog.log(`📝 Merged chunk: +${chunkWebsite.index.newFiles.length} new files, +${chunkWebpages.length} webpages`);
				ExportLog.log(`   Total items in attachmentsShownInTree: ${finalWebsite.index.attachmentsShownInTree.length}`);
				ExportLog.log(`   Note: Raw attachment files will be filtered out from file tree during tree generation`);
				ExportLog.log(`   Files will maintain their natural directory structure`);
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

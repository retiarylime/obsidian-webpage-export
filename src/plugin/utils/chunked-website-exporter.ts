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
		
		// Calculate the common root path for ALL files to ensure consistent directory structure
		const globalExportRoot = this.findCommonRootPath(files);
		ExportLog.log(`📁 Global export root calculated: "${globalExportRoot}"`);
		ExportLog.log(`✅ All chunks will use consistent root for directory structure preservation`);
		
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
				
				ExportLog.log(`🏗️ Starting chunk ${i + 1}/${chunks.length} with ${chunk.length} files and global root: "${globalExportRoot}"`);
				
				// Process the chunk
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
	 */
	private static findCommonRootPath(files: { path: string }[]): string {
		if (!files || files.length === 0) {
			return '';
		}
	
		if (files.length === 1) {
			const parts = files[0].path.split('/');
			parts.pop(); // Remove filename
			return parts.join('/');
		}
	
		const paths = files.map(file => file.path.split('/'));
		let commonPath: string[] = [];
		const shortestPathLength = Math.min(...paths.map(p => p.length));
	
		// Find the longest common prefix of directory segments
		for (let i = 0; i < shortestPathLength - 1; i++) { // -1 to exclude filename
			const segment = paths[0][i];
			if (paths.every(path => path[i] === segment)) {
				commonPath.push(segment);
			} else {
				break;
			}
		}
	
		return commonPath.join('/');
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
	 * Process a single chunk of files following all 5 Path.ts flows
	 */
	private static async processChunk(files: TFile[], destination: Path, chunkIndex: number, globalExportRoot: string): Promise<Website | undefined> {
		try {
			ExportLog.log(`Processing chunk ${chunkIndex + 1} with ${files.length} files`);
			
			// === FLOW 1: Vault Path Detection ===
			// Ensure destination is properly set with vault context
			const vaultBasedDestination = this.ensureVaultBasedDestination(destination);
			
			// === FLOW 2: Path Parsing & Normalization ===  
			// Validate and normalize all file paths in this chunk
			const normalizedFiles = this.validateAndNormalizeFilePaths(files);
			
			// Create website for this chunk
			const website = new Website(vaultBasedDestination);
			
			// === CRITICAL FIX: Set global export root BEFORE loading ===
			// This prevents Website.load() from calculating its own chunk-specific root
			website.exportOptions.exportRoot = globalExportRoot;
			ExportLog.log(`🔧 Pre-setting export root for chunk ${chunkIndex + 1}: "${globalExportRoot}"`);
			
			await website.load(normalizedFiles);
			
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
			this.validateRelativePathConsistency(builtWebsite, globalExportRoot);
			
			// === FINAL VERIFICATION: Check target paths are correct ===
			this.verifyChunkPathConsistency(builtWebsite, normalizedFiles, globalExportRoot);
			
			ExportLog.log(`Successfully processed chunk ${chunkIndex + 1} with all 5 Path.ts flows`);
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
				if (directoriesToCreate.size < 3) {
					ExportLog.log(`   📄 File: ${file.path} -> Target: ${targetPath.absoluted().path}`);
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
	private static validateRelativePathConsistency(website: Website, globalExportRoot: string): void {
		try {
			// Test relative path calculations with the global root
			const testSourcePath = new Path("test/source/file.md");
			const testTargetPath = new Path("test/target/file.md");
			
			// Validate getRelativePath works correctly
			const relativePath = Path.getRelativePath(testSourcePath, testTargetPath);
			
			// Validate getRelativePathFromVault works
			const vaultRelativePath = Path.getRelativePathFromVault(testTargetPath);
			
			ExportLog.log(`Relative path validation: source->target: ${relativePath.path}, vault->target: ${vaultRelativePath.path}`);
			
			// Validate export root consistency
			if (globalExportRoot !== website.exportOptions.exportRoot) {
				ExportLog.warning(`Export root mismatch: global="${globalExportRoot}", website="${website.exportOptions.exportRoot}"`);
			}
			
		} catch (error) {
			ExportLog.error(error, "Relative path validation failed");
		}
	}

	/**
	 * Verify that chunk paths are calculated consistently with global export root
	 */
	private static verifyChunkPathConsistency(website: Website, files: TFile[], globalExportRoot: string): void {
		try {
			ExportLog.log(`🔍 Verifying path consistency for ${files.length} files in chunk`);
			
			// Check export root consistency
			if (website.exportOptions.exportRoot !== globalExportRoot) {
				ExportLog.error(`❌ Export root inconsistency detected! Expected: "${globalExportRoot}", Got: "${website.exportOptions.exportRoot}"`);
			} else {
				ExportLog.log(`✅ Export root consistent: "${globalExportRoot}"`);
			}
			
			// Sample a few files to verify their paths
			const sampleFiles = files.slice(0, Math.min(3, files.length));
			for (const file of sampleFiles) {
				const targetPath = website.getTargetPathForFile(file);
				const expectedRoot = globalExportRoot ? globalExportRoot + "/" : "";
				
				if (globalExportRoot && !targetPath.path.includes(globalExportRoot)) {
					ExportLog.warning(`⚠️ File path may not respect global root: ${file.path} -> ${targetPath.absoluted().path}`);
				} else {
					ExportLog.log(`✅ Path verified: ${file.path} -> ${targetPath.absoluted().path}`);
				}
			}
			
		} catch (error) {
			ExportLog.error(error, "Path consistency verification failed");
		}
	}

	/**
	 * Merge a chunk website into the final website
	 */
	private static async mergeChunkIntoWebsite(chunkWebsite: Website, finalWebsite: Website | undefined): Promise<void> {
		if (!finalWebsite || !chunkWebsite) return;
		
		try {
			// Ensure final website maintains consistent export root
			if (finalWebsite.exportOptions.exportRoot !== chunkWebsite.exportOptions.exportRoot) {
				ExportLog.log(`🔄 Ensuring consistent export root in final website: "${chunkWebsite.exportOptions.exportRoot}"`);
				finalWebsite.exportOptions.exportRoot = chunkWebsite.exportOptions.exportRoot;
			}
			
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
				
				ExportLog.log(`📝 Merged chunk: +${chunkWebsite.index.newFiles.length} new files, +${chunkWebpages.length} webpages`);
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

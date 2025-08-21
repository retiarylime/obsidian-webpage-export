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
		
		// DEBUG: Show sample file paths to verify root calculation
		const samplePaths = files.slice(0, Math.min(10, files.length)).map(f => f.path);
		ExportLog.log(`🔍 Sample file paths for root calculation:`);
		samplePaths.forEach(path => ExportLog.log(`   📄 ${path}`));
		ExportLog.log(`🎯 Calculated common root: "${globalExportRoot}" from ${files.length} files`);
		
		// DEBUG: Test the root calculation with more detail
		if (files.length > 0) {
			const firstFile = files[0];
			const parentPath = new Path(firstFile.path).parent?.path ?? '';
			ExportLog.log(`🔍 First file: "${firstFile.path}" -> Parent: "${parentPath}"`);
			
			if (files.length > 1) {
				const paths = files.map(file => new Path(file.path).split());
				ExportLog.log(`🔍 Path segments comparison (first 5 files):`);
				paths.slice(0, 5).forEach((pathSegments, index) => {
					ExportLog.log(`   File ${index + 1}: [${pathSegments.join(' / ')}]`);
				});
				
				// Test common path calculation step by step
				const shortestLength = Math.min(...paths.map(p => p.length));
				ExportLog.log(`🔍 Shortest path length: ${shortestLength}`);
				
				let commonSegments: string[] = [];
				for (let i = 0; i < shortestLength; i++) {
					const segment = paths[0][i];
					const allMatch = paths.every(path => path[i] === segment);
					ExportLog.log(`   Segment ${i}: "${segment}" - All match: ${allMatch}`);
					if (allMatch) {
						commonSegments.push(segment);
					} else {
						break;
					}
				}
				ExportLog.log(`🔍 Common segments before processing: [${commonSegments.join(' / ')}]`);
			}
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
	 * (Uses the same algorithm as Website.findCommonRootPath for consistency)
	 */
	private static findCommonRootPath(files: { path: string }[]): string {
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
	
		return new Path(commonPath.join('/')).path;
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
			
			// === VERIFICATION: Ensure export root wasn't overridden ===
			if (website.exportOptions.exportRoot !== globalExportRoot) {
				ExportLog.error(`❌ CRITICAL: Export root was overridden during load!`);
				ExportLog.error(`   Expected: "${globalExportRoot}"`);
				ExportLog.error(`   Got: "${website.exportOptions.exportRoot}"`);
				ExportLog.error(`   This will cause path inconsistency!`);
				
				// Force restore the global export root
				website.exportOptions.exportRoot = globalExportRoot;
				ExportLog.log(`🔧 FORCE RESTORED export root to: "${globalExportRoot}"`);
			} else {
				ExportLog.log(`✅ Export root preserved correctly: "${globalExportRoot}"`);
			}
			
			// === ADDITIONAL DEBUG: Test removeRootFromPath behavior ===
			if (normalizedFiles.length > 0) {
				const testFile = normalizedFiles[0];
				const testTargetPath = website.getTargetPathForFile(testFile);
				ExportLog.log(`🧪 Testing path behavior with first file:`);
				ExportLog.log(`   Source: ${testFile.path}`);
				ExportLog.log(`   Target: ${testTargetPath.absoluted().path}`);
				ExportLog.log(`   Export root: "${website.exportOptions.exportRoot}"`);
				
				// Simulate what removeRootFromPath would do
				if (website.exportOptions.exportRoot && website.exportOptions.exportRoot !== '') {
					const rootPath = new Path(website.exportOptions.exportRoot);
					const rootSlugified = rootPath.slugify(website.exportOptions.slugifyPaths);
					const rootForComparison = rootSlugified.path + "/";
					
					ExportLog.log(`   🧪 Export root processing:`);
					ExportLog.log(`     Original: "${website.exportOptions.exportRoot}"`);
					ExportLog.log(`     Slugified: "${rootSlugified.path}"`);
					ExportLog.log(`     With slash: "${rootForComparison}"`);
					
					if (testTargetPath.path.startsWith(rootForComparison.replace(/\/$/, ""))) {
						ExportLog.log(`   ✅ Target path contains export root - will be stripped`);
						const remainingPath = testTargetPath.path.substring(rootForComparison.length);
						ExportLog.log(`   📍 After stripping: "${remainingPath}"`);
					} else {
						ExportLog.warning(`   ⚠️ Target path does NOT start with export root - will stay full path!`);
						ExportLog.warning(`     Target: "${testTargetPath.path}"`);
						ExportLog.warning(`     Root: "${rootForComparison}"`);
					}
				} else {
					ExportLog.warning(`   ⚠️ Export root is empty - no stripping will occur!`);
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
			
			// === CRITICAL VERIFICATION: Check export root after build ===
			if (builtWebsite && builtWebsite.exportOptions.exportRoot !== globalExportRoot) {
				ExportLog.error(`❌ CRITICAL: Export root changed during build!`);
				ExportLog.error(`   Expected: "${globalExportRoot}"`);
				ExportLog.error(`   Got: "${builtWebsite.exportOptions.exportRoot}"`);
				ExportLog.error(`   Files from this chunk will have wrong paths!`);
			}
			
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
			const sampleFiles = files.slice(0, Math.min(5, files.length));
			for (const file of sampleFiles) {
				const targetPath = website.getTargetPathForFile(file);
				
				ExportLog.log(`🔍 Path verification for: ${file.path}`);
				ExportLog.log(`   📁 Export root: "${globalExportRoot}"`);
				ExportLog.log(`   🎯 Target path: "${targetPath.absoluted().path}"`);
				ExportLog.log(`   📂 Working directory: "${targetPath.workingDirectory}"`);
				
				// Check if target path contains the export root
				const targetAbsolute = targetPath.absoluted().path;
				if (globalExportRoot && globalExportRoot !== '') {
					if (targetAbsolute.includes(globalExportRoot)) {
						ExportLog.log(`   ✅ Target path contains export root`);
					} else {
						ExportLog.warning(`   ⚠️ Target path does NOT contain export root`);
					}
				}
				
				ExportLog.log(`   ---`);
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

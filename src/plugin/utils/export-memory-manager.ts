import { MarkdownRendererAPI } from "../render-api/render-api";

/**
 * Enhanced memory management specifically for large vault exports
 */
export class ExportMemoryManager {
	private static readonly MEMORY_CHECK_INTERVAL = 5; // Check every 5 files
	private static readonly LOW_MEMORY_THRESHOLD = 150; // MB
	private static readonly HIGH_MEMORY_THRESHOLD = 250; // MB
	private static readonly CRITICAL_MEMORY_THRESHOLD = 400; // MB
	
	private static fileCount = 0;
	private static lastCleanupMemory = 0;

	/**
	 * Call this before starting export
	 */
	public static startExportSession(): void {
		this.fileCount = 0;
		this.lastCleanupMemory = this.getMemoryUsageMB();
		console.log(`Export session started. Initial memory: ${this.lastCleanupMemory.toFixed(1)}MB`);
	}

	/**
	 * Call this after processing each file
	 */
	public static async onFileProcessed(filePath: string): Promise<void> {
		this.fileCount++;
		const currentMemory = this.getMemoryUsageMB();
		
		// Check if we need cleanup
		const shouldCleanup = 
			this.fileCount % this.MEMORY_CHECK_INTERVAL === 0 || // Regular interval
			currentMemory > this.HIGH_MEMORY_THRESHOLD || // High memory
			(currentMemory - this.lastCleanupMemory) > 100; // Memory grew by 100MB

		if (shouldCleanup) {
			await this.performMemoryCleanup(filePath, currentMemory);
		}

		// Critical memory handling
		if (currentMemory > this.CRITICAL_MEMORY_THRESHOLD) {
			console.error(`CRITICAL MEMORY USAGE: ${currentMemory.toFixed(1)}MB - performing emergency cleanup`);
			await this.emergencyCleanup();
		}
	}

	/**
	 * Regular memory cleanup
	 */
	private static async performMemoryCleanup(filePath: string, memoryBefore: number): Promise<void> {
		console.log(`Memory cleanup at file ${this.fileCount} (${filePath}): ${memoryBefore.toFixed(1)}MB`);
		
		try {
			// Clean up DOM elements
			this.cleanupDOMElements();
			
			// Try to clean up render system
			try {
				MarkdownRendererAPI.forceCleanup();
			} catch (e) {
				console.warn("Failed to cleanup render API:", e);
			}
			
			// Force garbage collection
			this.forceGarbageCollection();
			
			// Small delay to let cleanup settle
			await this.delay(100);
			
			const memoryAfter = this.getMemoryUsageMB();
			const saved = memoryBefore - memoryAfter;
			console.log(`Memory cleanup completed: ${memoryBefore.toFixed(1)}MB -> ${memoryAfter.toFixed(1)}MB (saved ${saved.toFixed(1)}MB)`);
			
			this.lastCleanupMemory = memoryAfter;
			
		} catch (error) {
			console.error("Memory cleanup failed:", error);
		}
	}

	/**
	 * Emergency cleanup for critical memory situations
	 */
	private static async emergencyCleanup(): Promise<void> {
		try {
			// Multiple cleanup passes
			for (let i = 0; i < 3; i++) {
				this.cleanupDOMElements();
				this.forceGarbageCollection();
				await this.delay(200);
			}
			
			// Force cleanup of any cached elements
			this.clearAllCaches();
			
			const memoryAfter = this.getMemoryUsageMB();
			console.log(`Emergency cleanup completed. Memory: ${memoryAfter.toFixed(1)}MB`);
			
		} catch (error) {
			console.error("Emergency cleanup failed:", error);
		}
	}

	/**
	 * Clean up DOM elements that might be consuming memory
	 */
	private static cleanupDOMElements(): void {
		try {
			// Remove temporary containers
			const tempSelectors = [
				'.temp-export-container',
				'.obsidian-document:not([data-permanent])',
				'.markdown-preview-section:empty',
				'canvas:not([data-permanent])',
				'[data-temp="true"]'
			];
			
			let removedCount = 0;
			tempSelectors.forEach(selector => {
				try {
					const elements = document.querySelectorAll(selector);
					elements.forEach(el => {
						try {
							el.remove();
							removedCount++;
						} catch (e) {
							// Ignore individual removal errors
						}
					});
				} catch (e) {
					// Ignore selector errors
				}
			});

			if (removedCount > 0) {
				console.log(`Cleaned up ${removedCount} DOM elements`);
			}

			// Clean up any orphaned event listeners by removing and re-creating containers
			this.cleanupEventListeners();

		} catch (error) {
			console.warn("DOM cleanup error:", error);
		}
	}

	/**
	 * Clean up event listeners that might be causing memory leaks
	 */
	private static cleanupEventListeners(): void {
		try {
			// Find containers that might have accumulated event listeners
			const containers = document.querySelectorAll('.workspace-leaf-content, .markdown-preview-sizer');
			containers.forEach(container => {
				// Clone element to remove all event listeners
				const clone = container.cloneNode(true);
				container.parentNode?.replaceChild(clone, container);
			});
		} catch (error) {
			// Ignore cleanup errors
		}
	}

	/**
	 * Clear all possible caches
	 */
	private static clearAllCaches(): void {
		try {
			// Clear blob URLs
			if (typeof URL !== 'undefined' && URL.revokeObjectURL) {
				// We can't enumerate all blob URLs, but we can try to find them in the DOM
				const elements = document.querySelectorAll('[src^="blob:"], [href^="blob:"]');
				elements.forEach(el => {
					try {
						const url = el.getAttribute('src') || el.getAttribute('href');
						if (url && url.startsWith('blob:')) {
							URL.revokeObjectURL(url);
						}
					} catch (e) {
						// Ignore individual cleanup errors
					}
				});
			}

			// Clear any cached stylesheets
			const tempStyles = document.querySelectorAll('style[data-temp], link[data-temp]');
			tempStyles.forEach(style => style.remove());

		} catch (error) {
			console.warn("Cache cleanup error:", error);
		}
	}

	/**
	 * Force garbage collection if available
	 */
	private static forceGarbageCollection(): void {
		try {
			// Try global.gc first (Node.js/Electron)
			if (typeof global !== 'undefined' && global.gc) {
				global.gc();
				return;
			}
			
			// Try window.gc (some browsers)
			if (typeof window !== 'undefined' && (window as any).gc) {
				(window as any).gc();
				return;
			}
			
			// Fallback: create memory pressure to encourage GC
			const arrays: any[] = [];
			for (let i = 0; i < 20; i++) {
				arrays.push(new Array(1000000).fill(null));
			}
			arrays.length = 0; // Clear references
			
		} catch (e) {
			// GC not available or failed
		}
	}

	/**
	 * Get current memory usage in MB
	 */
	private static getMemoryUsageMB(): number {
		try {
			if (typeof process !== 'undefined' && process.memoryUsage) {
				return process.memoryUsage().heapUsed / 1024 / 1024;
			}
			
			// Fallback for browser environments
			if ('memory' in performance && (performance as any).memory) {
				return (performance as any).memory.usedJSHeapSize / 1024 / 1024;
			}
		} catch (e) {
			// Memory info not available
		}
		return 0;
	}

	/**
	 * Simple delay utility
	 */
	private static delay(ms: number): Promise<void> {
		return new Promise(resolve => setTimeout(resolve, ms));
	}

	/**
	 * Get memory statistics
	 */
	public static getStats(): { fileCount: number; memoryMB: number; lastCleanupMemory: number } {
		return {
			fileCount: this.fileCount,
			memoryMB: this.getMemoryUsageMB(),
			lastCleanupMemory: this.lastCleanupMemory
		};
	}

	/**
	 * Call this when export is complete
	 */
	public static endExportSession(): void {
		const finalMemory = this.getMemoryUsageMB();
		console.log(`Export session ended. Processed ${this.fileCount} files. Final memory: ${finalMemory.toFixed(1)}MB`);
		
		// Final cleanup
		this.cleanupDOMElements();
		this.forceGarbageCollection();
	}
}

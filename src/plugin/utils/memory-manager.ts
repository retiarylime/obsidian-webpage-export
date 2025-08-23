import { MarkdownRendererAPI } from "../render-api/render-api";

export class MemoryManager {
	private static readonly CLEANUP_THRESHOLD_MB = 200; // More aggressive threshold
	private static readonly CRITICAL_THRESHOLD_MB = 400; // Critical memory level
	private static cleanupCount = 0;

	/**
	 * Check current memory usage
	 */
	public static getMemoryUsageMB(): number {
		if (typeof process !== 'undefined' && process.memoryUsage) {
			return process.memoryUsage().heapUsed / 1024 / 1024;
		}
		return 0;
	}

	/**
	 * Check if memory cleanup is needed
	 */
	public static needsCleanup(): boolean {
		return this.getMemoryUsageMB() > this.CLEANUP_THRESHOLD_MB;
	}

	/**
	 * Perform memory cleanup operations
	 */
	public static async cleanup(): Promise<void> {
		this.cleanupCount++;
		const beforeCleanup = this.getMemoryUsageMB();
		
		try {
			// Clean up DOM elements first
			this.cleanupDOMElements();
			
			// Force cleanup in render API
			MarkdownRendererAPI.forceCleanup();
			
			// Clear any remaining caches
			this.clearBrowserCaches();
			
			// Force garbage collection multiple times for better cleanup
			this.forceGarbageCollection();
			await this.delay(50);
			this.forceGarbageCollection();
			
			// Small delay to allow cleanup to complete
			await this.delay(100);
			
			const afterCleanup = this.getMemoryUsageMB();
			const saved = beforeCleanup - afterCleanup;
			console.log(`Memory cleanup #${this.cleanupCount}: ${beforeCleanup.toFixed(1)}MB -> ${afterCleanup.toFixed(1)}MB (saved ${saved.toFixed(1)}MB)`);
			
		} catch (error) {
			console.warn("Memory cleanup encountered an error:", error);
		}
	}

	/**
	 * Critical memory cleanup - more aggressive
	 */
	public static async criticalCleanup(): Promise<void> {
		console.warn("Critical memory cleanup triggered!");
		
		// Multiple cleanup passes
		await this.cleanup();
		await this.delay(200);
		await this.cleanup();
		
		// Clear all possible caches
		this.clearAllCaches();
	}

	/**
	 * Clean up DOM elements that may be accumulating
	 */
	private static cleanupDOMElements(): void {
		// Remove temporary containers
		const tempSelectors = [
			'.temp-export-container',
			'.obsidian-document:not([data-permanent])', 
			'.markdown-preview-section:empty',
			'.html-progress-log-item:nth-child(n+100)' // Keep only last 100 log items
		];
		
		tempSelectors.forEach(selector => {
			try {
				const elements = document.querySelectorAll(selector);
				elements.forEach(el => {
					try {
						el.remove();
					} catch (e) {
						// Ignore individual removal errors
					}
				});
			} catch (e) {
				// Ignore selector errors
			}
		});

		// Clean up any leaked canvas elements (they can consume a lot of memory)
		const canvases = document.querySelectorAll('canvas:not([data-permanent])');
		canvases.forEach(canvas => {
			try {
				const canvasEl = canvas as HTMLCanvasElement;
				const ctx = canvasEl.getContext('2d');
				if (ctx) {
					ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);
				}
				canvas.remove();
			} catch (e) {
				// Ignore cleanup errors
			}
		});
	}

	/**
	 * Clear browser caches that might be holding memory
	 */
	private static clearBrowserCaches(): void {
		try {
			// Clear any cached images or resources
			if (typeof window !== 'undefined') {
				// Clear cached stylesheets
				const stylesheets = document.querySelectorAll('style[data-temp], link[data-temp]');
				stylesheets.forEach(sheet => sheet.remove());
				
				// Clear any cached blob URLs
				// Note: We can't enumerate all blob URLs, but we can try to clean up known patterns
			}
		} catch (e) {
			// Ignore cache clearing errors
		}
	}

	/**
	 * Clear all possible caches - public API method
	 */
	public static clearCaches(): void {
		this.clearAllCaches();
	}

	/**
	 * Clear all possible caches - most aggressive cleanup
	 */
	private static clearAllCaches(): void {
		try {
			this.clearBrowserCaches();
			
			// Clear any global caches that might exist
			if (typeof window !== 'undefined') {
				// Clear CSS rule caches
				const sheets = document.styleSheets;
				for (let i = 0; i < sheets.length; i++) {
					try {
						const sheet = sheets[i];
						if (sheet.href && sheet.href.includes('blob:')) {
							// This is a temporary stylesheet, try to clear it
							URL.revokeObjectURL(sheet.href);
						}
					} catch (e) {
						// Ignore individual sheet errors
					}
				}
			}
		} catch (e) {
			// Ignore cache clearing errors
		}
	}

	/**
	 * Force garbage collection if available
	 */
	private static forceGarbageCollection(): void {
		try {
			// Try global.gc first (Node.js)
			if (typeof global !== 'undefined' && global.gc) {
				global.gc();
				return;
			}
			
		// Try window.gc (some browsers)
		if (typeof window !== 'undefined' && (window as any).gc) {
			(window as any).gc();
			return;
		}
		
		// Fallback: gentle memory cleanup without memory pressure
		// Clear any existing weak references and encourage cleanup
		if (typeof setTimeout !== 'undefined') {
			// Use setTimeout to allow event loop to process
			setTimeout(() => {
				// Try a gentle cleanup approach
				try {
					// Clear any cached DOM references
					if (typeof document !== 'undefined') {
						document.dispatchEvent(new Event('memoryCleanup'));
					}
				} catch (e) {
					// Ignore cleanup errors
				}
			}, 0);
		}		} catch (e) {
			// GC not available or failed
		}
	}

	/**
	 * Simple delay utility
	 */
	private static delay(ms: number): Promise<void> {
		return new Promise(resolve => setTimeout(resolve, ms));
	}

	/**
	 * Monitor memory usage and automatically clean up if needed
	 */
	public static async autoCleanup(): Promise<void> {
		const memoryUsage = this.getMemoryUsageMB();
		
		if (memoryUsage > this.CRITICAL_THRESHOLD_MB) {
			console.warn(`Critical memory usage detected: ${memoryUsage.toFixed(1)}MB - performing critical cleanup`);
			await this.criticalCleanup();
		} else if (this.needsCleanup()) {
			console.log(`Auto cleanup triggered. Memory usage: ${memoryUsage.toFixed(1)}MB`);
			await this.cleanup();
		}
	}

	/**
	 * Reset cleanup counter (useful for tracking)
	 */
	public static resetCounter(): void {
		this.cleanupCount = 0;
	}

	/**
	 * Get cleanup statistics
	 */
	public static getStats(): { cleanupCount: number; memoryUsageMB: number } {
		return {
			cleanupCount: this.cleanupCount,
			memoryUsageMB: this.getMemoryUsageMB()
		};
	}
}

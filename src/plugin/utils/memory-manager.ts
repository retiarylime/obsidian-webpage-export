import { MarkdownRendererAPI } from "../render-api/render-api";

export class MemoryManager {
	private static readonly CLEANUP_THRESHOLD_MB = 300;
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
		
		try {
			// Clean up DOM elements
			this.cleanupDOMElements();
			
			// Force cleanup in render API
			MarkdownRendererAPI.forceCleanup();
			
			// Force garbage collection if available
			this.forceGarbageCollection();
			
			// Small delay to allow cleanup to complete
			await this.delay(50);
			
			console.log(`Memory cleanup #${this.cleanupCount} completed. Memory usage: ${this.getMemoryUsageMB().toFixed(1)}MB`);
			
		} catch (error) {
			console.warn("Memory cleanup encountered an error:", error);
		}
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
			
			// Fallback: create memory pressure to encourage GC
			// This is a hack but can sometimes help
			const arrays: any[] = [];
			for (let i = 0; i < 10; i++) {
				arrays.push(new Array(1000000).fill(0));
			}
			arrays.length = 0; // Clear references
			
		} catch (e) {
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
		if (this.needsCleanup()) {
			console.log(`Auto cleanup triggered. Memory usage: ${this.getMemoryUsageMB().toFixed(1)}MB`);
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

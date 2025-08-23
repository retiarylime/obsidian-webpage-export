// Test chunked export integration
import { ChunkedWebsiteExporter } from '../src/plugin/utils/chunked-website-exporter';

// Mock TFile for testing
class MockTFile {
    constructor(public path: string, public name: string, public size: number = 1000) {
        this.stat = { size };
    }
    stat: { size: number };
}

function testChunkedExportThreshold() {
    console.log("Testing chunked export threshold...");
    
    // Test with 400 files (should not use chunked export)
    const smallFileSet = Array.from({length: 400}, (_, i) => 
        new MockTFile(`file${i}.md`, `file${i}.md`, 1000)
    );
    
    const shouldUseChunkedSmall = ChunkedWebsiteExporter.shouldUseChunkedExport(smallFileSet as any);
    console.log(`400 files - should use chunked export: ${shouldUseChunkedSmall} (expected: false)`);
    
    // Test with 600 files (should use chunked export)
    const largeFileSet = Array.from({length: 600}, (_, i) => 
        new MockTFile(`file${i}.md`, `file${i}.md`, 1000)
    );
    
    const shouldUseChunkedLarge = ChunkedWebsiteExporter.shouldUseChunkedExport(largeFileSet as any);
    console.log(`600 files - should use chunked export: ${shouldUseChunkedLarge} (expected: true)`);
    
    return shouldUseChunkedSmall === false && shouldUseChunkedLarge === true;
}

// Run test
const result = testChunkedExportThreshold();
console.log(`Test ${result ? 'PASSED' : 'FAILED'}`);

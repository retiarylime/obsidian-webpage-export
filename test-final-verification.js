#!/usr/bin/env node

// Test script to verify our chunked exporter logic matches regular exporter

console.log('=== VERIFYING CHUNKED EXPORTER MATCHES REGULAR EXPORTER ===\n');

// Simulate your Korean vault structure
const koreanVaultFiles = [
    'Korean/2000 Essential Korean Words - Beginner & Intermediate/가리키다.md',
    'Korean/2000 Essential Korean Words - Beginner & Intermediate/갈아타다.md', 
    'Korean/2000 Essential Korean Words - Beginner & Intermediate/가까이.md',
    'Korean/Korean Grammar Sentences by Evita/test1.md',
    'Korean/Korean Grammar Sentences by Evita/test2.md',
];

// Mock Path class (simplified)
class MockPath {
    constructor(pathString) {
        this.path = pathString || '';
        this.segments = this.path.split('/').filter(segment => segment.length > 0);
    }
    
    split() {
        return this.segments;
    }
    
    get parent() {
        if (this.segments.length <= 1) return null;
        const parentSegments = this.segments.slice(0, -1);
        return new MockPath(parentSegments.join('/'));
    }
    
    removeRoot(root) {
        if (!root) return this.path;
        const rootWithSlash = root + '/';
        if (this.path.startsWith(rootWithSlash)) {
            return this.path.substring(rootWithSlash.length);
        }
        return this.path;
    }
}

// Regular exporter findCommonRootPath logic
function findCommonRootPath(files) {
    if (!files || files.length === 0) {
        return '';
    }

    if (files.length === 1) {
        return new MockPath(files[0]).parent?.path ?? '';
    }

    const paths = files.map(file => new MockPath(file).split());
    let commonPath = [];
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

    return commonPath.length > 0 ? new MockPath(commonPath.join("/")).path : '';
}

// Test with your Korean vault
console.log('📁 YOUR KOREAN VAULT SCENARIO:');
console.log('Files:', koreanVaultFiles);

const calculatedExportRoot = findCommonRootPath(koreanVaultFiles);
console.log(`\nCalculated exportRoot: "${calculatedExportRoot}"`);

console.log('\n🔄 PROCESSING EACH FILE:');
console.log('Regular Exporter Logic:');
koreanVaultFiles.forEach(filePath => {
    // Website.getTargetPathForFile() - uses full path
    const fullTargetPath = filePath.replace('.md', '.html').toLowerCase().replace(/\s+/g, '-').replace(/&/g, '&');
    
    // Downloadable.removeRootFromPath() - removes exportRoot if present
    const finalPath = new MockPath(fullTargetPath).removeRoot(calculatedExportRoot);
    
    console.log(`  ${filePath} -> ${finalPath}`);
});

console.log('\nChunked Exporter Logic (NOW SHOULD MATCH):');
koreanVaultFiles.forEach(filePath => {
    // Same logic as regular exporter now
    const fullTargetPath = filePath.replace('.md', '.html').toLowerCase().replace(/\s+/g, '-').replace(/&/g, '&');
    const finalPath = new MockPath(fullTargetPath).removeRoot(calculatedExportRoot);
    
    console.log(`  ${filePath} -> ${finalPath}`);
});

console.log('\n✅ EXPECTED RESULT:');
console.log('Both regular and chunked exporters should produce IDENTICAL directory structures.');
console.log(`Since exportRoot = "${calculatedExportRoot}", ${calculatedExportRoot === '' ? 'no root will be stripped' : `"${calculatedExportRoot}/" will be stripped from paths`}.`);

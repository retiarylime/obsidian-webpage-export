#!/usr/bin/env node

// Test with actual Korean file structure to debug the issue

// Mock Path class from our implementation
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
}

// Exact findCommonRootPath implementation from our chunked exporter
function findCommonRootPath(files) {
    console.log('🔧 findCommonRootPath input:', files);
    
    if (!files || files.length === 0) {
        console.log('🔧 No files, returning empty string');
        return '';
    }

    if (files.length === 1) {
        const result = new MockPath(files[0]).parent?.path ?? '';
        console.log('🔧 Single file, parent:', result);
        return result;
    }

    const paths = files.map(file => new MockPath(file).split());
    console.log('🔧 Split paths:', paths);
    
    let commonPath = [];
    const shortestPathLength = Math.min(...paths.map(p => p.length));
    console.log('🔧 Shortest path length:', shortestPathLength);

    for (let i = 0; i < shortestPathLength; i++) {
        const segment = paths[0][i];
        console.log(`🔧 Checking segment ${i}: "${segment}"`);
        
        if (paths.every(path => path[i] === segment)) {
            commonPath.push(segment);
            console.log(`🔧 Added to common path:`, commonPath);
        } else {
            console.log(`🔧 Segment differs, breaking`);
            break;
        }
    }

    console.log('🔧 Common path before length check:', commonPath);

    // If the common path is just the root, return an empty string
    if (commonPath.length <= 1) {
        console.log('🔧 Common path length <= 1, returning empty string');
        return '';
    }

    // Remove the last segment if it's not a common parent for all files
    const lastCommonSegment = commonPath[commonPath.length - 1];
    if (!paths.every(path => path.length > commonPath.length || path[commonPath.length - 1] !== lastCommonSegment)) {
        commonPath.pop();
        console.log('🔧 Removed last segment, common path now:', commonPath);
    }

    const result = commonPath.length > 0 ? new MockPath(commonPath.join("/")).path : '';
    console.log('🔧 Final result:', result);
    return result;
}

console.log('=== DEBUGGING KOREAN STRUCTURE ===\n');

// Test with the actual Korean files that were exported
const actualKoreanFiles = [
    'Korean/2000 Essential Korean Words - Beginner & Intermediate/가리키다.md',
    'Korean/2000 Essential Korean Words - Beginner & Intermediate/가르치다.md', 
    'Korean/2000 Essential Korean Words - Beginner & Intermediate/가까이.md',
    'Korean/Korean Grammar Sentences by Evita/가리키다.md',
    'Korean/Korean Grammar Sentences by Evita/가르치다.md',
];

console.log('Input files:');
actualKoreanFiles.forEach(file => console.log(`  ${file}`));

const exportRoot = findCommonRootPath(actualKoreanFiles);

console.log(`\n✅ Calculated exportRoot: "${exportRoot}"`);

console.log('\n=== SIMULATING FILE PROCESSING ===');
actualKoreanFiles.forEach(filePath => {
    // Simulate Website.getTargetPathForFile() 
    const targetPath = filePath.replace('.md', '.html').toLowerCase().replace(/\s+/g, '-').replace(/&/g, '&');
    
    // Simulate Downloadable.removeRootFromPath()
    const rootWithSlash = exportRoot + '/';
    let finalPath = targetPath;
    if (exportRoot && targetPath.startsWith(rootWithSlash)) {
        finalPath = targetPath.substring(rootWithSlash.length);
    }
    
    console.log(`${filePath} -> ${finalPath}`);
});

console.log(`\n🤔 Expected result with exportRoot="${exportRoot}":`);
if (exportRoot === '') {
    console.log('   ✅ No root stripping - files should keep full directory structure');
    console.log('   ✅ Should see korean/2000-essential-korean-words... and korean/korean-grammar-sentences...');
} else {
    console.log(`   ❌ Root "${exportRoot}/" will be stripped from paths`);
}

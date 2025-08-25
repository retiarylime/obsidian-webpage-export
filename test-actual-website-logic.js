#!/usr/bin/env node

// Test the ACTUAL Website.findCommonRootPath logic from the TypeScript code

// Mock Path class based on the real implementation
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
    
    static joinPath(segments) {
        return segments.join('/');
    }
}

// EXACT implementation from Website.ts
function findCommonRootPath(files) {
    if (!files || files.length === 0) {
        return '';
    }

    if (files.length === 1) {
        return new MockPath(files[0].path).parent?.path ?? '';
    }

    const paths = files.map(file => new MockPath(file.path).split());
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

console.log('=== TESTING ACTUAL Website.findCommonRootPath LOGIC ===\n');

// Test Case 1: Single Korean folder (common case)
console.log('📁 TEST CASE 1: Files all under Korean/ (single top-level folder)');
const koreanFiles = [
    { path: 'Korean/2000 Essential Korean Words - Beginner & Intermediate/가리키다.md' },
    { path: 'Korean/2000 Essential Korean Words - Beginner & Intermediate/갈아타다.md' },
    { path: 'Korean/Korean Grammar Sentences by Evita/test1.md' },
    { path: 'Korean/Korean Grammar Sentences by Evita/test2.md' },
];
const koreanRoot = findCommonRootPath(koreanFiles);
console.log(`Files: ${koreanFiles.map(f => f.path).join(', ')}`);
console.log(`Result: "${koreanRoot}"`);
console.log(`Explanation: commonPath.length = ${koreanFiles[0].path.split('/').length > 1 ? '2+' : '1'}, so ${koreanRoot === '' ? 'returns empty' : 'returns common path'}`);

console.log('\n' + '='.repeat(60) + '\n');

// Test Case 2: Mixed folders (different top-level)
console.log('📁 TEST CASE 2: Files from different top-level folders');
const mixedFiles = [
    { path: 'Korean/2000 Essential Korean Words - Beginner & Intermediate/가리키다.md' },
    { path: 'English/Grammar/present-tense.md' },
    { path: 'Math/Algebra/equations.md' },
];
const mixedRoot = findCommonRootPath(mixedFiles);
console.log(`Files: ${mixedFiles.map(f => f.path).join(', ')}`);
console.log(`Result: "${mixedRoot}"`);
console.log(`Explanation: No common segments, so returns empty`);

console.log('\n' + '='.repeat(60) + '\n');

// Test Case 3: Files under same subfolder
console.log('📁 TEST CASE 3: Files under same deep subfolder');
const sameSubfolderFiles = [
    { path: 'Korean/2000 Essential Korean Words - Beginner & Intermediate/file1.md' },
    { path: 'Korean/2000 Essential Korean Words - Beginner & Intermediate/file2.md' },
    { path: 'Korean/2000 Essential Korean Words - Beginner & Intermediate/file3.md' },
];
const sameSubfolderRoot = findCommonRootPath(sameSubfolderFiles);
console.log(`Files: ${sameSubfolderFiles.map(f => f.path).join(', ')}`);
console.log(`Result: "${sameSubfolderRoot}"`);

console.log('\n' + '='.repeat(60) + '\n');

// Test Case 4: Single file
console.log('📁 TEST CASE 4: Single file');
const singleFile = [
    { path: 'Korean/2000 Essential Korean Words - Beginner & Intermediate/가리키다.md' }
];
const singleRoot = findCommonRootPath(singleFile);
console.log(`Files: ${singleFile.map(f => f.path).join(', ')}`);
console.log(`Result: "${singleRoot}"`);

console.log('\n' + '='.repeat(60) + '\n');

// Test Case 5: Multiple levels but different final folders
console.log('📁 TEST CASE 5: Same parent but different final subfolders');
const differentSubfolders = [
    { path: 'Korean/Folder1/file1.md' },
    { path: 'Korean/Folder2/file2.md' },
    { path: 'Korean/Folder3/file3.md' },
];
const differentSubfoldersRoot = findCommonRootPath(differentSubfolders);
console.log(`Files: ${differentSubfolders.map(f => f.path).join(', ')}`);
console.log(`Result: "${differentSubfoldersRoot}"`);

#!/usr/bin/env node

// Test script to verify chunked exporter path logic
const fs = require('fs');
const path = require('path');

// Mock TFile class
class MockTFile {
    constructor(filePath) {
        this.path = filePath;
        this.name = path.basename(filePath);
        this.extension = path.extname(filePath).slice(1);
    }
}

// Test the findCommonRootPath logic from our chunked exporter
function findCommonRootPath(files) {
    if (!files || files.length === 0) {
        return '';
    }

    if (files.length === 1) {
        return path.dirname(files[0].path);
    }

    const paths = files.map(file => file.path.split('/').filter(p => p.length > 0));
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

    return commonPath.length > 0 ? commonPath.join('/') : '';
}

// Test with your actual vault structure
console.log('Testing chunked exporter path logic...');

// Simulate files from your vault based on the structure we saw
const testFiles = [
    new MockTFile('Korean/2000 Essential Korean Words - Beginner & Intermediate/가리키다.md'),
    new MockTFile('Korean/2000 Essential Korean Words - Beginner & Intermediate/갈아타다.md'),
    new MockTFile('Korean/Korean Grammar Sentences by Evita/test1.md'),
    new MockTFile('Korean/Korean Grammar Sentences by Evita/test2.md'),
    new MockTFile('Some Other Folder/file1.md'),
    new MockTFile('Another Folder/file2.md'),
];

console.log('\n=== Test Files ===');
testFiles.forEach(file => console.log(`  ${file.path}`));

const commonRoot = findCommonRootPath(testFiles);
console.log(`\n=== Results ===`);
console.log(`Common root path: "${commonRoot}"`);
console.log(`Mixed vault detected: ${commonRoot === '' ? 'YES (will preserve full paths)' : 'NO (will strip common root)'}`);

console.log('\n=== Expected Behavior ===');
if (commonRoot === '') {
    console.log('✅ MIXED VAULT: Each file should preserve its full directory structure');
    testFiles.forEach(file => {
        const htmlPath = file.path.replace('.md', '.html').toLowerCase().replace(/\s/g, '-');
        console.log(`  ${file.path} -> ${htmlPath}`);
    });
} else {
    console.log(`❌ SHARED ROOT: Files will have "${commonRoot}" stripped`);
    testFiles.forEach(file => {
        const relativePath = file.path.replace(commonRoot + '/', '');
        const htmlPath = relativePath.replace('.md', '.html').toLowerCase().replace(/\s/g, '-');
        console.log(`  ${file.path} -> ${htmlPath}`);
    });
}

// Test just Korean files (like your vault might actually have)
console.log('\n\n=== Testing Korean-only files (like your actual vault) ===');
const koreanFiles = [
    new MockTFile('Korean/2000 Essential Korean Words - Beginner & Intermediate/가리키다.md'),
    new MockTFile('Korean/2000 Essential Korean Words - Beginner & Intermediate/갈아타다.md'),
    new MockTFile('Korean/Korean Grammar Sentences by Evita/test1.md'),
    new MockTFile('Korean/Korean Grammar Sentences by Evita/test2.md'),
];

const koreanRoot = findCommonRootPath(koreanFiles);
console.log(`Korean files common root: "${koreanRoot}"`);
console.log(`Mixed vault detected: ${koreanRoot === '' ? 'YES' : 'NO'}`);

if (koreanRoot !== '') {
    console.log(`⚠️  With Korean-only files, common root is "${koreanRoot}"`);
    console.log('This means paths will be flattened unless our mixed-vault detection is triggered another way.');
}

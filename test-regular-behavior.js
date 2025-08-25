#!/usr/bin/env node

// Test script to understand how regular exporter handles directory structure
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

// Mock Path class (simplified version of the real Path class)
class MockPath {
    constructor(filePath) {
        this.path = filePath;
        this.fullName = path.basename(filePath);
    }
    
    setWorkingDirectory(dir) {
        // This would set the output directory but doesn't change the relative path structure
        return this;
    }
    
    slugify(shouldSlugify) {
        if (shouldSlugify) {
            // Convert to lowercase and replace spaces with hyphens
            this.path = this.path.toLowerCase().replace(/\s+/g, '-').replace(/[&]/g, '&');
        }
        return this;
    }
}

// Test the findCommonRootPath logic (from Website class)
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

// Simulate the regular Website.getTargetPathForFile method
function regularExporterGetTargetPath(file, exportRoot) {
    console.log(`  Processing: ${file.path}`);
    console.log(`    Export root: "${exportRoot}"`);
    
    // This is what the regular Website.getTargetPathForFile does:
    const targetPath = new MockPath(file.path);
    targetPath.slugify(true); // Assume slugification is enabled
    
    console.log(`    Result: ${targetPath.path}`);
    return targetPath;
}

console.log('=== TESTING REGULAR EXPORTER BEHAVIOR ===\n');

// Test Case 1: Files from same folder (like your Korean vault)
console.log('📁 TEST CASE 1: Files from same folder (Korean vault scenario)');
const samefolderFiles = [
    new MockTFile('Korean/2000 Essential Korean Words - Beginner & Intermediate/가리키다.md'),
    new MockTFile('Korean/2000 Essential Korean Words - Beginner & Intermediate/갈아타다.md'),
    new MockTFile('Korean/Korean Grammar Sentences by Evita/test1.md'),
    new MockTFile('Korean/Korean Grammar Sentences by Evita/test2.md'),
];

const samefolderRoot = findCommonRootPath(samefolderFiles);
console.log(`Common root: "${samefolderRoot}"`);
console.log('Regular exporter would process each file as:');
samefolderFiles.forEach(file => {
    regularExporterGetTargetPath(file, samefolderRoot);
});

console.log('\n' + '='.repeat(60) + '\n');

// Test Case 2: Files from mixed folders (diverse vault)
console.log('📁 TEST CASE 2: Files from mixed folders (diverse vault scenario)');
const mixedFiles = [
    new MockTFile('Korean/2000 Essential Korean Words - Beginner & Intermediate/가리키다.md'),
    new MockTFile('Korean/Korean Grammar Sentences by Evita/test1.md'),
    new MockTFile('English/Grammar/present-tense.md'),
    new MockTFile('Math/Algebra/equations.md'),
    new MockTFile('Science/Physics/gravity.md'),
];

const mixedRoot = findCommonRootPath(mixedFiles);
console.log(`Common root: "${mixedRoot}"`);
console.log('Regular exporter would process each file as:');
mixedFiles.forEach(file => {
    regularExporterGetTargetPath(file, mixedRoot);
});

console.log('\n' + '='.repeat(60) + '\n');

// Test Case 3: Files from single top-level folder
console.log('📁 TEST CASE 3: All files under one top-level folder');
const singleTopFiles = [
    new MockTFile('Korean/file1.md'),
    new MockTFile('Korean/file2.md'),
    new MockTFile('Korean/subfolder/file3.md'),
];

const singleTopRoot = findCommonRootPath(singleTopFiles);
console.log(`Common root: "${singleTopRoot}"`);
console.log('Regular exporter would process each file as:');
singleTopFiles.forEach(file => {
    regularExporterGetTargetPath(file, singleTopRoot);
});

console.log('\n' + '='.repeat(60) + '\n');
console.log('🔍 KEY INSIGHT:');
console.log('The regular Website.getTargetPathForFile() method uses the FULL file path');
console.log('regardless of what the common root is. It does NOT strip the common root.');
console.log('This means exportRoot calculation is used for OTHER purposes, not path generation.');

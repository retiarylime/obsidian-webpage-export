#!/usr/bin/env node

// Mock Obsidian environment
global.require = require;
global.Buffer = Buffer;
global.process = process;
global.console = console;

// Mock the obsidian module
const path = require('path');
const fs = require('fs');

// Create mock TFile objects
class MockTFile {
    constructor(filePath) {
        this.path = filePath;
        this.name = path.basename(filePath);
        this.extension = path.extname(filePath).slice(1);
    }
}

// Mock Obsidian app
global.app = {
    vault: {
        getFiles: () => {
            // Return some test Korean files to simulate the issue
            return [
                new MockTFile('Korean/Korean Grammar Sentences by Evita/가리키다.md'),
                new MockTFile('Korean/Korean Grammar Sentences by Evita/갈아타다.md'),
                new MockTFile('Korean/Korean Grammar Sentences by Evita/나빠지다.md'),
                new MockTFile('Korean/Korean Grammar Sentences by Evita/끄덕이다.md'),
                new MockTFile('Korean/Korean Grammar Sentences by Evita/꼼꼼하다.md')
            ];
        },
        readBinary: async (file) => Buffer.from("mock content"),
        adapter: {
            path: {
                relative: (from, to) => path.relative(from, to),
                join: (...parts) => path.join(...parts)
            }
        }
    },
    plugins: {
        getPlugin: () => ({
            settings: {
                exportPath: '/home/rl/Desktop/test',
                chunkSize: 3,
                useChunking: true
            }
        })
    }
};

// Mock the obsidian module
require.cache[require.resolve.paths('obsidian')[0] + '/obsidian'] = {
    exports: {
        TFile: MockTFile,
        moment: () => ({ format: () => '2024-08-25' })
    }
};

console.log('Testing chunked exporter path logic...');

// Test the path calculation logic directly
const testFiles = [
    new MockTFile('Korean/Korean Grammar Sentences by Evita/가리키다.md'),
    new MockTFile('Korean/Korean Grammar Sentences by Evita/갈아타다.md'),
    new MockTFile('Korean/Korean Grammar Sentences by Evita/나빠지다.md')
];

// Test findCommonRootPath logic (from our chunked exporter)
function findCommonRootPath(files) {
    if (!files || files.length === 0) return '';
    if (files.length === 1) return path.dirname(files[0].path);
    
    const paths = files.map(file => file.path.split('/'));
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

const commonRoot = findCommonRootPath(testFiles);
console.log(`Common root path: "${commonRoot}"`);
console.log(`Mixed vault detected: ${commonRoot === '' ? 'YES' : 'NO'}`);

for (const file of testFiles) {
    console.log(`File: ${file.path}`);
    console.log(`  - Should preserve full path: ${file.path}`);
    console.log(`  - Expected HTML path: ${file.path.replace('.md', '.html')}`);
}

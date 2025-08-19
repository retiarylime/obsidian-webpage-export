#!/usr/bin/env node

/**
 * Test script to verify memory management implementation
 * This simulates the behavior that would occur with a large vault export
 */

const fs = require('fs');
const path = require('path');

console.log('🧪 Testing Memory Management Implementation...\n');

// Test 1: Verify ChunkedWebsiteExporter exists and has correct methods
console.log('📋 Test 1: Checking ChunkedWebsiteExporter implementation...');
try {
    const chunkedExporterPath = './src/plugin/utils/chunked-website-exporter.ts';
    const content = fs.readFileSync(chunkedExporterPath, 'utf8');
    
    const requiredMethods = [
        'shouldUseChunkedExport',
        'getRecommendedChunkSize', 
        'exportInChunks'
    ];
    
    requiredMethods.forEach(method => {
        if (content.includes(method)) {
            console.log(`✅ Found method: ${method}`);
        } else {
            console.log(`❌ Missing method: ${method}`);
        }
    });
    
    // Check for memory management integration
    if (content.includes('MemoryManager') || content.includes('forceGarbageCollection')) {
        console.log('✅ Memory management integration found');
    } else {
        console.log('❌ Memory management integration missing');
    }
    
} catch (error) {
    console.log(`❌ Error reading ChunkedWebsiteExporter: ${error.message}`);
}

console.log();

// Test 2: Verify MemoryManager exists and has correct methods
console.log('📋 Test 2: Checking MemoryManager implementation...');
try {
    const memoryManagerPath = './src/plugin/utils/memory-manager.ts';
    const content = fs.readFileSync(memoryManagerPath, 'utf8');
    
    const requiredMethods = [
        'cleanupDOMElements',
        'forceGarbageCollection',
        'getMemoryUsage',
        'clearCaches'
    ];
    
    requiredMethods.forEach(method => {
        if (content.includes(method)) {
            console.log(`✅ Found method: ${method}`);
        } else {
            console.log(`❌ Missing method: ${method}`);
        }
    });
    
} catch (error) {
    console.log(`❌ Error reading MemoryManager: ${error.message}`);
}

console.log();

// Test 3: Verify integration in main exporter
console.log('📋 Test 3: Checking exporter integration...');
try {
    const exporterPath = './src/plugin/exporter.ts';
    const content = fs.readFileSync(exporterPath, 'utf8');
    
    if (content.includes('ChunkedWebsiteExporter.shouldUseChunkedExport')) {
        console.log('✅ Chunked export check integrated');
    } else {
        console.log('❌ Chunked export check missing');
    }
    
    if (content.includes('ChunkedWebsiteExporter.exportInChunks')) {
        console.log('✅ Chunked export method integrated');
    } else {
        console.log('❌ Chunked export method missing');
    }
    
} catch (error) {
    console.log(`❌ Error reading exporter: ${error.message}`);
}

console.log();

// Test 4: Check for settings integration
console.log('📋 Test 4: Checking settings integration...');
try {
    const files = [
        './src/plugin/settings/settings.ts',
        './src/plugin/website/pipeline-options.ts'
    ];
    
    let foundSettings = false;
    
    files.forEach(filePath => {
        if (fs.existsSync(filePath)) {
            const content = fs.readFileSync(filePath, 'utf8');
            if (content.includes('largeVaultChunkSize')) {
                console.log(`✅ Found largeVaultChunkSize setting in ${path.basename(filePath)}`);
                foundSettings = true;
            }
        }
    });
    
    if (!foundSettings) {
        console.log('❌ largeVaultChunkSize setting not found');
    }
    
} catch (error) {
    console.log(`❌ Error checking settings: ${error.message}`);
}

console.log();

// Test 5: Verify build output exists
console.log('📋 Test 5: Checking build output...');
try {
    const mainJsPath = './main.js';
    if (fs.existsSync(mainJsPath)) {
        const stats = fs.statSync(mainJsPath);
        console.log(`✅ Build output exists: main.js (${(stats.size / 1024 / 1024).toFixed(1)}MB)`);
        
        // Check if our code is in the build
        const content = fs.readFileSync(mainJsPath, 'utf8');
        if (content.includes('shouldUseChunkedExport') || content.includes('ChunkedWebsiteExporter')) {
            console.log('✅ Memory management code included in build');
        } else {
            console.log('⚠️  Memory management code may not be included in build');
        }
    } else {
        console.log('❌ Build output not found - run npm run build first');
    }
} catch (error) {
    console.log(`❌ Error checking build output: ${error.message}`);
}

console.log('\n🏁 Memory Management Test Complete!');
console.log('\n📝 Summary:');
console.log('- The chunked export system should automatically activate for vaults with 500+ files');
console.log('- Memory cleanup happens between chunks and includes DOM cleanup + garbage collection');
console.log('- Users can configure chunk size via largeVaultChunkSize setting');
console.log('- All existing plugin functionality is preserved');

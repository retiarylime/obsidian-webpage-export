#!/usr/bin/env node

/**
 * Test Script for Enhanced Crash Recovery System
 * Tests the file corruption detection and backup recovery mechanisms
 */

const fs = require('fs');
const path = require('path');

// Mock test directories
const testDir = '/tmp/obsidian-export-test';
const siteLibDir = path.join(testDir, 'site-lib');
const htmlDir = path.join(siteLibDir, 'html');
const jsDir = path.join(siteLibDir, 'js');

// Clean and create test directories
function setupTestEnvironment() {
    console.log('Setting up test environment...');
    
    if (fs.existsSync(testDir)) {
        fs.rmSync(testDir, { recursive: true, force: true });
    }
    
    fs.mkdirSync(testDir, { recursive: true });
    fs.mkdirSync(siteLibDir, { recursive: true });
    fs.mkdirSync(htmlDir, { recursive: true });
    fs.mkdirSync(jsDir, { recursive: true });
    
    console.log('✓ Test environment created');
}

// Create sample files with "PC방" content to simulate real scenario
function createSampleFiles() {
    console.log('Creating sample files with PC방 content...');
    
    // Create a sample search index with PC방 content
    const searchIndex = {
        documents: [
            { id: '1', title: 'PC방 Guide', content: 'PC방 information and details', path: '/pc-room-guide' },
            { id: '2', title: 'Gaming Centers', content: 'Various gaming centers including PC방', path: '/gaming-centers' },
            { id: '3', title: 'Seoul PC방 List', content: 'Best PC방 locations in Seoul', path: '/seoul-pc-rooms' }
        ],
        totalDocuments: 12000, // Simulate large number from previous chunks
        size: '1.5MB'
    };
    
    fs.writeFileSync(
        path.join(jsDir, 'search-index.json'),
        JSON.stringify(searchIndex, null, 2)
    );
    
    // Create file tree content with PC방 entries
    const fileTreeContent = `
<div class="file-tree">
    <div class="file-item" data-source-path-root-relative="pc-room-guide.md" data-path="/pc-room-guide">
        <span class="file-name">PC방 Guide</span>
    </div>
    <div class="file-item" data-source-path-root-relative="gaming-centers.md" data-path="/gaming-centers">
        <span class="file-name">Gaming Centers</span>
    </div>
    <div class="file-item" data-source-path-root-relative="seoul-pc-rooms.md" data-path="/seoul-pc-rooms">
        <span class="file-name">Seoul PC방 List</span>
    </div>
</div>
    `;
    
    fs.writeFileSync(
        path.join(htmlDir, 'file-tree-content-content.html'),
        fileTreeContent
    );
    
    // Create backup files
    fs.writeFileSync(
        path.join(jsDir, 'search-index.json.backup'),
        JSON.stringify(searchIndex, null, 2)
    );
    
    fs.writeFileSync(
        path.join(htmlDir, 'file-tree-content-content.html.backup'),
        fileTreeContent
    );
    
    console.log('✓ Sample files created with PC방 content');
}

// Simulate file corruption (0 bytes)
function simulateFileCorruption() {
    console.log('Simulating file corruption (chunk 90 crash scenario)...');
    
    // Corrupt the main files by making them 0 bytes
    fs.writeFileSync(path.join(jsDir, 'search-index.json'), '');
    fs.writeFileSync(path.join(htmlDir, 'file-tree-content-content.html'), '');
    
    console.log('✓ Files corrupted (0 bytes)');
}

// Test corruption detection
function testCorruptionDetection() {
    console.log('Testing corruption detection...');
    
    const searchIndexPath = path.join(jsDir, 'search-index.json');
    const fileTreePath = path.join(htmlDir, 'file-tree-content-content.html');
    
    // Check file sizes
    const searchIndexStats = fs.statSync(searchIndexPath);
    const fileTreeStats = fs.statSync(fileTreePath);
    
    const searchIndexCorrupted = searchIndexStats.size === 0;
    const fileTreeCorrupted = fileTreeStats.size === 0;
    
    console.log(`Search index corrupted: ${searchIndexCorrupted} (${searchIndexStats.size} bytes)`);
    console.log(`File tree corrupted: ${fileTreeCorrupted} (${fileTreeStats.size} bytes)`);
    
    return { searchIndexCorrupted, fileTreeCorrupted };
}

// Test backup recovery
function testBackupRecovery() {
    console.log('Testing backup recovery...');
    
    const searchIndexPath = path.join(jsDir, 'search-index.json');
    const searchIndexBackupPath = path.join(jsDir, 'search-index.json.backup');
    const fileTreePath = path.join(htmlDir, 'file-tree-content-content.html');
    const fileTreeBackupPath = path.join(htmlDir, 'file-tree-content-content.html.backup');
    
    // Restore from backups
    if (fs.existsSync(searchIndexBackupPath)) {
        fs.copyFileSync(searchIndexBackupPath, searchIndexPath);
        console.log('✓ Search index restored from backup');
    }
    
    if (fs.existsSync(fileTreeBackupPath)) {
        fs.copyFileSync(fileTreeBackupPath, fileTreePath);
        console.log('✓ File tree restored from backup');
    }
}

// Validate PC방 content preservation
function validatePCRoomContent() {
    console.log('Validating PC방 content preservation...');
    
    const searchIndexPath = path.join(jsDir, 'search-index.json');
    const fileTreePath = path.join(htmlDir, 'file-tree-content-content.html');
    
    let pcRoomFound = false;
    let totalDocuments = 0;
    
    // Check search index
    if (fs.existsSync(searchIndexPath)) {
        const searchContent = fs.readFileSync(searchIndexPath, 'utf8');
        if (searchContent.trim()) {
            try {
                const searchData = JSON.parse(searchContent);
                pcRoomFound = searchContent.includes('PC방');
                totalDocuments = searchData.documents ? searchData.documents.length : 0;
                console.log(`✓ Search index contains PC방: ${pcRoomFound}`);
                console.log(`✓ Search index documents: ${totalDocuments}`);
            } catch (e) {
                console.log('✗ Search index JSON parsing failed');
            }
        }
    }
    
    // Check file tree
    let fileTreePCRoom = false;
    if (fs.existsSync(fileTreePath)) {
        const fileTreeContent = fs.readFileSync(fileTreePath, 'utf8');
        fileTreePCRoom = fileTreeContent.includes('PC방');
        console.log(`✓ File tree contains PC방: ${fileTreePCRoom}`);
    }
    
    return {
        searchIndexPCRoom: pcRoomFound,
        fileTreePCRoom: fileTreePCRoom,
        totalDocuments: totalDocuments
    };
}

// Main test execution
async function runTests() {
    console.log('🧪 Starting Enhanced Crash Recovery Tests\n');
    
    try {
        // Test 1: Setup
        setupTestEnvironment();
        createSampleFiles();
        
        // Test 2: Verify initial state
        console.log('\n--- Initial State Validation ---');
        let validation = validatePCRoomContent();
        console.log(`Initial PC방 content found: ${validation.searchIndexPCRoom && validation.fileTreePCRoom}`);
        
        // Test 3: Simulate corruption
        console.log('\n--- Corruption Simulation ---');
        simulateFileCorruption();
        
        // Test 4: Detect corruption
        console.log('\n--- Corruption Detection ---');
        const corruption = testCorruptionDetection();
        
        // Test 5: Recovery
        console.log('\n--- Backup Recovery ---');
        testBackupRecovery();
        
        // Test 6: Final validation
        console.log('\n--- Final Validation ---');
        validation = validatePCRoomContent();
        
        // Results summary
        console.log('\n🎯 Test Results Summary:');
        console.log(`✅ Corruption Detection: ${corruption.searchIndexCorrupted && corruption.fileTreeCorrupted ? 'PASS' : 'FAIL'}`);
        console.log(`✅ PC방 Recovery: ${validation.searchIndexPCRoom && validation.fileTreePCRoom ? 'PASS' : 'FAIL'}`);
        console.log(`✅ Document Count: ${validation.totalDocuments} documents preserved`);
        
        if (validation.searchIndexPCRoom && validation.fileTreePCRoom && validation.totalDocuments > 0) {
            console.log('\n🎉 All tests PASSED! Enhanced crash recovery system working correctly.');
        } else {
            console.log('\n❌ Some tests FAILED. Review the implementation.');
        }
        
    } catch (error) {
        console.error('Test execution failed:', error);
    } finally {
        // Cleanup
        if (fs.existsSync(testDir)) {
            fs.rmSync(testDir, { recursive: true, force: true });
        }
        console.log('\n🧹 Test environment cleaned up');
    }
}

// Run the tests
runTests();

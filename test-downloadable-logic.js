#!/usr/bin/env node

// Test to verify what's happening in the Downloadable.removeRootFromPath method

// Mock classes
class MockPath {
    constructor(pathString, workingDir = '') {
        this.path = pathString || '';
        this.workingDirectory = workingDir;
        this.segments = this.path.split('/').filter(segment => segment.length > 0);
        this._fullName = this.segments[this.segments.length - 1] || '';
        this._base = this._fullName;
        this._basename = this._fullName.split('.')[0] || '';
        this._ext = '.' + (this._fullName.split('.')[1] || '');
        this._isDir = !this._fullName.includes('.');
    }
    
    get fullName() { return this._fullName; }
    get basename() { return this._basename; }
    get extension() { return this._ext; }
    get extensionName() { return this._ext.replace('.', ''); }
    get isDirectory() { return this._isDir; }
    get isAbsolute() { return this.path.startsWith('/'); }
    
    slugify(enable) {
        if (enable) {
            this.path = this.path.replaceAll(' ', '-').toLowerCase().replaceAll(/&/g, '&');
        }
        return this;
    }
    
    reparse(newPath) {
        this.path = newPath;
        this.segments = this.path.split('/').filter(segment => segment.length > 0);
        this._fullName = this.segments[this.segments.length - 1] || '';
    }
    
    setFileName(name) {
        const pathSegments = this.segments.slice(0, -1);
        pathSegments.push(name);
        this.path = pathSegments.join('/');
        this._fullName = name;
        this._basename = name.split('.')[0] || '';
    }
}

class MockAttachment {
    constructor(data, target, source, options) {
        this.exportOptions = options;
        this._source = source;
        this.data = data;
        this.targetPath = this.setTargetPath(target);
    }
    
    setTargetPath(target) {
        target.slugify(this.exportOptions.slugifyPaths);
        target = this.removeRootFromPath(target);
        return target;
    }
    
    removeRootFromPath(path, allowSlugify = true) {
        console.log(`🔧 removeRootFromPath called with:`);
        console.log(`   path: "${path.path}"`);
        console.log(`   exportRoot: "${this.exportOptions.exportRoot}"`);
        console.log(`   exportRoot type: ${typeof this.exportOptions.exportRoot}`);
        
        // CHUNKED EXPORT FIX: For mixed vaults (empty exportRoot), preserve full directory structure
        if (this.exportOptions.exportRoot === "" || this.exportOptions.exportRoot === undefined) {
            // Don't remove any root - preserve the full relative directory structure
            console.log(`🔧 ✅ Preserving full path for mixed vault: "${path.path}"`);
            return path;
        }
        
        console.log(`🔧 ❌ Applying root stripping logic`);
        
        // Original logic for normal exports
        // remove the export root from the target path
        const root = new MockPath(this.exportOptions.exportRoot ?? "").slugify(allowSlugify && this.exportOptions.slugifyPaths).path + "/";
        console.log(`   root to remove: "${root}"`);
        
        if (path.path.startsWith(root)) {
            const newPath = path.path.substring(root.length);
            console.log(`   stripped "${root}" -> "${newPath}"`);
            path.reparse(newPath);
        } else {
            console.log(`   path doesn't start with root, no stripping`);
        }
        return path;
    }
}

console.log('=== TESTING DOWNLOADABLE.removeRootFromPath ===\n');

// Test cases
const testCases = [
    {
        name: 'Empty exportRoot (mixed vault)',
        exportOptions: { exportRoot: '', slugifyPaths: true },
        targetPath: 'korean/2000-essential-korean-words---beginner-&-intermediate/test.html'
    },
    {
        name: 'Undefined exportRoot (mixed vault)',
        exportOptions: { exportRoot: undefined, slugifyPaths: true },
        targetPath: 'korean/2000-essential-korean-words---beginner-&-intermediate/test.html'
    },
    {
        name: 'Non-empty exportRoot (normal vault)',
        exportOptions: { exportRoot: 'korean', slugifyPaths: true },
        targetPath: 'korean/2000-essential-korean-words---beginner-&-intermediate/test.html'
    }
];

testCases.forEach((testCase, index) => {
    console.log(`\n--- Test Case ${index + 1}: ${testCase.name} ---`);
    
    const targetPath = new MockPath(testCase.targetPath);
    console.log(`Input path: "${targetPath.path}"`);
    
    const attachment = new MockAttachment('test data', targetPath, null, testCase.exportOptions);
    
    console.log(`Final path: "${attachment.targetPath.path}"`);
    console.log(`Expected: ${testCase.exportOptions.exportRoot === '' || testCase.exportOptions.exportRoot === undefined ? 'NO stripping' : 'WITH stripping'}`);
});

console.log('\n=== CONCLUSION ===');
console.log('If chunked export is still flattening files, the issue is likely:');
console.log('1. exportOptions.exportRoot is not being set correctly to empty string');
console.log('2. Different constructor parameters being passed');
console.log('3. Settings overrides not reaching the Attachment constructor');

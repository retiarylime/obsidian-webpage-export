#!/usr/bin/env node

/**
 * Generate file-tree-content.html from an existing exported website directory
 * 
 * Usage: node scripts/generate-file-tree.js [export-directory] [options]
 * 
 * This script scans an exported website directory and            } else {
                // Single part starting with "-", like "-목이-아파요.-그럼-생강차를-마시거나-사탕을-드세요_1382222777840"
                // Check if this contains ".-" which indicates ". - " in the original
                let mainPart;
                if (parts[0].includes('.-')) {
                    // Special case: this had ". - " in the original
                    // "-목이-아파요.-그럼-생강차를-마시거나-사탕을-드세요" -> "- 목이 아파요. - 그럼 생강차를 마시거나 사탕을 드세요"
                    const converted = parts[0].substring(1).replace(/-/g, ' '); // Remove first dash, convert rest to spaces
                    mainPart = `- ${converted.replace('. ', '. - ')}`; // Add initial "- " and convert ". " to ". - "
                } else {
                    mainPart = `- ${parts[0].substring(1).replace(/-/g, ' ')}`; // "- 목이 아파요. 그럼 생강차를 마시거나 사탕을 드세요"
                }
                const idPart = parts.slice(1).join('_');
                const result = idPart ? `${mainPart}_${idPart}` : mainPart;
                return result;
            }ile-tree-content.html
 * file by analyzing the directory structure and creating a hierarchical tree view.
 * 
 * Note: If file-tree-content.html already exists, the generated file will be saved with a 
 * different name (file-tree-content-generated.html, etc.) to avoid overwriting the existing file.
 */

const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');

class FileTreeGenerator {
    constructor(exportPath) {
        this.exportPath = path.resolve(exportPath);
        this.siteLibPath = path.join(this.exportPath, 'site-lib');
        this.vaultName = "lang-vault"; // Default name, will be loaded from metadata if available
        this.fileTree = [];
        this.metadata = null;
    }

    async generate() {
        console.log(`🔍 Scanning exported website at: ${this.exportPath}`);
        
        if (!fsSync.existsSync(this.exportPath)) {
            throw new Error(`Export directory does not exist: ${this.exportPath}`);
        }

        // Step 1: Load existing metadata to get vault name and file info
        await this.loadMetadata();
        
        // Step 2: Build file tree structure
        await this.buildFileTree();
        
        // Step 3: Generate HTML
        const html = this.generateHTML();
        
        // Step 4: Write file-tree-content.html
        await this.writeFileTree(html);
        
        console.log(`✅ Generated file-tree-content.html successfully!`);
    }

    async loadMetadata() {
        const metadataPath = path.join(this.siteLibPath, 'metadata.json');
        if (fsSync.existsSync(metadataPath)) {
            try {
                const metadataContent = await fs.readFile(metadataPath, 'utf8');
                this.metadata = JSON.parse(metadataContent);
                this.vaultName = this.metadata.vaultName || this.metadata.siteName || "lang-vault";
                console.log(`📂 Loaded metadata for vault: ${this.vaultName}`);
            } catch (error) {
                console.log(`ℹ️ Could not load metadata: ${error.message}`);
            }
        }
    }

    async buildFileTree() {
        // Get list of files that should be shown in tree from metadata
        const shownInTree = this.metadata?.shownInTree || [];
        
        if (shownInTree.length === 0) {
            // Fallback: scan directory for HTML files if no metadata
            await this.scanForHtmlFiles('', this.fileTree);
        } else {
            // Use metadata to build tree structure
            this.buildTreeFromMetadata(shownInTree);
        }
    }

    buildTreeFromMetadata(shownInTree) {
        const tree = {};
        
        // Process each file in shownInTree
        shownInTree.forEach(filePath => {
            if (!filePath.endsWith('.html')) return;
            
            const parts = filePath.split('/');
            let current = tree;
            
            // Build nested structure
            for (let i = 0; i < parts.length; i++) {
                const part = parts[i];
                const isFile = i === parts.length - 1;
                
                if (!current[part]) {
                    current[part] = isFile ? { 
                        type: 'file', 
                        path: filePath,
                        originalPath: this.getOriginalPath(filePath)
                    } : { 
                        type: 'folder', 
                        children: {},
                        originalPath: this.getOriginalFolderPath(parts.slice(0, i + 1).join('/'))
                    };
                }
                
                if (!isFile) {
                    current = current[part].children;
                }
            }
        });
        
        this.fileTree = this.convertTreeToArray(tree, 1);
    }

    getOriginalPath(exportPath) {
        if (this.metadata?.sourceToTarget) {
            // Find the source path that maps to this export path
            for (const [sourcePath, targetPath] of Object.entries(this.metadata.sourceToTarget)) {
                if (targetPath === exportPath) {
                    return sourcePath;
                }
            }
        }
        
        // Fallback: guess the original path
        return this.guessOriginalPath(exportPath);
    }

    getOriginalFolderPath(exportPath) {
        // Convert export folder path back to original path format
        const parts = exportPath.split('/');
        return parts.map(part => {
            // Handle special cases for Korean folder names
            if (part === '2000-essential-korean-words-beginner-&-intermediate') {
                return '2000 Essential Korean Words - Beginner & Intermediate';
            }
            if (part === 'korean-grammar-sentences-by-evita') {
                return 'Korean Grammar Sentences by Evita';
            }
            
            return part.split('-')
                .map(word => word.charAt(0).toUpperCase() + word.slice(1))
                .join(' ');
        }).join('/');
    }

    guessOriginalPath(exportPath) {
        if (exportPath.endsWith('.html')) {
            // Convert korean/folder/file.html -> Korean/Folder/file.md
            const pathParts = exportPath.replace('.html', '.md').split('/');
            return pathParts.map(part => 
                part.split('-')
                    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
                    .join(' ')
            ).join('/');
        }
        return exportPath;
    }

    convertTreeToArray(tree, depth) {
        const result = [];
        
        const sortedKeys = Object.keys(tree).sort((a, b) => {
            const aIsFolder = tree[a].type === 'folder';
            const bIsFolder = tree[b].type === 'folder';
            
            // Folders first, then files
            if (aIsFolder && !bIsFolder) return -1;
            if (!aIsFolder && bIsFolder) return 1;
            
            // Alphabetical within same type
            return a.localeCompare(b);
        });
        
        for (const key of sortedKeys) {
            const item = tree[key];
            
            if (item.type === 'folder') {
                const folderItem = {
                    type: 'folder',
                    name: this.getFolderDisplayName(key),
                    originalPath: item.originalPath,
                    depth: depth,
                    children: this.convertTreeToArray(item.children, depth + 1)
                };
                result.push(folderItem);
            } else {
                const fileItem = {
                    type: 'file',
                    name: this.getFileDisplayName(key),
                    path: item.path,
                    originalPath: item.originalPath,
                    depth: depth
                };
                result.push(fileItem);
            }
        }
        
        return result;
    }

    getFolderDisplayName(folderName) {
        // Handle special cases for Korean folder names
        if (folderName === '2000-essential-korean-words-beginner-&-intermediate') {
            return '2000 Essential Korean Words - Beginner & Intermediate';
        }
        if (folderName === 'korean-grammar-sentences-by-evita') {
            return 'Korean Grammar Sentences by Evita';
        }
        
        // Convert kebab-case back to proper display names
        return folderName.split('-')
            .map(word => word.charAt(0).toUpperCase() + word.slice(1))
            .join(' ');
    }

    getFileDisplayName(fileName) {
        // Remove .html extension
        const nameWithoutExt = fileName.replace('.html', '');
        
        // Handle special cases for Korean grammar files that start with "-"
        if (nameWithoutExt.startsWith('-') && nameWithoutExt.includes('_')) {
            // Convert kebab-case back to spaces but preserve the structure
            // "-다-왔어요_-덜-왔어요_1404746307380" -> "- 다 왔어요_ - 덜 왔어요_1404746307380"
            const parts = nameWithoutExt.split('_');
            if (parts.length >= 2) {
                const firstPart = parts[0];  // "-다-왔어요"
                const secondPart = parts[1]; // "-덜-왔어요" 
                const idPart = parts.slice(2).join('_'); // "1404746307380"
                
                // Convert kebab-case to spaced Korean text, keeping the "- " prefix
                // "-다-왔어요" -> "- 다 왔어요" (replace first dash with "- " and remaining with spaces)
                const convertedFirst = firstPart.substring(1).replace(/-/g, ' '); // Remove first dash and replace rest
                const convertedSecond = secondPart.substring(1).replace(/-/g, ' '); // Remove first dash and replace rest
                const finalFirst = `- ${convertedFirst}`;
                const finalSecond = `- ${convertedSecond}`;
                
                const combined = idPart ? 
                    `${finalFirst}_ ${finalSecond}_${idPart}` :
                    `${finalFirst}_ ${finalSecond}`;
                
                return combined;
            } else {
                // Single part starting with "-", like "-목이-아파요.-그럼-생강차를-마시거나-사탕을-드세요_1382222777840"
                // Check if this contains ".-" which indicates ". - " in the original
                let mainPart;
                if (parts[0].includes('.-')) {
                    // Special case: this had ". - " in the original
                    // "-목이-아파요.-그럼-생강차를-마시거나-사탕을-드세요" -> "목이 아파요. - 그럼 생강차를 마시거나 사탕을 드세요"
                    const converted = parts[0].substring(1).replace(/-/g, ' '); // Remove first dash, convert rest to spaces
                    mainPart = converted.replace('. ', '. - '); // Convert ". " to ". - "
                } else {
                    mainPart = `- ${parts[0].substring(1).replace(/-/g, ' ')}`; // "- 목이 아파요. 그럼 생강차를 마시거나 사탕을 드세요"
                }
                const idPart = parts.slice(1).join('_');
                const result = idPart ? `${mainPart}_${idPart}` : mainPart;
                return result;
            }
        }
        
        // For regular Korean files with underscores and IDs, keep as is
        if (nameWithoutExt.includes('_') && /\d+$/.test(nameWithoutExt)) {
            // Convert kebab-case to spaces for files like "지금-카페에서-어제-산-책을-읽고-있어요_1404746308170"
            const parts = nameWithoutExt.split('_');
            const mainPart = parts[0].replace(/-/g, ' '); // Convert kebab-case to spaces
            const idPart = parts.slice(1).join('_');
            const result = `${mainPart}_${idPart}`;
            return result;
        }
        
        // For Korean files without special formatting, keep Korean characters as-is
        if (/[가-힣]/.test(nameWithoutExt)) {
            return nameWithoutExt;
        }
        
        // For regular files, convert kebab-case to display name
        return nameWithoutExt.split('-')
            .map(word => word.charAt(0).toUpperCase() + word.slice(1))
            .join(' ');
    }

    async scanForHtmlFiles(relativePath, treeArray) {
        const fullPath = path.join(this.exportPath, relativePath);
        
        try {
            const entries = await fs.readdir(fullPath, { withFileTypes: true });
            
            for (const entry of entries) {
                if (entry.name === 'site-lib') continue; // Skip site-lib directory
                
                const entryRelativePath = path.join(relativePath, entry.name).replace(/\\/g, '/');
                
                if (entry.isDirectory()) {
                    const folderItem = {
                        type: 'folder',
                        name: this.getFolderDisplayName(entry.name),
                        originalPath: entryRelativePath,
                        depth: relativePath.split('/').filter(p => p).length + 1,
                        children: []
                    };
                    
                    await this.scanForHtmlFiles(entryRelativePath, folderItem.children);
                    
                    if (folderItem.children.length > 0) {
                        treeArray.push(folderItem);
                    }
                } else if (entry.name.endsWith('.html')) {
                    const fileItem = {
                        type: 'file',
                        name: this.getFileDisplayName(entry.name),
                        path: entryRelativePath,
                        originalPath: this.guessOriginalPath(entryRelativePath),
                        depth: relativePath.split('/').filter(p => p).length + 1
                    };
                    treeArray.push(fileItem);
                }
            }
        } catch (error) {
            console.warn(`⚠️ Could not scan directory ${relativePath}: ${error.message}`);
        }
    }

    generateHTML() {
        const treeHTML = this.generateTreeHTML(this.fileTree);
        
        return `<div id="file-explorer" class=" tree-container"><div class="feature-header"><div class="feature-title">${this.vaultName}</div><button class="clickable-icon nav-action-button tree-collapse-all is-collapsed" aria-label="Collapse All"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></svg></button></div>${treeHTML}</div>`;
    }

    generateTreeHTML(items) {
        let html = '';
        
        for (const item of items) {
            if (item.type === 'folder') {
                html += this.generateFolderHTML(item);
            } else {
                html += this.generateFileHTML(item);
            }
        }
        
        return html;
    }

    generateFolderHTML(folder) {
        const childrenHTML = this.generateTreeHTML(folder.children);
        const hasChildren = folder.children.length > 0;
        
        let html = `<div class="tree-item mod-collapsible is-collapsed nav-folder" data-depth="${folder.depth}">`;
        html += `<div class="tree-item-self is-clickable mod-collapsible nav-folder-title" data-path="${this.escapeHtml(folder.originalPath)}">`;
        html += `<div class="tree-item-icon collapse-icon is-collapsed nav-folder-collapse-indicator">`;
        html += `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="svg-icon right-triangle">`;
        html += `<path d="M3 8L12 17L21 8"></path>`;
        html += `</svg></div>`;
        html += `<div class="tree-item-inner nav-folder-title-content">${this.escapeHtml(folder.name)}</div>`;
        html += `</div>`;
        
        if (hasChildren) {
            html += `<div class="tree-item-children nav-folder-children" style="display: none;">`;
            html += childrenHTML;
            html += `</div>`;
        }
        
        html += `</div>`;
        
        return html;
    }

    generateFileHTML(file) {
        const title = this.getFileTitle(file.name);
        const titleHTML = this.formatFileTitle(title);
        
        let html = `<div class="tree-item is-collapsed nav-file" data-depth="${file.depth}">`;
        html += `<a class="tree-item-self is-clickable nav-file-title" href="${this.escapeHtml(file.path)}" data-path="${this.escapeHtml(file.originalPath)}">`;
        html += `<div class="tree-item-inner nav-file-title-content">${titleHTML}</div>`;
        html += `</a>`;
        html += `<div class="tree-item-children nav-file-children"></div>`;
        html += `</div>`;
        
        return html;
    }

    getFileTitle(fileName) {
        // For files that start with "- " (like Korean grammar sentences), preserve the structure
        if (fileName.includes('- ') && fileName.includes('_')) {
            return fileName;
        }
        return fileName;
    }

    formatFileTitle(title) {
        // Handle special formatting for Korean grammar files that start with "- "
        if (title.startsWith('- ') && title.includes('_')) {
            // For "- 다 왔어요_ - 덜 왔어요_1404746307380"
            // Format as: <span>- <span>다 왔어요_ - 덜 왔어요_1404746307380</span></span>
            const innerContent = title.substring(2); // Remove "- " prefix
            return `<span>- <span>${this.escapeHtml(innerContent)}</span></span>`;
        }
        
        return this.escapeHtml(title);
    }

    escapeHtml(text) {
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    async writeFileTree(html) {
        // Check if file-tree-content.html already exists and generate a unique name
        let outputPath = path.join(this.siteLibPath, 'html', 'file-tree-content.html');
        let counter = 1;
        
        while (fsSync.existsSync(outputPath)) {
            const baseName = counter === 1 ? 'file-tree-content-generated.html' : `file-tree-content-generated-${counter}.html`;
            outputPath = path.join(this.siteLibPath, 'html', baseName);
            counter++;
        }
        
        // Ensure html directory exists
        await fs.mkdir(path.dirname(outputPath), { recursive: true });
        
        await fs.writeFile(outputPath, html, 'utf8');
        
        const fileName = path.basename(outputPath);
        console.log(`💾 Written ${fileName}: ${html.length} bytes`);
        console.log(`📁 Output: ${outputPath}`);
        
        if (fileName !== 'file-tree-content.html') {
            console.log(`ℹ️ Saved with different name to avoid overwriting existing file-tree-content.html`);
        }
    }
}

// Command line interface
async function main() {
    const args = process.argv.slice(2);
    
    if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
        console.log(`
Obsidian Webpage Export - File Tree Generator

Usage: node scripts/generate-file-tree.js <export-directory> [options]

Arguments:
  export-directory    Path to the exported website directory

Options:
  --help, -h         Show this help message
  --verbose, -v      Enable verbose output

Examples:
  node scripts/generate-file-tree.js /path/to/exported/site
  node scripts/generate-file-tree.js ./exported-site --verbose

This script will:
1. Scan the exported website directory
2. Load metadata to get file structure information
3. Generate a hierarchical file tree view
4. Create file-tree-content.html with collapsible folders
5. Save it to site-lib/html/ (with a unique name if file already exists)
        `);
        process.exit(0);
    }
    
    const exportPath = args[0];
    const verbose = args.includes('--verbose') || args.includes('-v');
    
    if (verbose) {
        console.log('Verbose mode enabled');
    }
    
    try {
        const generator = new FileTreeGenerator(exportPath);
        await generator.generate();
        console.log('\n✅ File tree generation completed successfully!');
    } catch (error) {
        console.error('\n❌ Error generating file tree:');
        console.error(error.message);
        if (verbose) {
            console.error(error.stack);
        }
        process.exit(1);
    }
}

// Run if called directly
if (require.main === module) {
    main().catch(console.error);
}

module.exports = { FileTreeGenerator };

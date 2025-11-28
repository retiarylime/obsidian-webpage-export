#!/usr/bin/env node

/**
 * Generate metadata.json from an existing exported website directory
 * 
 * Usage: node scripts/generate-metadata.js [export-directory] [options]
 * 
 * This script scans an exported website directory and reconstructs the metadata.json
 * file by analyzing the file structure, HTML content, and existing data.
 * 
 * Note: If metadata.json already exists, the generated file will be saved with a 
 * different name (metadata-generated.json, metadata-generated-2.json, etc.) to 
 * avoid overwriting the existing file.
 */

const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

class MetadataGenerator {
    constructor(exportPath) {
        this.exportPath = path.resolve(exportPath);
        this.siteLibPath = path.join(this.exportPath, 'site-lib');
        this.treeOrderCounter = 0;
        this.metadata = {
            createdTime: Date.now(),
            shownInTree: [],
            attachments: [],
            allFiles: [],
            webpages: {},
            fileInfo: {},
            sourceToTarget: {},
            featureOptions: this.getDefaultFeatureOptions(),
            modifiedTime: Date.now(),
            siteName: "",
            vaultName: "",
            exportRoot: "",
            baseURL: "",
            pluginVersion: "1.3.2",
            themeName: "Default",
            bodyClasses: "",
            hasFavicon: false
        };
    }

    getDefaultFeatureOptions() {
        return {
            backlinks: { enabled: false },
            tags: { enabled: false },
            alias: { enabled: false },
            properties: { enabled: false },
            fileNavigation: { enabled: true },
            search: { enabled: true },
            outline: { enabled: false },
            themeToggle: { enabled: false },
            graphView: { enabled: false },
            sidebar: { enabled: false },
            customHead: { enabled: false },
            document: { enabled: false },
            rss: { enabled: false },
            linkPreview: { enabled: false }
        };
    }

    async generate() {
        console.log(`🔍 Scanning exported website at: ${this.exportPath}`);
        
        if (!fsSync.existsSync(this.exportPath)) {
            throw new Error(`Export directory does not exist: ${this.exportPath}`);
        }

        // Step 1: Load existing metadata if it exists
        await this.loadExistingMetadata();
        
        // Step 2: Scan directory structure
        await this.scanDirectory(this.exportPath, '');
        
        // Step 3: Analyze HTML files for webpage metadata
        await this.analyzeWebpages();
        
        // Step 4: Detect features and configurations
        await this.detectFeatures();
        
        // Step 5: Generate file tree structure
        this.generateFileTree();
        
        // Step 6: Write metadata.json
        await this.writeMetadata();
        
        console.log(`✅ Generated metadata.json with:`);
        console.log(`   - ${Object.keys(this.metadata.webpages).length} webpages`);
        console.log(`   - ${this.metadata.attachments.length} attachments`);
        console.log(`   - ${this.metadata.shownInTree.length} files in tree`);
        console.log(`   - ${this.metadata.allFiles.length} total files`);
    }

    async loadExistingMetadata() {
        const existingMetadataPath = path.join(this.siteLibPath, 'metadata.json');
        if (fsSync.existsSync(existingMetadataPath)) {
            try {
                const existingData = await fs.readFile(existingMetadataPath, 'utf8');
                const existing = JSON.parse(existingData);
                
                // Preserve important metadata in the correct order and names
                this.metadata.createdTime = existing.createdTime || this.metadata.createdTime;
                this.metadata.siteName = existing.siteName || this.metadata.siteName;
                this.metadata.vaultName = existing.vaultName || this.metadata.vaultName;
                this.metadata.exportRoot = existing.exportRoot || this.metadata.exportRoot;
                this.metadata.baseURL = existing.baseURL || this.metadata.baseURL;
                this.metadata.pluginVersion = existing.pluginVersion || this.metadata.pluginVersion;
                this.metadata.themeName = existing.themeName || this.metadata.themeName;
                this.metadata.bodyClasses = existing.bodyClasses || this.metadata.bodyClasses;
                this.metadata.hasFavicon = existing.hasFavicon || this.metadata.hasFavicon;
                this.metadata.featureOptions = existing.featureOptions || this.metadata.featureOptions;
                
                console.log(`📂 Loaded existing metadata: ${existingData.length} bytes`);
            } catch (error) {
                console.log(`ℹ️ Could not load existing metadata: ${error.message}`);
            }
        }
    }

    async scanDirectory(dirPath, relativePath) {
        const entries = await fs.readdir(dirPath, { withFileTypes: true });
        
        for (const entry of entries) {
            const fullPath = path.join(dirPath, entry.name);
            const relativeFilePath = path.join(relativePath, entry.name).replace(/\\/g, '/');
            
            if (entry.isDirectory()) {
                await this.scanDirectory(fullPath, relativeFilePath);
            } else {
                await this.processFile(fullPath, relativeFilePath);
            }
        }
    }

    async processFile(fullPath, relativePath) {
        // Skip generated files to avoid including them in the metadata
        if (this.isGeneratedFile(relativePath)) {
            return;
        }
        
        const stats = await fs.stat(fullPath);
        const ext = path.extname(relativePath).toLowerCase();
        
        // Determine file type and processing
        const isWebpage = ext === '.html';
        const isAttachment = !isWebpage || relativePath.startsWith('site-lib/');
        
        // Add to allFiles array for all files
        this.metadata.allFiles.push(relativePath);
        
        // Add attachments (non-webpage files and all site-lib files)
        if (isAttachment) {
            this.metadata.attachments.push(relativePath);
        }
        
        // Determine what goes in shownInTree
        const shouldShowInTree = isWebpage && !relativePath.startsWith('site-lib/') && !this.shouldExcludeFromTree(relativePath);
        if (shouldShowInTree) {
            this.metadata.shownInTree.push(relativePath);
            this.treeOrderCounter++;
        }
        
        // Create fileInfo entry for all files
        this.metadata.fileInfo[relativePath] = {
            createdTime: stats.birthtime.getTime(),
            modifiedTime: stats.mtime.getTime(),
            sourceSize: stats.size,
            sourcePath: this.guessSourcePath(relativePath),
            exportPath: relativePath,
            showInTree: shouldShowInTree,
            treeOrder: shouldShowInTree ? this.treeOrderCounter : 0,
            backlinks: [],
            type: this.getFileType(ext),
            data: null
        };
        
        // Add to sourceToTarget mapping if we can determine the source
        const sourcePath = this.guessSourcePath(relativePath);
        if (sourcePath) {
            this.metadata.sourceToTarget[sourcePath] = relativePath;
        }
    }

    isGeneratedFile(relativePath) {
        // Skip generated files that shouldn't be included in metadata
        const filename = path.basename(relativePath);
        
        // Skip generated metadata files
        if (filename.startsWith('metadata-generated')) {
            return true;
        }
        
        // Skip the metadata.json file itself to avoid self-reference
        if (filename === 'metadata.json') {
            return true;
        }
        
        // Skip generated file-tree files
        if (filename.startsWith('file-tree-content-generated')) {
            return true;
        }
        
        // Skip other common temporary/generated files
        if (filename.startsWith('.DS_Store') || filename.startsWith('Thumbs.db')) {
            return true;
        }
        
        return false;
    }

    guessSourcePath(exportPath) {
        // Try to reverse-engineer the original source path from the export path
        if (exportPath.startsWith('site-lib/')) {
            // Site-lib files often don't have source mappings or have empty source paths
            return "";
        }
        
        if (exportPath.endsWith('.html')) {
            // Convert HTML export path back to likely markdown source path
            // e.g., korean/folder/file.html -> Korean/Folder/file.md
            const pathParts = exportPath.replace('.html', '.md').split('/');
            const sourceParts = pathParts.map(part => {
                // Convert URL-safe names back to original names
                return part
                    .split('-')
                    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
                    .join(' ');
            });
            return sourceParts.join('/');
        }
        
        // For other files (like assets), try to guess the source structure
        const pathParts = exportPath.split('/');
        if (pathParts.length > 0) {
            const sourceParts = pathParts.map((part, index) => {
                if (index < pathParts.length - 1) { // Directory parts
                    return part
                        .split('-')
                        .map(word => word.charAt(0).toUpperCase() + word.slice(1))
                        .join(' ');
                } else { // File name - keep as is for assets
                    return part;
                }
            });
            return sourceParts.join('/');
        }
        
        return exportPath;
    }

    shouldExcludeFromTree(filePath) {
        // Exclude certain file patterns from tree (but not from attachments)
        const excludePatterns = [
            /\.DS_Store$/,
            /Thumbs\.db$/,
            /\.tmp$/,
            /\.temp$/
        ];
        
        return excludePatterns.some(pattern => pattern.test(filePath));
    }

    getFileType(extension) {
        const typeMap = {
            '.html': 'markdown',
            '.md': 'markdown',
            '.canvas': 'canvas',
            '.excalidraw': 'excalidraw',
            '.png': 'media',
            '.jpg': 'media',
            '.jpeg': 'media',
            '.gif': 'media',
            '.svg': 'media',
            '.webp': 'media',
            '.ico': 'media',
            '.pdf': 'attachment',
            '.mp3': 'media',
            '.mp4': 'media',
            '.wav': 'media',
            '.ogg': 'media',
            '.wasm': 'other',
            '.js': 'script',
            '.css': 'style',
            '.ttf': 'font',
            '.otf': 'font',
            '.woff': 'font',
            '.woff2': 'font',
            '.xml': 'other'
        };
        
        return typeMap[extension.toLowerCase()] || 'other';
    }

    async analyzeWebpages() {
        console.log(`📄 Analyzing HTML files for webpage metadata...`);
        
        for (const filePath of this.metadata.allFiles) {
            if (path.extname(filePath).toLowerCase() === '.html' && !filePath.startsWith('site-lib/')) {
                await this.analyzeWebpage(filePath);
            }
        }
    }

    async analyzeWebpage(relativePath) {
        const fullPath = path.join(this.exportPath, relativePath);
        
        try {
            const htmlContent = await fs.readFile(fullPath, 'utf8');
            const dom = new JSDOM(htmlContent);
            const document = dom.window.document;
            
            // Extract title
            const titleElement = document.querySelector('title');
            let title = titleElement ? titleElement.textContent.trim() : path.basename(relativePath, '.html');
            
            // Extract description from meta or first paragraph
            let description = '';
            const metaDescription = document.querySelector('meta[name="description"]');
            if (metaDescription) {
                description = metaDescription.getAttribute('content') || '';
            } else {
                // Try to get description from content
                const firstParagraph = document.querySelector('.markdown-preview-view p');
                if (firstParagraph) {
                    description = firstParagraph.textContent.trim().substring(0, 200);
                }
            }
            
            // Extract headers
            const headers = [];
            const headerElements = document.querySelectorAll('h1, h2, h3, h4, h5, h6');
            headerElements.forEach(header => {
                const level = parseInt(header.tagName.charAt(1));
                const heading = header.textContent.trim();
                const id = header.getAttribute('id') || heading.replace(/\s+/g, '_') + '_0';
                headers.push({ heading, level, id });
            });
            
            // Extract links
            const links = [];
            const linkElements = document.querySelectorAll('a[data-href]:not(.external-link)');
            linkElements.forEach(link => {
                const href = link.getAttribute('data-href');
                if (href && !href.startsWith('http')) {
                    links.push(href);
                }
            });
            
            // Find attachments referenced in this webpage
            const attachments = [];
            const mediaElements = document.querySelectorAll('img, audio, video, source');
            mediaElements.forEach(media => {
                const src = media.getAttribute('src');
                if (src && !src.startsWith('http') && !src.startsWith('data:')) {
                    // Convert relative paths to be relative from export root
                    const pathToRoot = this.calculatePathToRoot(relativePath);
                    const fullAttachmentPath = src.startsWith('./') ? 
                        path.normalize(path.join(path.dirname(relativePath), src.substring(2))) :
                        src.startsWith('../') ?
                        path.normalize(path.join(path.dirname(relativePath), src)) :
                        src;
                    attachments.push(fullAttachmentPath.replace(/\\/g, '/'));
                }
            });
            
            // Get file stats for timestamps
            const stats = await fs.stat(fullPath);
            const fileInfo = this.metadata.fileInfo[relativePath];
            
            // Create webpage metadata matching exact format
            this.metadata.webpages[relativePath] = {
                title,
                icon: "",
                description,
                aliases: [],
                inlineTags: [],
                frontmatterTags: [],
                headers,
                links,
                author: "",
                coverImageURL: "",
                fullURL: relativePath,
                pathToRoot: this.calculatePathToRoot(relativePath),
                attachments,
                createdTime: fileInfo?.createdTime || stats.birthtime.getTime(),
                modifiedTime: fileInfo?.modifiedTime || stats.mtime.getTime(),
                sourceSize: fileInfo?.sourceSize || stats.size,
                sourcePath: fileInfo?.sourcePath || this.guessSourcePath(relativePath),
                exportPath: relativePath,
                showInTree: fileInfo?.showInTree !== false,
                treeOrder: fileInfo?.treeOrder || 0,
                backlinks: [],
                type: "markdown"
            };
            
        } catch (error) {
            console.warn(`⚠️ Could not analyze webpage ${relativePath}: ${error.message}`);
        }
    }

    calculatePathToRoot(filePath) {
        const depth = filePath.split('/').length - 1;
        return depth > 0 ? '../'.repeat(depth) : './';
    }

    async detectFeatures() {
        console.log(`🔍 Detecting enabled features...`);
        
        // Check for search functionality
        const searchIndexPath = path.join(this.siteLibPath, 'search-index.json');
        if (fsSync.existsSync(searchIndexPath)) {
            this.metadata.featureOptions.search.enabled = true;
        }
        
        // Check for favicon
        const faviconPath = path.join(this.exportPath, 'favicon.ico');
        this.metadata.hasFavicon = fsSync.existsSync(faviconPath);
        
        // Check for graph view
        const graphFiles = ['graph-view.js', 'graph-wasm.wasm'];
        const hasGraphView = graphFiles.some(file => 
            fsSync.existsSync(path.join(this.siteLibPath, file))
        );
        if (hasGraphView) {
            this.metadata.featureOptions.graphView.enabled = true;
        }
        
        // Detect theme from CSS files
        const cssFiles = await this.getCSSFiles();
        if (cssFiles.length > 0) {
            // Try to detect theme name from CSS file names or content
            const themeFile = cssFiles.find(file => file.includes('theme'));
            if (themeFile) {
                this.metadata.themeName = path.basename(themeFile, '.css');
            }
        }
    }

    async getCSSFiles() {
        const cssPath = path.join(this.siteLibPath, 'css');
        if (!fsSync.existsSync(cssPath)) return [];
        
        const files = await fs.readdir(cssPath);
        return files.filter(file => file.endsWith('.css'));
    }

    generateFileTree() {
        // Sort files for consistent tree order
        this.metadata.shownInTree.sort((a, b) => {
            // Directories first, then files
            const aIsDir = !path.extname(a);
            const bIsDir = !path.extname(b);
            
            if (aIsDir && !bIsDir) return -1;
            if (!aIsDir && bIsDir) return 1;
            
            return a.localeCompare(b, undefined, { numeric: true });
        });
        
        // Update tree order in file info
        this.metadata.shownInTree.forEach((filePath, index) => {
            if (this.metadata.fileInfo[filePath]) {
                this.metadata.fileInfo[filePath].treeOrder = index;
            }
        });
    }

    async writeMetadata() {
        // Check if metadata.json already exists and generate a unique name
        let outputPath = path.join(this.siteLibPath, 'metadata.json');
        let counter = 1;
        
        while (fsSync.existsSync(outputPath)) {
            const baseName = counter === 1 ? 'metadata-generated.json' : `metadata-generated-${counter}.json`;
            outputPath = path.join(this.siteLibPath, baseName);
            counter++;
        }
        
        // Ensure site-lib directory exists
        await fs.mkdir(this.siteLibPath, { recursive: true });
        
        // Update modifiedTime to current time
        this.metadata.modifiedTime = Date.now();
        
        // Create final metadata object in the exact order as the regular exporter
        const finalMetadata = {
            createdTime: this.metadata.createdTime,
            shownInTree: this.metadata.shownInTree,
            attachments: this.metadata.attachments,
            allFiles: this.metadata.allFiles,
            webpages: this.metadata.webpages,
            fileInfo: this.metadata.fileInfo,
            sourceToTarget: this.metadata.sourceToTarget,
            featureOptions: this.metadata.featureOptions,
            modifiedTime: this.metadata.modifiedTime,
            siteName: this.metadata.siteName,
            vaultName: this.metadata.vaultName,
            exportRoot: this.metadata.exportRoot,
            baseURL: this.metadata.baseURL,
            pluginVersion: this.metadata.pluginVersion,
            themeName: this.metadata.themeName,
            bodyClasses: this.metadata.bodyClasses,
            hasFavicon: this.metadata.hasFavicon
        };
        
        const metadataJson = JSON.stringify(finalMetadata, null, 2);
        await fs.writeFile(outputPath, metadataJson, 'utf8');
        
        const fileName = path.basename(outputPath);
        console.log(`💾 Written ${fileName}: ${metadataJson.length} bytes`);
        console.log(`📁 Output: ${outputPath}`);
        
        if (fileName !== 'metadata.json') {
            console.log(`ℹ️  Saved with different name to avoid overwriting existing metadata.json`);
        }
    }
}

// Command line interface
async function main() {
    const args = process.argv.slice(2);
    
    if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
        console.log(`
Obsidian Webpage Export - Metadata Generator

Usage: node scripts/generate-metadata.js <export-directory> [options]

Arguments:
  export-directory    Path to the exported website directory

Options:
  --help, -h         Show this help message
  --verbose, -v      Enable verbose output

Examples:
  node scripts/generate-metadata.js /path/to/exported/site
  node scripts/generate-metadata.js ./exported-site --verbose

This script will:
1. Scan the exported website directory
2. Analyze HTML files and extract metadata
3. Detect enabled features and configurations
4. Generate a comprehensive metadata.json file
5. Save it to site-lib/ (with a unique name if metadata.json already exists)
        `);
        process.exit(0);
    }
    
    const exportPath = args[0];
    const verbose = args.includes('--verbose') || args.includes('-v');
    
    if (verbose) {
        console.log('Verbose mode enabled');
    }
    
    try {
        const generator = new MetadataGenerator(exportPath);
        await generator.generate();
        console.log('\n✅ Metadata generation completed successfully!');
    } catch (error) {
        console.error('\n❌ Error generating metadata:');
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

module.exports = { MetadataGenerator };

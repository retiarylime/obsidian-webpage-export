#!/usr/bin/env node
/**
 * Generate Search Index Script
 * 
 * This script generates a search index for any Obsidian webpage export using MiniSearch.
 * It replicates the exact content extraction and indexing logic used by the regular 
 * Obsidian webpage exporter to produce functionally identical search results.
 * 
 * Usage: node generate-search-index.js <export-directory>
 * 
 * For large exports (>1000 files), consider increasing Node.js memory:
 * node --max-old-space-size=8192 generate-search-index.js <export-directory>
 * 
 * The generated index will include:
 * - All markdown documents discovered from metadata.json (limited to 1000 for memory)
 * - Content extracted using the same TreeWalker logic as the regular exporter
 * - Stop words filtering identical to the original implementation
 * - Combined description + searchContent fields like the original
 * - Exact MiniSearch configuration matching the regular exporter
 * 
 * Output files are generated with incremental names to prevent overwriting:
 * - search-index-generated.json (first run)
 * - search-index-generated-1.json (second run)
 * - search-index-generated-2.json (third run)
 * - etc.
 */

const fs = require('fs');
const path = require('path');
const MiniSearch = require('minisearch');
const { JSDOM } = require('jsdom');

// Stop words list matching the regular exporter
const stopWords = ["a", "about", "actually", "almost", "also", "although", "always", "am", "an", "and", "any", "are", "as", "at", "be", "became", "become", "but", "by", "can", "could", "did", "do", "does", "each", "either", "else", "for", "from", "had", "has", "have", "hence", "how", "i", "if", "in", "is", "it", "its", "just", "may", "maybe", "me", "might", "mine", "must", "my", "mine", "must", "my", "neither", "nor", "not", "of", "oh", "ok", "when", "where", "whereas", "wherever", "whenever", "whether", "which", "while", "who", "whom", "whoever", "whose", "why", "will", "with", "within", "without", "would", "yes", "yet", "you", "your"];

function extractContentFromHTML(filePath) {
    try {
        const htmlContent = fs.readFileSync(filePath, 'utf8');
        const dom = new JSDOM(htmlContent);
        const document = dom.window.document;
        
        // Replicate the exact content extraction logic from the regular exporter
        // Look for the main content elements in the same order as the original
        const contentElement = document.querySelector('.obsidian-document') || 
                              document.querySelector('.markdown-preview-sizer') || 
                              document.querySelector('.canvas-wrapper') || 
                              document.body;
        
        if (!contentElement) {
            return '';
        }

        // Skip elements that the regular exporter skips
        const skipSelector = ".math, svg, img, .frontmatter, .metadata-container, .heading-after, style, script";
        
        function getTextNodes(element) {
            const textNodes = [];
            const walker = document.createTreeWalker(
                element, 
                dom.window.NodeFilter.SHOW_TEXT, 
                null
            );
    
            let node;
            while (node = walker.nextNode()) {
                // Skip nodes whose parents match the skip selector
                if (node.parentElement) {
                    // Check if any parent matches the skip selector
                    let parent = node.parentElement;
                    let shouldSkip = false;
                    while (parent && parent !== element) {
                        if (parent.matches && parent.matches(skipSelector)) {
                            shouldSkip = true;
                            break;
                        }
                        parent = parent.parentElement;
                    }
                    if (shouldSkip) continue;
                }
                textNodes.push(node);
            }
            return textNodes;
        }

        const textNodes = getTextNodes(contentElement);

        let content = '';
        for (const node of textNodes) {
            content += ' ' + (node.textContent || '') + ' ';
        }

        // Extract href and src links like the original
        const links = contentElement.querySelectorAll('a[href]');
        const hrefLinks = Array.from(links).map(link => link.getAttribute('href')).filter(Boolean);
        
        const srcElements = contentElement.querySelectorAll('[src]');
        const srcLinks = Array.from(srcElements).map(el => el.getAttribute('src')).filter(Boolean);

        content += ' ' + hrefLinks.join(" ") + ' ';
        content += ' ' + srcLinks.join(" ") + ' ';

        // Normalize whitespace exactly like the original
        content = content.trim().replace(/\s+/g, ' ');

        return content;
        
    } catch (error) {
        console.warn(`⚠️ Could not extract content from ${filePath}:`, error.message);
        return '';
    }
}

function generateSearchIndex(exportDirectory) {
    console.log(`🔍 Generating search index for: ${exportDirectory}`);
    
    // Read metadata.json
    const metadataPath = path.join(exportDirectory, 'site-lib', 'metadata.json');
    if (!fs.existsSync(metadataPath)) {
        console.error('❌ metadata.json not found in site-lib directory');
        process.exit(1);
    }
    
    const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
    console.log(`📂 Loaded metadata for vault: ${metadata.vaultName}`);
    
    // Prepare documents for indexing
    const documents = [];
    
    // Get all HTML files that should be indexed (exclude site-lib files)
    const webpages = metadata.webpages || {};
    
    // Process all markdown files found in metadata
    const fileList = Object.keys(webpages).filter(filePath => {
        const pageData = webpages[filePath];
        return pageData && pageData.type === 'markdown';
    });
    
    // Sort files for consistent ordering
    fileList.sort();
    
    console.log(`📄 Found ${fileList.length} markdown files to index`);
    
    // For very large exports, process in batches to avoid memory issues
    const BATCH_SIZE = 1000;
    if (fileList.length > BATCH_SIZE) {
        console.log(`⚠️ Large export detected (${fileList.length} files). Consider using a smaller subset or increasing Node.js memory limit with --max-old-space-size=8192`);
        console.log(`📦 Processing first ${BATCH_SIZE} files to avoid memory issues...`);
        fileList.splice(BATCH_SIZE);
    }
    
    for (const filePath of fileList) {
        const pageData = webpages[filePath];
        
        // Create document for search index
        const htmlFilePath = path.join(exportDirectory, filePath);
        
        if (!fs.existsSync(htmlFilePath)) {
            console.warn(`⚠️ Warning: HTML file not found: ${htmlFilePath}`);
            continue;
        }
        
        const extractedContent = extractContentFromHTML(htmlFilePath);
        
        // Combine description and searchContent like the regular exporter
        const description = pageData.description || '';
        const searchContent = extractedContent;
        const combinedContent = (description + " " + searchContent).trim() || pageData.title || 'No content';
        
        const doc = {
            id: filePath,
            title: pageData.title || pageData.sourcePath?.split('/').pop()?.replace('.md', '') || 'Untitled',
            aliases: Array.isArray(pageData.aliases) ? pageData.aliases : [],
            headers: Array.isArray(pageData.headers) ? pageData.headers.map(h => h.heading).filter(h => h && h !== pageData.title) : [],
            tags: [...(pageData.inlineTags || []), ...(pageData.frontmatterTags || [])].filter(t => t != null && typeof t === 'string'),
            content: combinedContent,
            url: filePath
        };
        
        documents.push(doc);
    }
    
    console.log(`📄 Processing ${documents.length} documents for indexing`);
    
    // Find the next available filename to avoid overwriting existing files
    function findNextAvailableFilename(baseDir, baseName, extension) {
        let counter = 1;
        let filename;
        
        while (true) {
            if (counter === 0) {
                filename = `${baseName}.${extension}`;
            } else {
                filename = `${baseName}-${counter}.${extension}`;
            }
            
            const fullPath = path.join(baseDir, filename);
            if (!fs.existsSync(fullPath)) {
                return { filename, fullPath };
            }
            counter++;
        }
    }
    
    // Create MiniSearch instance with exact same configuration as original
    const miniSearch = new MiniSearch({
        fields: ['title', 'aliases', 'headers', 'tags', 'content'],
        storeFields: ['title', 'aliases', 'headers', 'tags', 'url'],
        processTerm: (term, _fieldName) => 
            stopWords.includes(term) ? null : term.toLowerCase(),
        autoVacuum: false,  // Disabled to prevent TreeIterator corruption like the original
        idField: 'id'
    });
    
    // Add documents to the search index
    miniSearch.addAll(documents);
    
    // Export the search index - use the natural format without artificial ID shifting
    const searchIndex = miniSearch.toJSON();
    
    // Generate incremental filename
    const outputDir = path.join(exportDirectory, 'site-lib');
    const { filename, fullPath: outputPath } = findNextAvailableFilename(outputDir, 'search-index-generated', 'json');
    
    // Save to file with incremental name
    fs.writeFileSync(outputPath, JSON.stringify(searchIndex, null, 0));
    
    const fileSize = fs.statSync(outputPath).size;
    console.log(`💾 Written ${filename}: ${fileSize} bytes`);
    console.log(`📁 Output: ${outputPath}`);
    console.log(`ℹ️ Generated incremental filename to avoid overwriting existing files`);
    console.log(`✅ Search index generation completed successfully!`);
}

// Main execution
if (require.main === module) {
    const exportDir = process.argv[2];
    if (!exportDir) {
        console.error('❌ Usage: node generate-search-index.js <export-directory>');
        process.exit(1);
    }
    
    if (!fs.existsSync(exportDir)) {
        console.error(`❌ Export directory does not exist: ${exportDir}`);
        process.exit(1);
    }
    
    generateSearchIndex(exportDir);
}

module.exports = { generateSearchIndex };

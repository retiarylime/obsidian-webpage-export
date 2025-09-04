#!/usr/bin/env node

const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

class OriginalFormatSearchIndexGenerator {
    constructor(exportPath, verbose = false) {
        this.exportPath = exportPath;
        this.siteLibPath = path.join(exportPath, 'site-lib');
        this.verbose = verbose;
        this.documents = [];
        this.metadata = null;
    }

    async generate() {
        console.log(`🔍 Generating search index for: ${this.exportPath}`);
        
        // Load metadata first
        await this.loadMetadata();
        
        // Scan for HTML files
        await this.scanDirectory(this.exportPath, '');
        
        if (this.documents.length === 0) {
            console.log('❌ No HTML files found to index');
            return;
        }

        console.log(`📄 Found ${this.documents.length} HTML files to index`);
        
        // Build search index in exact original format
        const searchIndex = this.buildOriginalFormatSearchIndex();
        
        // Save the index
        await this.saveSearchIndex(searchIndex);
        
        console.log('✅ Search index generation completed successfully!');
    }

    async loadMetadata() {
        const metadataPath = path.join(this.siteLibPath, 'metadata.json');
        
        if (fsSync.existsSync(metadataPath)) {
            try {
                const metadataContent = await fs.readFile(metadataPath, 'utf8');
                this.metadata = JSON.parse(metadataContent);
                if (this.verbose) {
                    console.log(`📂 Loaded existing metadata: ${metadataContent.length} bytes`);
                }
            } catch (error) {
                console.error('❌ Error loading metadata:', error.message);
            }
        }
    }

    async scanDirectory(dirPath, relativePath) {
        try {
            const entries = await fs.readdir(dirPath, { withFileTypes: true });
            
            for (const entry of entries) {
                const fullPath = path.join(dirPath, entry.name);
                const relativeFilePath = relativePath ? path.join(relativePath, entry.name) : entry.name;
                
                if (entry.isDirectory()) {
                    // Skip site-lib directory for HTML scanning
                    if (entry.name !== 'site-lib') {
                        await this.scanDirectory(fullPath, relativeFilePath);
                    }
                } else if (entry.name.endsWith('.html') && !relativeFilePath.startsWith('site-lib/')) {
                    await this.processHtmlFile(fullPath, relativeFilePath);
                }
            }
        } catch (error) {
            console.error(`Error scanning directory ${dirPath}:`, error.message);
        }
    }

    async processHtmlFile(fullPath, relativePath) {
        try {
            const htmlContent = await fs.readFile(fullPath, 'utf8');
            const document = this.extractDetailedDocumentData(htmlContent, relativePath);
            this.documents.push(document);
            
            if (this.verbose) {
                console.log(`📄 Indexed: ${relativePath}`);
            }
        } catch (error) {
            console.error(`Error processing HTML file ${fullPath}:`, error.message);
        }
    }

    extractDetailedDocumentData(htmlContent, relativePath) {
        const dom = new JSDOM(htmlContent);
        const document = dom.window.document;
        
        // Extract title - match original format exactly
        const titleElement = document.querySelector('title');
        let title = '';
        if (titleElement) {
            title = titleElement.textContent.trim();
            // Remove " - Website" suffix if present
            title = title.replace(/ - Website$/, '');
        }
        
        // Extract headers - match original structure
        const headers = [];
        
        // Look for span elements with nested spans (original format)
        const spanHeaders = document.querySelectorAll('span');
        spanHeaders.forEach(span => {
            const spanText = span.textContent?.trim();
            if (spanText && spanText.length > 0) {
                // Check if this looks like a header span from original format
                const nestedSpan = span.querySelector('span');
                if (nestedSpan) {
                    headers.push(`<span>${span.innerHTML}</span>`);
                }
            }
        });
        
        // Also extract table headers and regular headers
        const headerElements = document.querySelectorAll('h1, h2, h3, th');
        headerElements.forEach(el => {
            const headerText = el.textContent?.trim();
            if (headerText && !headers.includes(headerText)) {
                headers.push(headerText);
            }
        });
        
        // Extract content using original approach
        let content = '';
        if (document.body) {
            // Remove script and style elements
            const scripts = document.querySelectorAll('script, style');
            scripts.forEach(script => script.remove());
            
            // Get all text content and preserve some structure
            content = document.body.textContent || '';
            content = content.replace(/\s+/g, ' ').trim();
        }
        
        // Extract aliases and tags (usually empty)
        const aliases = [];
        const tags = [];
        
        return {
            path: relativePath,
            title: title,
            aliases: aliases,
            headers: headers,
            tags: tags,
            content: content
        };
    }

    buildOriginalFormatSearchIndex() {
        const documents = this.documents;
        
        // Sort documents to match original order (Korean grammar sentences first)
        documents.sort((a, b) => {
            const aIsKoreanGrammar = a.path.includes('korean-grammar-sentences');
            const bIsKoreanGrammar = b.path.includes('korean-grammar-sentences');
            
            if (aIsKoreanGrammar && !bIsKoreanGrammar) return -1;
            if (!aIsKoreanGrammar && bIsKoreanGrammar) return 1;
            
            return a.path.localeCompare(b.path);
        });

        const searchIndex = {
            documentCount: documents.length,
            nextId: 11 + documents.length, // Start from 11 like original
            documentIds: {},
            fieldIds: {
                title: 0,
                aliases: 1,
                headers: 2,
                tags: 3,
                path: 4,
                content: 5
            },
            fieldLength: {},
            averageFieldLength: [0, 0, 0, 0, 0, 0],
            storedFields: {},
            dirtCount: documents.length,
            index: [],
            serializationVersion: 2
        };

        // Build document mappings
        let currentId = 11;
        const allTerms = new Map();
        const fieldLengths = [[], [], [], [], [], []];

        documents.forEach((doc, index) => {
            const docId = String(currentId++);
            
            // Store document ID mapping
            searchIndex.documentIds[docId] = doc.path;
            
            // Calculate field lengths (word count for each field)
            const titleWords = this.countWords(doc.title);
            const aliasWords = doc.aliases.length > 0 ? this.countWords(doc.aliases.join(' ')) : 1;
            const headerWords = this.countWords(doc.headers.join(' '));
            const tagWords = doc.tags.length > 0 ? this.countWords(doc.tags.join(' ')) : 1;
            const pathWords = this.countWords(doc.path);
            const contentWords = this.countWords(doc.content);
            
            const docFieldLengths = [titleWords, aliasWords, headerWords, tagWords, pathWords, contentWords];
            searchIndex.fieldLength[docId] = docFieldLengths;
            
            // Accumulate for averages
            docFieldLengths.forEach((length, fieldIndex) => {
                fieldLengths[fieldIndex].push(length);
            });
            
            // Store fields
            searchIndex.storedFields[docId] = {
                title: doc.title,
                aliases: doc.aliases,
                headers: doc.headers,
                tags: doc.tags,
                path: doc.path
            };
            
            // Index terms
            this.indexTerms(doc, docId, allTerms);
        });

        // Calculate average field lengths
        searchIndex.averageFieldLength = fieldLengths.map(lengths => 
            lengths.reduce((sum, len) => sum + len, 0) / lengths.length
        );

        // Build term index
        searchIndex.index = this.buildTermIndex(allTerms);

        return searchIndex;
    }

    countWords(text) {
        if (!text || typeof text !== 'string') return 1;
        const words = text.trim().split(/\s+/);
        return Math.max(1, words.length);
    }

    indexTerms(doc, docId, allTerms) {
        // Index all fields
        const fields = {
            0: doc.title,
            1: doc.aliases.join(' '),
            2: doc.headers.join(' '),
            3: doc.tags.join(' '),
            4: doc.path,
            5: doc.content
        };

        Object.entries(fields).forEach(([fieldId, text]) => {
            if (text && typeof text === 'string') {
                const terms = this.extractTerms(text);
                terms.forEach(term => {
                    if (!allTerms.has(term)) {
                        allTerms.set(term, {});
                    }
                    if (!allTerms.get(term)[fieldId]) {
                        allTerms.get(term)[fieldId] = {};
                    }
                    if (!allTerms.get(term)[fieldId][docId]) {
                        allTerms.get(term)[fieldId][docId] = 0;
                    }
                    allTerms.get(term)[fieldId][docId]++;
                });
            }
        });
    }

    extractTerms(text) {
        // Extract terms similar to how Lunr.js would do it
        const terms = new Set();
        
        // Split on whitespace and punctuation
        const words = text.toLowerCase()
            .replace(/[^\w\s가-힣]/g, ' ')
            .split(/\s+/)
            .filter(word => word.length > 0);
            
        words.forEach(word => {
            if (word.length > 0) {
                terms.add(word);
            }
        });
        
        return Array.from(terms);
    }

    buildTermIndex(allTerms) {
        const index = [];
        
        // Convert terms map to array format
        for (const [term, fields] of allTerms.entries()) {
            index.push([term, fields]);
        }
        
        // Sort alphabetically
        index.sort((a, b) => a[0].localeCompare(b[0]));
        
        return index;
    }

    async saveSearchIndex(searchIndex) {
        try {
            const outputFile = path.join(this.siteLibPath, 'search-index-generated.json');
            const jsonContent = JSON.stringify(searchIndex);
            
            await fs.writeFile(outputFile, jsonContent, 'utf8');
            
            if (this.verbose) {
                console.log(`💾 Written search-index: ${jsonContent.length} bytes`);
                console.log(`📁 Output: ${outputFile}`);
                console.log(`✅ Generated search index with:`);
                console.log(`   - ${searchIndex.documentCount} documents`);
                console.log(`   - ${searchIndex.index.length} indexed terms`);
            }
            
        } catch (error) {
            console.error('❌ Error saving search index:', error.message);
            throw error;
        }
    }
}

// CLI interface
if (require.main === module) {
    const args = process.argv.slice(2);
    
    if (args.length === 0) {
        console.log('Usage: node generate-search-index-reverse-engineered.js <export-path> [--verbose]');
        console.log('');
        console.log('Example:');
        console.log('  node generate-search-index-reverse-engineered.js /path/to/export --verbose');
        process.exit(1);
    }
    
    const exportPath = args[0];
    const verbose = args.includes('--verbose');
    
    // Check if export path exists
    if (!fsSync.existsSync(exportPath)) {
        console.error(`❌ Export path does not exist: ${exportPath}`);
        process.exit(1);
    }
    
    // Run generator
    const generator = new OriginalFormatSearchIndexGenerator(exportPath, verbose);
    generator.generate()
        .then(() => {
            console.log('🎉 Search index generation completed!');
        })
        .catch(error => {
            console.error('❌ Error generating search index:', error.message);
            process.exit(1);
        });
}

module.exports = OriginalFormatSearchIndexGenerator;

#!/usr/bin/env node

/**
 * Sample Export File Contents
 * Shows what the actual generated files contain
 */

console.log("📝 SAMPLE EXPORTED FILE CONTENTS");
console.log("=================================\n");

console.log("🏠 index.html (Main Homepage):");
console.log("─────────────────────────────");
console.log(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>My Obsidian Vault</title>
    <link rel="stylesheet" href="site-lib/css/obsidian-styles.css">
    <link rel="stylesheet" href="site-lib/css/theme-styles.css">
    <link rel="stylesheet" href="site-lib/css/website-styles.css">
</head>
<body class="theme-dark">
    <div id="app">
        <div id="sidebar">
            <div id="file-explorer">
                <!-- File tree navigation -->
                <ul class="nav-folder">
                    <li><a href="Daily Notes.html">Daily Notes</a></li>
                    <li class="nav-folder">
                        <span class="nav-folder-title">Projects</span>
                        <ul>
                            <li><a href="Projects/Project A.html">Project A</a></li>
                            <li><a href="Projects/Project B.html">Project B</a></li>
                        </ul>
                    </li>
                </ul>
            </div>
            <div id="search-container">
                <input type="text" id="search-input" placeholder="Search notes...">
                <div id="search-results"></div>
            </div>
        </div>
        <div id="main-content">
            <h1>Welcome to My Obsidian Vault</h1>
            <p>This is your exported digital garden...</p>
        </div>
    </div>
    <script src="site-lib/js/website.js"></script>
</body>
</html>`);

console.log("\n\n📄 Sample Note.html (Converted Markdown):");
console.log("──────────────────────────────────────");
console.log(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>My Important Note - My Obsidian Vault</title>
    <link rel="stylesheet" href="../site-lib/css/obsidian-styles.css">
    <!-- ... other stylesheets ... -->
</head>
<body class="theme-dark">
    <div id="app">
        <div id="sidebar">
            <!-- Same navigation as index.html -->
        </div>
        <div id="main-content">
            <div class="markdown-preview-view">
                <h1>My Important Note</h1>
                <p>This note was written in <strong>Obsidian</strong> and exported to HTML.</p>
                
                <h2>Features Preserved</h2>
                <ul>
                    <li>Internal links: <a href="Other Note.html">Other Note</a></li>
                    <li>Images: <img src="images/diagram.png" alt="Diagram"></li>
                    <li>Callouts and formatting</li>
                </ul>
                
                <blockquote class="callout callout-info">
                    <div class="callout-title">Info</div>
                    <div class="callout-content">
                        <p>Callouts are preserved with full styling!</p>
                    </div>
                </blockquote>
                
                <h2>Code Blocks</h2>
                <pre><code class="language-javascript">
function hello() {
    console.log("Syntax highlighting works!");
}
                </code></pre>
                
                <p>Tags: <span class="tag">#important</span> <span class="tag">#project</span></p>
            </div>
        </div>
    </div>
    <script src="../site-lib/js/website.js"></script>
</body>
</html>`);

console.log("\n\n📋 metadata.json (Site Configuration):");
console.log("─────────────────────────────────────");
console.log(`{
    "siteName": "My Obsidian Vault",
    "description": "My digital garden exported from Obsidian",
    "author": "Your Name",
    "created": "2025-08-24T15:30:00.000Z",
    "exportVersion": "1.3.2",
    "totalFiles": 247,
    "totalPages": 123,
    "totalAttachments": 45,
    "features": {
        "search": true,
        "graphView": true,
        "themeToggle": true,
        "fileNavigation": true,
        "backlinks": true,
        "tags": true
    },
    "theme": {
        "default": "dark",
        "available": ["dark", "light"]
    },
    "files": [
        {
            "path": "Daily Notes.html",
            "title": "Daily Notes",
            "created": "2025-01-15T10:00:00.000Z",
            "modified": "2025-08-20T14:30:00.000Z",
            "size": 2048,
            "tags": ["daily", "notes"]
        },
        {
            "path": "Projects/Project A.html", 
            "title": "Project A",
            "created": "2025-02-01T09:00:00.000Z",
            "modified": "2025-08-22T16:45:00.000Z",
            "size": 4096,
            "tags": ["project", "important"]
        }
    ]
}`);

console.log("\n\n🔍 search-index.json (Search Data):");
console.log("──────────────────────────────────");
console.log(`{
    "version": "1.0",
    "created": "2025-08-24T15:30:00.000Z",
    "documents": [
        {
            "id": 0,
            "path": "Daily Notes.html",
            "title": "Daily Notes",
            "content": "daily notes routine morning pages reflection...",
            "headings": ["Morning Routine", "Evening Reflection"],
            "tags": ["daily", "notes"],
            "links": ["Projects/Project A.html", "Other Note.html"]
        },
        {
            "id": 1, 
            "path": "Projects/Project A.html",
            "title": "Project A", 
            "content": "project management tasks deadlines goals...",
            "headings": ["Overview", "Tasks", "Timeline"],
            "tags": ["project", "important"],
            "links": ["Daily Notes.html", "Resources.html"]
        }
    ],
    "index": {
        "daily": [0],
        "notes": [0],
        "project": [1], 
        "management": [1],
        "tasks": [1]
    }
}`);

console.log("\n\n🎨 site-lib/css/website-styles.css (Core Styling):");
console.log("─────────────────────────────────────────────────");
console.log(`/* Website layout and navigation */
#app {
    display: flex;
    height: 100vh;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
}

#sidebar {
    width: 300px;
    background: var(--background-secondary);
    border-right: 1px solid var(--background-modifier-border);
    overflow-y: auto;
}

#main-content {
    flex: 1;
    padding: 20px;
    overflow-y: auto;
    background: var(--background-primary);
}

/* File navigation */
.nav-folder {
    list-style: none;
    padding-left: 20px;
}

.nav-folder-title {
    font-weight: 600;
    color: var(--text-muted);
    cursor: pointer;
}

.nav-folder a {
    color: var(--text-normal);
    text-decoration: none;
    padding: 4px 8px;
    display: block;
    border-radius: 4px;
}

.nav-folder a:hover {
    background: var(--background-modifier-hover);
}

/* Search */
#search-input {
    width: 100%;
    padding: 8px;
    border: 1px solid var(--background-modifier-border);
    background: var(--background-primary);
    color: var(--text-normal);
}

/* Theme support */
.theme-dark {
    --background-primary: #1e1e1e;
    --background-secondary: #252525;
    --text-normal: #dcddde;
    --text-muted: #999999;
}

.theme-light {
    --background-primary: #ffffff;
    --background-secondary: #f5f5f5;
    --text-normal: #2e3338;
    --text-muted: #666666;
}`);

console.log("\n\n🚀 JavaScript Functionality (site-lib/js/website.js):");
console.log("────────────────────────────────────────────────────");
console.log(`// Search functionality
class SiteSearch {
    constructor() {
        this.searchIndex = null;
        this.loadSearchIndex();
        this.initializeSearch();
    }
    
    async loadSearchIndex() {
        const response = await fetch('search-index.json');
        this.searchIndex = await response.json();
    }
    
    search(query) {
        if (!this.searchIndex || !query) return [];
        
        const results = [];
        const terms = query.toLowerCase().split(' ');
        
        this.searchIndex.documents.forEach(doc => {
            const content = (doc.title + ' ' + doc.content).toLowerCase();
            const score = terms.reduce((acc, term) => {
                return acc + (content.includes(term) ? 1 : 0);
            }, 0);
            
            if (score > 0) {
                results.push({ ...doc, score });
            }
        });
        
        return results.sort((a, b) => b.score - a.score);
    }
}

// Theme toggling
class ThemeManager {
    constructor() {
        this.currentTheme = localStorage.getItem('theme') || 'dark';
        this.applyTheme();
    }
    
    toggleTheme() {
        this.currentTheme = this.currentTheme === 'dark' ? 'light' : 'dark';
        localStorage.setItem('theme', this.currentTheme);
        this.applyTheme();
    }
    
    applyTheme() {
        document.body.className = \`theme-\${this.currentTheme}\`;
    }
}

// Initialize when page loads
document.addEventListener('DOMContentLoaded', () => {
    new SiteSearch();
    new ThemeManager();
});`);

console.log("\n\n📁 Directory Structure Summary:");
console.log("──────────────────────────────");
console.log("🎯 The exported website is a complete, self-contained static site:");
console.log("   • All Obsidian features preserved (links, images, formatting)");
console.log("   • Full-text search works offline");
console.log("   • Responsive design for desktop and mobile");
console.log("   • Dark/light theme toggle");
console.log("   • File tree navigation");
console.log("   • Graph view of note connections (if enabled)");
console.log("   • No server required - works on any web host");
console.log("   • Can be opened directly in browser (file:// URLs)");
console.log("");
console.log("🚀 Deploy anywhere: GitHub Pages, Netlify, your own server, or local viewing!");

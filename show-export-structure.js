#!/usr/bin/env node

/**
 * Exported Website Structure Documentation
 * 
 * This script shows the final directory structure that both export methods produce.
 * Both regular exporter (<500 files) and chunked exporter (>500 files) create identical structures.
 */

console.log("📁 EXPORTED WEBSITE DIRECTORY STRUCTURE");
console.log("========================================\n");

console.log("🏠 Root Export Directory (e.g., /path/to/export/):");
console.log("├── index.html                    # Main entry point / homepage");
console.log("├── metadata.json                 # Site metadata and configuration");
console.log("├── search-index.json            # Full-text search index");
console.log("├── rss.xml                      # RSS feed (if enabled)");
console.log("├── sitemap.xml                  # Site map (if enabled)");
console.log("└── site-lib/                    # Static assets and resources");
console.log("    ├── css/                     # Stylesheets");
console.log("    │   ├── obsidian-styles.css  # Core Obsidian styles");
console.log("    │   ├── theme-styles.css     # Active theme styles");
console.log("    │   ├── plugin-styles.css    # Plugin-specific styles");
console.log("    │   ├── snippet-styles.css   # Custom CSS snippets");
console.log("    │   └── website-styles.css   # Export-specific styles");
console.log("    ├── js/                      # JavaScript files");
console.log("    │   ├── website.js           # Main website functionality");
console.log("    │   ├── graph-view.js        # Graph view (if enabled)");
console.log("    │   ├── search.js            # Search functionality");
console.log("    │   └── theme-toggle.js      # Dark/light mode toggle");
console.log("    ├── media/                   # Images, videos, audio files");
console.log("    │   ├── image1.png");
console.log("    │   ├── image2.jpg");
console.log("    │   └── attachment.pdf");
console.log("    ├── fonts/                   # Web fonts (if any)");
console.log("    │   └── font-file.woff2");
console.log("    └── html/                    # Additional HTML components");
console.log("        └── file-tree.html       # File navigation tree");
console.log("");

console.log("📄 Content Files (Markdown → HTML):");
console.log("├── note1.html                   # Top-level notes");
console.log("├── note2.html");
console.log("├── folder1/                     # Preserves folder structure");
console.log("│   ├── subnote1.html");
console.log("│   ├── subnote2.html");
console.log("│   └── subfolder/");
console.log("│       └── deep-note.html");
console.log("└── folder2/");
console.log("    ├── another-note.html");
console.log("    └── images/                  # Local attachments stay with notes");
console.log("        └── local-image.png");
console.log("");

console.log("🔗 Path Structure Details:");
console.log("─────────────────────────");
console.log("• Vault structure is preserved: folder/subfolder/note.html");
console.log("• Note names become HTML filenames: 'My Note.md' → 'My Note.html'");
console.log("• Spaces and special chars handled based on slugify settings");
console.log("• If slugifyPaths=true: 'My Note.html' → 'my-note.html'");
console.log("• Attachments keep original filenames and extensions");
console.log("• Internal links automatically updated to .html extensions");
console.log("• Cross-references maintained with correct relative paths");
console.log("");

console.log("📊 Key Files Explained:");
console.log("───────────────────────");
console.log("🏠 index.html:");
console.log("   • Main entry point with navigation");
console.log("   • Shows file tree, search, and content area");
console.log("   • Responsive design with sidebar/mobile layouts");
console.log("");

console.log("📋 metadata.json:");
console.log("   • Site configuration and file listings");
console.log("   • Theme settings and feature flags");
console.log("   • File modification times and relationships");
console.log("");

console.log("🔍 search-index.json:");
console.log("   • Full-text search index of all content");
console.log("   • Enables instant search across all notes");
console.log("   • Includes titles, headings, and body text");
console.log("");

console.log("🎨 site-lib/ directory:");
console.log("   • Contains all static assets needed for the site");
console.log("   • Organized by type: css/, js/, media/, fonts/, html/");
console.log("   • Self-contained - no external dependencies");
console.log("");

console.log("🌐 Deployment Ready:");
console.log("────────────────────");
console.log("✅ Static files only - no server-side processing needed");
console.log("✅ Works on any web server (Apache, Nginx, GitHub Pages, etc.)");
console.log("✅ Can be opened directly in browser (file:// URLs)");
console.log("✅ All assets self-contained - no external dependencies");
console.log("✅ Responsive design works on desktop and mobile");
console.log("✅ Dark/light theme toggle included");
console.log("✅ Full-text search works offline");
console.log("✅ Graph view shows note connections (if enabled)");
console.log("");

console.log("🔄 Export Method Comparison:");
console.log("───────────────────────────");
console.log("📁 REGULAR EXPORTER (≤500 files):");
console.log("   • Processes all files at once");
console.log("   • Faster for small vaults");
console.log("   • Single pass through all content");
console.log("");

console.log("📁 CHUNKED EXPORTER (>500 files):");
console.log("   • Processes files in chunks of 30");
console.log("   • Memory-efficient for large vaults");
console.log("   • Crash recovery with resume capability");
console.log("   • Progress tracking per chunk");
console.log("");

console.log("🎯 IDENTICAL FINAL STRUCTURE:");
console.log("────────────────────────────");
console.log("Both export methods produce byte-identical directory structures!");
console.log("• Same file paths and names");
console.log("• Same asset organization");
console.log("• Same metadata.json content");
console.log("• Same search-index.json content");
console.log("• Same internal link resolution");
console.log("• Same relative path calculations");
console.log("");

console.log("📦 Example Export Structure:");
console.log("├── /home/user/my-website/        # Export destination");
console.log("│   ├── index.html                # Homepage");
console.log("│   ├── Daily Notes.html          # Top-level note");
console.log("│   ├── Projects/                 # Folder from vault");
console.log("│   │   ├── Project A.html        # Note in folder");
console.log("│   │   └── images/               # Attachments");
console.log("│   │       └── diagram.png");
console.log("│   ├── Research/                 # Another folder");
console.log("│   │   ├── Topic 1.html");
console.log("│   │   └── Topic 2.html");
console.log("│   ├── metadata.json             # Site metadata");
console.log("│   ├── search-index.json         # Search index");
console.log("│   └── site-lib/                 # Static assets");
console.log("│       ├── css/ js/ media/ fonts/ html/");
console.log("│       └── [all required assets]");
console.log("");

console.log("🚀 Ready to Deploy!");
console.log("Just upload the entire export directory to any web server!");

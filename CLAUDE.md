# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

The **Obsidian Webpage Export** plugin is a sophisticated tool that converts Obsidian vaults and documents into static HTML websites. The plugin provides comprehensive export functionality while maintaining visual fidelity with Obsidian's native styling.

**Core Features:**
- Full text search, file navigation tree, document outline, interactive graph view
- Theme toggle (dark/light), mobile-optimized responsive design
- Comprehensive plugin support (Dataview, Excalidraw, Canvas, Tasks, etc.)
- Single-file export (HTML + dependencies bundled) and chunked export for large vaults
- RSS feed generation, Docker containerization, CI/CD automation
- Multi-format support: Markdown, Canvas pages, Excalidraw diagrams, media files

## Development Commands

```bash
# Development build with hot reload
npm run dev

# Production build with type checking
npm run build

# Build with git commit and push
npm run build-and-push

# Automated version bumping
npm run version

# Generate export metadata
npm run generate-metadata
```

## Complete Architecture Overview

The plugin follows a **modular, feature-based architecture** with a **pipeline-based export system**:

### Directory Structure

```
src/
├── plugin/                    # Main plugin implementation
│   ├── main.ts               # Plugin entry point and lifecycle
│   ├── exporter.ts           # Core export orchestration
│   ├── asset-loaders/        # Asset management subsystem
│   ├── features/             # Export features (graph, search, etc.)
│   ├── render-api/           # Markdown rendering engine
│   ├── settings/             # Configuration management
│   ├── utils/                # Utility functions
│   └── website/              # Website generation system
├── frontend/                 # Client-side web components
│   ├── main/                 # Website runtime and navigation
│   ├── graph-view/           # WebAssembly-based graph visualization
│   └── shared/               # Frontend utilities
├── shared/                   # Shared types and interfaces
└── assets/                   # Static resources and styles
```

### Core Subsystems

#### 1. Export Pipeline (`src/plugin/website/`)
**Architecture Flow:** Files Selection → Website Loading → Document Rendering → Asset Processing → HTML Generation → File Writing

**Key Components:**
- `website.ts` - Main orchestrator for the entire export process
- `export-pipeline.ts` - Pipeline configuration and options management
- `webpage.ts` - Individual page generation and optimization
- `index.ts` - Website index generation and metadata management

**Critical Features:**
- **Chunked Export**: Automatically processes large vaults (>200 files) in configurable chunks
- **Incremental Updates**: Only reprocesses changed files for faster exports
- **Single File Mode**: Combines entire website into one self-contained HTML file
- **Progress Persistence**: Tracks export progress with crash recovery

#### 2. Asset Management System (`src/plugin/asset-loaders/`)
**Sophisticated Asset Pipeline:**
- `base-asset.ts` - Foundation for all asset handling with mutability management
- `obsidian-styles.ts` - Extracts and processes Obsidian's core styles
- `theme-styles.ts` - Handles custom theme integration
- `other-plugin-styles.ts` - Manages third-party plugin styles
- `website-js.ts` - Bundles frontend JavaScript

**Asset Types & Strategies:**
- Scripts, styles, media, fonts, HTML with inline/external/deffered loading policies
- Smart decisions about inlining vs external linking
- Static vs temporary asset management
- Comprehensive optimization and bundling

#### 3. Advanced Rendering Engine (`src/plugin/render-api/`)
**Multi-Strategy Rendering:**
- `render-api.ts` - Advanced rendering engine with batch processing
- `dataview-renderer.ts` - Dataview plugin integration
- `canvas-renderer.ts` - Canvas page rendering
- `excalidraw-renderer.ts` - Diagram conversion to SVG

**Key Capabilities:**
- Batch processing for efficient multi-document rendering
- Fallback rendering strategies for reliability
- Comprehensive plugin integration (Dataview, Excalidraw, Canvas, etc.)
- HTML post-processing and optimization

#### 4. Feature System (`src/plugin/features/` & `src/shared/features/`)
**Modular Feature Architecture:**
- `feature-generator.ts` - Framework for dynamic feature insertion
- Each feature is self-contained with comprehensive configuration options
- Features can be dynamically enabled/disabled

**Available Features:**
- **Graph View**: Interactive WebAssembly-based node visualization
- **Search**: Full-text search with MiniSearch indexing
- **File Navigation**: Tree-based hierarchical file browser
- **Outline**: Document structure navigation
- **Theme Toggle**: Dark/light mode switching
- **Backlinks**: Link relationship visualization
- **Tags**: Tag management and display
- **Custom Head Content**: HTML/JS injection point

#### 5. Frontend Runtime (`src/frontend/main/`)
**Website Runtime System:**
- `website.ts` - Main application controller with SPA-style navigation
- `document.ts` - Document handling and content management
- `search.ts` - Client-side search functionality
- `graph-view.ts` - Interactive graph visualization
- `theme.ts` - Theme management and responsive design

**Runtime Features:**
- Mobile-responsive design with breakpoint system
- Touch-friendly interactions and accessibility support
- Lazy loading and performance optimization
- Progressive enhancement for universal compatibility

### Export Process Workflow

1. **Export Initiation** (`main.ts`): Plugin registration, command setup, file selection
2. **Export Decision Engine** (`exporter.ts`): Determines single file vs chunked export strategy
3. **Website Generation** (`website/website.ts`): Template loading, feature injection, asset collection
4. **Markdown Rendering Pipeline** (`render-api/`): Converts to HTML with full plugin integration
5. **Asset Management** (`asset-loaders/`): Optimizes and bundles static resources
6. **Feature Integration** (`features/`): Injects interactive features
7. **Output Generation**: Produces optimized HTML/CSS/JS with proper structure

### Configuration and Settings

**Comprehensive Settings System** (`src/plugin/settings/`):
- **Export Presets**: Online, Local, Raw Documents with different optimization strategies
- **Feature Toggles**: Granular control over individual export features
- **Asset Controls**: Blacklist/whitelist for file processing and asset optimization
- **Plugin Integration**: Supported plugin compatibility and configuration
- **Customization**: Custom CSS, fonts, icons, and content injection

## Build System and Deployment

### ESBuild Configuration (`esbuild.config.mjs`)
**Dual Build Process:**
- **Frontend Build**: `src/frontend/main/index.txt.ts` → optimized web bundle
- **Plugin Build**: `src/plugin/main.ts` → Obsidian plugin bundle
- Custom post-processing with regex replacements for optimization
- Asset processing for JS, CSS, WASM, images, and other file types

**TypeScript Setup:**
- Dual configurations for plugin and frontend
- Strict mode with comprehensive type checking
- Modern ES6+ targets with contemporary browser support

### Docker Deployment (`Dockerfile`, `docker-compose.yaml`)
**Container Architecture:**
- Multi-stage build: Node.js build stage + Ubuntu runtime
- Full Obsidian installation with headless Electron operation
- Xvfb for GUI operations without display
- Flexible volume mounting for vault and output directories

### CI/CD Pipeline (`.github/workflows/`)
**Automated Operations:**
- GitHub Actions for testing and releases
- Multi-platform Docker builds (AMD64 and ARM64)
- Automated plugin distribution and Docker image publishing
- Semantic versioning with changelog generation

## Advanced Technical Features

### Performance Optimizations
- **Chunked Processing**: Handles large vaults efficiently with memory management
- **Parallel Processing**: Concurrent asset and document processing
- **Incremental Updates**: Only processes changed content
- **Web Workers**: Background processing for intensive tasks
- **Lazy Loading**: Dynamic content loading and code splitting
- **Intelligent Caching**: Content and asset caching strategies

### Plugin Ecosystem Integration
**Comprehensive Plugin Support:**
- **Dataview**: Full data query and table support
- **Excalidraw**: Diagram conversion to SVG
- **Canvas**: Interactive canvas export with embedded content
- **Advanced Tables**: Enhanced table formatting
- **Iconize**: Custom icon system support
- **Banner Plugin**: Header image integration

### Mobile and Accessibility
**Responsive Design:**
- Mobile-first approach with breakpoint system
- Touch-friendly interactions and gestures
- Optimized performance for mobile devices
- Progressive enhancement ensures core functionality everywhere

**Accessibility Features:**
- Full keyboard navigation support
- Screen reader compatibility with ARIA labels
- Proper focus management and semantic HTML
- WCAG color contrast compliance

## Development Patterns and Best Practices

### Architecture Patterns
- **MVC-like Structure**: Models in `shared/`, Views in `frontend/`, Controllers in `plugin/`
- **Feature-based Modularity**: Self-contained features with clear interfaces
- **Event-driven Design**: Loose coupling through event systems
- **Dependency Injection**: Services injected where needed

### Code Quality Standards
- **Strong TypeScript Typing**: Comprehensive type definitions and interfaces
- **Error Handling**: Graceful degradation with fallback strategies
- **Comprehensive Logging**: Detailed error reporting and debugging information
- **User Feedback**: Clear error messages and progress indicators

## Critical Development Files

### Core Plugin Files
1. **`src/plugin/main.ts`** - Plugin lifecycle, command registration, public API
2. **`src/plugin/exporter.ts`** - Export orchestration and decision engine
3. **`src/plugin/utils/chunked-website-exporter.ts`** - Large vault processing (performance-critical)
4. **`src/plugin/website/website.ts`** - Website generation orchestrator

### Rendering and Processing
5. **`src/plugin/render-api/render-api.ts`** - Advanced markdown rendering engine
6. **`src/plugin/asset-loaders/asset-handler.ts`** - Asset management and optimization
7. **`src/plugin/features/feature.ts`** - Feature system framework

### Configuration and Build
8. **`src/plugin/settings/settings.ts`** - Comprehensive configuration management
9. **`esbuild.config.mjs`** - Dual build configuration and post-processing
10. **`src/frontend/main/website.ts`** - Frontend runtime controller

### Specialized Systems
11. **`src/frontend/graph-view/`** - WebAssembly-based graph visualization
12. **`Dockerfile`** and **`docker-compose.yaml`** - Container deployment setup
13. **`.github/workflows/`** - CI/CD automation pipelines

## Plugin API and Integration

The plugin exposes a comprehensive public API for other plugins:
- `HTMLExportPlugin.api` - MarkdownRendererAPI for external access
- `HTMLExportPlugin.internalAPI` - Internal renderer access
- `HTMLExportPlugin.assetHandler` - Asset management access
- `HTMLExportPlugin.Website` - Website generation access

This enables other plugins to integrate with the export system and extend its capabilities.
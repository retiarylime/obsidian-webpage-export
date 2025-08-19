# Large Vault Export Solutions

This document explains the solutions implemented to handle large Obsidian vaults (5000+ notes) that were previously crashing during export.

## Problem

When exporting large vaults (500+ files), the plugin would crash after processing approximately 400 files due to:

1. **Memory Exhaustion**: DOM elements and rendered content accumulating in memory
2. **Resource Leaks**: Event listeners and view instances not being properly cleaned up  
3. **Browser/Electron Limits**: Too many concurrent operations overwhelming the rendering engine
4. **Asset Loading**: Excessive asset caching consuming memory

## Solutions Implemented

### 1. Chunked Export System (`ChunkedWebsiteExporter`)

Large vaults are now automatically processed in chunks:

- **Automatic Detection**: Vaults with >200 files use chunked export
- **Smart Chunking**: Files are sorted by complexity (size, type) for optimal processing
- **Recommended Chunk Sizes**:
  - 500-1000 files: 40 files per chunk
  - 1000-3000 files: 30 files per chunk  
  - 3000-5000 files: 25 files per chunk
  - 5000+ files: 20 files per chunk

### 2. Memory Management (`MemoryManager`)

Aggressive memory cleanup between chunks:

- **DOM Cleanup**: Removes temporary containers and unused elements
- **Canvas Cleanup**: Clears canvas memory which can be substantial
- **Garbage Collection**: Forces GC when available
- **Memory Monitoring**: Tracks usage and triggers cleanup at 300MB threshold

### 3. Configurable Performance Settings

New setting in Export Options:
- **Large Vault Chunk Size**: Allows users to fine-tune chunk size (default: 25)
- **Lower values**: Use less memory but may be slower
- **Higher values**: Faster but use more memory

## User Guidelines

### For Very Large Vaults (3000+ files):

1. **Reduce Chunk Size**: Set chunk size to 15-20 files in export settings
2. **Close Other Apps**: Free up system memory before export
3. **Monitor Progress**: Watch the progress bar - exports may take 10-30+ minutes
4. **Don't Interrupt**: Let the export complete; interruption may require restart

### Troubleshooting

**If export still fails:**

1. **Reduce chunk size** to 10-15 files
2. **Export in sections**: Select folders/files in smaller batches
3. **Check system memory**: Ensure at least 4GB RAM available
4. **Update Obsidian**: Ensure you're running the latest version

**Memory optimization tips:**

- Close other Obsidian vaults during export
- Disable unnecessary Obsidian plugins temporarily
- Close other memory-intensive applications
- Consider restarting Obsidian before large exports

### Performance Expectations

**Typical export times:**
- 500 files: 2-5 minutes
- 1000 files: 5-10 minutes  
- 3000 files: 15-25 minutes
- 5000+ files: 25-45 minutes

**Memory usage:**
- Standard export: 200-800MB peak
- Chunked export: 150-400MB peak (much more stable)

## Technical Details

### How Chunked Export Works

1. **File Analysis**: Files sorted by size and complexity
2. **Chunk Creation**: Files divided into optimal chunk sizes
3. **Sequential Processing**: Each chunk processed independently
4. **Memory Cleanup**: Aggressive cleanup between chunks
5. **Result Merging**: Chunks combined into final website

### Memory Management Strategy

- **Proactive Cleanup**: Memory cleaned every 3 chunks
- **Reactive Cleanup**: Triggered when memory exceeds threshold
- **DOM Pruning**: Removes temporary and orphaned elements
- **Asset Management**: Prevents asset cache bloat

## Limitations

- **Single-threaded**: Export is still sequential (Obsidian API limitation)
- **Memory dependent**: Very large files (>50MB) may still cause issues
- **Plugin dependent**: Some complex plugins may not work optimally in chunks

## Future Improvements

Potential enhancements being considered:

- **Resume capability**: Allow resuming interrupted exports
- **Selective export**: Smart file filtering to exclude problematic files
- **Progress persistence**: Save progress state for very long exports
- **Parallel processing**: Where possible within Obsidian's constraints

---

*These improvements should allow successful export of vaults with 5000+ files while maintaining all plugin functionality and workflow.*

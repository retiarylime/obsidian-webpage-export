# Export Path Fix Scripts

These Python scripts fix path and file tree navigation issues in exported Obsidian websites by rebuilding the metadata.json file with correct path mappings.

## The Problem

When using chunked export for large websites, some files (especially root-level files like `darakwon-metadata.html`) may not be properly indexed in the metadata, causing "This page does not exist yet" errors when clicking navigation links.

## The Solution

The `fix_export_paths.py` script:

1. **Scans** your entire export directory to discover all files
2. **Rebuilds** the `metadata.json` file with correct path mappings  
3. **Ensures** all HTML files have proper webpage entries for navigation
4. **Fixes** file tree navigation by mapping paths correctly
5. **Creates** a backup of the original metadata

## Usage

### Fix Export Paths

```bash
# Run the fix script on your export directory
python fix_export_paths.py /home/rl/Desktop/export
```

### Test the Fix

```bash  
# Verify the fix worked correctly
python test_export_fix.py /home/rl/Desktop/export
```

### Dry Run (Preview Changes)

```bash
# See what would be changed without making modifications
python fix_export_paths.py /home/rl/Desktop/export --dry-run
```

## What It Fixes

- ✅ **Missing webpage entries** - HTML files that weren't indexed properly
- ✅ **Broken file tree navigation** - Links in the file tree that return "page does not exist"
- ✅ **Path mapping inconsistencies** - Mismatched source/target path mappings
- ✅ **Chunked export metadata gaps** - Files processed in different chunks but not merged properly

## Files Modified

- `site-lib/metadata.json` - The main metadata file (backup created as `metadata.json.backup`)

## Example Output

```
🔧 Fixing export paths in: /home/rl/Desktop/export
✅ Valid export directory found
✅ Loaded metadata with 245 webpages
✅ Created backup: site-lib/metadata.json.backup
🔍 Scanning export directory...
✅ Discovered 312 files
🔨 Rebuilding metadata...
✅ Rebuilt metadata with 267 webpages
   Total files: 312
   Files in tree: 289
✅ Saved updated metadata: site-lib/metadata.json
🔍 Validating fix...
✅ All 267 HTML files have webpage entries
✅ All 289 tree files have proper entries
✅ Fixed problematic files: ['darakwon-metadata.html', 'evita-metadata.html']
✅ Export path fix completed successfully!
```

## Safety

- ✅ **Non-destructive** - Only modifies `metadata.json`, never your content files
- ✅ **Backup created** - Original metadata saved as `metadata.json.backup`
- ✅ **Dry run mode** - Preview changes before applying them
- ✅ **Validation** - Tests ensure the fix worked correctly

## Recovery

If something goes wrong, you can restore the original metadata:

```bash
cd /home/rl/Desktop/export/site-lib
cp metadata.json.backup metadata.json
```

## How It Works

The script addresses the root cause identified in the chunked export system:

1. **Chunked export** processes large websites in memory-safe chunks
2. **Metadata merging** wasn't properly combining all chunk results  
3. **Frontend navigation** (`getWebpageData()`) couldn't find missing webpage entries
4. **Path resolution** had mismatches between file tree paths and metadata keys

The fix ensures all discovered files are properly indexed in the metadata with consistent path mappings, enabling smooth navigation throughout your exported website.

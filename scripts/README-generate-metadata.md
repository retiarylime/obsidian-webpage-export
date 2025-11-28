# Metadata Generator Script

This script generates a `metadata.json` file from an existing exported website directory. It's useful for:

- Reconstructing metadata after it's been lost or corrupted
- Analyzing existing exported websites
- Creating metadata for manually created website structures
- Debugging export issues

## Installation

First install the required dependencies:

```bash
npm install
```

## Usage

### Basic Usage

```bash
# Generate metadata for an exported site
node scripts/generate-metadata.js /path/to/exported/site

# Using npm script
npm run generate-metadata /path/to/exported/site

# With verbose output
node scripts/generate-metadata.js ./exported-site --verbose
```

### Examples

```bash
# Generate metadata for a site exported to 'my-vault-export'
node scripts/generate-metadata.js ./my-vault-export

# Analyze an existing website and regenerate metadata
node scripts/generate-metadata.js /home/user/websites/my-obsidian-site --verbose
```

## What it does

The script performs the following operations:

1. **📂 Scans Directory Structure**: Recursively scans the export directory to catalog all files
2. **📄 Analyzes HTML Files**: Extracts metadata from HTML files including:
   - Page titles and descriptions
   - Headers (H1-H6) with IDs
   - Internal links and attachments
   - Author information
3. **🔍 Detects Features**: Identifies enabled features by checking for:
   - Search index files
   - Graph view assets
   - Favicon presence
   - Theme CSS files
4. **🌲 Builds File Tree**: Creates the navigation tree structure
5. **💾 Generates metadata.json**: Creates a comprehensive metadata file in `site-lib/`

## Output

The script generates a `metadata.json` file in the `site-lib/` directory containing:

- **Site Information**: Name, vault name, timestamps, theme info
- **File Inventory**: Complete list of all files and their metadata
- **Webpage Data**: Extracted HTML metadata, headers, links
- **Navigation Tree**: File tree structure for navigation
- **Feature Configuration**: Detected enabled features
- **Path Mappings**: Source to target path relationships

## Sample Output

```
🔍 Scanning exported website at: /path/to/exported/site
📂 Loaded existing metadata: 45234 bytes
📄 Analyzing HTML files for webpage metadata...
🔍 Detecting enabled features...
💾 Written metadata.json: 52341 bytes
📁 Output: /path/to/exported/site/site-lib/metadata.json

✅ Generated metadata.json with:
   - 145 webpages
   - 67 attachments  
   - 198 files in tree
   - 212 total files

✅ Metadata generation completed successfully!
```

## Use Cases

### Crash Recovery
If your export was interrupted and metadata.json is corrupted or missing:
```bash
node scripts/generate-metadata.js ./my-export
```

### Website Analysis
To analyze the structure of an existing exported website:
```bash
node scripts/generate-metadata.js ./website --verbose
```

### Manual Site Creation
If you've manually created a website structure and need proper metadata:
```bash
# Create the structure, then generate metadata
node scripts/generate-metadata.js ./manual-site
```

## Limitations

- **Source Path Recovery**: Cannot determine original Obsidian source paths
- **Tag Extraction**: Cannot extract Obsidian tags from HTML (not stored in HTML)
- **Alias Detection**: Cannot detect Obsidian aliases from exported HTML
- **Link Resolution**: May not perfectly resolve all internal link relationships

## Error Handling

The script gracefully handles:
- Missing or corrupted existing metadata
- Unreadable HTML files
- Permission errors
- Invalid directory structures

Use `--verbose` flag to see detailed error information.

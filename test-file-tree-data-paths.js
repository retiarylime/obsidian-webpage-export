// test-file-tree-data-paths.js
const fs = require('fs');
const path = require('path');

// Path to your file-tree-content.html
const fileTreePath = path.resolve('/home/rl/Desktop/test/site-lib/html/file-tree-content.html');

fs.readFile(fileTreePath, 'utf8', (err, data) => {
  if (err) {
    console.error('Error reading file:', err);
    process.exit(1);
  }

  // Regex to match all data-path="...":
  const regex = /data-path="([^"]+)"/g;
  const matches = [];
  let match;
  while ((match = regex.exec(data)) !== null) {
    matches.push(match[1]);
  }

  // Print results
  console.log(`Found ${matches.length} data-path entries:`);
  matches.forEach((entry, idx) => {
    console.log(`${idx + 1}: ${entry}`);
  });
});

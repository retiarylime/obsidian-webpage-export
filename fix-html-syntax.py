#!/usr/bin/env python3
"""
HTML Syntax Fixer for file-tree-content-content.html
Fixes double-encoding and formatting issues
"""
import re
import html

def fix_html_file(input_file, output_file=None):
    """Fix HTML syntax issues in the file-tree content"""
    
    if output_file is None:
        output_file = input_file + '.fixed'
    
    print(f"Reading {input_file}...")
    with open(input_file, 'r', encoding='utf-8') as f:
        content = f.read()
    
    print(f"Original file size: {len(content)} characters")
    
    # Fix 1: Decode excessive HTML entity encoding
    print("Fixing HTML entity over-encoding...")
    
    # Fix multiple levels of &amp; encoding
    # &amp;amp;amp;amp;amp;amp; -> &amp;amp;amp;amp; -> &amp;amp; -> &
    while '&amp;amp;' in content:
        old_content = content
        content = content.replace('&amp;amp;', '&amp;')
        if content == old_content:  # Prevent infinite loop
            break
    
    # Final cleanup: &amp; -> &
    content = content.replace('&amp;', '&')
    
    # Fix 2: Add proper line breaks for readability
    print("Adding proper line breaks...")
    
    # Add line breaks after closing tags
    content = re.sub(r'></div>', r'>\n</div>', content)
    content = re.sub(r'></a>', r'>\n</a>', content)
    content = re.sub(r'><div', r'>\n<div', content)
    content = re.sub(r'><a ', r'>\n<a ', content)
    content = re.sub(r'><svg', r'>\n<svg', content)
    content = re.sub(r'></svg>', r'>\n</svg>', content)
    content = re.sub(r'><button', r'>\n<button', content)
    content = re.sub(r'></button>', r'>\n</button>', content)
    
    # Fix 3: Validate and fix basic HTML structure
    print("Validating HTML structure...")
    
    # Check for unclosed tags (basic validation)
    div_open = content.count('<div')
    div_close = content.count('</div>')
    a_open = content.count('<a ')
    a_close = content.count('</a>')
    svg_open = content.count('<svg')
    svg_close = content.count('</svg>')
    button_open = content.count('<button')
    button_close = content.count('</button>')
    
    print(f"Tag validation:")
    print(f"  <div>: {div_open} open, {div_close} close - {'✓' if div_open == div_close else '✗'}")
    print(f"  <a>: {a_open} open, {a_close} close - {'✓' if a_open == a_close else '✗'}")
    print(f"  <svg>: {svg_open} open, {svg_close} close - {'✓' if svg_open == svg_close else '✗'}")
    print(f"  <button>: {button_open} open, {button_close} close - {'✓' if button_open == button_close else '✗'}")
    
    # Fix 4: Clean up any remaining encoding issues
    print("Final cleanup...")
    
    # Remove any remaining multiple spaces
    content = re.sub(r'  +', ' ', content)
    
    # Ensure proper indentation (basic)
    lines = content.split('\n')
    indented_lines = []
    indent_level = 0
    
    for line in lines:
        line = line.strip()
        if not line:
            continue
            
        # Decrease indent for closing tags
        if line.startswith('</'):
            indent_level = max(0, indent_level - 1)
        
        # Add indentation
        indented_lines.append('  ' * indent_level + line)
        
        # Increase indent for opening tags (but not self-closing)
        if line.startswith('<') and not line.startswith('</') and not line.endswith('/>') and not any(tag in line for tag in ['<path', '<svg', '<input', '<img', '<br', '<hr']):
            indent_level += 1
    
    content = '\n'.join(indented_lines)
    
    print(f"Fixed file size: {len(content)} characters")
    print(f"Writing to {output_file}...")
    
    with open(output_file, 'w', encoding='utf-8') as f:
        f.write(content)
    
    print(f"✅ HTML syntax fixes completed!")
    print(f"Original file: {input_file}")
    print(f"Fixed file: {output_file}")
    
    return output_file

if __name__ == "__main__":
    import sys
    
    input_file = "/home/rl/Desktop/test/site-lib/html/file-tree-content-content.html"
    
    if len(sys.argv) > 1:
        input_file = sys.argv[1]
    
    fix_html_file(input_file)

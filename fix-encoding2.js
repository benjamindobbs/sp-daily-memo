// fix-encoding2.js — fixes remaining garbled chars using Unicode escapes
const fs = require('fs');
const path = require('path');
const viewsDir = path.join(__dirname, 'views');

// Build patterns using Unicode escapes to avoid any source encoding ambiguity
// ✓ (U+2713) = E2 9C 93 → garbled: â(U+00E2) + œ(U+0153) + "(U+201C left-quote)
const CHECK = 'âœ“';  // âœ"
// — (U+2014 em dash) = E2 80 94 → garbled: â(U+00E2) + €(U+20AC) + "(U+201D right-quote)
const EMDASH = 'â€”';  // â€"
// … (U+2026 ellipsis) = E2 80 A6 → garbled: â(U+00E2) + €(U+20AC) + ¦(U+00A6)
const ELLIPSIS = 'â€¦';  // â€¦
// ' (U+2019 right-single) = E2 80 99 → garbled: â(U+00E2) + €(U+20AC) + ™(U+2122)
const RSQUOTE = 'â€™';  // â€™
// ∕ minus (U+2212) = E2 88 92 → garbled: â(U+00E2) + ˆ(U+02C6) + '(U+2019)
const MINUS = 'âˆ’';   // âˆ'

const replacements = [
  [CHECK,    '&#10003;'],
  [EMDASH,   '—'],
  [ELLIPSIS, '…'],
  [RSQUOTE,  '’'],
  [MINUS,    '−'],
];

const files = fs.readdirSync(viewsDir).filter(f => f.endsWith('.ejs'));
let totalFixed = 0;

for (const file of files) {
  const filePath = path.join(viewsDir, file);
  let content = fs.readFileSync(filePath, 'utf8');
  const original = content;
  for (const [from, to] of replacements) {
    content = content.split(from).join(to);
  }
  if (content !== original) {
    fs.writeFileSync(filePath, content, 'utf8');
    console.log('Fixed: ' + file);
    totalFixed++;
  }
}
console.log('Done. Fixed ' + totalFixed + ' file(s).');

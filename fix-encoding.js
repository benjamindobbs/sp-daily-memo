// fix-encoding.js — fixes double-encoded UTF-8 chars in all EJS templates
const fs = require('fs');
const path = require('path');
const viewsDir = path.join(__dirname, 'views');

// Simple string replacements (no hidden control chars)
// Each entry: [garbledString, replacement]
const simple = [
  // em dash â€" (C3 A2 E2 80 9C E2 80 94 — actually: â€" = U+00E2 U+20AC U+201D... wait)
  // â€" = E2 80 94 misread as Latin-1: â=E2, €=80 (Win-1252), "=94 (Win-1252 right-quote)
  ['â€”', '—'],   // â€" → — (em dash)
  ['â€¦', '…'],   // â€¦ → … (ellipsis)
  ['â€™', '’'],   // â€™ → ' (right single quote)
  ['Â·', '·'],         // Â· → · (middle dot)
  ['Ã—', '×'],         // Ã— → × (multiplication sign)
  // Calendar 📅 = F0 9F 93 85: ð=F0, Ÿ=9F, "=93(Win-1252 left-quote), …=85(Win-1252 ellipsis)
  ['ðŸ“…', '&#128197;'],  // ðŸ"… → 📅
  // Arrows 🔄 = F0 9F 94 84: ð=F0, Ÿ=9F, "=94(right-quote), „=84(Win-1252 low-9-quote)
  ['ðŸ”„', '&#128260;'],  // ðŸ"„ → 🔄
  // Clipboard 📋 = F0 9F 93 8B: ð=F0, Ÿ=9F, "=93(left-quote), ‹=8B(Win-1252 single-left-angle)
  ['ðŸ“‹', '&#128203;'],  // ðŸ"‹ → 📋
  // Pointing hand 👈 = F0 9F 91 88: ð=F0, Ÿ=9F, '=91(Win-1252 left-single-quote), ˆ=88(Win-1252 modifier)
  ['ðŸ‘ˆ', '&#128072;'],  // ðŸ'ˆ → 👈
  // Floppy 💾 = F0 9F 92 BE: ð=F0, Ÿ=9F, '=92(right-single-quote), ¾=BE
  ['ðŸ’¾', '&#128190;'],  // ðŸ'¾ → 💾
  // Tennis 🎾 = F0 9F 8E BE: ð=F0, Ÿ=9F, Ž=8E(Win-1252), ¾=BE
  ['ðŸŽ¾', '&#127934;'],  // ðŸŽ¾ → 🎾
  // Bus 🚌 = F0 9F 9A 8C: ð=F0, Ÿ=9F, š=9A(Win-1252), Œ=8C(Win-1252)
  ['ðŸšŒ', '&#128652;'],  // ðŸšŒ → 🚌
  // Person 👤 = F0 9F 91 A4: ð=F0, Ÿ=9F, '=91, ¤=A4
  ['ðŸ‘¤', '&#128100;'],  // ðŸ'¤ → 👤
  // Party 🎉 = F0 9F 8E 89: ð=F0, Ÿ=9F, Ž=8E, ‰=89(Win-1252 per mille)
  ['ðŸŽ‰', '&#127881;'],  // ðŸŽ‰ → 🎉
  // Rocket 🚀 = F0 9F 9A 80: ð=F0, Ÿ=9F, š=9A, €=80(Win-1252 euro)
  ['ðŸš€', '&#128640;'],  // ðŸš€ → 🚀
  // Gear ⚙ = E2 9A 99 (without variation selector): â=E2, š=9A(Win-1252), ™=99(Win-1252 trademark)
  ['âš™', '&#9881;'],          // âš™ → ⚙
  // Checkmark ✅ = E2 9C 85: â=E2, œ=9C(Win-1252), …=85(ellipsis)
  ['âœ…', '&#9989;'],          // âœ… → ✅
  // Minus sign ∓ = E2 88 93 or minus ∓: actually âˆ' = E2 88 92 = ∓ or âˆ' = ∑?
  // Actually "−" (minus) = U+2212 = E2 88 92: â=E2, ˆ=88(Win-1252 modifier-letter), '=92(right-quote)
  // But in the file it shows as âˆ' which is â + ˆ + '. Let me check: ˆ=U+02C6=C5 86 in UTF-8? No.
  // Windows-1252: 0x88 = ˆ (U+02C6 modifier circumflex). 0x92 = ' (U+2019 right-single-quote).
  // So âˆ' = U+00E2 + U+02C6 + U+2019 → replacement for − (U+2212)
  ['âˆ’', '−'],           // âˆ' → − (minus sign, for "Fewer Filters")
  // Box drawing ─ = E2 94 80: â=E2, "=94(right-double-quote), €=80(euro sign)
  ['â”€', '─'],           // â"€ → ─ (box drawing, in comments only)
];

// Regex replacements for chars with hidden control chars (U+008D, U+008F, U+0090)
// These appear as garbled visible prefix + invisible control char
const regexReplacements = [
  // Clock ⏰ = E2 8F B0: â=E2, [U+008F hidden]=8F, °=B0
  [/â°/g, '&#9200;'],    // â[hidden]° → ⏰

  // House 🏠 = F0 9F 8F A0: ð=F0, Ÿ=9F, [U+008F hidden]=8F,  =A0 (non-breaking space)
  [/ðŸ /g, '&#127968;'],  // ðŸ[hidden]  → 🏠

  // Runner 🏃 = F0 9F 8F 83: ð=F0, Ÿ=9F, [U+008F hidden]=8F, ƒ=83(Win-1252)
  [/ðŸƒ/g, '&#127939;'],  // ðŸ[hidden]ƒ → 🏃

  // Bento 🍱 = F0 9F 8D B1: ð=F0, Ÿ=9F, [U+008D hidden]=8D, ±=B1
  [/ðŸ±/g, '&#127857;'],  // ðŸ[hidden]± → 🍱

  // Magnifying glass 🔍 = F0 9F 94 8D: ð=F0, Ÿ=9F, "=94(right-quote), [U+008D hidden]=8D
  [/ðŸ”/g, '&#128269;'],  // ðŸ"[hidden] → 🔍

  // Location pin 📍 = F0 9F 93 8D: ð=F0, Ÿ=9F, "=93(left-quote), [U+008D hidden]=8D
  [/ðŸ“/g, '&#128205;'],  // ðŸ"[hidden] → 📍

  // Trash 🗑 = F0 9F 97 91: ð=F0, Ÿ=9F, —=97(Win-1252 em-dash), '=91(left-single-quote)
  // Then variation selector ️ = EF B8 8F: ï=EF, ¸=B8, [U+008F hidden]=8F
  [/ðŸ—‘ï¸/g, '&#128465;&#65039;'],  // ðŸ—'ï¸[hidden] → 🗑️

  // Star ⭐ = E2 AD 90: â=E2, ­=AD (soft hyphen), [U+0090 hidden]=90
  [/â­/g, '&#11088;'],   // â­[hidden] → ⭐

  // Variation selector ️ = EF B8 8F (alone, at end of emoji)
  // ï=EF, ¸=B8, [U+008F hidden]=8F
  [/ï¸/g, '&#65039;'],   // ï¸[hidden] → variation selector
];

const files = fs.readdirSync(viewsDir).filter(f => f.endsWith('.ejs'));
let totalFixed = 0;

for (const file of files) {
  const filePath = path.join(viewsDir, file);
  let content = fs.readFileSync(filePath, 'utf8');
  const original = content;

  for (const [from, to] of simple) {
    content = content.split(from).join(to);
  }

  for (const [pattern, to] of regexReplacements) {
    content = content.replace(pattern, to);
  }

  if (content !== original) {
    fs.writeFileSync(filePath, content, 'utf8');
    console.log('Fixed: ' + file);
    totalFixed++;
  }
}

console.log('\nDone. Fixed ' + totalFixed + ' file(s).');

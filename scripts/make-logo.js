'use strict';

// Generates the Black Swamp Totes app icon — the cattail brand mark (matching
// views/partials/cattail.ejs) in Lily Green on a Swamp Black square. Writes the
// SVG source and a 1024×1024 PNG used as the site favicon / apple-touch-icon and
// as the source for the operator PWA icons (scripts/generate-icons.js).
//
//   node scripts/make-logo.js
//
// Re-run scripts/generate-icons.js afterward to refresh the operator icons.

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const SWAMP = '#0a1a0a';
const LILY = '#22c55e';

// The three cattails + water ripple from cattail.ejs (viewBox 0 0 52 76),
// centered and scaled (×3.9) inside a 512 canvas with padding.
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 512 512">
  <rect width="512" height="512" fill="${SWAMP}"/>
  <g transform="translate(154,108) scale(3.9)">
    <rect x="4" y="14" width="9" height="24" rx="4.5" fill="${LILY}"/>
    <line x1="8.5" y1="38" x2="8.5" y2="63" stroke="${LILY}" stroke-width="2.5" stroke-linecap="round"/>
    <rect x="21" y="2" width="9" height="28" rx="4.5" fill="${LILY}"/>
    <line x1="25.5" y1="30" x2="25.5" y2="67" stroke="${LILY}" stroke-width="2.5" stroke-linecap="round"/>
    <line x1="25.5" y1="46" x2="40" y2="38" stroke="${LILY}" stroke-width="1.5" stroke-linecap="round" opacity=".65"/>
    <rect x="38" y="20" width="9" height="20" rx="4.5" fill="${LILY}"/>
    <line x1="42.5" y1="40" x2="42.5" y2="63" stroke="${LILY}" stroke-width="2.5" stroke-linecap="round"/>
    <path d="M0 66 C9 62 17 70 26 66 C35 62 43 70 52 66" fill="none" stroke="${LILY}" stroke-width="1.5" stroke-linecap="round" opacity=".65"/>
  </g>
</svg>`;

const imagesDir = path.join(__dirname, '..', 'public', 'images');
const svgPath = path.join(imagesDir, 'logo.svg');
const pngPath = path.join(imagesDir, 'logo.png');

fs.writeFileSync(svgPath, SVG);
sharp(Buffer.from(SVG))
  .png()
  .toFile(pngPath)
  .then((info) => {
    console.log(`  ✓ logo.svg`);
    console.log(`  ✓ logo.png (${info.width}×${info.height})`);
  })
  .catch((err) => {
    console.error('Logo generation failed:', err);
    process.exit(1);
  });

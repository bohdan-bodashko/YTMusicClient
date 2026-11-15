/**
 * Lightweight zero-dependency static check script for YTMusicClient.
 * Validates JS syntax, HTML inline scripts, i18n parity, and image/build assets.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const errors = [];

function walkFiles(dir, extFilter) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkFiles(fullPath, extFilter));
    } else if (!extFilter || entry.name.endsWith(extFilter)) {
      results.push(fullPath);
    }
  }
  return results;
}

function checkJsSyntax(filePath) {
  const code = fs.readFileSync(filePath, 'utf8');
  const rel = path.relative(ROOT, filePath);
  try {
    new vm.Script(code, { filename: rel });
  } catch (err) {
    errors.push(`JS syntax error in ${rel}: ${err.message}`);
  }
}

function checkHtmlScripts(filePath) {
  const html = fs.readFileSync(filePath, 'utf8');
  const rel = path.relative(ROOT, filePath);
  const scriptRegex = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  let index = 0;
  while ((match = scriptRegex.exec(html)) !== null) {
    index += 1;
    const body = match[1].trim();
    if (!body) continue;
    try {
      new vm.Script(body, { filename: `${rel}#script-${index}` });
    } catch (err) {
      errors.push(`Inline script syntax error in ${rel} (#${index}): ${err.message}`);
    }
  }
}

function flattenKeys(obj, prefix = '', out = new Map()) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    out.set(prefix, obj);
    return out;
  }
  for (const [k, v] of Object.entries(obj)) {
    const next = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      flattenKeys(v, next, out);
    } else {
      out.set(next, v);
    }
  }
  return out;
}

function checkI18nParity() {
  const i18nPath = path.join(ROOT, 'src', 'shared', 'i18n.js');
  if (!fs.existsSync(i18nPath)) {
    errors.push('Missing src/shared/i18n.js');
    return;
  }
  let mod;
  try {
    mod = require(i18nPath);
  } catch (err) {
    errors.push(`Failed to load src/shared/i18n.js: ${err.message}`);
    return;
  }
  const translations = mod.TRANSLATIONS || mod.translations;
  if (!translations || !translations.en || !translations.uk) {
    errors.push('i18n.js must export TRANSLATIONS.en and TRANSLATIONS.uk');
    return;
  }
  const enMap = flattenKeys(translations.en);
  const ukMap = flattenKeys(translations.uk);

  for (const key of enMap.keys()) {
    if (!ukMap.has(key)) {
      errors.push(`i18n missing Ukrainian key: ${key}`);
    }
  }
  for (const key of ukMap.keys()) {
    if (!enMap.has(key)) {
      errors.push(`i18n missing English key: ${key}`);
    }
  }
  for (const [key, enVal] of enMap.entries()) {
    if (!ukMap.has(key)) continue;
    const ukVal = ukMap.get(key);
    if (typeof enVal === 'string' && typeof ukVal === 'string') {
      const enVars = [...enVal.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
      const ukVars = [...ukVal.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
      if (enVars !== ukVars) {
        errors.push(`i18n placeholder mismatch for "${key}": en=[${enVars}] vs uk=[${ukVars}]`);
      }
    }
  }
}

function checkPng(relPath, expectedW, expectedH) {
  const full = path.join(ROOT, relPath);
  if (!fs.existsSync(full)) {
    errors.push(`Missing asset: ${relPath}`);
    return;
  }
  const buf = fs.readFileSync(full);
  const sig = buf.subarray(0, 8).toString('hex');
  if (sig !== '89504e470d0a1a0a' || buf.length < 26) {
    errors.push(`Invalid PNG header: ${relPath}`);
    return;
  }
  const w = buf.readUInt32BE(16);
  const h = buf.readUInt32BE(20);
  if (w !== expectedW || h !== expectedH) {
    errors.push(`Unexpected PNG dimensions for ${relPath}: ${w}x${h} (expected ${expectedW}x${expectedH})`);
  }
}

function checkIco(relPath, minEntries) {
  const full = path.join(ROOT, relPath);
  if (!fs.existsSync(full)) {
    errors.push(`Missing asset: ${relPath}`);
    return;
  }
  const buf = fs.readFileSync(full);
  if (buf.length < 22 || buf.readUInt16LE(0) !== 0 || buf.readUInt16LE(2) !== 1) {
    errors.push(`Invalid ICO header: ${relPath}`);
    return;
  }
  const count = buf.readUInt16LE(4);
  if (count < minEntries) {
    errors.push(`ICO ${relPath} has ${count} entries (expected >= ${minEntries})`);
  }
}

function checkBmp(relPath, expectedW, expectedH) {
  const full = path.join(ROOT, relPath);
  if (!fs.existsSync(full)) {
    errors.push(`Missing build BMP: ${relPath}`);
    return;
  }
  const buf = fs.readFileSync(full);
  if (buf.length < 54 || buf.subarray(0, 2).toString('ascii') !== 'BM') {
    errors.push(`Invalid BMP header: ${relPath}`);
    return;
  }
  const w = buf.readInt32LE(18);
  const h = buf.readInt32LE(22);
  const bpp = buf.readUInt16LE(28);
  const comp = buf.readUInt32LE(30);
  if (w !== expectedW || h !== expectedH || bpp !== 24 || comp !== 0) {
    errors.push(
      `Invalid BMP format for ${relPath}: ${w}x${h} ${bpp}bpp comp=${comp} (expected ${expectedW}x${expectedH} 24bpp comp=0)`
    );
  }
}

function checkPackageAndAssets() {
  const pkgPath = path.join(ROOT, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  if (!/^\d+\.\d+\.\d+$/.test(pkg.version || '')) {
    errors.push(`Invalid package.json version: ${pkg.version}`);
  }
  if (!pkg.build || !pkg.build.appId) {
    errors.push('Missing package.json build.appId');
  }

  checkPng('assets/icon.png', 256, 256);
  checkIco('assets/icon.ico', 6);
  checkPng('assets/tray-icon.png', 32, 32);
  checkPng('assets/tray-icon@2x.png', 64, 64);
  for (const kind of ['play', 'pause', 'next', 'prev']) {
    checkPng(`assets/thumb-${kind}.png`, 32, 32);
  }
  checkBmp('build/installerHeader.bmp', 150, 57);
  checkBmp('build/installerSidebar.bmp', 164, 314);
  checkBmp('build/portableSplash.bmp', 460, 240);
}

const jsFiles = [
  ...walkFiles(path.join(ROOT, 'src'), '.js'),
  ...walkFiles(path.join(ROOT, 'scripts'), '.js'),
];
for (const file of jsFiles) {
  checkJsSyntax(file);
}

const htmlFiles = walkFiles(path.join(ROOT, 'src', 'renderer'), '.html');
for (const file of htmlFiles) {
  checkHtmlScripts(file);
}

checkI18nParity();
checkPackageAndAssets();

if (errors.length > 0) {
  console.error(`Check failed with ${errors.length} error(s):`);
  for (const err of errors) {
    console.error(`  - ${err}`);
  }
  process.exit(1);
}

console.log(
  `All static checks passed (${jsFiles.length} JS files, ${htmlFiles.length} HTML files, i18n parity, and image/build assets).`
);

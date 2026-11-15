/**
 * Lightweight zero-dependency static check script for YTMusicClient.
 * Validates JS syntax, HTML inline scripts, i18n parity, and image/build assets.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const SRC_DIR = path.join(ROOT, 'src');
const PRELOAD_DIR = path.join(SRC_DIR, 'preload');
const PRELOAD_MAIN_WORLD_SCRIPTS = new Set(['auth-patcher.js', 'page-patcher.js']);
const FORBIDDEN_SRC_PATTERNS = [
  { label: 'sandbox: false', regex: /\bsandbox\s*:\s*false\b/ },
  { label: 'nodeIntegration: true', regex: /\bnodeIntegration\s*:\s*true\b/ },
  { label: 'webSecurity: false', regex: /\bwebSecurity\s*:\s*false\b/ },
  { label: 'allowRunningInsecureContent: true', regex: /\ballowRunningInsecureContent\s*:\s*true\b/ },
  { label: 'rejectUnauthorized: false', regex: /\brejectUnauthorized\s*:\s*false\b/ },
  { label: 'innerHTML', regex: /\binnerHTML\b/ },
  { label: 'outerHTML', regex: /\bouterHTML\b/ },
  { label: 'insertAdjacentHTML', regex: /\binsertAdjacentHTML\b/ },
  { label: 'document.write', regex: /\bdocument\s*\.\s*write\b/ },
  { label: 'eval(', regex: /\beval\s*\(/ },
  { label: 'new Function(', regex: /\bnew\s+Function\s*\(/ },
];
const REGEX_PREFIX_KEYWORDS = new Set([
  'return',
  'case',
  'throw',
  'else',
  'do',
  'typeof',
  'void',
  'delete',
  'in',
  'instanceof',
  'new',
  'yield',
  'await',
  'of',
]);
const errors = [];

function stripJsComments(code) {
  let out = '';
  let i = 0;
  let canStartRegex = true;
  const templateBraceStack = [];
  const len = code.length;

  const scanString = (quote) => {
    out += code[i++];
    while (i < len) {
      const ch = code[i++];
      out += ch;
      if (ch === '\\' && i < len) {
        out += code[i++];
      } else if (ch === quote) {
        break;
      }
    }
    canStartRegex = false;
  };

  const scanTemplateChunk = () => {
    while (i < len) {
      const ch = code[i++];
      out += ch;
      if (ch === '\\' && i < len) {
        out += code[i++];
      } else if (ch === '$' && code[i] === '{') {
        out += code[i++];
        templateBraceStack.push(1);
        canStartRegex = true;
        return;
      } else if (ch === '`') {
        canStartRegex = false;
        return;
      }
    }
  };

  while (i < len) {
    const ch = code[i];
    const next = code[i + 1];

    if (ch === '/' && next === '/') {
      i += 2;
      while (i < len && code[i] !== '\n') i += 1;
      continue;
    }

    if (ch === '/' && next === '*') {
      i += 2;
      out += ' ';
      while (i < len && !(code[i] === '*' && code[i + 1] === '/')) {
        if (code[i] === '\n') out += '\n';
        i += 1;
      }
      if (i < len) i += 2;
      continue;
    }

    if (ch === '\'' || ch === '"') {
      scanString(ch);
      continue;
    }

    if (ch === '`') {
      out += code[i++];
      scanTemplateChunk();
      continue;
    }

    if (ch === '/' && canStartRegex) {
      out += code[i++];
      let inClass = false;
      while (i < len) {
        const rc = code[i++];
        out += rc;
        if (rc === '\\' && i < len) {
          out += code[i++];
        } else if (rc === '[' && !inClass) {
          inClass = true;
        } else if (rc === ']' && inClass) {
          inClass = false;
        } else if (rc === '/' && !inClass) {
          break;
        } else if (rc === '\n') {
          break;
        }
      }
      canStartRegex = false;
      continue;
    }

    if (/[ \t\r\n]/.test(ch)) {
      out += code[i++];
      continue;
    }

    if (ch === '{' && templateBraceStack.length > 0) {
      templateBraceStack[templateBraceStack.length - 1] += 1;
      out += code[i++];
      canStartRegex = true;
      continue;
    }

    if (ch === '}' && templateBraceStack.length > 0) {
      templateBraceStack[templateBraceStack.length - 1] -= 1;
      out += code[i++];
      if (templateBraceStack[templateBraceStack.length - 1] === 0) {
        templateBraceStack.pop();
        scanTemplateChunk();
      } else {
        canStartRegex = false;
      }
      continue;
    }

    if (/[A-Za-z_$]/.test(ch)) {
      let word = '';
      while (i < len && /[A-Za-z0-9_$]/.test(code[i])) {
        word += code[i++];
      }
      out += word;
      canStartRegex = REGEX_PREFIX_KEYWORDS.has(word);
      continue;
    }

    if (/[0-9]/.test(ch)) {
      while (i < len && /[0-9A-Za-z_.]/.test(code[i])) {
        out += code[i++];
      }
      canStartRegex = false;
      continue;
    }

    if ((ch === '+' && next === '+') || (ch === '-' && next === '-')) {
      out += ch + next;
      i += 2;
      canStartRegex = false;
      continue;
    }

    out += code[i++];
    canStartRegex = ch !== ')' && ch !== ']';
  }

  return out;
}

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

  const isUnderSrc = filePath === SRC_DIR || filePath.startsWith(`${SRC_DIR}${path.sep}`);
  if (!isUnderSrc) return;

  const stripped = stripJsComments(code);
  for (const { label, regex } of FORBIDDEN_SRC_PATTERNS) {
    if (regex.test(stripped)) {
      errors.push(`Forbidden security pattern "${label}" in ${rel}`);
    }
  }

  const isUnderPreload = filePath.startsWith(`${PRELOAD_DIR}${path.sep}`);
  if (isUnderPreload && !PRELOAD_MAIN_WORLD_SCRIPTS.has(path.basename(filePath))) {
    if (/\brequire\s*\(\s*['"`](?:node:)?(?:fs|path)(?:[\\/][^'"`]*)?['"`]\s*\)/.test(stripped)) {
      errors.push(`Sandboxed preload must not require fs/path in ${rel}`);
    }
    if (/\brequire\s*\(\s*['"`]\.\.?[\\/]/.test(stripped)) {
      errors.push(`Sandboxed preload must not use relative require() in ${rel}`);
    }
  }
}

function extractHtmlAttributes(tag) {
  const attrs = Object.create(null);
  const attrRegex = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
  let match;
  while ((match = attrRegex.exec(tag)) !== null) {
    attrs[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? '';
  }
  return attrs;
}

function checkHtmlCsp(html, rel) {
  const withoutComments = html.replace(/<!--[\s\S]*?-->/g, '');
  const metaRegex = /<meta\b[^>]*>/gi;
  let cspContent = null;
  let match;
  while ((match = metaRegex.exec(withoutComments)) !== null) {
    const attrs = extractHtmlAttributes(match[0]);
    if (String(attrs['http-equiv'] || '').toLowerCase() === 'content-security-policy') {
      cspContent = attrs.content ?? '';
      break;
    }
  }
  if (cspContent === null || !cspContent.trim()) {
    errors.push(`Missing Content-Security-Policy <meta> tag in ${rel}`);
    return;
  }
  if (/'unsafe-inline'|'unsafe-eval'|https?:/i.test(cspContent)) {
    errors.push(`Insecure CSP directive ('unsafe-inline', 'unsafe-eval', or http(s):) in ${rel}`);
  }
}

function checkHtmlScripts(filePath) {
  const html = fs.readFileSync(filePath, 'utf8');
  const rel = path.relative(ROOT, filePath);
  checkHtmlCsp(html, rel);
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

  const fuses = pkg.build && pkg.build.electronFuses;
  const expectedFuses = {
    runAsNode: false,
    enableCookieEncryption: true,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false,
    enableEmbeddedAsarIntegrityValidation: true,
    onlyLoadAppFromAsar: true,
    grantFileProtocolExtraPrivileges: false,
  };
  if (!fuses || typeof fuses !== 'object') {
    errors.push('Missing package.json build.electronFuses configuration');
  } else {
    for (const [key, expected] of Object.entries(expectedFuses)) {
      if (fuses[key] !== expected) {
        errors.push(`package.json build.electronFuses.${key} must be ${expected}`);
      }
    }
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

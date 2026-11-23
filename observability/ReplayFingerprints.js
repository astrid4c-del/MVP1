'use strict';

/**
 * REPLAY FINGERPRINTS -- shared, single-source SCHEMA/BUILD identity
 * computation, moved to `src/` (from `tests/support/deterministicReplay.js`,
 * which now imports from here) so DETERMINISTIC REPLAY CAPTURE (production,
 * opt-in, `LLMService.js`) and the C007 test-only replay harness speak the
 * EXACT same identity language -- never two independent implementations
 * that could quietly diverge. Pure, no I/O side effects other than reading
 * this package's own `src/` tree for the build fingerprint.
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const PACKAGE_ROOT = path.join(__dirname, '..', '..');

function sha256Hex(str) {
  return crypto.createHash('sha256').update(str).digest('hex');
}

/**
 * Canonicalizes a JSON-shaped object for fingerprinting: object keys sorted
 * lexicographically at every level, arrays keep their own semantic order
 * (never sorted -- order is meaningful there).
 */
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canonicalize(value[key]);
    return out;
  }
  return value;
}

/**
 * SCHEMA VERSION identity (not mere shape compatibility): a real,
 * deterministic fingerprint of a live responseSchema/parsedOutput object.
 * Returns null for a falsy/non-object input (nothing to fingerprint) --
 * callers treat null-vs-null as compatible.
 */
function computeSchemaFingerprint(shapeObject) {
  if (!shapeObject || typeof shapeObject !== 'object') return null;
  return sha256Hex(JSON.stringify(canonicalize(shapeObject)));
}

// Process-lifetime cache: hashing the whole src tree per call would be
// wasteful across many calls in one process -- the source tree cannot
// change mid-process, so caching is safe and never masks a real build
// change (a genuinely different build is a different process/run).
let _engineBuildFingerprintCache = null;

/**
 * BUILD VERSION identity (not a callProfile proxy, not git HEAD -- the
 * worktree can be dirty and HEAD would not identify the code actually
 * executed): SHA-256 over every file under packages/cognitive-engine/src,
 * ordered by relative path, hashing "relativePath\0<bytes>" for each --
 * deterministic regardless of filesystem mtimes, independent of git
 * cleanliness.
 */
function computeEngineBuildFingerprint({ srcRoot = path.join(PACKAGE_ROOT, 'src'), useCache = true } = {}) {
  if (useCache && _engineBuildFingerprintCache) return _engineBuildFingerprintCache;
  const EXCLUDED_DIR_NAMES = new Set(['node_modules', '.git', 'tests', 'fixtures']);
  const files = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isDirectory()) {
        if (EXCLUDED_DIR_NAMES.has(entry.name)) continue;
        walk(path.join(dir, entry.name));
      } else if (entry.isFile()) {
        if (entry.name.endsWith('.db') || entry.name.endsWith('.db-wal') || entry.name.endsWith('.db-shm')) continue;
        files.push(path.join(dir, entry.name));
      }
    }
  })(srcRoot);
  files.sort();
  const hash = crypto.createHash('sha256');
  for (const filePath of files) {
    const relPath = path.relative(srcRoot, filePath).split(path.sep).join('/');
    hash.update(relPath);
    hash.update('\0');
    hash.update(fs.readFileSync(filePath));
    hash.update('\0');
  }
  const fingerprint = hash.digest('hex');
  if (useCache) _engineBuildFingerprintCache = fingerprint;
  return fingerprint;
}

module.exports = { sha256Hex, canonicalize, computeSchemaFingerprint, computeEngineBuildFingerprint };

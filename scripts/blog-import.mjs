#!/usr/bin/env node
/**
 * blog-import.mjs — full two-way sync between a synced document folder and the blog.
 *
 * A local pipeline. The BLOG_INBOX folder (Google-Drive-synced) is the SOURCE OF
 * TRUTH; the site mirrors it:
 *   - a new document        → a new blog post
 *   - a changed document    → the post is updated (+ updatedDate)
 *   - a removed document    → the post is removed from the site (after backup)
 *
 * Documents are converted to Markdown with Microsoft's `markitdown`. A Markdown
 * source that already carries YAML frontmatter is preserved as-is (lets us round-
 * trip the existing posts losslessly and lets Keren edit frontmatter directly).
 * Article TEXT is never edited — we only add frontmatter and drop a duplicated
 * leading title heading.
 *
 * Category comes from the sub-folder the file sits in (must match the enum in
 * src/content.config.ts). Every generated post is also mirrored to BLOG_BACKUP —
 * a synced folder that NEVER deletes, so it keeps every article ever published,
 * including ones later removed.
 *
 * Modes:
 *   node scripts/blog-import.mjs            one-shot: import/update, then reconcile deletions
 *   node scripts/blog-import.mjs --watch    stay running, sync on add/change/unlink
 *   node scripts/blog-import.mjs --export    one-time: mirror existing posts → inbox + backup
 *   BLOG_NO_GIT=1 …                         convert only, do NOT commit/push (testing)
 *
 * Safety: deletion sync refuses to run when the inbox is missing/empty or holds
 * far fewer docs than we track (Drive mid-sync), and never deletes more than
 * BLOG_MAX_DELETE posts in one pass — so an unsynced folder can't wipe the blog.
 *
 * Requires: `markitdown` on PATH (uv tool install "markitdown[all]") and, for
 * --watch, the `chokidar` dev dependency.
 */
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
// BLOG_OUT / BLOG_LEDGER let tests point these at a sandbox; production uses the defaults.
const BLOG_DIR = process.env.BLOG_OUT || path.join(REPO_ROOT, 'src', 'content', 'blog');
const LEDGER_PATH = process.env.BLOG_LEDGER || path.join(__dirname, '.blog-imported.json');

const INBOX = process.env.BLOG_INBOX || 'D:\\AI Projects\\Crypto Women\\Blog - Crypto Women';
// Synced backup folder (sibling of the inbox) — keeps every article, forever.
const BACKUP_DIR = process.env.BLOG_BACKUP || 'D:\\AI Projects\\Crypto Women\\Blog Backup - Crypto Women';
const NO_GIT = process.env.BLOG_NO_GIT === '1';
const WATCH = process.argv.includes('--watch');
const EXPORT = process.argv.includes('--export');
// Never auto-delete more than this many posts in one reconciliation pass.
const MAX_DELETE_PER_RUN = Number(process.env.BLOG_MAX_DELETE) || 5;
// Give Drive a moment before treating an unlink as a real deletion.
const UNLINK_CONFIRM_MS = 3000;

// A CSV in the inbox root lets the user override any post's publish date without
// touching the documents. The system keeps it auto-populated (one row per post);
// the user edits ONLY the override column (open it in Google Sheets / Excel).
// Empty override = keep the original creation date. pubDate never changes on its
// own — this is the single, exceptional, manual override channel.
const DATE_CSV = process.env.BLOG_DATE_CSV || path.join(INBOX, 'blog-dates.csv');
const CSV_COLS = {
  slug: 'מזהה',
  title: 'כותרת',
  category: 'קטגוריה',
  original: 'תאריך_מקורי',
  override: 'דריסת_תאריך',
};

// Must match the enum in src/content.config.ts exactly.
const CATEGORIES = new Set(['מיינדסט', 'השקעות', 'ביטקוין', "בלוקצ'יין", 'מדריך', 'כללי']);
const DEFAULT_CATEGORY = 'כללי';

// Extensions markitdown handles well and we want to publish.
const SUPPORTED = new Set([
  '.docx', '.doc', '.pdf', '.txt', '.md', '.markdown',
  '.html', '.htm', '.pptx', '.rtf', '.odt', '.xlsx',
]);
// Google-native Drive files are JSON pointer stubs, not real content.
const GOOGLE_STUBS = new Set(['.gdoc', '.gsheet', '.gslides']);

// Mirror all output to a log file too — when the watcher runs as a headless
// scheduled task there is no console, so the log is the only way to see errors.
const LOG_FILE = path.join(__dirname, 'watcher', 'watcher.log');
function fileLog(line) {
  try { fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${line}\n`); } catch { /* ignore */ }
}
const log = (...a) => { const s = a.join(' '); console.log(s); fileLog(s); };
const warn = (...a) => { const s = a.join(' '); console.warn('  ⚠', s); fileLog('WARN ' + s); };
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// ── helpers ────────────────────────────────────────────────────────────────

function slugify(name) {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // strip Latin diacritics
    .replace(/['"]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
}

function humanize(name) {
  return name.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function shortHash(str) {
  return createHash('sha256').update(str).digest('hex').slice(0, 6);
}
function sha256(str) {
  return createHash('sha256').update(str).digest('hex');
}

function isoDate(d) {
  const date = d instanceof Date ? d : new Date(d);
  return date.toISOString().slice(0, 10);
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

/** Pick the article title and body from converted Markdown (no frontmatter). */
function extractTitleAndBody(md, fallbackTitle) {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  let i = 0;
  while (i < lines.length && lines[i].trim() === '') i++;
  const first = lines[i]?.trim() ?? '';
  const headingMatch = first.match(/^#{1,3}\s+(.+?)\s*#*$/);
  if (headingMatch) {
    // A real heading — use it as the title and drop it from the body so the
    // article page (which already renders the title) isn't doubled.
    const body = lines.slice(i + 1).join('\n').trim();
    return { title: headingMatch[1].trim(), body };
  }
  // No heading: keep the body fully intact, take the title from the filename.
  return { title: fallbackTitle, body: md.replace(/\r\n/g, '\n').trim() };
}

/** Plain-text excerpt for the card / SEO description (additive, not a text edit). */
function makeExcerpt(md, max = 155) {
  const plain = md
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[#>*_`~|-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (plain.length <= max) return plain;
  return plain.slice(0, max).replace(/\s+\S*$/, '') + '…';
}

/** Parse YAML frontmatter from a Markdown file (only the simple fields we use). */
function parseFrontmatter(raw) {
  const text = raw.replace(/\r\n/g, '\n');
  if (!text.startsWith('---\n')) return { data: {}, body: text.trim() };
  const end = text.indexOf('\n---', 4);
  if (end === -1) return { data: {}, body: text.trim() };
  const fm = text.slice(4, end);
  const body = text.slice(end + 4).replace(/^\n+/, '').trim();
  const data = {};
  for (const line of fm.split('\n')) {
    const m = line.match(/^([A-Za-z_][\w-]*):\s?(.*)$/);
    if (!m) continue;
    const key = m[1];
    const v = m[2].trim();
    if (v === '') { data[key] = ''; }
    else if (v.startsWith('[')) { try { data[key] = JSON.parse(v); } catch { data[key] = []; } }
    else if (v.startsWith('"')) { try { data[key] = JSON.parse(v); } catch { data[key] = v.replace(/^"|"$/g, ''); } }
    else if (v === 'true' || v === 'false') { data[key] = v === 'true'; }
    else { data[key] = v; }
  }
  if (data.pubDate) data.pubDate = new Date(data.pubDate);
  if (data.updatedDate) data.updatedDate = new Date(data.updatedDate);
  return { data, body };
}

/** Canonical, deterministic frontmatter — export and import produce identical bytes. */
function serializeFrontmatter(d) {
  const L = ['---'];
  L.push(`title: ${JSON.stringify(d.title || '')}`);
  L.push(`description: ${JSON.stringify(d.description || '')}`);
  L.push(`pubDate: ${isoDate(d.pubDate)}`);
  if (d.updatedDate) L.push(`updatedDate: ${isoDate(d.updatedDate)}`);
  if (d.heroImage) L.push(`heroImage: ${JSON.stringify(d.heroImage)}`);
  L.push(`category: ${JSON.stringify(CATEGORIES.has(d.category) ? d.category : DEFAULT_CATEGORY)}`);
  L.push(`tags: ${JSON.stringify(Array.isArray(d.tags) ? d.tags : [])}`);
  if (d.featured) L.push('featured: true');
  L.push(`draft: ${d.draft ? 'true' : 'false'}`);
  L.push('---');
  return L.join('\n');
}

function categoryFor(file) {
  const parent = path.basename(path.dirname(file));
  return CATEGORIES.has(parent) ? parent : DEFAULT_CATEGORY;
}

function creationDate(file) {
  const st = fs.statSync(file);
  const bt = st.birthtime;
  // Fall back to mtime if birthtime is missing/epoch (can happen on some FS).
  if (!bt || bt.getTime() <= 0) return st.mtime;
  return bt;
}

function convert(file) {
  // Write to a temp file with `-o` (markitdown writes UTF-8) and read it back
  // with Node, instead of capturing stdout — on Windows the console code page
  // mangles Hebrew in piped stdout into "?" characters.
  const out = path.join(os.tmpdir(), `mid-${randomUUID()}.md`);
  const env = { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' };
  const opts = { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, windowsHide: true, env };
  try {
    // Prefer the uv-managed tool (installed with the [all] extras). A bare
    // `markitdown` may point at an install missing those, so it's only a fallback.
    try {
      execFileSync('uv', ['tool', 'run', 'markitdown', file, '-o', out], opts);
    } catch {
      execFileSync('markitdown', [file, '-o', out], opts);
    }
    return fs.readFileSync(out, 'utf8');
  } catch (e) {
    throw new Error(`markitdown failed: ${(e.stderr || e.message || '').toString().slice(0, 300)}`);
  } finally {
    try { fs.unlinkSync(out); } catch { /* temp file may not exist on failure */ }
  }
}

function loadLedger() {
  try { return JSON.parse(fs.readFileSync(LEDGER_PATH, 'utf8')); }
  catch { return {}; }
}
function saveLedger(l) {
  fs.writeFileSync(LEDGER_PATH, JSON.stringify(l, null, 2) + '\n');
}

function uniqueSlug(base, wantedFile) {
  let slug = base || 'post';
  let candidate = path.join(BLOG_DIR, slug + '.md');
  let n = 2;
  while (fs.existsSync(candidate) && candidate !== wantedFile) {
    slug = `${base}-${n++}`;
    candidate = path.join(BLOG_DIR, slug + '.md');
  }
  return slug;
}

/** Write a copy of a post to the backup folder (which never deletes). */
function mirrorToBackup(slug, content) {
  try {
    ensureDir(BACKUP_DIR);
    fs.writeFileSync(path.join(BACKUP_DIR, slug + '.md'), content);
  } catch (e) {
    warn(`backup write failed for ${slug}: ${String(e.message).slice(0, 120)}`);
  }
}

// ── publish-date override CSV ────────────────────────────────────────────────

function isOverridesCsv(file) {
  return path.resolve(file) === path.resolve(DATE_CSV);
}

/** Accept YYYY-MM-DD or DD/MM/YYYY (Israeli style). @returns {Date|null} */
function parseUserDate(s) {
  const v = (s || '').trim();
  let m = v.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) { const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])); return Number.isNaN(d.getTime()) ? null : d; }
  m = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) { const d = new Date(Date.UTC(+m[3], +m[2] - 1, +m[1])); return Number.isNaN(d.getTime()) ? null : d; }
  return null;
}

/** Minimal RFC-4180 CSV parser (handles quoted fields with commas/quotes). */
function parseCsv(text) {
  const s = text.replace(/^﻿/, '');
  const rows = [];
  let field = '';
  let row = [];
  let inQuotes = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') { if (s[i + 1] === '"') { field += '"'; i++; } else inQuotes = false; }
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((x) => x !== ''));
}

function csvField(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Read the override CSV → { slug: 'YYYY-MM-DD' } (only valid, non-empty rows). */
function loadOverrides() {
  let rows;
  try { rows = parseCsv(fs.readFileSync(DATE_CSV, 'utf8')); } catch { return {}; }
  if (rows.length < 2) return {};
  const header = rows[0].map((h) => h.trim());
  const iSlug = header.indexOf(CSV_COLS.slug) >= 0 ? header.indexOf(CSV_COLS.slug) : 0;
  let iOv = header.indexOf(CSV_COLS.override);
  if (iOv < 0) iOv = header.length - 1; // fall back to the last column
  const map = {};
  for (const r of rows.slice(1)) {
    const slug = (r[iSlug] || '').trim();
    const d = parseUserDate(r[iOv]);
    if (slug && d) map[slug] = isoDate(d);
  }
  return map;
}

/** Re-populate the CSV: one row per current post, preserving user overrides. */
function writeOverridesCsv(ledger) {
  const existing = loadOverrides();
  const seen = new Set();
  const rows = [];
  for (const { slug, pubDate } of Object.values(ledger)) {
    if (seen.has(slug)) continue;
    seen.add(slug);
    const file = path.join(BLOG_DIR, slug + '.md');
    if (!fs.existsSync(file)) continue;
    const { data } = parseFrontmatter(fs.readFileSync(file, 'utf8'));
    rows.push([slug, data.title || '', data.category || '', pubDate, existing[slug] || '']);
  }
  rows.sort((a, b) => String(b[3]).localeCompare(String(a[3]))); // newest original date first
  const header = [CSV_COLS.slug, CSV_COLS.title, CSV_COLS.category, CSV_COLS.original, CSV_COLS.override];
  const out = '﻿' + [header, ...rows].map((cells) => cells.map(csvField).join(',')).join('\r\n') + '\r\n';
  try {
    const cur = fs.existsSync(DATE_CSV) ? fs.readFileSync(DATE_CSV, 'utf8') : '';
    if (cur !== out) { ensureDir(path.dirname(DATE_CSV)); fs.writeFileSync(DATE_CSV, out); }
  } catch (e) {
    warn(`could not write ${path.basename(DATE_CSV)}: ${String(e.message).slice(0, 120)}`);
  }
}

/** Apply the CSV overrides: rewrite any post whose date differs from desired. */
function applyDateOverrides(ledger) {
  const overrides = loadOverrides();
  for (const entry of Object.values(ledger)) {
    const file = path.join(BLOG_DIR, entry.slug + '.md');
    if (!fs.existsSync(file)) continue;
    const desired = overrides[entry.slug] || entry.pubDate; // override, else original
    const { data, body } = parseFrontmatter(fs.readFileSync(file, 'utf8'));
    const current = data.pubDate ? isoDate(data.pubDate) : null;
    if (current === desired) continue;
    data.pubDate = new Date(desired);
    const content = `${serializeFrontmatter(data)}\n\n${body}\n`;
    fs.writeFileSync(file, content);
    mirrorToBackup(entry.slug, content);
    log(`  ⏱ date ${overrides[entry.slug] ? 'override' : 'reset'}: blog/${entry.slug}.md → ${desired}`);
    publishChange(file, `blog: set date ${entry.slug} ${desired}`);
  }
}

function handleOverridesChanged(ledger) {
  applyDateOverrides(ledger);
  writeOverridesCsv(ledger);
}

// ── core: process a single file ──────────────────────────────────────────────

/** @returns {null | {slug, file, action}} */
function processFile(file, ledger) {
  const ext = path.extname(file).toLowerCase();
  const base = path.basename(file);

  if (base.startsWith('~$') || ext === '.tmp' || ext === '.crdownload') return null;
  if (GOOGLE_STUBS.has(ext)) {
    warn(`skipping Google stub "${base}" — export it to .docx or .pdf into the folder.`);
    return null;
  }
  if (!SUPPORTED.has(ext)) return null;

  const isMd = ext === '.md' || ext === '.markdown';
  // Markdown is read directly (avoids markitdown mangling existing frontmatter);
  // everything else is converted to Markdown first.
  const raw = isMd ? fs.readFileSync(file, 'utf8') : convert(file);
  if (!raw || raw.trim().length < 40) {
    warn(`skipping "${base}" — no usable text.`);
    return null;
  }

  const hash = sha256(raw);
  const prev = ledger[file];
  if (prev && prev.hash === hash) return null; // unchanged

  const folderCat = categoryFor(file);
  const parsed = isMd ? parseFrontmatter(raw) : null;
  const hasFm = !!(parsed && parsed.data && parsed.data.title);

  let data;
  let body;
  let slug;

  if (hasFm) {
    // Markdown with real frontmatter → preserve its metadata; the FOLDER wins for
    // category (the user's "category = sub-folder" rule).
    body = parsed.body;
    const category = CATEGORIES.has(folderCat)
      ? folderCat
      : (CATEGORIES.has(parsed.data.category) ? parsed.data.category : DEFAULT_CATEGORY);
    const fmDate = parsed.data.pubDate;
    const pubDate = fmDate instanceof Date && !Number.isNaN(fmDate.getTime())
      ? fmDate
      : (prev ? new Date(prev.pubDate) : creationDate(file));
    data = {
      ...parsed.data,
      category,
      pubDate,
      description: parsed.data.description || makeExcerpt(body),
      tags: Array.isArray(parsed.data.tags) ? parsed.data.tags : [],
      updatedDate: prev ? new Date() : parsed.data.updatedDate,
      draft: !!parsed.data.draft,
    };
    slug = prev?.slug || path.basename(base, ext); // a .md's filename is its slug
    slug = uniqueSlug(slug, path.join(BLOG_DIR, slug + '.md'));
  } else {
    // docx/pdf/txt or a frontmatter-less .md → generate metadata.
    const fallbackTitle = humanize(path.basename(base, ext));
    const t = extractTitleAndBody(raw, fallbackTitle);
    body = t.body;
    const pubDate = prev ? new Date(prev.pubDate) : creationDate(file);
    data = {
      title: t.title,
      description: makeExcerpt(body),
      pubDate,
      updatedDate: prev ? new Date() : undefined,
      category: folderCat,
      tags: [],
      draft: false,
    };
    slug = prev?.slug;
    if (!slug) {
      const fromName = slugify(path.basename(base, ext));
      slug = fromName || `post-${isoDate(pubDate)}-${shortHash(file)}`;
      slug = uniqueSlug(slug, null);
    }
  }

  // The ledger keeps the ORIGINAL date; a CSV override (if any) only affects the
  // date written into the post, so overrides survive edits and are reversible.
  const basePubDate = data.pubDate;
  const ov = loadOverrides()[slug];
  const effDate = ov ? new Date(ov) : basePubDate;

  const outFile = path.join(BLOG_DIR, slug + '.md');
  const content = `${serializeFrontmatter({ ...data, pubDate: effDate })}\n\n${body}\n`;
  fs.writeFileSync(outFile, content);
  mirrorToBackup(slug, content);

  ledger[file] = { slug, hash, pubDate: isoDate(basePubDate) };
  saveLedger(ledger);

  const action = prev ? 'update' : 'import';
  log(`  ✓ ${action}: "${data.title}"  →  blog/${slug}.md  [${data.category}, ${isoDate(effDate)}${ov ? ' override' : ''}]`);
  return { slug, file: outFile, action };
}

/** Remove a post whose source document was deleted (its backup copy is kept). */
function removePost(slug, src, ledger) {
  const file = path.join(BLOG_DIR, slug + '.md');
  // Make sure the backup has the latest copy before we delete the live post.
  try { if (fs.existsSync(file)) mirrorToBackup(slug, fs.readFileSync(file, 'utf8')); } catch { /* ignore */ }
  let removed = false;
  try {
    if (fs.existsSync(file)) { fs.unlinkSync(file); removed = true; }
  } catch (e) {
    warn(`could not delete ${file}: ${String(e.message).slice(0, 120)}`);
  }
  delete ledger[src];
  saveLedger(ledger);
  if (removed) {
    log(`  ✗ removed: blog/${slug}.md (source gone) — kept in backup.`);
    publishChange(file, `blog: remove ${slug}`);
  }
}

/** Delete posts whose source documents have vanished — guarded against wipes. */
function reconcileDeletions(ledger) {
  if (!fs.existsSync(INBOX)) {
    warn('inbox missing — skipping deletion sync (safety).');
    return;
  }
  const supported = [...walk(INBOX)].filter((f) => SUPPORTED.has(path.extname(f).toLowerCase()));
  if (supported.length === 0) {
    warn('inbox has no documents — skipping deletion sync (Drive may be unsynced).');
    return;
  }
  const tracked = Object.keys(ledger).length;
  if (tracked > 0 && supported.length < tracked * 0.5) {
    warn(`inbox has ${supported.length} docs vs ${tracked} tracked — skipping deletion sync (Drive may be mid-sync).`);
    return;
  }
  const orphans = Object.entries(ledger).filter(([src]) => !fs.existsSync(src));
  if (orphans.length === 0) return;
  if (orphans.length > MAX_DELETE_PER_RUN) {
    warn(`${orphans.length} tracked sources vanished (> limit ${MAX_DELETE_PER_RUN}) — skipping bulk deletion for safety. Delete posts manually or raise BLOG_MAX_DELETE.`);
    return;
  }
  log(`Reconciling ${orphans.length} deletion(s)…`);
  for (const [src, entry] of orphans) removePost(entry.slug, src, ledger);
}

// ── git publish ──────────────────────────────────────────────────────────────

function git(args) {
  return execFileSync('git', ['-C', REPO_ROOT, ...args], { encoding: 'utf8', windowsHide: true });
}

/** Stage one blog file (added, modified, or deleted), commit and push. */
function publishChange(file, message) {
  if (NO_GIT) {
    log(`  · BLOG_NO_GIT set — not committing (${message}).`);
    return;
  }
  try {
    // `git add` stages the current state of the path — creation, edit OR deletion.
    // Only the blog post is staged; the ledger is gitignored/machine-local.
    git(['add', '--', file]);
    try {
      git(['diff', '--cached', '--quiet']);
      return; // exit 0 = nothing staged
    } catch { /* staged changes exist — continue */ }
    git(['commit', '-m', message]);
    try {
      git(['pull', '--rebase']);
    } catch (e) {
      warn(`pull --rebase failed, trying push anyway: ${String(e.message).slice(0, 120)}`);
    }
    try {
      git(['push']);
    } catch {
      git(['pull', '--rebase']);
      git(['push']);
    }
    log(`  ↑ ${message} → deploy triggered.`);
  } catch (e) {
    const detail = [e.message, e.stderr, e.stdout].filter(Boolean).join(' | ').replace(/\s+/g, ' ');
    warn(`git publish failed (${message}): ${detail.slice(0, 500)}`);
  }
}

// ── walking / watching ───────────────────────────────────────────────────────

function* walk(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(full);
    else if (e.isFile()) yield full;
  }
}

function oneShot() {
  if (!fs.existsSync(INBOX)) {
    warn(`inbox folder not found: ${INBOX}`);
    return;
  }
  const ledger = loadLedger();
  let count = 0;
  for (const file of walk(INBOX)) {
    try {
      const res = processFile(file, ledger);
      if (res) { publishChange(res.file, `blog: ${res.action} ${res.slug}`); count++; }
    } catch (e) {
      warn(`failed "${path.basename(file)}": ${String(e.message).slice(0, 200)}`);
    }
  }
  reconcileDeletions(ledger);
  applyDateOverrides(ledger);
  writeOverridesCsv(ledger);
  log(count ? `Done — ${count} post(s) imported/updated.` : 'Nothing new to import.');
}

async function watch() {
  const { default: chokidar } = await import('chokidar');
  const ledger = loadLedger();
  ensureDir(BACKUP_DIR);
  log(`👀 watching ${INBOX}`);
  log(`   backup → ${BACKUP_DIR}`);
  log(`   date overrides → ${DATE_CSV}`);
  // Catch deletions that happened while the watcher was off (guarded internally),
  // then apply any date overrides and refresh the CSV.
  reconcileDeletions(ledger);
  applyDateOverrides(ledger);
  writeOverridesCsv(ledger);
  const watcher = chokidar.watch(INBOX, {
    ignoreInitial: false,
    // Skip dot-folders and Drive's own sync working dir (e.g. ".tmp.driveupload").
    ignored: (p) => /(^|[\\/])\.[^\\/]+([\\/]|$)/.test(p),
    awaitWriteFinish: { stabilityThreshold: 2500, pollInterval: 400 },
    depth: 4,
  });
  const onUpsert = (file) => {
    try {
      // The date-override CSV isn't a post — a change to it re-applies overrides.
      if (isOverridesCsv(file)) { handleOverridesChanged(ledger); return; }
      const res = processFile(file, ledger);
      if (res) { publishChange(res.file, `blog: ${res.action} ${res.slug}`); writeOverridesCsv(ledger); }
    } catch (e) {
      warn(`failed "${path.basename(file)}": ${String(e.message).slice(0, 200)}`);
    }
  };
  const onUnlink = async (file) => {
    if (!SUPPORTED.has(path.extname(file).toLowerCase())) return;
    const entry = ledger[file];
    if (!entry) return; // not a document we imported
    // Drive can remove+re-add a file mid-sync — confirm it's really gone.
    await delay(UNLINK_CONFIRM_MS);
    if (fs.existsSync(file)) return;
    try { removePost(entry.slug, file, ledger); writeOverridesCsv(ledger); }
    catch (e) { warn(`delete failed "${path.basename(file)}": ${String(e.message).slice(0, 200)}`); }
  };
  watcher.on('add', onUpsert).on('change', onUpsert).on('unlink', onUnlink);
  watcher.on('error', (e) => warn(`watcher error: ${e}`));
}

/** One-time: mirror the existing posts into the inbox (by category) + backup,
 *  canonicalize their frontmatter, and seed the ledger so they aren't re-imported. */
function exportExisting() {
  ensureDir(INBOX);
  ensureDir(BACKUP_DIR);
  const ledger = loadLedger();
  let n = 0;
  for (const name of fs.readdirSync(BLOG_DIR)) {
    if (!name.endsWith('.md')) continue;
    const slug = name.replace(/\.md$/, '');
    const full = path.join(BLOG_DIR, name);
    const { data, body } = parseFrontmatter(fs.readFileSync(full, 'utf8'));
    if (!data.title) { warn(`export skip ${name}: no frontmatter title`); continue; }
    const category = CATEGORIES.has(data.category) ? data.category : DEFAULT_CATEGORY;
    const content = `${serializeFrontmatter({ ...data, category })}\n\n${body}\n`;
    // Canonicalise the live post so later imports reproduce identical bytes.
    fs.writeFileSync(full, content);
    // Write the source-of-truth copy into the inbox under its category.
    const inboxDir = path.join(INBOX, category);
    ensureDir(inboxDir);
    const inboxFile = path.join(inboxDir, slug + '.md');
    fs.writeFileSync(inboxFile, content);
    mirrorToBackup(slug, content);
    ledger[inboxFile] = { slug, hash: sha256(content), pubDate: isoDate(data.pubDate) };
    n++;
  }
  saveLedger(ledger);
  writeOverridesCsv(ledger);
  log(`Exported ${n} existing post(s) → inbox + backup, seeded ledger, wrote ${path.basename(DATE_CSV)}.`);
}

// ── entry ────────────────────────────────────────────────────────────────────

const invokedDirectly =
  path.resolve(process.argv[1] || '') === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  if (EXPORT) exportExisting();
  else if (WATCH) watch();
  else oneShot();
}

export {
  parseFrontmatter, serializeFrontmatter, processFile, reconcileDeletions,
  parseCsv, parseUserDate, loadOverrides, writeOverridesCsv, applyDateOverrides,
};

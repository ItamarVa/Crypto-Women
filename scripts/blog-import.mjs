#!/usr/bin/env node
/**
 * blog-import.mjs — turn documents dropped into a synced folder into blog posts.
 *
 * A local pipeline: Keren saves a Word/PDF/Markdown/TXT/HTML file into the
 * BLOG_INBOX folder (a Google-Drive-synced folder), this script converts it to
 * Markdown with Microsoft's `markitdown`, extracts the article, and writes a new
 * post into src/content/blog with the file's creation date as the publish date.
 * The article TEXT is kept verbatim — we only add frontmatter and drop a single
 * duplicated title heading.
 *
 * Category comes from the sub-folder the file sits in (e.g. a file under
 * "…/Blog - Crypto Women/השקעות/foo.docx" → category "השקעות").
 *
 * Modes:
 *   node scripts/blog-import.mjs           one-shot: import every new/changed file
 *   node scripts/blog-import.mjs --watch   stay running, import on drop (Drive-safe)
 *   BLOG_NO_GIT=1 …                        convert only, do NOT commit/push (testing)
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
const BLOG_DIR = path.join(REPO_ROOT, 'src', 'content', 'blog');
const LEDGER_PATH = path.join(__dirname, '.blog-imported.json');

const INBOX = process.env.BLOG_INBOX || 'D:\\AI Projects\\Crypto Women\\Blog - Crypto Women';
const NO_GIT = process.env.BLOG_NO_GIT === '1';
const WATCH = process.argv.includes('--watch');

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

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

/** Pick the article title and body from converted Markdown. */
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
  // Force UTF-8 for Python too, as a belt-and-suspenders measure.
  const env = { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' };
  const opts = { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, windowsHide: true, env };
  try {
    // Prefer the uv-managed tool (installed with the [all] extras, so it can read
    // .docx/.pdf/etc). A bare `markitdown` on PATH may point at an unrelated
    // install missing those optional dependencies, so it's only a fallback.
    try {
      execFileSync('uv', ['tool', 'run', 'markitdown', file, '-o', out], opts);
    } catch {
      execFileSync('markitdown', [file, '-o', out], opts);
    }
    return fs.readFileSync(out, 'utf8');
  } catch (e) {
    throw new Error(`markitdown failed: ${(e.stderr || e.message || '').toString().slice(0, 300)}`);
  } finally {
    try {
      fs.unlinkSync(out);
    } catch {
      /* temp file may not exist on failure */
    }
  }
}

function loadLedger() {
  try {
    return JSON.parse(fs.readFileSync(LEDGER_PATH, 'utf8'));
  } catch {
    return {};
  }
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

function buildFrontmatter({ title, pubDate, updatedDate, category, description }) {
  const fm = [
    '---',
    `title: ${JSON.stringify(title)}`,
    `description: ${JSON.stringify(description || '')}`,
    `pubDate: ${isoDate(pubDate)}`,
  ];
  if (updatedDate) fm.push(`updatedDate: ${isoDate(updatedDate)}`);
  fm.push(`category: ${JSON.stringify(category)}`);
  fm.push('tags: []');
  fm.push('draft: false');
  fm.push('---');
  return fm.join('\n');
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

  const md = convert(file);
  if (!md || md.trim().length < 40) {
    warn(`skipping "${base}" — conversion produced no usable text.`);
    return null;
  }

  const hash = createHash('sha256').update(md).digest('hex');
  const prev = ledger[file];
  if (prev && prev.hash === hash) return null; // unchanged

  const fallbackTitle = humanize(path.basename(base, ext));
  const { title, body } = extractTitleAndBody(md, fallbackTitle);
  const pubDate = prev ? new Date(prev.pubDate) : creationDate(file);
  const updatedDate = prev ? new Date() : undefined;
  const category = categoryFor(file);
  const description = makeExcerpt(body);

  // Slug: keep a prior slug on update; otherwise from filename, else Hebrew fallback.
  let slug = prev?.slug;
  if (!slug) {
    const fromName = slugify(path.basename(base, ext));
    slug = fromName || `post-${isoDate(pubDate)}-${shortHash(file)}`;
    slug = uniqueSlug(slug, null);
  }
  const outFile = path.join(BLOG_DIR, slug + '.md');

  const frontmatter = buildFrontmatter({ title, pubDate, updatedDate, category, description });
  fs.writeFileSync(outFile, `${frontmatter}\n\n${body}\n`);

  ledger[file] = { slug, hash, pubDate: isoDate(pubDate) };
  saveLedger(ledger);

  const action = prev ? 'update' : 'import';
  log(`  ✓ ${action}: "${title}"  →  blog/${slug}.md  [${category}, ${isoDate(pubDate)}]`);
  return { slug, file: outFile, action };
}

// ── git publish ──────────────────────────────────────────────────────────────

function git(args) {
  return execFileSync('git', ['-C', REPO_ROOT, ...args], { encoding: 'utf8', windowsHide: true });
}

function publish(result) {
  if (NO_GIT) {
    log(`  · BLOG_NO_GIT set — not committing (${result.slug}).`);
    return;
  }
  try {
    // Only stage the blog post. The ledger (scripts/.blog-imported.json) is
    // gitignored/machine-local — adding it makes `git add` error out and abort.
    git(['add', '--', result.file]);
    // Nothing staged? bail quietly.
    try {
      git(['diff', '--cached', '--quiet']);
      return; // exit 0 = no staged changes
    } catch {
      /* staged changes exist — continue */
    }
    git(['commit', '-m', `blog: ${result.action} ${result.slug}`]);
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
    log(`  ↑ published ${result.slug} → deploy triggered.`);
  } catch (e) {
    const detail = [e.message, e.stderr, e.stdout].filter(Boolean).join(' | ').replace(/\s+/g, ' ');
    warn(`git publish failed for ${result.slug}: ${detail.slice(0, 500)}`);
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
      if (res) {
        publish(res);
        count++;
      }
    } catch (e) {
      warn(`failed "${path.basename(file)}": ${String(e.message).slice(0, 200)}`);
    }
  }
  log(count ? `Done — ${count} post(s) imported/updated.` : 'Nothing new to import.');
}

async function watch() {
  const { default: chokidar } = await import('chokidar');
  const ledger = loadLedger();
  log(`👀 watching ${INBOX} for new blog documents… (Ctrl+C to stop)`);
  const watcher = chokidar.watch(INBOX, {
    ignoreInitial: false,
    // Skip dot-folders and Google Drive's own sync working directory
    // (e.g. ".tmp.driveupload") — they only hold partial uploads.
    ignored: (p) => /(^|[\\/])\.[^\\/]+([\\/]|$)/.test(p),
    awaitWriteFinish: { stabilityThreshold: 2500, pollInterval: 400 },
    depth: 4,
  });
  const handle = (file) => {
    try {
      const res = processFile(file, ledger);
      if (res) publish(res);
    } catch (e) {
      warn(`failed "${path.basename(file)}": ${String(e.message).slice(0, 200)}`);
    }
  };
  watcher.on('add', handle).on('change', handle);
  watcher.on('error', (e) => warn(`watcher error: ${e}`));
}

// ── entry ────────────────────────────────────────────────────────────────────

if (WATCH) {
  watch();
} else {
  oneShot();
}

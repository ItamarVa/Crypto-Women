// ============================================================
// fetch-news.mjs — Crypto Women automatic news aggregator
// Pulls RSS from leading crypto outlets (global + Hebrew),
// normalizes, dedupes, and writes src/data/news.json.
// Zero runtime deps — native fetch + lightweight RSS parsing.
// Run locally: `node scripts/fetch-news.mjs`
// In CI: scheduled GitHub Action commits the refreshed JSON.
// ============================================================

import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, '..', 'src', 'data');
const OUT_FILE = join(OUT_DIR, 'news.json');

// Each source: name (display), lang, url (RSS), site (homepage for fallback favicon)
const FEEDS = [
  { name: 'CoinDesk', lang: 'en', url: 'https://www.coindesk.com/arc/outboundfeeds/rss/', site: 'https://www.coindesk.com' },
  { name: 'Cointelegraph', lang: 'en', url: 'https://cointelegraph.com/rss', site: 'https://cointelegraph.com' },
  { name: 'Decrypt', lang: 'en', url: 'https://decrypt.co/feed', site: 'https://decrypt.co' },
  { name: 'Bitcoin Magazine', lang: 'en', url: 'https://bitcoinmagazine.com/.rss/full/', site: 'https://bitcoinmagazine.com' },
  { name: 'The Defiant', lang: 'en', url: 'https://thedefiant.io/api/feed', site: 'https://thedefiant.io' },
  // Hebrew / Israeli sources (WordPress feeds — skipped gracefully if unavailable)
  { name: 'Bitcoin Embassy TLV', lang: 'he', url: 'https://www.bitcoin.org.il/feed/', site: 'https://www.bitcoin.org.il' },
  { name: 'CryptoJungle', lang: 'he', url: 'https://cryptojungle.co.il/feed/', site: 'https://cryptojungle.co.il' },
];

const TIMEOUT_MS = 15000;
const MAX_ITEMS = 60;
const MAX_PER_SOURCE = 12;

// --- tiny helpers -------------------------------------------------

function decodeEntities(s = '') {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;|&rsquo;|&lsquo;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#8211;|&ndash;/g, '–')
    .replace(/&#8212;|&mdash;/g, '—')
    .replace(/&hellip;|&#8230;/g, '…')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

function stripHtml(s = '') {
  return decodeEntities(s.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function truncate(s, n) {
  if (!s) return '';
  if (s.length <= n) return s;
  return s.slice(0, n).replace(/\s+\S*$/, '') + '…';
}

function tag(block, name) {
  // matches <name ...>...</name> or <name .../> ; returns inner text
  const re = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, 'i');
  const m = block.match(re);
  return m ? m[1].trim() : '';
}

function attr(block, name, attrName) {
  const re = new RegExp(`<${name}\\b[^>]*\\b${attrName}=["']([^"']+)["'][^>]*>`, 'i');
  const m = block.match(re);
  return m ? m[1].trim() : '';
}

function extractImage(itemXml, descHtml) {
  // media:content / media:thumbnail / enclosure url, else first <img> in description
  return (
    attr(itemXml, 'media:content', 'url') ||
    attr(itemXml, 'media:thumbnail', 'url') ||
    attr(itemXml, 'enclosure', 'url') ||
    (descHtml.match(/<img[^>]+src=["']([^"']+)["']/i)?.[1] ?? '') ||
    ''
  );
}

function normalizeTitleKey(t) {
  return stripHtml(t).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().slice(0, 80);
}

async function fetchFeed(feed) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(feed.url, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': 'CryptoWomenBot/1.0 (+https://itamarva.github.io/Crypto-Women)',
        Accept: 'application/rss+xml, application/xml, text/xml, */*',
      },
      redirect: 'follow',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const xml = await res.text();
    const items = [];
    // RSS uses <item>, Atom uses <entry> — support both
    const isAtom = !/<item[\s>]/i.test(xml) && /<entry[\s>]/i.test(xml);
    const splitter = isAtom ? /<entry[\s>]/i : /<item[\s>]/i;
    const closer = isAtom ? /<\/entry>/i : /<\/item>/i;
    const openTag = isAtom ? '<entry ' : '<item ';
    const blocks = xml.split(splitter).slice(1);
    for (const raw of blocks.slice(0, MAX_PER_SOURCE * 2)) {
      const itemXml = openTag + raw.split(closer)[0];
      const title = stripHtml(tag(itemXml, 'title'));
      let link = stripHtml(tag(itemXml, 'link')) || attr(itemXml, 'link', 'href');
      if (!title || !link) continue;
      const descHtml = tag(itemXml, 'description') || tag(itemXml, 'content:encoded') || '';
      const summary = truncate(stripHtml(descHtml), 220);
      const pub = tag(itemXml, 'pubDate') || tag(itemXml, 'dc:date') || tag(itemXml, 'published');
      const ts = pub ? Date.parse(pub) : NaN;
      const image = extractImage(itemXml, descHtml);
      items.push({
        title,
        link,
        summary,
        source: feed.name,
        lang: feed.lang,
        date: Number.isNaN(ts) ? null : new Date(ts).toISOString(),
        image: image || null,
      });
    }
    console.log(`  ✓ ${feed.name}: ${items.length} items`);
    return items.slice(0, MAX_PER_SOURCE);
  } catch (err) {
    console.warn(`  ✗ ${feed.name}: ${err.message}`);
    return [];
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  console.log('Fetching crypto news feeds…');
  const results = await Promise.all(FEEDS.map(fetchFeed));
  let all = results.flat();

  // dedupe by normalized title
  const seen = new Set();
  all = all.filter((it) => {
    const k = normalizeTitleKey(it.title);
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  // sort newest first; items without date sink to the bottom
  all.sort((a, b) => (Date.parse(b.date || 0) || 0) - (Date.parse(a.date || 0) || 0));
  all = all.slice(0, MAX_ITEMS);

  const sourcesOk = [...new Set(all.map((i) => i.source))];

  // Preserve previous data if every feed failed (resilience)
  if (all.length === 0) {
    try {
      const prev = JSON.parse(await readFile(OUT_FILE, 'utf-8'));
      console.warn('All feeds failed — keeping existing news.json');
      return prev;
    } catch {
      console.warn('All feeds failed and no previous data — writing empty set');
    }
  }

  const payload = {
    updated: new Date().toISOString(),
    count: all.length,
    sources: sourcesOk,
    items: all,
  };

  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(OUT_FILE, JSON.stringify(payload, null, 2) + '\n', 'utf-8');
  console.log(`\nWrote ${all.length} items from ${sourcesOk.length} sources → src/data/news.json`);
  return payload;
}

main().catch((e) => {
  console.error('fetch-news failed:', e);
  process.exit(1);
});

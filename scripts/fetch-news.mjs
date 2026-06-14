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

// Gemini (AI Studio) translation — only runs when GEMINI_API_KEY is set (CI).
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const GEMINI_TIMEOUT_MS = 60000;

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

// Stable short id from the article link — used for the internal page route.
function hashId(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
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
        id: hashId(link),
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

// --- Original Hebrew content via Gemini ------------------------------
// For each article we generate ORIGINAL Hebrew content (not a translation of
// the copyrighted body) in the voice of the site owner, Keren Waldman Hanan:
//   title_he      — Hebrew headline
//   brief_he      — 1 short sentence for the card
//   commentary_he — 2-3 short first-person paragraphs, as if Keren read the
//                   story and is sharing it warmly with her community
//   points_he[]   — 3-4 key takeaways
//   meaning_he    — "what it means" — global + Israel angle if relevant
// Grounded ONLY in the headline + RSS snippet we hold (we never copy the full
// article). On any failure returns [] so the page falls back to the snippet.

// Keren's voice, distilled from the site's own About/blog copy.
const VOICE = `Write as Keren Waldman Hanan (קרן ולדמן חנן), founder of the "Crypto Women" (קריפטו וומן) community.
Her voice: warm, personal, first-person feminine Hebrew, speaking directly to her community of women (and men) as "חברות"/"אתן".
She demystifies crypto and investing, is encouraging and empowering, mission-driven (bringing more women into investing, "לנפץ תקרות זכוכית").
She is an industrial engineer + MBA, crypto investor since 2017. Tone is intimate, optimistic, plain-spoken — never hype, never financial advice.
Typical phrasing: "אני ממש שמחה שאת כאן", "לקפוץ למים", "ככל שלומדים יותר, פחות מפחדים", "תפתחו את הראש, תלמדו, תחקרו".`;

async function generateBatch(items) {
  const key = process.env.GEMINI_API_KEY;
  if (!key || items.length === 0) return [];
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${key}`;
  const payloadItems = items.map((it, i) => ({
    i,
    source: it.source,
    title: it.title,
    summary: it.summary || '',
  }));
  const prompt = `${VOICE}

For EACH news item below, produce ORIGINAL Hebrew content. This is NOT a translation — write fresh content in Keren's voice based only on the provided headline and short snippet.

Hard rules:
- Ground everything ONLY in the provided title + summary. Do NOT invent facts, numbers, dates, quotes, or personal anecdotes. If the snippet is thin, keep it general and say what is reasonably implied — never fabricate.
- This is editorial framing/education, not financial advice. No "buy/sell" recommendations.
- Keep well-known coins as Hebrew (ביטקוין, את'ריום); keep terms like DeFi/NFT/stablecoin/ETF/Web3 as-is. Don't translate company/product/people names.

For each item return:
- title_he: a clear Hebrew headline (not clickbait).
- brief_he: ONE short Hebrew sentence summarizing the story for a card.
- commentary_he: 2-3 short paragraphs (use \\n\\n between them) in Keren's warm first-person voice, as if she read this and is sharing it with her community — what happened and why it's interesting.
- points_he: array of 3-4 short Hebrew bullet takeaways.
- meaning_he: 1-2 sentences — "מה זה אומר": the broader significance globally, and the angle for Israel if and only if there is a genuine one (otherwise keep it global).

Return one object per input item, in the same order.
Items:
${JSON.stringify(payloadItems, null, 2)}`;

  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.6,
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: {
            title_he: { type: 'STRING' },
            brief_he: { type: 'STRING' },
            commentary_he: { type: 'STRING' },
            points_he: { type: 'ARRAY', items: { type: 'STRING' } },
            meaning_he: { type: 'STRING' },
          },
          required: ['title_he', 'brief_he', 'commentary_he', 'points_he', 'meaning_he'],
        },
      },
    },
  };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), GEMINI_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      console.warn(`  ✗ Gemini HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return [];
    }
    const data = await res.json();
    const text = (data?.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
    const arr = JSON.parse(text);
    console.log(`  ✓ generated Hebrew content for ${arr.length} items via ${GEMINI_MODEL}`);
    return Array.isArray(arr) ? arr : [];
  } catch (err) {
    console.warn(`  ✗ generation failed: ${err.message}`);
    return [];
  } finally {
    clearTimeout(timer);
  }
}

const GEN_FIELDS = ['title_he', 'brief_he', 'commentary_he', 'points_he', 'meaning_he'];

async function generateAll(all) {
  // Reuse prior generated content (cache by link) so each article is done once.
  const prevByLink = new Map();
  try {
    const prev = JSON.parse(await readFile(OUT_FILE, 'utf-8'));
    for (const it of prev.items || []) if (it.link) prevByLink.set(it.link, it);
  } catch {
    /* no previous file */
  }

  for (const it of all) {
    const cached = prevByLink.get(it.link);
    for (const f of GEN_FIELDS) it[f] = cached?.[f] ?? (f === 'points_he' ? [] : null);
  }

  const todo = all.filter((it) => !it.title_he);
  if (todo.length === 0) {
    console.log('Hebrew content: nothing new to generate.');
    return;
  }
  if (!process.env.GEMINI_API_KEY) {
    console.warn(`Hebrew content: GEMINI_API_KEY not set — leaving ${todo.length} items as source snippet.`);
    return;
  }
  console.log(`Generating Hebrew content for ${todo.length} new item(s)…`);
  const out = await generateBatch(todo);
  todo.forEach((it, i) => {
    const g = out[i];
    if (g && g.title_he) {
      it.title_he = g.title_he;
      it.brief_he = g.brief_he || '';
      it.commentary_he = g.commentary_he || '';
      it.points_he = Array.isArray(g.points_he) ? g.points_he : [];
      it.meaning_he = g.meaning_he || '';
    }
  });
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

  // Generate original Hebrew content (cached by link; needs GEMINI_API_KEY)
  await generateAll(all);

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

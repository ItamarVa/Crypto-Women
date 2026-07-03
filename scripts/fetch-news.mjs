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

// Gemini (AI Studio) — only runs when GEMINI_API_KEY is set (CI).
// gemini-2.5-flash is the quality/speed sweet spot for a 500-700 word original
// article with data. flash-lite is too thin for this; pro risks the 90s timeout.
// NOTE: a repo Variable GEMINI_MODEL overrides this — set it to gemini-2.5-flash
// (or delete it) so the feed uses this model.
const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash';
const GEMINI_MODEL = process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;
// Try the configured model first; if it's unavailable (e.g. a retired/typo'd
// GEMINI_MODEL var), automatically fall back to the default model.
const MODEL_CANDIDATES = [...new Set([GEMINI_MODEL, DEFAULT_GEMINI_MODEL])];
const GEMINI_TIMEOUT_MS = 90000;
// Bump when the generated-content format changes — cached items whose stored
// gen_v differs are regenerated once (then stay cached). v2 = full 450-700 word
// original article + terms glossary. v3 = more measured/professional tone (less
// gushing first-person, no formulaic self-reminders), 500-700 words, includes
// concrete figures from the source.
// v4 = fixes v3 truncation (gemini-2.5-flash "thinking" ate the output-token
// budget → short/empty articles); thinking capped + maxOutputTokens raised +
// a length guard that rejects short generations.
// v5 = length adherence: v4 was NOT token-truncated (maxOutputTokens is huge) —
// gemini-2.5-flash simply under-produced (~390 words avg, all < 500). Prompt now
// scaffolds five distinct developed paragraphs + a firm ~600 target, and the
// length guard is raised so short generations retry instead of passing.
const CONTENT_VERSION = 5;
// Full-article fetch (richer source material for the original Hebrew summary).
const ARTICLE_TIMEOUT_MS = 12000;
const MAX_ARTICLE_CHARS = 5000;
// Generate in small chunks so each Gemini request stays well under the timeout.
// The output is now a full 450-700 word article per item (much larger than the
// old short summary), so we keep chunks small (4) to stay under the 90s timeout.
const GEN_CHUNK_SIZE = Number(process.env.GEN_CHUNK_SIZE) || 3;
// Reject a generated article that came back too short so it isn't marked as done
// — the previous content stays visible and it retries next run. Set near the 500
// target (with slack) to enforce the length requirement, not just catch truncation.
const MIN_COMMENTARY_WORDS = 470;

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

// --- Full-article fetch (heuristic readability, dependency-free) ------
// Extracts the main readable text of an article page. Best-effort: returns ''
// on paywall/block/timeout so the caller falls back to the RSS snippet.
function extractReadable(html) {
  let region = '';
  const art = html.match(/<article[\s\S]*?<\/article>/i);
  if (art) region = art[0];
  else {
    const main = html.match(/<main[\s\S]*?<\/main>/i);
    region = main ? main[0] : html;
  }
  region = region
    .replace(/<(script|style|noscript|svg|header|footer|nav|aside|form)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
  return stripHtml(region);
}

async function fetchArticleText(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ARTICLE_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': 'CryptoWomenBot/1.0 (+https://itamarva.github.io/Crypto-Women)',
        Accept: 'text/html,application/xhtml+xml',
      },
    });
    if (!res.ok) return '';
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('html')) return '';
    const html = await res.text();
    const text = extractReadable(html);
    return text.length > 400 ? text.slice(0, MAX_ARTICLE_CHARS) : '';
  } catch {
    return '';
  } finally {
    clearTimeout(timer);
  }
}

// --- Original Hebrew content via Gemini ------------------------------
// For each article we write a full ORIGINAL Hebrew article (NOT a translation
// or close paraphrase of the copyrighted source) for the Crypto Women audience,
// per the site owner's editorial brief:
//   title_he      — original Hebrew headline (must differ from the source)
//   brief_he      — 1 short sentence for the card
//   commentary_he — the article itself: opener + body + short conclusion,
//                   ~450-700 words, accessible, in Keren's warm community voice
//   terms_he[]    — {term, explain} glossary for any jargon (may be empty)
//   points_he[]   — 3-5 key takeaways / practical lessons
//   meaning_he    — why this matters specifically to the readers/community
// Grounded ONLY in the title + snippet (+ best-effort full text) we hold; we
// never copy the source. On any failure returns [] so the page falls back.

// The Crypto Women editorial voice — professional and measured (updated per the
// site owner's feedback: less gushing, no formulaic self-reminders).
const VOICE = `Write for the "Crypto Women" (קריפטו וומן) community, founded by Keren Waldman Hanan (קרן ולדמן חנן) — an industrial engineer + MBA and crypto investor since 2017.
The voice is a knowledgeable, level-headed guide: professional, clear and quietly warm, but MEASURED — never gushing, never hype. You explain crypto, blockchain and investing at eye level to readers (women and men) who are curious but not necessarily technical.
Write mostly in a calm, informative, journalistic register. A light touch of community warmth is fine (an occasional "אנחנו", a direct address) but keep it restrained and grown-up — the substance carries the piece, not the emotion.
AVOID, strictly:
- Effusive excitement: "אני ממש שמחה", "אני מתרגשת", "כמה מרגש", exclamation-heavy openings.
- Terms of endearment / over-familiarity: "חברות יקרות", "אוהבת אתכן", "מתוקות".
- Formulaic personal reminders or stock reflective sentences reused across articles — e.g. anything like "אני מזכירה לעצמי תמיד…", "כמו שאני תמיד אומרת…". Vary every opener and closer; never fall into a repeated template.
Stay educational — never financial advice.`;

async function generateBatch(items) {
  const key = process.env.GEMINI_API_KEY;
  if (!key || items.length === 0) return [];
  const payloadItems = items.map((it, i) => ({
    i,
    source: it.source,
    title: it.title,
    summary: it.summary || '',
    text: (it._fullText || '').slice(0, MAX_ARTICLE_CHARS),
  }));
  const prompt = `${VOICE}

TASK: For EACH news item below, write a complete, ORIGINAL Hebrew article for the Crypto Women community — readers who are curious about crypto, blockchain, tech and finance but are NOT necessarily technical experts. This is an original creation in Hebrew based on facts from the source: NOT a translation, NOT a close summary, NOT a near paraphrase.

Each item may include "text": the article's main body fetched from the source. Treat it ONLY as factual raw material.

COPYRIGHT — non-negotiable. You MUST:
- NOT translate the source word-for-word.
- NOT rewrite it paragraph-by-paragraph.
- NOT keep the source's structure or paragraph order.
- NOT copy its headline, sentences, distinctive phrasings or original expressions; never reproduce more than a few consecutive words verbatim.
- Use only the CORE FACTS and build an independent Hebrew article from them — your own framing, your own order, your own words.
- For important factual claims, hedge carefully: "לפי הדיווח", "על פי הפרסום", or "לפי [source name]".
- If a detail is not clearly in the source, do NOT add it and do NOT guess. If the source is thin, stay general — never fabricate facts, numbers, dates, quotes or anecdotes.

STYLE:
- Clear, substantive and professional; natural community Hebrew at eye level, measured tone, no heavy jargon and no gushing.
- Comprehensive: convey the full story, the background and the meaning. Prefer depth and concrete detail over emotion.
- INCLUDE THE NUMBERS: whenever the source gives concrete figures — prices, percentages, dates, sums, amounts raised, market caps, user counts, valuations — weave the important ones into the article; they are what make it credible and useful. Always attribute them ("לפי הדיווח", "על פי הפרסום"). NEVER invent, round-guess or extrapolate a number that isn't in the source.
- Don't be alarmist, but present risks honestly. Make no promises/guarantees. No clickbait headlines. Don't present opinion as fact; frame interpretation as interpretation ("נראה ש…", "ייתכן ש…").
- Educational framing, NOT financial advice. No buy/sell recommendations.
- Keep well-known coins in Hebrew (ביטקוין, את'ריום); keep terms like DeFi/NFT/stablecoin/ETF/Web3 as-is. Don't translate company/product/people names.
- Vary tone, opening and structure across the different items — do NOT reuse a template, a stock opener, or a formulaic closing sentence.
- LENGTH IS PART OF THE TASK: every article must be a full 500-700 word piece (about five developed paragraphs). Short 300-400 word write-ups will be rejected. Reach real depth through concrete detail and context — never through padding or repetition.

For each item return these fields (all Hebrew):
- title_he: an ORIGINAL Hebrew headline that is NOT identical to the source headline.
- brief_he: ONE short sentence summarizing the story, for a card.
- commentary_he: the article body — a DEVELOPED piece of 500-700 words, TARGET ~600. This is a hard requirement: a 300-400 word summary is NOT acceptable; keep writing until the article is genuinely full. Write it as FIVE substantial paragraphs (each a real, multi-sentence paragraph, not one line), separated by \\n\\n, each covering a DISTINCT facet so the article naturally reaches full length: (1) an opener — what happened and why it matters to the reader; (2) the core facts and the concrete figures from the source (prices, %, sums, dates, valuations), attributed; (3) the background and context that make the story understandable to a non-expert; (4) the wider picture — implications, the risks presented honestly, or a second angle; (5) a short closing paragraph with a clear, grounded takeaway. Develop each paragraph fully with explanation — do NOT stop short. Write in the measured, professional community voice described above — not gushing, no formulaic self-reminders. Do NOT put a headline, bullet points, or the disclaimer inside this field.
- terms_he: array of professional terms that appear, each {term: the term, explain: a one-line plain-Hebrew explanation}. Include only genuinely non-obvious terms; return an empty array if none are needed.
- points_he: array of 3-5 short key points / practical takeaways for the crypto audience (only if it suits the topic; otherwise 3).
- meaning_he: 1-2 sentences — why this specifically matters to the readers/community (the global significance, and the Israeli angle only if there is a genuine one).

Return one object per input item, in the same order.
Items:
${JSON.stringify(payloadItems, null, 2)}`;

  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.7,
      // gemini-2.5-flash runs "thinking" by default, which eats the output-token
      // budget and truncated the JSON (articles came out short/empty). Cap the
      // thinking budget and give the output plenty of room for a full 500-700
      // word article per item (chunk of a few).
      thinkingConfig: { thinkingBudget: 2048 },
      maxOutputTokens: 24576,
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: {
            title_he: { type: 'STRING' },
            brief_he: { type: 'STRING' },
            commentary_he: { type: 'STRING' },
            terms_he: {
              type: 'ARRAY',
              items: {
                type: 'OBJECT',
                properties: { term: { type: 'STRING' }, explain: { type: 'STRING' } },
                required: ['term', 'explain'],
              },
            },
            points_he: { type: 'ARRAY', items: { type: 'STRING' } },
            meaning_he: { type: 'STRING' },
          },
          required: ['title_he', 'brief_he', 'commentary_he', 'points_he', 'meaning_he'],
        },
      },
    },
  };

  // Try each candidate model; on "model unavailable" fall through to the next.
  for (const model of MODEL_CANDIDATES) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), GEMINI_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (res.ok) {
        const data = await res.json();
        const text = (data?.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
        const arr = JSON.parse(text);
        console.log(`  ✓ generated Hebrew content for ${arr.length} items via ${model}`);
        return Array.isArray(arr) ? arr : [];
      }
      const errText = await res.text();
      const modelUnavailable =
        res.status === 404 || /not found|not supported|unknown name|is not available/i.test(errText);
      if (modelUnavailable && model !== MODEL_CANDIDATES[MODEL_CANDIDATES.length - 1]) {
        console.warn(`  ↪ model "${model}" unavailable (HTTP ${res.status}) — falling back to default…`);
        continue; // try next candidate
      }
      // Other errors (invalid key 400/401, quota 429, …) — fail gracefully.
      console.warn(`  ✗ Gemini HTTP ${res.status} (${model}): ${errText.slice(0, 200)}`);
      return [];
    } catch (err) {
      console.warn(`  ✗ generation failed (${model}): ${err.message}`);
      return [];
    } finally {
      clearTimeout(timer);
    }
  }
  return [];
}

const GEN_FIELDS = ['title_he', 'brief_he', 'commentary_he', 'terms_he', 'points_he', 'meaning_he'];
const ARRAY_FIELDS = new Set(['terms_he', 'points_he']);

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
    for (const f of GEN_FIELDS) it[f] = cached?.[f] ?? (ARRAY_FIELDS.has(f) ? [] : null);
    it.gen_v = cached?.gen_v ?? null; // content-format version of the cached copy
  }

  // Regenerate items that were never generated OR are on an older content
  // format. Old content is kept as fallback if regeneration later fails.
  const todo = all.filter((it) => !it.title_he || it.gen_v !== CONTENT_VERSION);
  if (todo.length === 0) {
    console.log('Hebrew content: nothing new to generate.');
    return;
  }
  if (!process.env.GEMINI_API_KEY) {
    console.warn(`Hebrew content: GEMINI_API_KEY not set — leaving ${todo.length} items as source snippet.`);
    return;
  }
  // Pull full article text in parallel (best-effort; falls back to snippet).
  console.log(`Fetching full text for ${todo.length} article(s)…`);
  await Promise.all(todo.map(async (it) => { it._fullText = await fetchArticleText(it.link); }));
  const withText = todo.filter((it) => it._fullText).length;
  console.log(`  full text obtained for ${withText}/${todo.length}`);

  console.log(`Generating Hebrew content for ${todo.length} new item(s) in chunks of ${GEN_CHUNK_SIZE}…`);
  let done = 0;
  for (let c = 0; c < todo.length; c += GEN_CHUNK_SIZE) {
    const chunk = todo.slice(c, c + GEN_CHUNK_SIZE);
    const out = await generateBatch(chunk);
    chunk.forEach((it, j) => {
      const g = out[j];
      const words = g?.commentary_he ? g.commentary_he.trim().split(/\s+/).length : 0;
      if (g && g.title_he && words >= MIN_COMMENTARY_WORDS) {
        it.title_he = g.title_he;
        it.brief_he = g.brief_he || '';
        it.commentary_he = g.commentary_he || '';
        it.terms_he = Array.isArray(g.terms_he)
          ? g.terms_he.filter((t) => t && t.term && t.explain)
          : [];
        it.points_he = Array.isArray(g.points_he) ? g.points_he : [];
        it.meaning_he = g.meaning_he || '';
        it.gen_v = CONTENT_VERSION;
        done++;
      } else if (g && g.title_he) {
        console.warn(`  ↪ skipped "${it.source}" — commentary too short (${words} words); keeping fallback, will retry.`);
      }
    });
  }
  for (const it of todo) delete it._fullText; // transient — never persisted
  console.log(`  Hebrew content written for ${done}/${todo.length} items.`);
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

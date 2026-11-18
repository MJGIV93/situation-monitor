import { need, strip, clip } from "../lib/util.mjs";

// Headlines are context, not a reading: nothing here is scored. Each outlet's own feed
// is read, and a story counts as major when several outlets are carrying it at once.
const FEEDS = [
  ["BBC", "https://feeds.bbci.co.uk/news/rss.xml"],
  ["BBC", "https://feeds.bbci.co.uk/news/world/rss.xml"],
  ["NPR", "https://feeds.npr.org/1001/rss.xml"],
  ["PBS", "https://www.pbs.org/newshour/feeds/rss/headlines"],
  ["CBS", "https://www.cbsnews.com/latest/rss/main"],
  ["NBC", "https://feeds.nbcnews.com/nbcnews/public/news"],
  ["ABC", "https://abcnews.go.com/abcnews/topstories"],
  ["NY Times", "https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml"],
  ["NY Times", "https://rss.nytimes.com/services/xml/rss/nyt/World.xml"],
  ["Washington Post", "https://feeds.washingtonpost.com/rss/world"],
  ["Fox News", "https://moxie.foxnews.com/google-publisher/latest.xml"],
  ["Guardian", "https://www.theguardian.com/world/rss"],
  ["Guardian", "https://www.theguardian.com/us-news/rss"],
  ["Al Jazeera", "https://www.aljazeera.com/xml/rss/all.xml"],
  ["France 24", "https://www.france24.com/en/rss"],
];
const OUTLETS = [...new Set(FEEDS.map((f) => f[0]))];
// A story is listed while outlets have carried it in the past 12 hours, and ranked by how
// many have published on it in the past 6, so yesterday's news sinks as today's arrives.
const WINDOW_H = 12, FRESH_H = 6, MIN_OUTLETS = 3, SHOWN = 12;

// Running stories. Every headline on one of these is gathered into a single entry, because
// a war produces a dozen differently worded headlines a day that would never group by wording.
const THREADS = [
  ["Iran", /\biran|tehran|hormuz|qeshm|\birgc\b|houthi|(strike|attack|missile|drone)\w*\b.*\b(bahrain|kuwait|qatar)\b|\b(bahrain|kuwait|qatar)\b.*(strike|attack|missile|drone)/i],
  ["Russia-Ukraine", /ukrain|kyiv|\bcrimea|\bkerch\b|zelensky|donbas|kharkiv|russia\w*\b.*\b(strike|missile|drone|attack|troops|invasion|offensive)/i],
  ["Israel-Gaza", /\bgaza|hamas|hezbollah|west bank|israel\w*\b.*\b(strike|attack|ceasefire|hostage|offensive|troops)|lebanon\b.*\b(strike|attack)/i],
  ["China-Taiwan", /taiwan|south china sea/i],
  ["North Korea", /north korea|pyongyang|\bkim jong/i],
];
// Kinds of event that are shown once two outlets carry them, instead of three.
const FLAGS = [
  ["Attack", /terror|bombing|\bbomb\b|mass shooting|gunman|gunmen|shooter|hostage|explosion|car ramm/i],
  ["Nuclear", /nuclear (weapon|test|strike|threat|plant|warhead)|radiation leak/i],
  ["US military", /\b(US|U\.S\.|american) (air)?strikes?\b|\bpentagon (orders|deploys|sends|announces|confirms)|troops? (deploy|sent to|withdraw)|national guard (deploy|troops|sent)|carrier (strike )?group|\b(US|U\.S\.) (navy|forces|warships?|jets?) (strike|attack|deploy|intercept|sink|seize|shoot)/i],
  ["Cyber", /cyber ?attack|\bhack(ed|ers?|ing)?\b|ransomware|data breach|tech (outage|problem|turmoil)|\boutages?\b/i],
  ["Grid", /blackout|power (grid|outage|cut)|grid (failure|emergency|operator)|\bpipeline\b|\brefinery\b/i],
  ["Aviation", /ground stop|plane crash|jet crash|airliner|air traffic control|\bFAA\b|midair|flights? (grounded|cancel)/i],
  ["Markets", /bank (failure|run|collapse)|stocks? (plunge|tumble|crash|sink|slide)|market (crash|rout|plunge|turmoil|sell-?off)|circuit breaker|emergency rate|\brecession\b/i],
  ["US government", /government shutdown|\bshutdown\b|national emergency|insurrection act|martial law|assassinat|impeach|25th amendment|state of emergency/i],
  ["Disaster", /hurricane|earthquake|wildfire|tornado|tsunami|typhoon|volcano|landslide|\bflood(s|ing|ed)?\b/i],
  ["Outbreak", /outbreak|pandemic|quarantine|bird flu|ebola|measles|mpox|new variant/i],
  ["NY-NJ", /new york city|\bnew york\b(?! times)|\bnyc\b|manhattan|brooklyn|new jersey|\bnewark\b|nj transit|\bmamdani\b/i],
];

const SKIP_TITLE = /^(live|watch|listen|video|quiz|opinion|photos?|in pictures|podcast|newsletter|news wrap|morning|briefing)\b[^a-z]|crossword|wordle|horoscope|\bas it happened\b|^the papers/i;
const SKIP_LINK = /\/(sport|sports|football|opinion|commentisfree|lifeandstyle|lifestyle|entertainment|culture|food|travel|video|videos|live-tv|games|podcasts?)\//i;
const STOP = new Set(("the a an and or but of to in on at by for with from as is are was were be been it its this that these those his her their our your he she they we you i who what when where why how " +
  "after before over under into out up down off about amid among against between during while than then now new says say said saying will would could may might can not no more most less has have had do does did " +
  "us u.s uk live updates update latest news report reports reported video watch here what's whats first one two three year years day days week weeks get gets got make makes made take takes set amid per via just still also back look looks looking meet meets meeting face faces facing").split(" "));
const SAME = { ukrainian: "ukraine", ukraines: "ukraine", russian: "russia", russias: "russia", iranian: "iran", irans: "iran", israeli: "israel", chinese: "china", democratic: "democrat", dem: "democrat", dems: "democrat", republican: "gop", republicans: "gop", crimean: "crimea", american: "america", killed: "kill", kills: "kill", dead: "kill", dies: "kill", died: "kill", death: "kill", deaths: "kill", wins: "win", won: "win", beats: "win", defeats: "win", defeating: "win", flips: "flip", flipped: "flip", strikes: "attack", strike: "attack", struck: "attack", attacks: "attack", attacked: "attack", missiles: "missile", drones: "drone", president: "", white: "", house: "" };

const decode = (s) => strip(String(s).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")).replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16))).replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();
export function tokens(title) {
  const words = title.toLowerCase().replace(/[’‘]/g, "'").replace(/'s\b/g, "").replace(/u\.s\./g, "us").split(/[^a-z0-9]+/);
  const out = new Set();
  for (let w of words) {
    if (w.length < 3 || STOP.has(w)) continue;
    if (w in SAME) w = SAME[w];
    else if (w.length > 4 && w.endsWith("s") && !w.endsWith("ss")) w = w.slice(0, -1);
    if (w) out.add(w);
  }
  return out;
}
// Two headlines are the same story when they share three distinctive words, or two that make up half of the shorter one.
export function same(a, b) {
  let n = 0;
  for (const w of a) if (b.has(w)) n++;
  return n >= 3 || (n >= 2 && n / Math.min(a.size, b.size) >= 0.5);
}

function parse(xml, outlet, now) {
  const items = [];
  for (const [, body] of xml.matchAll(/<item[\s>]([\s\S]*?)<\/item>/g)) {
    const pick = (tag) => body.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`))?.[1] ?? "";
    const title = decode(pick("title")).replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\uFE0F]/gu, "").trim().replace(/^[A-Z][A-Z' -]{3,30}:\s+(?=[A-Z])/, "").replace(/^[A-Za-z' ]{0,24}\blive( updates)?:\s*/i, "").replace(/\s+[–-] (live|as it happened).*$/i, "");
    const link = decode(pick("link")) || decode(pick("guid"));
    const at = Date.parse(decode(pick("pubDate")) || decode(pick("dc:date")));
    if (!title || title.length < 20 || !/^https:\/\//.test(link) || isNaN(at) || at > now + 3600e3 || now - at > WINDOW_H * 3600e3) continue;
    if (SKIP_TITLE.test(title) || SKIP_LINK.test(link)) continue;
    const t = tokens(title);
    if (t.size >= 3) items.push({ outlet, title, link, at, t, rank: items.length, fresh: now - at < FRESH_H * 3600e3 });
  }
  return items;
}

function cluster(items) {
  const out = [];
  // Items near the top of each feed are placed first, so a story forms around its most prominent headlines.
  for (const it of [...items].sort((a, b) => a.rank - b.rank)) {
    const home = out.find((s) => s.some((x) => same(x.t, it.t)));
    if (home) home.push(it);
    else out.push([it]);
  }
  return out;
}
// One headline per outlet: its newest one.
function perOutlet(items) {
  const by = new Map();
  for (const it of items) if (!by.has(it.outlet) || it.at > by.get(it.outlet).at) by.set(it.outlet, it);
  return by;
}
function story(items, lead, topic, min = MIN_OUTLETS) {
  const by = perOutlet(items), has = OUTLETS.filter((o) => by.has(o));
  return {
    title: lead.title, link: lead.link, outlet: lead.outlet, topic, n: has.length, min,
    fresh: has.filter((o) => by.get(o).fresh).length,
    links: has.map((o) => ({ o, u: by.get(o).link, t: clip(by.get(o).title, 140) })),
    first: Math.min(...items.map((x) => x.at)), last: Math.max(...items.map((x) => x.at)),
  };
}
// The headline shown comes from the first outlet in the list with new coverage, or failing that, any coverage.
const leadOf = (items) => { const all = OUTLETS.map((o) => perOutlet(items).get(o)).filter(Boolean); return all.find((x) => x.fresh) ?? all[0]; };
const freshOutlets = (items) => [...perOutlet(items).values()].filter((x) => x.fresh).length;

export function group(items) {
  const stories = [], rest = [];
  const threads = new Map(THREADS.map(([name]) => [name, []]));
  for (const it of items) {
    const hit = THREADS.find(([, re]) => re.test(it.title));
    (hit ? threads.get(hit[0]) : rest).push(it);
  }
  for (const [name, list] of threads) {
    if (!list.length) continue;
    // The headline shown is from the development most outlets are leading with.
    const main = cluster(list).sort((a, b) => freshOutlets(b) - freshOutlets(a) || perOutlet(b).size - perOutlet(a).size || Math.min(...a.map((x) => x.rank)) - Math.min(...b.map((x) => x.rank)))[0];
    stories.push(story([...main, ...list.filter((x) => !main.includes(x) && !perOutlet(main).has(x.outlet))], leadOf(main), name));
  }
  for (const c of cluster(rest)) {
    const titles = [...perOutlet(c).values()].map((x) => x.title);
    const flag = FLAGS.find(([, re]) => titles.filter((t) => re.test(t)).length >= 2)?.[0];
    stories.push(story(c, leadOf(c), flag, flag ? 2 : MIN_OUTLETS));
  }
  return stories;
}

export default [
  {
    id: "news",
    every: 10,
    async run(ctx) {
      const pages = await Promise.all(FEEDS.map(async ([outlet, url]) => {
        const res = await ctx.get(url);
        return res.ok ? parse(res.text, outlet, ctx.now) : null;
      }));
      const answered = new Set(FEEDS.filter((_, i) => pages[i]).map((f) => f[0]));
      need(answered.size >= 6, `only ${answered.size} of ${OUTLETS.length} news outlets answered`);
      const stories = group(pages.filter(Boolean).flat())
        .filter((s) => s.n >= s.min)
        // Stories with new coverage come first. A watched topic ranks as if two more outlets carried it.
        .sort((a, b) => (b.fresh > 0) - (a.fresh > 0) || b.fresh + (b.topic ? 2 : 0) + b.n / 4 - (a.fresh + (a.topic ? 2 : 0) + a.n / 4) || b.last - a.last)
        .slice(0, SHOWN)
        .map(({ min, ...s }) => ({ ...s, title: clip(s.title, 150), first: new Date(s.first).toISOString(), last: new Date(s.last).toISOString() }));
      return { kind: "news", stories, outlets: OUTLETS.length, answered: answered.size };
    },
  },
];

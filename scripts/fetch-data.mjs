/**
 * Brand Solar System — data pipeline
 *
 * Reads COMPANY_NAME + MONID_API_KEY from .env, pulls rich brand data from
 * monid.ai across many sources (PDL, Akta, Twitter/X, LinkedIn, Instagram,
 * TikTok, Reddit, Hacker News, Xiaohongshu, News, GitHub), then normalizes
 * everything into data/company.json for the 3D frontend.
 *
 * Usage: npm run fetch
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const RAW_DIR = path.join(DATA_DIR, "raw");

const COMPANY = process.env.COMPANY_NAME;
const KEY = process.env.MONID_API_KEY;
const BASE = process.env.MONID_API_BASE_URL || "https://api.monid.ai";

if (!COMPANY || !KEY) {
  console.error("Missing COMPANY_NAME or MONID_API_KEY in .env");
  process.exit(1);
}

fs.mkdirSync(RAW_DIR, { recursive: true });

// ---------------------------------------------------------------- monid api
let WORKSPACE = process.env.MONID_WORKSPACE_ID || null;

async function api(pathname, opts = {}) {
  const res = await fetch(BASE + pathname, {
    ...opts,
    headers: {
      Authorization: `Bearer ${KEY}`,
      "Content-Type": "application/json",
      ...(WORKSPACE ? { "x-workspace-id": WORKSPACE } : {}),
      ...(opts.headers || {}),
    },
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

async function ensureWorkspace() {
  if (WORKSPACE) return;
  const { body } = await api("/v1/auth/whoami");
  WORKSPACE = body?.workspace?.workspaceId;
  if (!WORKSPACE) throw new Error("Could not resolve workspace id from /v1/auth/whoami");
  console.log(`workspace: ${WORKSPACE} (${body.workspace.name})`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CACHED = process.argv.includes("--cached");

/** Execute a monid endpoint; handles sync 200 and async 202 + polling. */
async function runEndpoint(label, provider, endpoint, input, { timeoutMs = 150_000 } = {}) {
  const rawFile = path.join(RAW_DIR, `${label}.json`);
  if (CACHED && fs.existsSync(rawFile)) {
    const run = JSON.parse(fs.readFileSync(rawFile, "utf8"));
    const ok = run?.status === "COMPLETED" && (run?.providerResponse?.httpStatus ?? 200) < 400;
    console.log(`${ok ? "ok " : "ERR"} ${label.padEnd(14)} (cached)`);
    return ok ? run.output : null;
  }
  const t0 = Date.now();
  try {
    const { status, body } = await api("/v1/run", {
      method: "POST",
      body: JSON.stringify({ provider, endpoint, input }),
    });
    let run = body;
    if (status === 202) {
      const runId = body.runId;
      while (Date.now() - t0 < timeoutMs) {
        await sleep(4000);
        const r = await api(`/v1/runs/${runId}`);
        run = r.body;
        if (run?.status === "COMPLETED" || run?.status === "FAILED") break;
      }
    } else if (status >= 400) {
      throw new Error(`HTTP ${status}: ${body?.message}`);
    }
    const httpStatus = run?.providerResponse?.httpStatus ?? 200;
    const ok = run?.status === "COMPLETED" && httpStatus < 400;
    fs.writeFileSync(path.join(RAW_DIR, `${label}.json`), JSON.stringify(run, null, 2));
    console.log(`${ok ? "ok " : "ERR"} ${label.padEnd(14)} status=${run?.status} http=${httpStatus} ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    return ok ? run.output : null;
  } catch (e) {
    console.log(`ERR ${label.padEnd(14)} ${e.message}`);
    return null;
  }
}

// ------------------------------------------------------------ text analysis
const STOP = new Set(
  `a an the and or but if then else for while of on in to from with without at by is are was were be been being do does did have has had it its it's this that these those we you they i he she them his her our your their us as not no yes so too very can could will would should may might must about into over under again further once here there when where why how all any both each few more most other some such only own same than
 https http com www rt amp just like get got new one two via what who out up down now today day says said say make made using use news years year week month time people world big small good great best
 openai chatgpt gpt ai artificial intelligence company companies`.split(/\s+/)
);

function extractKeywords(texts, limit = 14) {
  const freq = new Map();
  for (const t of texts) {
    if (!t) continue;
    const words = String(t)
      .toLowerCase()
      .replace(/https?:\/\/\S+/g, " ")
      .replace(/[^a-z0-9\u4e00-\u9fff#@' ]+/g, " ")
      .split(/\s+/);
    for (let w of words) {
      w = w.replace(/^[@#']+|'+$/g, "");
      if (w.length < 3 || w.length > 24 || STOP.has(w) || /^\d+$/.test(w)) continue;
      freq.set(w, (freq.get(w) || 0) + 1);
    }
  }
  const list = [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([text, count]) => ({ text, count }));
  list.diversity = freq.size; // distinct keyword pool size before truncation
  return list;
}

const POS = new Set("love loved amazing awesome great excellent good best incredible impressive beautiful wow win winning success successful helpful happy excited exciting cool fantastic brilliant genius powerful revolutionary breakthrough insane wild".split(" "));
const NEG = new Set("hate hated bad worst terrible awful broken fail failed failure scam lawsuit sue sued angry disappointed disappointing problem problems issue issues bug bugs wrong scary dangerous fear worried worry concern concerns risk lies lying fake down outage".split(" "));

function sentimentOf(texts) {
  let p = 0, n = 0;
  for (const t of texts) {
    if (!t) continue;
    for (const w of String(t).toLowerCase().split(/\W+/)) {
      if (POS.has(w)) p++;
      else if (NEG.has(w)) n++;
    }
  }
  if (p + n === 0) return 0;
  // dampen extreme scores from tiny samples
  return ((p - n) / (p + n)) * Math.min(1, (p + n) / 6); // -1..1
}

const log10 = (x) => Math.log10(Math.max(1, Number(x) || 0));

// ----------------------------------------------------------------- pipeline
async function main() {
  console.log(`\nFetching brand universe for "${COMPANY}" via ${BASE}\n`);
  await ensureWorkspace();

  // ---- Step 1: PDL company enrichment (gives us website + social urls)
  const pdl = await runEndpoint("pdl", "pdl", "/v5/company/enrich", {
    name: COMPANY,
    titlecase: true,
  });

  const website = pdl?.website ? `https://${String(pdl.website).replace(/^https?:\/\//, "")}` : null;
  const handleFromUrl = (u) => (u ? String(u).replace(/\/$/, "").split("/").pop() : null);
  const twitterHandle = handleFromUrl(pdl?.twitter_url) || COMPANY.replace(/\s+/g, "");
  const linkedinSlug = handleFromUrl(pdl?.linkedin_url) || COMPANY.toLowerCase().replace(/\s+/g, "-");
  const guessHandle = COMPANY.toLowerCase().replace(/[^a-z0-9]/g, "");

  // ---- Step 2: all sources in parallel
  const q = (queryParams) => ({ queryParams });
  const [akta, twProfile, twPosts, li, ig, tk, rd, hn, xhs, news, gh,
         yt, gt, gtq, aktaRev] = await Promise.all([
    website
      ? runEndpoint("akta", "akta", "/v1/company/enrichment", q({
          company: website,
          sections: ["digital_presence", "company_assessment", "strategic_signal"],
        }))
      : null,
    runEndpoint("twitter_profile", "tikhub", "/api/v1/twitter/web/fetch_user_profile", q({ screen_name: twitterHandle })),
    runEndpoint("twitter_posts", "tikhub", "/api/v1/twitter/web/fetch_user_post_tweet", q({ screen_name: twitterHandle })),
    runEndpoint("linkedin", "tikhub", "/api/v1/linkedin/web_v2/get_company_profile", q({ url: linkedinSlug })),
    runEndpoint("instagram", "tikhub", "/api/v1/instagram/v2/fetch_user_posts", q({ username: guessHandle })),
    runEndpoint("tiktok", "tikhub", "/api/v1/tiktok/app/v3/fetch_user_post_videos", q({ unique_id: guessHandle, count: 20 })),
    runEndpoint("reddit", "tikhub", "/api/v1/reddit/app/fetch_dynamic_search", q({ query: COMPANY, need_format: true, sort: "HOT", time_range: "month" })),
    runEndpoint("hackernews", "api.kadec0.xyz", "/v1/hackernews", q({ mode: "search", q: COMPANY, maxItems: 25 })),
    runEndpoint("xiaohongshu", "tikhub", "/api/v1/xiaohongshu/app_v2/search_notes", q({ keyword: COMPANY })),
    runEndpoint("news", "blockrun.ai", "/api/v1/surf/search/news", q({ q: COMPANY })),
    runEndpoint("github", "api.kadec0.xyz", "/v1/github", q({ mode: "search", q: COMPANY, maxItems: 15 })),
    runEndpoint("youtube", "tikhub", "/api/v1/youtube/web/search_video", q({ search_query: COMPANY })),
    runEndpoint("gtrend", "google-trends.use.x402atlas.com", "/trend", q({ keyword: COMPANY })),
    runEndpoint("gtrend_queries", "google-trends.use.x402atlas.com", "/related-queries", q({ keyword: COMPANY, country: "us" })),
    website
      ? runEndpoint("akta_reviews", "akta", "/v1/company/employee-reviews", q({ company: website, limit: 10 }))
      : null,
  ]);

  // ------------------------------------------------------------- normalize
  const sources = [];
  const stripHtml = (s) => String(s || "").replace(/<[^>]*>/g, "");
  const addSource = (s, texts) => {
    if (!s) return;
    const keywords = s.keywords ?? extractKeywords(texts);
    const kwDiversity = s.kwDiversity ?? keywords.diversity ?? keywords.length;
    const sentiment = s.sentiment ?? sentimentOf(texts);
    const m = s.metrics || {};
    const reach = m.followers ?? m.views ?? m.plays ?? m.reach ?? null;
    const eng = m.engagement ?? m.likes ?? m.upvotes ?? m.points ?? null;
    const engagementRate = reach && eng ? Math.min(1, eng / reach) : null;
    sources.push({ ...s, keywords: [...keywords], kwDiversity, sentiment, engagementRate });
  };

  // Twitter / X
  if (twProfile || twPosts) {
    const tweets = (twPosts?.data?.timeline ?? twPosts?.timeline ?? []).filter(Boolean);
    const texts = tweets.map((t) => t.text || t.full_text || "");
    const eng = tweets.reduce((a, t) => a + (t.favorites || t.favorite_count || 0) + (t.retweets || t.retweet_count || 0) + (t.replies || 0), 0);
    addSource(
      {
        id: "twitter",
        name: "X / Twitter",
        color: "#7dd3fc",
        metrics: {
          followers: twProfile?.sub_count ?? null,
          posts: twProfile?.statuses_count ?? null,
          engagement: eng || null,
          verified: twProfile?.blue_verified ?? null,
        },
        magnitude: log10(twProfile?.sub_count),
        activity: Math.min(1, tweets.length / 20),
        items: tweets.slice(0, 6).map((t) => ({
          title: (t.text || t.full_text || "").slice(0, 120),
          engagement: (t.favorites || 0) + (t.retweets || 0),
        })),
        url: `https://x.com/${twitterHandle}`,
      },
      texts
    );
  }

  // LinkedIn
  if (li) {
    const c = li.data ?? li;
    const posts = c.recent_posts ?? [];
    const employees = c.employee_count ?? null;
    addSource(
      {
        id: "linkedin",
        name: "LinkedIn",
        color: "#60a5fa",
        metrics: { employees, recentPosts: posts.length || null },
        magnitude: log10(employees) + 2, // employee count is a much smaller scale than followers
        activity: Math.min(1, posts.length / 10),
        items: posts.slice(0, 6).map((p) => ({ title: (p.text || "").slice(0, 120), engagement: p.likes || 0 })),
        url: c.url || (pdl?.linkedin_url ? `https://${pdl.linkedin_url}` : null),
      },
      [c.description ?? "", ...posts.map((p) => p.text || "")]
    );
  }

  // Instagram
  if (ig) {
    const items = ig.data?.items ?? ig.items ?? [];
    const user = items[0]?.user ?? ig.data?.user ?? {};
    const texts = items.map((p) => p.caption?.text || "");
    const eng = items.reduce((a, p) => a + (p.like_count || 0) + (p.comment_count || 0), 0);
    addSource(
      {
        id: "instagram",
        name: "Instagram",
        color: "#f0abfc",
        metrics: { posts: items.length || null, engagement: eng || null, followers: user.follower_count ?? null },
        magnitude: log10(user.follower_count ?? eng),
        activity: Math.min(1, items.length / 12),
        items: items.slice(0, 6).map((p) => ({ title: (p.caption?.text || "post").slice(0, 120), engagement: (p.like_count || 0) + (p.comment_count || 0) })),
        url: `https://instagram.com/${guessHandle}`,
      },
      texts
    );
  }

  // TikTok
  if (tk) {
    const vids = tk.data?.aweme_list ?? tk.aweme_list ?? [];
    const author = vids[0]?.author ?? {};
    const texts = vids.map((v) => v.desc || "");
    const eng = vids.reduce((a, v) => a + (v.statistics?.digg_count || 0) + (v.statistics?.comment_count || 0) + (v.statistics?.share_count || 0), 0);
    addSource(
      {
        id: "tiktok",
        name: "TikTok",
        color: "#5eead4",
        metrics: { followers: author.follower_count ?? null, videos: vids.length || null, engagement: eng || null },
        magnitude: log10(author.follower_count ?? eng),
        activity: Math.min(1, vids.length / 15),
        items: vids.slice(0, 6).map((v) => ({ title: (v.desc || "video").slice(0, 120), engagement: v.statistics?.digg_count || 0 })),
        url: `https://tiktok.com/@${guessHandle}`,
      },
      texts
    );
  }

  // Reddit
  if (rd) {
    const edges = rd.search?.dynamic?.components?.main?.edges ?? [];
    const arr = edges
      .flatMap((e) => e?.node?.children ?? [])
      .map((ch) => ch?.post)
      .filter(Boolean)
      .map((p) => ({
        title: p.postTitle,
        text: p.content?.markdown || "",
        score: p.score || 0,
        num_comments: p.commentCount || 0,
        subreddit: p.subreddit?.name || "",
      }));
    const texts = arr.map((p) => `${p.title || ""} ${p.text || ""}`);
    const eng = arr.reduce((a, p) => a + (p.score || 0) + (p.num_comments || 0), 0);
    addSource(
      {
        id: "reddit",
        name: "Reddit",
        color: "#fb923c",
        metrics: { posts: arr.length || null, engagement: eng || null },
        magnitude: log10(eng),
        activity: Math.min(1, arr.length / 20),
        items: arr.slice(0, 6).map((p) => ({ title: (p.title || "").slice(0, 120), engagement: p.score || 0 })),
        url: `https://reddit.com/search/?q=${encodeURIComponent(COMPANY)}`,
      },
      texts
    );
  }

  // Hacker News
  if (hn) {
    const items = hn.items ?? hn.results ?? hn.stories ?? (Array.isArray(hn) ? hn : []);
    const texts = items.map((s) => s.title || "");
    const eng = items.reduce((a, s) => a + (s.points || s.score || 0) + (s.comments || s.num_comments || 0), 0);
    addSource(
      {
        id: "hackernews",
        name: "Hacker News",
        color: "#fdba74",
        metrics: { stories: items.length || null, points: eng || null },
        magnitude: log10(eng),
        activity: Math.min(1, items.length / 25),
        items: items.slice(0, 6).map((s) => ({ title: (s.title || "").slice(0, 120), engagement: s.points || s.score || 0 })),
        url: `https://hn.algolia.com/?q=${encodeURIComponent(COMPANY)}`,
      },
      texts
    );
  }

  // Xiaohongshu
  if (xhs) {
    const notes = (xhs.data?.items ?? xhs.items ?? [])
      .map((i) => i.note ?? i.note_card ?? i)
      .filter((n) => n && (n.title || n.desc || n.display_title));
    const texts = notes.map((n) => `${n.title || n.display_title || ""} ${n.desc || ""}`);
    const eng = notes.reduce((a, n) => a + Number(n.likes || n.liked_count || n.interact_info?.liked_count || 0), 0);
    addSource(
      {
        id: "xiaohongshu",
        name: "Xiaohongshu",
        color: "#fda4af",
        metrics: { notes: notes.length || null, likes: eng || null },
        magnitude: log10(eng),
        activity: Math.min(1, notes.length / 15),
        items: notes.slice(0, 6).map((n) => ({ title: (n.title || n.display_title || "note").slice(0, 120), engagement: Number(n.likes || n.liked_count || 0) })),
        url: `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(COMPANY)}`,
      },
      texts
    );
  }

  // News / Web
  if (news) {
    const arts = news.data ?? news.results ?? news.articles ?? news.items ?? (Array.isArray(news) ? news : []);
    const texts = arts.map((a) => `${a.title || ""} ${a.summary || a.snippet || a.description || ""}`);
    addSource(
      {
        id: "news",
        name: "News / Web",
        color: "#c4b5fd",
        metrics: { articles: arts.length || null },
        magnitude: log10(arts.length * 100),
        activity: Math.min(1, arts.length / 10),
        items: arts.slice(0, 6).map((a) => ({ title: (a.title || "").slice(0, 120), engagement: 0 })),
        url: website,
      },
      texts
    );
  }

  // GitHub
  if (gh) {
    const repos = gh.items ?? gh.repos ?? gh.results ?? (Array.isArray(gh) ? gh : []);
    const stars = repos.reduce((a, r) => a + (r.stars || r.stargazers_count || 0), 0);
    addSource(
      {
        id: "github",
        name: "GitHub",
        color: "#a5b4fc",
        metrics: { repos: repos.length || null, stars: stars || null },
        magnitude: log10(stars),
        activity: Math.min(1, repos.length / 15),
        items: repos.slice(0, 6).map((r) => ({ title: (r.full_name || r.name || "").slice(0, 120), engagement: r.stars || r.stargazers_count || 0 })),
        url: `https://github.com/search?q=${encodeURIComponent(COMPANY)}`,
      },
      repos.map((r) => r.description || "")
    );
  }

  // YouTube
  if (yt) {
    const vids = (yt.videos ?? []).filter((v) => v && !v.is_live_content);
    const views = vids.reduce((a, v) => a + (Number(v.number_of_views) || 0), 0);
    addSource(
      {
        id: "youtube",
        name: "YouTube",
        color: "#fca5a5",
        metrics: { videos: vids.length || null, views: views || null },
        magnitude: log10(views),
        activity: Math.min(1, vids.length / 20),
        items: vids.slice(0, 6).map((v) => ({ title: (v.title || "").slice(0, 120), engagement: Number(v.number_of_views) || 0 })),
        url: `https://www.youtube.com/results?search_query=${encodeURIComponent(COMPANY)}`,
      },
      vids.map((v) => `${v.title || ""} ${v.description || ""}`)
    );
  }

  // Google Search interest (trends)
  let trendInfo = null;
  if (gt?.series?.length) {
    const vals = gt.series.map((s) => Number(s.value) || 0);
    const last = vals[vals.length - 1];
    const prevAvg = vals.slice(0, -1).reduce((a, b) => a + b, 0) / Math.max(1, vals.length - 1);
    trendInfo = { interest: last, delta: prevAvg ? (last - prevAvg) / prevAvg : 0, series: gt.series.slice(-12) };
    const related = (gtq?.top ?? []).slice(0, 14).map((t) => ({ text: t.term, count: Math.max(1, Math.round(t.value / 8)) }));
    const rising = (gtq?.rising ?? []).slice(0, 4).map((t) => t.term);
    addSource({
      id: "gsearch",
      name: "Google Search",
      color: "#86efac",
      metrics: { interestNow: last, longTermAvg: Math.round(prevAvg), risingQueries: rising.join(", ") || null },
      magnitude: 2 + (last / 100) * 5,
      activity: last / 100,
      keywords: related,
      sentiment: 0,
      items: rising.map((t) => ({ title: `rising: ${t}`, engagement: 0 })),
      url: `https://trends.google.com/trends/explore?q=${encodeURIComponent(COMPANY)}`,
    }, []);
  }

  // Workplace (Akta employee reviews / Glassdoor)
  if (aktaRev?.data?.employee_reviews) {
    const er = aktaRev.data.employee_reviews;
    const rating = er.overall_rating?.glassdoor ?? null;
    const others = Object.fromEntries((er.other_ratings ?? []).map((r) => [r.type, r.value]));
    const reviews = er.reviews?.data ?? [];
    addSource({
      id: "workplace",
      name: "Workplace",
      color: "#d8b4fe",
      metrics: {
        glassdoor: rating,
        outlook: others.business_outlook != null ? Math.round(others.business_outlook * 100) + "%" : null,
        recommend: others.recommend_to_friend != null ? Math.round(others.recommend_to_friend * 100) + "%" : null,
        workLife: others.work_life_balance ?? null,
      },
      magnitude: 3 + (rating ?? 3) * 0.6,
      activity: Math.min(1, reviews.length / 10),
      sentiment: rating != null ? Math.max(-1, Math.min(1, (rating - 3.2) / 1.4)) : 0,
      items: reviews.slice(0, 6).map((r) => ({ title: `${"★".repeat(Math.round(r.rating || 0))} ${r.summary || ""}`.slice(0, 120), engagement: r.helpful_count || 0 })),
      url: website,
      keywords: extractKeywords(reviews.map((r) => `${r.summary || ""} ${r.pros || ""} ${r.cons || ""}`)),
    }, []);
  }

  // -------------------------------------------------------------- company
  const totalFollowers = sources.reduce((a, s) => a + (s.metrics.followers || 0), 0);
  const popularity = Math.min(1, sources.reduce((a, s) => a + s.magnitude, 0) / (sources.length * 8 || 1));
  const overallSentiment = sources.length
    ? sources.reduce((a, s) => a + s.sentiment, 0) / sources.length
    : 0;

  const out = {
    generatedAt: new Date().toISOString(),
    company: {
      name: pdl?.display_name || pdl?.name || COMPANY,
      website,
      description: pdl?.summary || twProfile?.desc || "",
      industry: pdl?.industry || null,
      founded: pdl?.founded || null,
      employees: pdl?.employee_count || null,
      headquarters: pdl?.location?.name || null,
      tags: (pdl?.tags || []).slice(0, 10),
      totalFollowers,
      popularity,
      sentiment: overallSentiment,
      trend: trendInfo,
      intel: (() => {
        // company-core intel from Akta (valuation, revenue, users, market position)
        const a = akta?.data;
        if (!a) return null;
        const scale = {};
        for (const si of a.strategic_signal?.scale_indicator ?? []) {
          const code = si.type?.code;
          if (code && !scale[code]) scale[code] = String(si.value).split("(")[0].trim();
        }
        return {
          marketPosition: (a.company_assessment?.market_position || "").slice(0, 420) || null,
          strengths: (a.company_assessment?.strengths ?? []).slice(0, 4).map((s) => s.headline).filter(Boolean),
          valuation: scale.valuation ?? null,
          funding: scale.funding_raised ?? null,
          revenue: scale.revenue ?? null,
          users: scale.user_engagement ?? scale.customer_count ?? null,
          profiles: (a.digital_presence?.social_media_profiles ?? []).map((p) => p.platform),
        };
      })(),
    },
    sources: sources.sort((a, b) => b.magnitude - a.magnitude),
  };

  fs.writeFileSync(path.join(DATA_DIR, "company.json"), JSON.stringify(out, null, 2));
  console.log(`\nWrote data/company.json — ${sources.length} sources, popularity=${popularity.toFixed(2)}, sentiment=${overallSentiment.toFixed(2)}`);

  const { body: bal } = await api("/v1/wallet/balance");
  if (bal?.balance) console.log(`Wallet balance: $${bal.balance.value}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

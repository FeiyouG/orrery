/**
 * Signal Solar System — shared data pipeline (browser + Node)
 *
 * Turns a subject (a company like "OpenAI" or a topic like "GPT-5.6") into a
 * normalized universe snapshot by querying monid.ai across many sources.
 *
 * Storage-agnostic: pass a `cache` adapter ({ get(label), set(label, run) })
 * — the Node CLI backs it with data/raw/<slug>/*.json files, the browser
 * backs it with IndexedDB. Cache-first: cached endpoints are free, misses
 * are fetched live (and charged). `fresh: true` bypasses the cache.
 */

export const DEFAULT_API_BASE = "https://api.monid.ai";

export const slugify = (s) =>
  String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log10 = (x) => Math.log10(Math.max(1, Number(x) || 0));

// ------------------------------------------------------------ text analysis
const STOP = new Set(
  `a an the and or but if then else for while of on in to from with without at by is are was were be been being do does did have has had it its it's this that these those we you they i he she them his her our your their us as not no yes so too very can could will would should may might must about into over under again further once here there when where why how all any both each few more most other some such only own same than
 https http com www rt amp just like get got new one two via what who out up down now today day says said say make made using use news years year week month time people world big small good great best
 ai artificial intelligence company companies`.split(/\s+/)
);

function makeKeywordExtractor(subject) {
  // the subject's own tokens are never interesting keywords
  const stop = new Set([...STOP, ...String(subject).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)]);
  return function extractKeywords(texts, limit = 14) {
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
        if (w.length < 3 || w.length > 24 || stop.has(w) || /^\d+$/.test(w)) continue;
        freq.set(w, (freq.get(w) || 0) + 1);
      }
    }
    const list = [...freq.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([text, count]) => ({ text, count }));
    list.diversity = freq.size; // distinct keyword pool size before truncation
    return list;
  };
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

// ----------------------------------------------------------------- pipeline
export async function whoami({ apiKey, apiBase = DEFAULT_API_BASE }) {
  const res = await fetch(`${apiBase}/v1/auth/whoami`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error?.message || body?.message || `whoami failed (HTTP ${res.status})`);
  const workspaceId = body?.workspace?.workspaceId;
  if (!workspaceId) throw new Error("could not resolve workspace from API key");
  return { workspaceId, workspaceName: body?.workspace?.name ?? null };
}

/**
 * Build a universe snapshot for a subject.
 * @returns {Promise<{snapshot: object, subjectType: string, balance: string|null, workspaceId: string}>}
 */
export async function buildUniverse({
  subject,
  subjectType: requestedType = "auto",
  apiKey,
  apiBase = DEFAULT_API_BASE,
  workspaceId = null,
  cache = null,
  fresh = false,
  onProgress = () => {},
} = {}) {
  if (!subject) throw new Error("subject required");
  if (!apiKey) throw new Error("Monid API key required");

  const SUBJECT = String(subject).trim();
  const SUBJECT_TYPE = String(requestedType || "auto").toLowerCase();
  const extractKeywords = makeKeywordExtractor(SUBJECT);

  const api = async (pathname, opts = {}) => {
    const res = await fetch(apiBase + pathname, {
      ...opts,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        ...(workspaceId ? { "x-workspace-id": workspaceId } : {}),
        ...(opts.headers || {}),
      },
    });
    const body = await res.json().catch(() => null);
    return { status: res.status, body };
  };

  /** Execute a monid endpoint; handles sync 200 and async 202 + polling. */
  async function runEndpoint(label, provider, endpoint, input, { timeoutMs = 150_000 } = {}) {
    if (!fresh && cache) {
      const run = await cache.get(label);
      if (run) {
        const ok = run?.status === "COMPLETED" && (run?.providerResponse?.httpStatus ?? 200) < 400;
        onProgress({ label, phase: "cached", ok });
        return ok ? run.output : null;
      }
      onProgress({ label, phase: "miss" });
    }
    // workspace resolved lazily so fully-cached rebuilds never touch the API
    if (!workspaceId) ({ workspaceId } = await whoami({ apiKey, apiBase }));
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
      } else if (status === 402) {
        const err = new Error("Monid balance empty — top up your wallet to keep scanning");
        err.payment = true;
        throw err;
      } else if (status >= 400) {
        throw new Error(`HTTP ${status}: ${body?.message}`);
      }
      const httpStatus = run?.providerResponse?.httpStatus ?? 200;
      const ok = run?.status === "COMPLETED" && httpStatus < 400;
      if (cache) await cache.set(label, run);
      onProgress({ label, phase: "done", ok, httpStatus, ms: Date.now() - t0, cost: run?.cost?.value ?? null });
      return ok ? run.output : null;
    } catch (e) {
      if (e.payment) throw e; // out of balance: abort the whole scan
      // cache hard failures so cache-first rebuilds don't retry (and re-pay)
      if (cache && !/whoami|API key/i.test(e.message)) {
        await cache.set(label, { status: "FAILED", error: e.message });
      }
      onProgress({ label, phase: "error", ok: false, error: e.message });
      return null;
    }
  }

  // ---- Step 1: PDL company enrichment (gives us website + social urls).
  // Skipped for topics; in auto mode the subject counts as a company only
  // when PDL actually recognizes it (a topic like "GPT-5.6" won't match).
  const pdl = SUBJECT_TYPE === "topic"
    ? null
    : await runEndpoint("pdl", "pdl", "/v5/company/enrich", {
        name: SUBJECT,
        titlecase: true,
      });

  // PDL fuzzy-matches loosely (it echoes back invented records for topics
  // like "Fable 5"), so require real substance: a website plus at least one
  // corporate fact before treating the subject as a company.
  const looksLikeCompany = !!(pdl?.website && (pdl?.employee_count || pdl?.founded || pdl?.linkedin_url));
  const isCompany = SUBJECT_TYPE === "company" || (SUBJECT_TYPE !== "topic" && looksLikeCompany);
  const subjectType = isCompany ? "company" : "topic";

  const website = pdl?.website ? `https://${String(pdl.website).replace(/^https?:\/\//, "")}` : null;
  const handleFromUrl = (u) => (u ? String(u).replace(/\/$/, "").split("/").pop() : null);
  const twitterHandle = handleFromUrl(pdl?.twitter_url) || SUBJECT.replace(/\s+/g, "");
  const linkedinSlug = handleFromUrl(pdl?.linkedin_url) || SUBJECT.toLowerCase().replace(/\s+/g, "-");
  const guessHandle = SUBJECT.toLowerCase().replace(/[^a-z0-9]/g, "");

  // ---- Step 2: all sources in parallel.
  // Keyword-driven sources work for any subject; account/company-based
  // sources (profiles, timelines, enrichment) only run in company mode.
  const q = (queryParams) => ({ queryParams });
  const [akta, twProfile, twPosts, li, ig, tk, rd, hn, xhs, news, gh,
         yt, gt, gtq, aktaRev, twSearch] = await Promise.all([
    isCompany && website
      ? runEndpoint("akta", "akta", "/v1/company/enrichment", q({
          company: website,
          sections: ["digital_presence", "company_assessment", "strategic_signal"],
        }))
      : null,
    isCompany ? runEndpoint("twitter_profile", "tikhub", "/api/v1/twitter/web/fetch_user_profile", q({ screen_name: twitterHandle })) : null,
    isCompany ? runEndpoint("twitter_posts", "tikhub", "/api/v1/twitter/web/fetch_user_post_tweet", q({ screen_name: twitterHandle })) : null,
    isCompany ? runEndpoint("linkedin", "tikhub", "/api/v1/linkedin/web_v2/get_company_profile", q({ url: linkedinSlug })) : null,
    isCompany ? runEndpoint("instagram", "tikhub", "/api/v1/instagram/v2/fetch_user_posts", q({ username: guessHandle })) : null,
    // discourse, not the subject's own account: search what people post ABOUT it
    runEndpoint("tiktok_search", "tikhub", "/api/v1/tiktok/app/v3/fetch_general_search_result", q({ keyword: SUBJECT, count: 20, offset: 0 })),
    runEndpoint("reddit", "tikhub", "/api/v1/reddit/app/fetch_dynamic_search", q({ query: SUBJECT, need_format: true, sort: "HOT", time_range: "month" })),
    runEndpoint("hackernews", "api.kadec0.xyz", "/v1/hackernews", q({ mode: "search", q: SUBJECT, maxItems: 25 })),
    runEndpoint("xiaohongshu", "tikhub", "/api/v1/xiaohongshu/app_v2/search_notes", q({ keyword: SUBJECT })),
    runEndpoint("news", "blockrun.ai", "/api/v1/surf/search/news", q({ q: SUBJECT })),
    runEndpoint("github", "api.kadec0.xyz", "/v1/github", q({ mode: "search", q: SUBJECT, maxItems: 15 })),
    runEndpoint("youtube", "tikhub", "/api/v1/youtube/web/search_video", q({ search_query: SUBJECT })),
    runEndpoint("gtrend", "google-trends.use.x402atlas.com", "/trend", q({ keyword: SUBJECT })),
    runEndpoint("gtrend_queries", "google-trends.use.x402atlas.com", "/related-queries", q({ keyword: SUBJECT, country: "us" })),
    isCompany && website
      ? runEndpoint("akta_reviews", "akta", "/v1/company/employee-reviews", q({ company: website, limit: 10 }))
      : null,
    // topics have no account timeline — search X by keyword instead
    !isCompany
      ? runEndpoint("twitter_search", "tikhub", "/api/v1/twitter/web/fetch_search_timeline", q({ keyword: SUBJECT, search_type: "Top" }))
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

  // Twitter / X — company: own timeline + profile; topic: keyword search
  const twFeed = twPosts ?? twSearch;
  if (twProfile || twFeed) {
    const tweets = (twFeed?.data?.timeline ?? twFeed?.timeline ?? []).filter(Boolean);
    const texts = tweets.map((t) => t.text || t.full_text || "");
    const eng = tweets.reduce((a, t) => a + (t.favorites || t.favorite_count || 0) + (t.retweets || t.retweet_count || 0) + (t.replies || 0), 0);
    addSource(
      {
        id: "twitter",
        name: "X / Twitter",
        color: "#7dd3fc",
        metrics: {
          followers: twProfile?.sub_count ?? null,
          posts: twProfile?.statuses_count ?? tweets.length ?? null,
          engagement: eng || null,
          verified: twProfile?.blue_verified ?? null,
        },
        magnitude: twProfile ? log10(twProfile.sub_count) : log10(eng * 30),
        activity: Math.min(1, tweets.length / 20),
        items: tweets.slice(0, 6).map((t) => ({
          title: (t.text || t.full_text || "").slice(0, 120),
          engagement: (t.favorites || 0) + (t.retweets || 0),
          url: t.tweet_id ? `https://x.com/i/web/status/${t.tweet_id}` : null,
        })),
        url: isCompany
          ? `https://x.com/${twitterHandle}`
          : `https://x.com/search?q=${encodeURIComponent(SUBJECT)}`,
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
        items: posts.slice(0, 6).map((p) => ({ title: (p.text || "").slice(0, 120), engagement: p.likes || 0, url: p.url || null })),
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
        items: items.slice(0, 6).map((p) => ({
          title: (p.caption?.text || "post").slice(0, 120),
          engagement: (p.like_count || 0) + (p.comment_count || 0),
          url: p.code ? `https://www.instagram.com/p/${p.code}/` : null,
        })),
        url: `https://instagram.com/${guessHandle}`,
      },
      texts
    );
  }

  // TikTok — keyword search: what the world posts about the subject
  if (tk) {
    const vids = (tk.data ?? []).map((i) => i?.aweme_info).filter((v) => v && v.desc != null);
    const texts = vids.map((v) => v.desc || "");
    const plays = vids.reduce((a, v) => a + (v.statistics?.play_count || 0), 0);
    const eng = vids.reduce((a, v) => a + (v.statistics?.digg_count || 0) + (v.statistics?.comment_count || 0) + (v.statistics?.share_count || 0), 0);
    addSource(
      {
        id: "tiktok",
        name: "TikTok",
        color: "#5eead4",
        metrics: { videos: vids.length || null, plays: plays || null, engagement: eng || null },
        magnitude: log10(Math.max(plays, eng * 30)),
        activity: Math.min(1, vids.length / 15),
        items: [...vids].sort((a, b) => (b.statistics?.digg_count || 0) - (a.statistics?.digg_count || 0))
          .slice(0, 6).map((v) => ({
            title: (v.desc || "video").slice(0, 120),
            engagement: v.statistics?.digg_count || 0,
            url: v.aweme_id ? `https://www.tiktok.com/@${v.author?.unique_id || "user"}/video/${v.aweme_id}` : null,
          })),
        url: `https://www.tiktok.com/search?q=${encodeURIComponent(SUBJECT)}`,
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
        link: /^https?:/.test(p.url || "") ? p.url : p.permalink ? `https://www.reddit.com${p.permalink}` : null,
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
        items: arr.slice(0, 6).map((p) => ({ title: (p.title || "").slice(0, 120), engagement: p.score || 0, url: p.link })),
        url: `https://reddit.com/search/?q=${encodeURIComponent(SUBJECT)}`,
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
        items: items.slice(0, 6).map((s) => ({
          title: (s.title || "").slice(0, 120),
          engagement: s.points || s.score || 0,
          url: s.hnUrl || (s.objectID ? `https://news.ycombinator.com/item?id=${s.objectID}` : s.url || null),
        })),
        url: `https://hn.algolia.com/?q=${encodeURIComponent(SUBJECT)}`,
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
        items: notes.slice(0, 6).map((n) => ({
          title: (n.title || n.display_title || "note").slice(0, 120),
          engagement: Number(n.likes || n.liked_count || 0),
          url: n.id ? `https://www.xiaohongshu.com/explore/${n.id}` : null,
        })),
        url: `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(SUBJECT)}`,
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
        items: arts.slice(0, 6).map((a) => ({ title: (a.title || "").slice(0, 120), engagement: 0, url: a.url || a.link || null })),
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
        items: repos.slice(0, 6).map((r) => ({
          title: (r.full_name || r.name || "").slice(0, 120),
          engagement: r.stars || r.stargazers_count || 0,
          url: r.url || r.html_url || (r.full_name ? `https://github.com/${r.full_name}` : null),
        })),
        url: `https://github.com/search?q=${encodeURIComponent(SUBJECT)}`,
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
        items: vids.slice(0, 6).map((v) => ({
          title: (v.title || "").slice(0, 120),
          engagement: Number(v.number_of_views) || 0,
          url: v.video_id ? `https://www.youtube.com/watch?v=${v.video_id}` : null,
        })),
        url: `https://www.youtube.com/results?search_query=${encodeURIComponent(SUBJECT)}`,
      },
      vids.map((v) => `${v.title || ""} ${v.description || ""}`)
    );
  }

  // Google Search interest (trends)
  let trendInfo = null;
  let relatedTerms = [];
  if (gt?.series?.length) {
    const vals = gt.series.map((s) => Number(s.value) || 0);
    const last = vals[vals.length - 1];
    const prevAvg = vals.slice(0, -1).reduce((a, b) => a + b, 0) / Math.max(1, vals.length - 1);
    trendInfo = { interest: last, delta: prevAvg ? (last - prevAvg) / prevAvg : 0, series: gt.series.slice(-12) };
    const related = (gtq?.top ?? []).slice(0, 14).map((t) => ({ text: t.term, count: Math.max(1, Math.round(t.value / 8)) }));
    relatedTerms = related.map((r) => r.text);
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
      items: rising.map((t) => ({ title: `rising: ${t}`, engagement: 0, url: `https://trends.google.com/trends/explore?q=${encodeURIComponent(t)}` })),
      url: `https://trends.google.com/trends/explore?q=${encodeURIComponent(SUBJECT)}`,
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
      name: pdl?.display_name || pdl?.name || SUBJECT,
      subjectType,
      website,
      description: pdl?.summary || twProfile?.desc || "",
      industry: pdl?.industry || null,
      founded: pdl?.founded || null,
      employees: pdl?.employee_count || null,
      headquarters: pdl?.location?.name || null,
      tags: (isCompany ? pdl?.tags || [] : relatedTerms).slice(0, 10),
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

  onProgress({ phase: "normalized", sources: sources.length, popularity, sentiment: overallSentiment, subjectType });

  let balance = null;
  try {
    const { body: bal } = await api("/v1/wallet/balance");
    balance = bal?.balance?.value ?? null;
  } catch { /* non-fatal */ }

  return { snapshot: out, subjectType, balance, workspaceId };
}

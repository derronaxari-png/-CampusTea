require("dotenv").config();
const express = require("express");
const path = require("path");
const { Pool } = require("pg");
const { randomUUID } = require("crypto");

const app = express();
const port = process.env.PORT || 3000;
const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
    })
  : null;

app.disable("x-powered-by");
app.use(express.json({ limit: "12kb" }));
app.use(express.static(path.join(__dirname, "../public")));

const categories = new Set(["Hot take", "Campus", "Dating", "Confessions"]);
const localPosts = [];
const localReactions = new Map();

/* ---------- In-memory rate limiter ---------- */
const rateBuckets = new Map();
function rateLimit({ max, windowMs, keyFn }) {
  return (req, res, next) => {
    const key = keyFn(req);
    if (!key) return res.status(400).json({ error: "Missing identity. Refresh and try again." });
    const now = Date.now();
    const arr = (rateBuckets.get(key) || []).filter((t) => now - t < windowMs);
    if (arr.length >= max) {
      const minutes = Math.ceil(windowMs / 60000);
      return res.status(429).json({
        error: `Slow down — the kettle's still hot. Try again in ${minutes} minutes.`,
      });
    }
    arr.push(now);
    rateBuckets.set(key, arr);
    next();
  };
}

const visitorKey = (req) => {
  const v = req.body && req.body.visitorId;
  return typeof v === "string" && /^[\w-]{16,80}$/.test(v) ? v : req.ip;
};

// Periodically clean buckets so memory doesn't grow forever
setInterval(() => {
  const now = Date.now();
  for (const [k, arr] of rateBuckets) {
    const kept = arr.filter((t) => now - t < 60 * 60 * 1000);
    if (kept.length) rateBuckets.set(k, kept);
    else rateBuckets.delete(k);
  }
}, 10 * 60 * 1000);

function cleanText(value, maxLength) {
  if (typeof value !== "string") return "";
  return value.trim().replace(/\s+/g, " ").slice(0, maxLength);
}

async function initializeDatabase() {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS posts (
      id TEXT PRIMARY KEY,
      alias TEXT NOT NULL,
      category TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS comments (
      id TEXT PRIMARY KEY,
      post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      alias TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS reactions (
      post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      visitor_id TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (post_id, visitor_id)
    );
    ALTER TABLE posts ADD COLUMN IF NOT EXISTS visitor_id TEXT;
    ALTER TABLE posts ADD COLUMN IF NOT EXISTS hidden BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE posts ADD COLUMN IF NOT EXISTS report_count INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE comments ADD COLUMN IF NOT EXISTS visitor_id TEXT;
    CREATE TABLE IF NOT EXISTS reports (
      id TEXT PRIMARY KEY,
      post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      reporter_visitor_id TEXT NOT NULL,
      reason TEXT NOT NULL CHECK (reason IN ('bullying','doxxing','spam','other')),
      note TEXT,
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','hidden','dismissed')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (post_id, reporter_visitor_id)
    );
    CREATE INDEX IF NOT EXISTS comments_post_created_idx ON comments(post_id, created_at);
    CREATE INDEX IF NOT EXISTS posts_created_idx ON posts(created_at DESC);
    CREATE INDEX IF NOT EXISTS posts_hidden_idx ON posts(hidden);
    CREATE INDEX IF NOT EXISTS reports_status_idx ON reports(status, created_at DESC);
  `);
}

async function getPosts() {
  if (!pool) {
    return localPosts
      .filter((p) => !p.hidden)
      .slice(0, 60)
      .map((post) => ({
        ...post,
        comments: post.comments.slice(-4),
        comment_count: post.comments.length,
      }));
  }

  const { rows } = await pool.query(`
    SELECT p.id, p.alias, p.category, p.body, p.created_at,
      (SELECT COUNT(*)::int FROM reactions r WHERE r.post_id = p.id) AS reactions,
      (SELECT COUNT(*)::int FROM comments c WHERE c.post_id = p.id) AS comment_count,
      (SELECT COALESCE(json_agg(json_build_object(
          'id', recent.id, 'alias', recent.alias, 'body', recent.body, 'created_at', recent.created_at
        ) ORDER BY recent.created_at), '[]'::json)
        FROM (
          SELECT id, alias, body, created_at
          FROM comments
          WHERE post_id = p.id
          ORDER BY created_at DESC
          LIMIT 4
        ) recent
      ) AS comments
    FROM posts p
    WHERE p.hidden = FALSE
    ORDER BY p.created_at DESC
    LIMIT 60
  `);
  return rows;
}

app.get("/api/posts", async (_request, response) => {
  try {
    response.json({ posts: await getPosts() });
  } catch (error) {
    console.error("Could not load campus posts:", error);
    response.status(503).json({ error: "The tea is taking a moment to load. Try again shortly." });
  }
});

/* ---------- Post creation (rate-limited) ---------- */
app.post(
  "/api/posts",
  rateLimit({ max: 3, windowMs: 60 * 60 * 1000, keyFn: visitorKey }),
  async (request, response) => {
    const payload = request.body && typeof request.body === "object" ? request.body : {};
    const body = cleanText(payload.body, 500);
    const category = cleanText(payload.category, 30);
    const alias = cleanText(payload.alias, 28) || "Campus insider";
    const visitorId = cleanText(payload.visitorId, 80);

    if (body.length < 8) {
      return response.status(400).json({ error: "Give the campus something more than a one-liner (8 characters minimum)." });
    }
    if (!categories.has(category)) {
      return response.status(400).json({ error: "Choose one of the campus tea categories." });
    }

    const post = {
      id: randomUUID(),
      alias,
      category,
      body,
      visitor_id: visitorId || null,
      created_at: new Date().toISOString(),
      reactions: 0,
      comments: [],
    };

    try {
      if (pool) {
        await pool.query(
          "INSERT INTO posts (id, alias, category, body, visitor_id) VALUES ($1, $2, $3, $4, $5)",
          [post.id, post.alias, post.category, post.body, post.visitor_id],
        );
      } else {
        localPosts.unshift(post);
        localReactions.set(post.id, new Set());
      }
      delete post.visitor_id; // Don't send the visitor ID back to the client
      response.status(201).json({ post });
    } catch (error) {
      console.error("Could not publish campus post:", error);
      response.status(503).json({ error: "Your post couldn't be published. Please try again." });
    }
  },
);

/* ---------- Comment creation (rate-limited) ---------- */
app.post(
  "/api/posts/:postId/comments",
  rateLimit({ max: 10, windowMs: 60 * 60 * 1000, keyFn: visitorKey }),
  async (request, response) => {
    const payload = request.body && typeof request.body === "object" ? request.body : {};
    const body = cleanText(payload.body, 240);
    const alias = cleanText(payload.alias, 28) || "Campus insider";
    const visitorId = cleanText(payload.visitorId, 80);
    if (body.length < 2) {
      return response.status(400).json({ error: "Add a little more to your reply." });
    }

    const comment = { id: randomUUID(), alias, body, created_at: new Date().toISOString() };
    try {
      if (pool) {
        const result = await pool.query(
          "INSERT INTO comments (id, post_id, alias, body, visitor_id) SELECT $1, id, $3, $4, $5 FROM posts WHERE id = $2 AND hidden = FALSE RETURNING id",
          [comment.id, request.params.postId, alias, body, visitorId || null],
        );
        if (!result.rowCount) return response.status(404).json({ error: "That post is no longer here." });
      } else {
        const post = localPosts.find((item) => item.id === request.params.postId);
        if (!post || post.hidden) return response.status(404).json({ error: "That post is no longer here." });
        post.comments.push(comment);
      }
      response.status(201).json({ comment });
    } catch (error) {
      console.error("Could not add comment:", error);
      response.status(503).json({ error: "Your reply couldn't be sent. Please try again." });
    }
  },
);

/* ---------- Reactions (unchanged from your original) ---------- */
app.post("/api/posts/:postId/reactions", async (request, response) => {
  const payload = request.body && typeof request.body === "object" ? request.body : {};
  const visitorId = cleanText(payload.visitorId, 80);
  if (!/^[\w-]{16,80}$/.test(visitorId)) {
    return response.status(400).json({ error: "Refresh the page to try that reaction again." });
  }

  try {
    if (pool) {
      const exists = await pool.query("SELECT 1 FROM posts WHERE id = $1", [request.params.postId]);
      if (!exists.rowCount) return response.status(404).json({ error: "That post is no longer here." });
      await pool.query(
        `INSERT INTO reactions (post_id, visitor_id) VALUES ($1, $2)
         ON CONFLICT (post_id, visitor_id) DO NOTHING`,
        [request.params.postId, visitorId],
      );
      const { rows } = await pool.query(
        "SELECT COUNT(*)::int AS reactions FROM reactions WHERE post_id = $1",
        [request.params.postId],
      );
      return response.json({ reactions: rows[0].reactions });
    }

    const post = localPosts.find((item) => item.id === request.params.postId);
    if (!post) return response.status(404).json({ error: "That post is no longer here." });
    const reactions = localReactions.get(post.id);
    reactions.add(visitorId);
    response.json({ reactions: reactions.size });
  } catch (error) {
    console.error("Could not react to post:", error);
    response.status(503).json({ error: "Your reaction couldn't be saved. Please try again." });
  }
});

/* ---------- NEW: Reporting ---------- */
app.post(
  "/api/posts/:postId/report",
  rateLimit({ max: 20, windowMs: 60 * 60 * 1000, keyFn: visitorKey }),
  async (request, response) => {
    const payload = request.body && typeof request.body === "object" ? request.body : {};
    const reason = cleanText(payload.reason, 20);
    const note = cleanText(payload.note, 300);
    const visitorId = cleanText(payload.visitorId, 80);
    const validReasons = new Set(["bullying", "doxxing", "spam", "other"]);
    
    if (!validReasons.has(reason)) {
      return response.status(400).json({ error: "Pick a reason for the report." });
    }
    if (!visitorId || !/^[\w-]{16,80}$/.test(visitorId)) {
      return response.status(400).json({ error: "Refresh and try again." });
    }

    try {
      if (pool) {
        const exists = await pool.query("SELECT 1 FROM posts WHERE id = $1 AND hidden = FALSE", [request.params.postId]);
        if (!exists.rowCount) return response.status(404).json({ error: "That post is no longer here." });
        
        const inserted = await pool.query(
          `INSERT INTO reports (id, post_id, reporter_visitor_id, reason, note)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (post_id, reporter_visitor_id) DO NOTHING
           RETURNING id`,
          [randomUUID(), request.params.postId, visitorId, reason, note || null],
        );
        if (inserted.rowCount) {
          await pool.query("UPDATE posts SET report_count = report_count + 1 WHERE id = $1", [request.params.postId]);
        }
      } else {
        const post = localPosts.find((p) => p.id === request.params.postId);
        if (!post) return response.status(404).json({ error: "That post is no longer here." });
        post.report_count = (post.report_count || 0) + 1;
      }
      response.status(201).json({ ok: true });
    } catch (error) {
      console.error("Could not record report:", error);
      response.status(503).json({ error: "Report couldn't be saved. Try again." });
    }
  },
);

/* ---------- NEW: Admin Dashboard ---------- */
function requireAdmin(req, res, next) {
  const password = process.env.ADMIN_PASSWORD;
  if (!password) return res.status(503).send("ADMIN_PASSWORD not configured.");
  const auth = req.headers.authorization || "";
  const [scheme, encoded] = auth.split(" ");
  
  if (scheme !== "Basic" || !encoded) {
    return res.set("WWW-Authenticate", 'Basic realm="admin"').status(401).send("Auth required");
  }
  
  const [, provided] = Buffer.from(encoded, "base64").toString().split(":");
  if (provided !== password) {
    return res.set("WWW-Authenticate", 'Basic realm="admin"').status(401).send("Bad password");
  }
  next();
}

app.get("/admin", requireAdmin, async (_req, res) => {
  try {
    if (!pool) return res.status(503).send("Admin requires a database.");
    const { rows } = await pool.query(`
      SELECT p.id, p.alias, p.category, p.body, p.created_at, p.hidden, p.report_count,
        (SELECT json_agg(json_build_object('reason', r.reason, 'note', r.note, 'at', r.created_at))
         FROM reports r WHERE r.post_id = p.id AND r.status = 'open') AS reports
      FROM posts p
      WHERE p.report_count > 0 OR p.hidden = TRUE
      ORDER BY p.report_count DESC, p.created_at DESC
      LIMIT 100
    `);
    
    const rowsHtml = rows.map((p) => `
      <tr class="${p.hidden ? "hidden-row" : ""}">
        <td><code>${p.id.slice(0, 8)}</code></td>
        <td>${p.category}</td>
        <td>${p.body.replace(/[<>&"]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c]))}</td>
        <td>${p.report_count}</td>
        <td>${(p.reports || []).map(r => r.reason).join(", ") || "—"}</td>
        <td>${p.hidden ? "HIDDEN" : "live"}</td>
        <td>
          <form method="POST" action="/admin/posts/${p.id}/hide" style="display:inline">
            <button>${p.hidden ? "Unhide" : "Hide"}</button>
          </form>
          <form method="POST" action="/admin/posts/${p.id}/dismiss" style="display:inline">
            <button>Dismiss</button>
          </form>
        </td>
      </tr>`).join("");

    res.send(`<!doctype html>
      <html><head><meta charset="utf-8"><title>Moderation</title>
      <style>
        body{font:14px system-ui;background:#0b0c0f;color:#eaeaea;padding:2rem}
        table{width:100%;border-collapse:collapse}th,td{padding:.5rem;border-bottom:1px solid #222;text-align:left;vertical-align:top}
        .hidden-row{opacity:.5}button{background:#c8ff4d;border:0;padding:.25rem .6rem;cursor:pointer;border-radius:4px;margin-right:.25rem}
        code{color:#c8ff4d}
      </style></head><body>
      <h1>Moderation queue</h1>
      <p>${rows.length} post(s) flagged or hidden.</p>
      <table><thead><tr><th>ID</th><th>Category</th><th>Body</th><th>Reports</th><th>Reasons</th><th>State</th><th></th></tr></thead>
      <tbody>${rowsHtml || "<tr><td colspan=7>All clear.</td></tr>"}</tbody></table>
      </body></html>`);
  } catch (e) {
    console.error(e);
    res.status(500).send("Admin error");
  }
});

app.post("/admin/posts/:id/hide", requireAdmin, async (req, res) => {
  await pool.query("UPDATE posts SET hidden = NOT hidden WHERE id = $1", [req.params.id]);
  res.redirect("/admin");
});

app.post("/admin/posts/:id/dismiss", requireAdmin, async (req, res) => {
  await pool.query("UPDATE reports SET status='dismissed' WHERE post_id=$1", [req.params.id]);
  await pool.query("UPDATE posts SET report_count = 0 WHERE id = $1", [req.params.id]);
  res.redirect("/admin");
});

/* ---------- Catch-all for the frontend ---------- */
app.get(/.*/, (_request, response) => {
  response.sendFile(path.join(__dirname, "../public", "index.html"));
});

// Export the app for Vercel
module.exports = app;

// Initialize the database in the background
initializeDatabase().catch(console.error);
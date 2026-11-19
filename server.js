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
app.use(express.static(path.join(__dirname, "public")));

const categories = new Set(["Hot take", "Campus", "Dating", "Confessions"]);
const localPosts = [];
const localReactions = new Map();

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
    CREATE INDEX IF NOT EXISTS comments_post_created_idx ON comments(post_id, created_at);
    CREATE INDEX IF NOT EXISTS posts_created_idx ON posts(created_at DESC);
  `);
}

async function getPosts() {
  if (!pool) {
    return localPosts.slice(0, 60).map((post) => ({
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

app.post("/api/posts", async (request, response) => {
  const payload = request.body && typeof request.body === "object" ? request.body : {};
  const body = cleanText(payload.body, 500);
  const category = cleanText(payload.category, 30);
  const alias = cleanText(payload.alias, 28) || "Campus insider";
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
    created_at: new Date().toISOString(),
    reactions: 0,
    comments: [],
  };
  try {
    if (pool) {
      await pool.query(
        "INSERT INTO posts (id, alias, category, body) VALUES ($1, $2, $3, $4)",
        [post.id, post.alias, post.category, post.body],
      );
    } else {
      localPosts.unshift(post);
      localReactions.set(post.id, new Set());
    }
    response.status(201).json({ post });
  } catch (error) {
    console.error("Could not publish campus post:", error);
    response.status(503).json({ error: "Your post couldn't be published. Please try again." });
  }
});

app.post("/api/posts/:postId/comments", async (request, response) => {
  const payload = request.body && typeof request.body === "object" ? request.body : {};
  const body = cleanText(payload.body, 240);
  const alias = cleanText(payload.alias, 28) || "Campus insider";
  if (body.length < 2) {
    return response.status(400).json({ error: "Add a little more to your reply." });
  }

  const comment = { id: randomUUID(), alias, body, created_at: new Date().toISOString() };
  try {
    if (pool) {
      const result = await pool.query(
        "INSERT INTO comments (id, post_id, alias, body) SELECT $1, id, $3, $4 FROM posts WHERE id = $2 RETURNING id",
        [comment.id, request.params.postId, alias, body],
      );
      if (!result.rowCount) return response.status(404).json({ error: "That post is no longer here." });
    } else {
      const post = localPosts.find((item) => item.id === request.params.postId);
      if (!post) return response.status(404).json({ error: "That post is no longer here." });
      post.comments.push(comment);
    }
    response.status(201).json({ comment });
  } catch (error) {
    console.error("Could not add comment:", error);
    response.status(503).json({ error: "Your reply couldn't be sent. Please try again." });
  }
});

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

app.get(/.*/, (_request, response) => {
  response.sendFile(path.join(__dirname, "public", "index.html"));
});

initializeDatabase()
  .then(() => app.listen(port, () => console.log(`Knutsford Campus Tea listening on ${port}`)))
  .catch((error) => {
    console.error("Could not initialize the database:", error);
    process.exit(1);
  });

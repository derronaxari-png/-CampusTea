const postList = document.querySelector("#post-list");
const composer = document.querySelector("#post-body");
const categorySelect = document.querySelector("#post-category");
const spillButton = document.querySelector("#spill-button");
const formMessage = document.querySelector("#form-message");
const toast = document.querySelector("#toast");
const charCount = document.querySelector("#char-count");
const visitorId = getVisitorId();
const reactedPosts = new Set();
let toastTimer;
let lastPostsSignature = "";

function getVisitorId() {
  const key = "knutsford-tea-visitor";
  let id = localStorage.getItem(key);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(key, id);
  }
  return id;
}

function escapeText(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

function relativeTime(value) {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function renderComment(comment) {
  return `<div class="comment"><strong>${escapeText(comment.alias)}</strong> ${escapeText(comment.body)}<time>${relativeTime(comment.created_at)}</time></div>`;
}

function renderPost(post) {
  const comments = Array.isArray(post.comments) ? post.comments : [];
  const categoryClass = String(post.category || "").toLowerCase().replace(/[^a-z]+/g, "-");
  const reacted = reactedPosts.has(post.id);
  return `
    <article class="post-card" data-post-id="${escapeText(post.id)}">
      <div class="post-header">
        <span class="post-avatar">✳</span>
        <span class="post-author">${escapeText(post.alias || "Campus insider")}</span>
        <time class="post-time">${relativeTime(post.created_at)}</time>
        <span class="post-category ${categoryClass}">${escapeText(post.category)}</span>
      </div>
      <p class="post-body">${escapeText(post.body)}</p>
      <div class="post-actions">
        <button class="action-button reaction-button ${reacted ? "reacted" : ""}" type="button" aria-label="React with tea"><span>♨</span><b>${Number(post.reactions) || 0}</b> sips</button>
        <button class="action-button comment-toggle" type="button"><span>↳</span>${Number(post.comment_count) || comments.length} whispers</button>
      </div>
      <div class="comments">${comments.map(renderComment).join("")}</div>
      <form class="comment-form">
        <label class="visually-hidden" for="reply-${escapeText(post.id)}">Add a whisper</label>
        <input id="reply-${escapeText(post.id)}" name="body" maxlength="240" placeholder="Add to the conversation..." required>
        <button type="submit">Whisper ↗</button>
      </form>
    </article>`;
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("visible"), 3000);
}

async function request(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...options.headers },
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Something went wrong. Try again.");
  return result;
}

async function loadPosts() {
  try {
    const { posts } = await request("/api/posts");
    if (!posts.length) {
      lastPostsSignature = "[]";
      postList.innerHTML = '<div class="empty-state"><span>☕</span> It’s a little quiet. Be the first to spill.</div>';
      return;
    }
    const signature = JSON.stringify(posts);
    if (signature === lastPostsSignature) return;

    const drafts = new Map();
    for (const card of postList.querySelectorAll(".post-card")) {
      drafts.set(card.dataset.postId, card.querySelector(".comment-form input").value);
    }
    const focusedInput = document.activeElement.matches(".comment-form input")
      ? document.activeElement
      : null;
    const focusedPostId = focusedInput?.closest(".post-card").dataset.postId;
    const selectionStart = focusedInput?.selectionStart;
    const selectionEnd = focusedInput?.selectionEnd;

    postList.innerHTML = posts.map(renderPost).join("");
    for (const card of postList.querySelectorAll(".post-card")) {
      card.querySelector(".comment-form input").value = drafts.get(card.dataset.postId) || "";
    }
    if (focusedPostId) {
      const input = [...postList.querySelectorAll(".post-card")]
        .find((card) => card.dataset.postId === focusedPostId)
        ?.querySelector(".comment-form input");
      if (input) {
        input.focus();
        input.setSelectionRange(selectionStart, selectionEnd);
      }
    }
    lastPostsSignature = signature;
    const today = new Date().toDateString();
    const count = posts.filter((post) => new Date(post.created_at).toDateString() === today).length;
    document.querySelector("#pulse-count").textContent = count;
  } catch (error) {
    if (!postList.querySelector(".post-card")) {
      postList.innerHTML = `<div class="empty-state">${escapeText(error.message)}</div>`;
    }
  }
}

composer.addEventListener("input", () => {
  charCount.textContent = `${composer.value.length} / 500`;
  formMessage.classList.remove("visible");
});

spillButton.addEventListener("click", async () => {
  spillButton.disabled = true;
  formMessage.classList.remove("visible");
  try {
    await request("/api/posts", {
      method: "POST",
      body: JSON.stringify({ body: composer.value, category: categorySelect.value }),
    });
    composer.value = "";
    charCount.textContent = "0 / 500";
    showToast("Your tea is out there. Stay mysterious. ✳");
    await loadPosts();
  } catch (error) {
    formMessage.textContent = error.message;
    formMessage.classList.add("visible");
  } finally {
    spillButton.disabled = false;
  }
});

postList.addEventListener("click", async (event) => {
  const card = event.target.closest(".post-card");
  if (!card) return;
  const postId = card.dataset.postId;
  if (event.target.closest(".comment-toggle")) {
    card.querySelector(".comment-form input").focus();
    return;
  }
  if (event.target.closest(".reaction-button")) {
    if (reactedPosts.has(postId)) return;
    try {
      const { reactions } = await request(`/api/posts/${encodeURIComponent(postId)}/reactions`, {
        method: "POST",
        body: JSON.stringify({ visitorId }),
      });
      reactedPosts.add(postId);
      card.querySelector(".reaction-button b").textContent = reactions;
      card.querySelector(".reaction-button").classList.add("reacted");
    } catch (error) {
      showToast(error.message);
    }
  }
});

postList.addEventListener("submit", async (event) => {
  if (!event.target.matches(".comment-form")) return;
  event.preventDefault();
  const card = event.target.closest(".post-card");
  const input = event.target.elements.body;
  const button = event.target.querySelector("button");
  button.disabled = true;
  try {
    await request(`/api/posts/${encodeURIComponent(card.dataset.postId)}/comments`, {
      method: "POST",
      body: JSON.stringify({ body: input.value }),
    });
    input.value = "";
    await loadPosts();
  } catch (error) {
    showToast(error.message);
  } finally {
    button.disabled = false;
  }
});

loadPosts();
setInterval(() => {
  if (!document.hidden) loadPosts();
}, 6000);

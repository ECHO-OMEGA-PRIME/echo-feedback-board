/**
 * Echo Feedback Board v1.0.0 — Canny/UserVoice Alternative
 * Feature requests, bug reports, upvoting, roadmap, changelogs
 */

interface Env {
  DB: D1Database;
  CACHE: KVNamespace;
  ENGINE_RUNTIME: Fetcher;
  ECHO_API_KEY: string;
}

interface RLState { c: number; t: number }

function sanitize(s: string, max = 2000): string {
  return s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '').slice(0, max);
}
function uid(): string { return crypto.randomUUID().replace(/-/g, '').slice(0, 16); }
function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' } });
}
function err(msg: string, status = 400): Response { return json({ ok: false, error: msg }, status); }

async function rateLimit(kv: KVNamespace, key: string, max: number, windowSec = 60): Promise<boolean> {
  const now = Date.now();
  const raw = await kv.get(key);
  let state: RLState = raw ? JSON.parse(raw) : { c: 0, t: now };
  const elapsed = (now - state.t) / 1000;
  const decay = Math.max(0, state.c - (elapsed / windowSec) * max);
  if (decay + 1 > max) return false;
  await kv.put(key, JSON.stringify({ c: decay + 1, t: now } as RLState), { expirationTtl: windowSec * 2 });
  return true;
}

function getTenant(req: Request): string {
  return req.headers.get('X-Tenant-ID') || new URL(req.url).searchParams.get('tenant_id') || '';
}
function authOk(req: Request, env: Env): boolean {
  if (!env.ECHO_API_KEY) return true;
  return req.headers.get('X-Echo-API-Key') === env.ECHO_API_KEY;
}
async function hashIP(ip: string): Promise<string> {
  const data = new TextEncoder().encode(ip + 'echo-fb-salt-2026');
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.method === 'OPTIONS') return json({ ok: true });
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    if (path === '/health') return json({ ok: true, service: 'echo-feedback-board', version: '1.0.0' });
    if (path === '/status') {
      const [t, p] = await Promise.all([
        env.DB.prepare('SELECT COUNT(*) as c FROM tenants').first<{c:number}>(),
        env.DB.prepare('SELECT COUNT(*) as c FROM posts').first<{c:number}>(),
      ]);
      return json({ ok: true, tenants: t?.c || 0, posts: p?.c || 0, version: '1.0.0' });
    }

    // Public board access
    if (path.startsWith('/public/')) return handlePublicAPI(req, env, path, method, url);

    // Rate limit writes
    if (method !== 'GET') {
      const rlKey = `rl:${getTenant(req) || req.headers.get('CF-Connecting-IP') || 'anon'}`;
      if (!await rateLimit(env.CACHE, rlKey, 60)) return err('Rate limited', 429);
    }

    if (!authOk(req, env)) return err('Unauthorized', 401);
    const tid = getTenant(req);

    try {
      // ── Tenants ──
      if (path === '/tenants' && method === 'POST') {
        const b = await req.json() as Record<string, unknown>;
        const id = uid();
        await env.DB.prepare('INSERT INTO tenants (id, name) VALUES (?, ?)').bind(id, sanitize(String(b.name || ''), 200)).run();
        const bid = uid();
        await env.DB.prepare('INSERT INTO boards (id, tenant_id, name, slug, description) VALUES (?, ?, ?, ?, ?)').bind(bid, id, 'Feature Requests', 'feature-requests', 'Submit and vote on feature ideas').run();
        return json({ ok: true, id, default_board_id: bid });
      }
      if (path === '/tenants/me' && method === 'GET') {
        const t = await env.DB.prepare('SELECT * FROM tenants WHERE id = ?').bind(tid).first();
        return t ? json(t) : err('Not found', 404);
      }

      // ── Boards ──
      if (path === '/boards' && method === 'GET') {
        const rows = await env.DB.prepare('SELECT * FROM boards WHERE tenant_id = ? ORDER BY created_at').bind(tid).all();
        return json(rows.results);
      }
      if (path === '/boards' && method === 'POST') {
        const b = await req.json() as Record<string, unknown>;
        const cnt = await env.DB.prepare('SELECT COUNT(*) as c FROM boards WHERE tenant_id = ?').bind(tid).first<{c:number}>();
        const tenant = await env.DB.prepare('SELECT max_boards FROM tenants WHERE id = ?').bind(tid).first<{max_boards:number}>();
        if ((cnt?.c || 0) >= (tenant?.max_boards || 3)) return err('Board limit reached');
        const id = uid();
        const slug = sanitize(String(b.slug || b.name || ''), 50).toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-');
        await env.DB.prepare('INSERT INTO boards (id, tenant_id, name, slug, description, is_public, allow_anonymous) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(id, tid, sanitize(String(b.name || ''), 200), slug, sanitize(String(b.description || ''), 500), b.is_public === false ? 0 : 1, b.allow_anonymous ? 1 : 0).run();
        return json({ ok: true, id, slug });
      }
      if (path.match(/^\/boards\/[^/]+$/) && method === 'PUT') {
        const bid = path.split('/')[2];
        const b = await req.json() as Record<string, unknown>;
        const fields: string[] = []; const vals: unknown[] = [];
        if (b.name) { fields.push('name = ?'); vals.push(sanitize(String(b.name), 200)); }
        if (b.description !== undefined) { fields.push('description = ?'); vals.push(sanitize(String(b.description), 500)); }
        if (b.is_public !== undefined) { fields.push('is_public = ?'); vals.push(b.is_public ? 1 : 0); }
        if (b.allow_anonymous !== undefined) { fields.push('allow_anonymous = ?'); vals.push(b.allow_anonymous ? 1 : 0); }
        if (!fields.length) return err('No fields');
        vals.push(bid, tid);
        await env.DB.prepare(`UPDATE boards SET ${fields.join(', ')} WHERE id = ? AND tenant_id = ?`).bind(...vals).run();
        return json({ ok: true });
      }

      // ── Posts (admin) ──
      if (path === '/posts' && method === 'GET') {
        const limit = Math.min(Number(url.searchParams.get('limit') || 50), 100);
        const boardId = url.searchParams.get('board_id');
        const status = url.searchParams.get('status');
        const category = url.searchParams.get('category');
        const sort = url.searchParams.get('sort') || 'votes';
        let q = 'SELECT * FROM posts WHERE tenant_id = ?';
        const params: unknown[] = [tid];
        if (boardId) { q += ' AND board_id = ?'; params.push(boardId); }
        if (status) { q += ' AND status = ?'; params.push(status); }
        if (category) { q += ' AND category = ?'; params.push(category); }
        q += sort === 'newest' ? ' ORDER BY created_at DESC' : sort === 'trending' ? ' ORDER BY (vote_count + comment_count * 2) DESC' : ' ORDER BY vote_count DESC';
        q += ' LIMIT ?';
        params.push(limit);
        const rows = await env.DB.prepare(q).bind(...params).all();
        return json(rows.results);
      }
      if (path.match(/^\/posts\/[^/]+$/) && method === 'GET') {
        const pid = path.split('/')[2];
        const post = await env.DB.prepare('SELECT * FROM posts WHERE id = ? AND tenant_id = ?').bind(pid, tid).first();
        if (!post) return err('Not found', 404);
        const comments = await env.DB.prepare('SELECT * FROM comments WHERE post_id = ? AND tenant_id = ? AND is_internal = 0 ORDER BY created_at ASC').bind(pid, tid).all();
        const history = await env.DB.prepare('SELECT * FROM status_changes WHERE post_id = ? ORDER BY created_at DESC LIMIT 20').bind(pid).all();
        return json({ ...(post as object), comments: comments.results, status_history: history.results });
      }
      if (path.match(/^\/posts\/[^/]+\/status$/) && method === 'PUT') {
        const pid = path.split('/')[2];
        const b = await req.json() as Record<string, unknown>;
        const oldPost = await env.DB.prepare('SELECT status FROM posts WHERE id = ? AND tenant_id = ?').bind(pid, tid).first<{status:string}>();
        const newStatus = sanitize(String(b.status || ''), 30);
        await env.DB.prepare('UPDATE posts SET status = ?, updated_at = datetime(\'now\'), eta = ? WHERE id = ? AND tenant_id = ?').bind(newStatus, b.eta ? sanitize(String(b.eta), 30) : null, pid, tid).run();
        await env.DB.prepare('INSERT INTO status_changes (post_id, tenant_id, old_status, new_status, changed_by, note) VALUES (?, ?, ?, ?, ?, ?)').bind(pid, tid, oldPost?.status || 'unknown', newStatus, sanitize(String(b.changed_by || 'admin'), 100), sanitize(String(b.note || ''), 500)).run();
        return json({ ok: true });
      }
      if (path.match(/^\/posts\/[^/]+\/merge$/) && method === 'POST') {
        const pid = path.split('/')[2];
        const b = await req.json() as Record<string, unknown>;
        const targetId = sanitize(String(b.target_id || ''), 50);
        // Move votes to target
        await env.DB.prepare('UPDATE votes SET post_id = ? WHERE post_id = ?').bind(targetId, pid).run();
        const voteCount = await env.DB.prepare('SELECT COUNT(*) as c FROM votes WHERE post_id = ?').bind(targetId).first<{c:number}>();
        await env.DB.prepare('UPDATE posts SET vote_count = ? WHERE id = ?').bind(voteCount?.c || 0, targetId).run();
        await env.DB.prepare('UPDATE posts SET status = \'merged\', merged_into = ? WHERE id = ? AND tenant_id = ?').bind(targetId, pid, tid).run();
        return json({ ok: true });
      }
      if (path.match(/^\/posts\/[^/]+$/) && method === 'DELETE') {
        const pid = path.split('/')[2];
        await env.DB.prepare('DELETE FROM votes WHERE post_id = ?').bind(pid).run();
        await env.DB.prepare('DELETE FROM comments WHERE post_id = ?').bind(pid).run();
        await env.DB.prepare('DELETE FROM status_changes WHERE post_id = ?').bind(pid).run();
        await env.DB.prepare('DELETE FROM posts WHERE id = ? AND tenant_id = ?').bind(pid, tid).run();
        return json({ ok: true });
      }

      // ── Internal Comments ──
      if (path.match(/^\/posts\/[^/]+\/internal-comments$/) && method === 'GET') {
        const pid = path.split('/')[2];
        const rows = await env.DB.prepare('SELECT * FROM comments WHERE post_id = ? AND tenant_id = ? AND is_internal = 1 ORDER BY created_at ASC').bind(pid, tid).all();
        return json(rows.results);
      }
      if (path.match(/^\/posts\/[^/]+\/internal-comments$/) && method === 'POST') {
        const pid = path.split('/')[2];
        const b = await req.json() as Record<string, unknown>;
        const id = uid();
        await env.DB.prepare('INSERT INTO comments (id, post_id, tenant_id, author_name, content, is_admin, is_internal) VALUES (?, ?, ?, ?, ?, 1, 1)').bind(id, pid, tid, sanitize(String(b.author_name || 'Admin'), 100), sanitize(String(b.content || ''), 5000)).run();
        return json({ ok: true, id });
      }

      // ── Roadmap ──
      if (path === '/roadmap' && method === 'GET') {
        const rows = await env.DB.prepare('SELECT * FROM roadmap_items WHERE tenant_id = ? ORDER BY sort_order ASC, created_at ASC').bind(tid).all();
        return json(rows.results);
      }
      if (path === '/roadmap' && method === 'POST') {
        const b = await req.json() as Record<string, unknown>;
        const id = uid();
        await env.DB.prepare('INSERT INTO roadmap_items (id, tenant_id, title, description, status, quarter, sort_order, linked_post_ids) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(id, tid, sanitize(String(b.title || ''), 200), sanitize(String(b.description || ''), 1000), sanitize(String(b.status || 'planned'), 30), sanitize(String(b.quarter || ''), 10), Number(b.sort_order || 0), JSON.stringify(b.linked_post_ids || [])).run();
        return json({ ok: true, id });
      }
      if (path.match(/^\/roadmap\/[^/]+$/) && method === 'PUT') {
        const rid = path.split('/')[2];
        const b = await req.json() as Record<string, unknown>;
        const fields: string[] = []; const vals: unknown[] = [];
        if (b.title) { fields.push('title = ?'); vals.push(sanitize(String(b.title), 200)); }
        if (b.description !== undefined) { fields.push('description = ?'); vals.push(sanitize(String(b.description), 1000)); }
        if (b.status) { fields.push('status = ?'); vals.push(sanitize(String(b.status), 30)); }
        if (b.quarter) { fields.push('quarter = ?'); vals.push(sanitize(String(b.quarter), 10)); }
        if (b.sort_order !== undefined) { fields.push('sort_order = ?'); vals.push(Number(b.sort_order)); }
        if (b.linked_post_ids) { fields.push('linked_post_ids = ?'); vals.push(JSON.stringify(b.linked_post_ids)); }
        if (!fields.length) return err('No fields');
        vals.push(rid, tid);
        await env.DB.prepare(`UPDATE roadmap_items SET ${fields.join(', ')} WHERE id = ? AND tenant_id = ?`).bind(...vals).run();
        return json({ ok: true });
      }

      // ── Changelogs ──
      if (path === '/changelogs' && method === 'GET') {
        const rows = await env.DB.prepare('SELECT * FROM changelogs WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 50').bind(tid).all();
        return json(rows.results);
      }
      if (path === '/changelogs' && method === 'POST') {
        const b = await req.json() as Record<string, unknown>;
        const id = uid();
        const published = b.published ? 1 : 0;
        await env.DB.prepare('INSERT INTO changelogs (id, tenant_id, title, content, version, category, published, linked_post_ids, published_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(id, tid, sanitize(String(b.title || ''), 200), sanitize(String(b.content || ''), 10000), sanitize(String(b.version || ''), 20), sanitize(String(b.category || 'improvement'), 30), published, JSON.stringify(b.linked_post_ids || []), published ? new Date().toISOString() : null).run();
        // Close linked posts
        if (Array.isArray(b.linked_post_ids)) {
          for (const pid of b.linked_post_ids) {
            await env.DB.prepare('UPDATE posts SET status = \'complete\' WHERE id = ? AND tenant_id = ? AND status != \'complete\'').bind(String(pid), tid).run();
          }
        }
        return json({ ok: true, id });
      }

      // ── Analytics ──
      if (path === '/analytics' && method === 'GET') {
        const [totalPosts, openPosts, inProgress, completed, totalVotes, topPosts] = await Promise.all([
          env.DB.prepare('SELECT COUNT(*) as c FROM posts WHERE tenant_id = ?').bind(tid).first<{c:number}>(),
          env.DB.prepare('SELECT COUNT(*) as c FROM posts WHERE tenant_id = ? AND status = \'open\'').bind(tid).first<{c:number}>(),
          env.DB.prepare('SELECT COUNT(*) as c FROM posts WHERE tenant_id = ? AND status = \'in_progress\'').bind(tid).first<{c:number}>(),
          env.DB.prepare('SELECT COUNT(*) as c FROM posts WHERE tenant_id = ? AND status = \'complete\'').bind(tid).first<{c:number}>(),
          env.DB.prepare('SELECT SUM(vote_count) as c FROM posts WHERE tenant_id = ?').bind(tid).first<{c:number}>(),
          env.DB.prepare('SELECT id, title, vote_count, status FROM posts WHERE tenant_id = ? ORDER BY vote_count DESC LIMIT 10').bind(tid).all(),
        ]);
        const byCategory = await env.DB.prepare('SELECT category, COUNT(*) as c FROM posts WHERE tenant_id = ? GROUP BY category ORDER BY c DESC').bind(tid).all();
        return json({ total_posts: totalPosts?.c || 0, open: openPosts?.c || 0, in_progress: inProgress?.c || 0, completed: completed?.c || 0, total_votes: totalVotes?.c || 0, top_posts: topPosts.results, by_category: byCategory.results });
      }

      // ── AI ──
      if (path === '/ai/summarize-feedback' && method === 'POST') {
        const b = await req.json() as Record<string, unknown>;
        const boardId = String(b.board_id || '');
        const posts = await env.DB.prepare('SELECT title, description, vote_count, status, category FROM posts WHERE tenant_id = ? AND board_id = ? ORDER BY vote_count DESC LIMIT 30').bind(tid, boardId).all();
        try {
          const resp = await env.ENGINE_RUNTIME.fetch('https://engine/query', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ engine_id: 'GEN-01', query: `Analyze this product feedback and summarize the top themes, most requested features, and common pain points:\n${JSON.stringify(posts.results)}\n\nReturn a structured summary with: Top 5 Themes, Most Requested Features (by votes), Common Pain Points, Recommendations.` }) });
          const data = await resp.json() as Record<string, unknown>;
          return json({ ok: true, summary: data.answer || data.response });
        } catch { return json({ ok: true, summary: 'Unable to generate summary at this time.' }); }
      }

      return err('Not found', 404);
    } catch (e: unknown) {
      return err(String((e as Error).message || e), 500);
    }
  },

  async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
    // Update board post counts
    const boards = await env.DB.prepare('SELECT id FROM boards').all();
    for (const b of boards.results) {
      const bid = (b as { id: string }).id;
      const cnt = await env.DB.prepare('SELECT COUNT(*) as c FROM posts WHERE board_id = ? AND status != \'merged\'').bind(bid).first<{c:number}>();
      await env.DB.prepare('UPDATE boards SET post_count = ? WHERE id = ?').bind(cnt?.c || 0, bid).run();
    }
    // Cleanup old activity
    await env.DB.prepare('DELETE FROM activity_log WHERE created_at < datetime(\'now\', \'-60 days\')').run();
  },
};

// ── Public Board API (no auth, rate limited) ──
async function handlePublicAPI(req: Request, env: Env, path: string, method: string, url: URL): Promise<Response> {
  const ip = req.headers.get('CF-Connecting-IP') || 'anon';
  if (method !== 'GET') {
    if (!await rateLimit(env.CACHE, `pub:${ip}`, 20)) return err('Rate limited', 429);
  }

  // GET /public/:tenant_id/boards
  if (path.match(/^\/public\/[^/]+\/boards$/) && method === 'GET') {
    const tid = path.split('/')[2];
    const rows = await env.DB.prepare('SELECT id, name, slug, description, post_count FROM boards WHERE tenant_id = ? AND is_public = 1 ORDER BY created_at').bind(tid).all();
    return json(rows.results);
  }

  // GET /public/:tenant_id/boards/:slug/posts
  if (path.match(/^\/public\/[^/]+\/boards\/[^/]+\/posts$/) && method === 'GET') {
    const parts = path.split('/');
    const tid = parts[2]; const boardSlug = parts[4];
    const board = await env.DB.prepare('SELECT id, is_public FROM boards WHERE tenant_id = ? AND slug = ?').bind(tid, boardSlug).first<{id:string;is_public:number}>();
    if (!board || !board.is_public) return err('Board not found', 404);
    const sort = url.searchParams.get('sort') || 'votes';
    const status = url.searchParams.get('status');
    const limit = Math.min(Number(url.searchParams.get('limit') || 50), 100);
    let q = 'SELECT id, title, description, category, status, vote_count, comment_count, author_name, tags, pinned, eta, created_at FROM posts WHERE tenant_id = ? AND board_id = ? AND status != \'merged\'';
    const params: unknown[] = [tid, board.id];
    if (status) { q += ' AND status = ?'; params.push(status); }
    q += ' ORDER BY pinned DESC, ' + (sort === 'newest' ? 'created_at DESC' : sort === 'trending' ? '(vote_count + comment_count * 2) DESC' : 'vote_count DESC');
    q += ' LIMIT ?';
    params.push(limit);
    const rows = await env.DB.prepare(q).bind(...params).all();
    return json(rows.results);
  }

  // GET /public/:tenant_id/posts/:id
  if (path.match(/^\/public\/[^/]+\/posts\/[^/]+$/) && method === 'GET') {
    const parts = path.split('/');
    const tid = parts[2]; const pid = parts[4];
    const post = await env.DB.prepare('SELECT id, title, description, category, status, vote_count, comment_count, author_name, tags, eta, created_at FROM posts WHERE id = ? AND tenant_id = ?').bind(pid, tid).first();
    if (!post) return err('Not found', 404);
    const comments = await env.DB.prepare('SELECT id, author_name, content, is_admin, created_at FROM comments WHERE post_id = ? AND tenant_id = ? AND is_internal = 0 ORDER BY created_at ASC LIMIT 100').bind(pid, tid).all();
    return json({ ...(post as object), comments: comments.results });
  }

  // POST /public/:tenant_id/posts — Submit feedback
  if (path.match(/^\/public\/[^/]+\/posts$/) && method === 'POST') {
    const tid = path.split('/')[2];
    const b = await req.json() as Record<string, unknown>;
    const boardId = sanitize(String(b.board_id || ''), 50);
    const board = await env.DB.prepare('SELECT id, allow_anonymous FROM boards WHERE id = ? AND tenant_id = ? AND is_public = 1').bind(boardId, tid).first<{id:string;allow_anonymous:number}>();
    if (!board) return err('Board not found', 404);
    if (!board.allow_anonymous && !b.author_email) return err('Email required');
    const id = uid();
    await env.DB.prepare('INSERT INTO posts (id, tenant_id, board_id, title, description, category, author_name, author_email) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(id, tid, boardId, sanitize(String(b.title || ''), 200), sanitize(String(b.description || ''), 5000), sanitize(String(b.category || 'feature'), 30), sanitize(String(b.author_name || 'Anonymous'), 100), sanitize(String(b.author_email || ''), 200)).run();
    return json({ ok: true, id });
  }

  // POST /public/:tenant_id/posts/:id/vote — Upvote
  if (path.match(/^\/public\/[^/]+\/posts\/[^/]+\/vote$/) && method === 'POST') {
    const parts = path.split('/');
    const tid = parts[2]; const pid = parts[4];
    const ipHash = await hashIP(ip);
    try {
      await env.DB.prepare('INSERT INTO votes (post_id, tenant_id, voter_ip_hash) VALUES (?, ?, ?)').bind(pid, tid, ipHash).run();
      await env.DB.prepare('UPDATE posts SET vote_count = vote_count + 1 WHERE id = ? AND tenant_id = ?').bind(pid, tid).run();
      return json({ ok: true, voted: true });
    } catch {
      return json({ ok: false, voted: false, error: 'Already voted' });
    }
  }

  // POST /public/:tenant_id/posts/:id/comments — Public comment
  if (path.match(/^\/public\/[^/]+\/posts\/[^/]+\/comments$/) && method === 'POST') {
    const parts = path.split('/');
    const tid = parts[2]; const pid = parts[4];
    const b = await req.json() as Record<string, unknown>;
    const id = uid();
    await env.DB.prepare('INSERT INTO comments (id, post_id, tenant_id, author_name, author_email, content, parent_id) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(id, pid, tid, sanitize(String(b.author_name || 'Anonymous'), 100), sanitize(String(b.author_email || ''), 200), sanitize(String(b.content || ''), 5000), b.parent_id ? sanitize(String(b.parent_id), 50) : null).run();
    await env.DB.prepare('UPDATE posts SET comment_count = comment_count + 1 WHERE id = ?').bind(pid).run();
    return json({ ok: true, id });
  }

  // GET /public/:tenant_id/roadmap
  if (path.match(/^\/public\/[^/]+\/roadmap$/) && method === 'GET') {
    const tid = path.split('/')[2];
    const rows = await env.DB.prepare('SELECT id, title, description, status, quarter FROM roadmap_items WHERE tenant_id = ? ORDER BY sort_order ASC').bind(tid).all();
    return json(rows.results);
  }

  // GET /public/:tenant_id/changelogs
  if (path.match(/^\/public\/[^/]+\/changelogs$/) && method === 'GET') {
    const tid = path.split('/')[2];
    const rows = await env.DB.prepare('SELECT id, title, content, version, category, published_at FROM changelogs WHERE tenant_id = ? AND published = 1 ORDER BY published_at DESC LIMIT 30').bind(tid).all();
    return json(rows.results);
  }

  return err('Not found', 404);
}

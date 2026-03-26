-- Echo Feedback Board v1.0.0 — Canny/UserVoice alternative
-- Feature requests, bug reports, upvoting, roadmap, changelogs

CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  plan TEXT DEFAULT 'starter',
  logo_url TEXT,
  accent_color TEXT DEFAULT '#14b8a6',
  custom_domain TEXT,
  max_boards INTEGER DEFAULT 3,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS boards (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  description TEXT,
  is_public INTEGER DEFAULT 1,
  allow_anonymous INTEGER DEFAULT 0,
  post_count INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(tenant_id, slug)
);

CREATE TABLE IF NOT EXISTS posts (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  board_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  category TEXT DEFAULT 'feature',
  status TEXT DEFAULT 'open',
  priority TEXT DEFAULT 'normal',
  author_name TEXT,
  author_email TEXT,
  vote_count INTEGER DEFAULT 0,
  comment_count INTEGER DEFAULT 0,
  merged_into TEXT,
  eta TEXT,
  tags TEXT DEFAULT '[]',
  pinned INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS votes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  voter_email TEXT,
  voter_ip_hash TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(post_id, voter_ip_hash)
);

CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  parent_id TEXT,
  author_name TEXT,
  author_email TEXT,
  content TEXT NOT NULL,
  is_admin INTEGER DEFAULT 0,
  is_internal INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS status_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  old_status TEXT,
  new_status TEXT NOT NULL,
  changed_by TEXT,
  note TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS roadmap_items (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT DEFAULT 'planned',
  quarter TEXT,
  sort_order INTEGER DEFAULT 0,
  linked_post_ids TEXT DEFAULT '[]',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS changelogs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  version TEXT,
  category TEXT DEFAULT 'improvement',
  published INTEGER DEFAULT 0,
  linked_post_ids TEXT DEFAULT '[]',
  published_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS subscribers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  email TEXT NOT NULL,
  post_id TEXT,
  board_id TEXT,
  type TEXT DEFAULT 'board',
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(tenant_id, email, post_id)
);

CREATE TABLE IF NOT EXISTS activity_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  action TEXT NOT NULL,
  actor TEXT,
  target TEXT,
  details TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_boards_tenant ON boards(tenant_id);
CREATE INDEX IF NOT EXISTS idx_posts_board ON posts(board_id, status);
CREATE INDEX IF NOT EXISTS idx_posts_tenant ON posts(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_votes_post ON votes(post_id);
CREATE INDEX IF NOT EXISTS idx_comments_post ON comments(post_id);
CREATE INDEX IF NOT EXISTS idx_status_changes_post ON status_changes(post_id);
CREATE INDEX IF NOT EXISTS idx_roadmap_tenant ON roadmap_items(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_changelogs_tenant ON changelogs(tenant_id, published);
CREATE INDEX IF NOT EXISTS idx_subscribers_tenant ON subscribers(tenant_id);
CREATE INDEX IF NOT EXISTS idx_activity_tenant ON activity_log(tenant_id, created_at);

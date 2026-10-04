-- Registry of dev worktrees this server created. Live state (processes, tunnel URL, git, routes) is read on demand.
CREATE TABLE worktrees (
  name              TEXT PRIMARY KEY CHECK (length(name) BETWEEN 1 AND 30),
  path              TEXT NOT NULL UNIQUE,
  git_branch        TEXT NOT NULL,
  port              INTEGER NOT NULL UNIQUE CHECK (port BETWEEN 1024 AND 65535),
  phone             TEXT UNIQUE,
  neon_branch_id    TEXT NOT NULL,
  neon_branch_name  TEXT NOT NULL,
  created_at        TEXT NOT NULL
);

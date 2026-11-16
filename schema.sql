-- Waitlist for the Pathnote beta. Only what the page tells people it keeps:
-- email, which AI they use, page language, and when they signed up.
CREATE TABLE IF NOT EXISTS waitlist (
  email TEXT PRIMARY KEY,
  ai TEXT NOT NULL,
  lang TEXT NOT NULL,
  source TEXT,
  created_at INTEGER NOT NULL
);

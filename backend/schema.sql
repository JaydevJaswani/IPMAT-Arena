-- IPMAT Arena — Cloudflare D1 schema
-- Apply once:  npx wrangler d1 execute ipmat-arena --file=backend/schema.sql --remote

-- Who is allowed to log in. Refreshed from masterdata via build_roster.py -> roster.sql
CREATE TABLE IF NOT EXISTS students (
  pin    TEXT PRIMARY KEY,      -- IMS PIN, the login key
  name   TEXT NOT NULL,
  batch  TEXT NOT NULL
);

-- One row per finished Daily 10 (or other set). Leaderboards aggregate from here.
CREATE TABLE IF NOT EXISTS attempts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  pin        TEXT NOT NULL,
  set_id     TEXT NOT NULL,         -- e.g. 'daily-2026-09-21'
  day        TEXT NOT NULL,         -- 'YYYY-MM-DD'
  score      INTEGER NOT NULL,      -- +4/-1 marks
  correct    INTEGER NOT NULL,
  total      INTEGER NOT NULL,
  time_sec   INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (pin, set_id)             -- one scored attempt per set per student
);
CREATE INDEX IF NOT EXISTS idx_attempts_day  ON attempts(day);
CREATE INDEX IF NOT EXISTS idx_attempts_pin  ON attempts(pin);

-- Rolling engagement state per student (streak, XP).
CREATE TABLE IF NOT EXISTS progress (
  pin            TEXT PRIMARY KEY,
  xp             INTEGER NOT NULL DEFAULT 0,
  current_streak INTEGER NOT NULL DEFAULT 0,
  best_streak    INTEGER NOT NULL DEFAULT 0,
  last_day       TEXT
);

-- Named tests uploaded from decks/PDFs (static question sets).
CREATE TABLE IF NOT EXISTS tests (
  id         TEXT PRIMARY KEY,          -- slug, e.g. 'numbers-1-workshop'
  name       TEXT NOT NULL,
  topic      TEXT,
  q_count    INTEGER NOT NULL DEFAULT 0,
  live       INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Static questions belonging to a test. Answers stay server-side (grading is /grade).
CREATE TABLE IF NOT EXISTS questions (
  id       TEXT PRIMARY KEY,            -- e.g. 'numbers-1-workshop:1'
  test_id  TEXT NOT NULL,
  seq      INTEGER NOT NULL,
  topic    TEXT, tier TEXT,
  type     TEXT NOT NULL,               -- 'int' | 'short' | 'mcq'
  mode     TEXT NOT NULL DEFAULT 'auto',-- 'auto' (gradeable) | 'open' (self-check)
  stem     TEXT NOT NULL,
  options  TEXT,                        -- JSON array for mcq, else NULL
  answer   TEXT,                        -- normalized answer (server-side only)
  answer_display TEXT,
  solution TEXT, trap TEXT, source TEXT
);
CREATE INDEX IF NOT EXISTS idx_q_test ON questions(test_id, seq);

-- Wrong questions to resurface with NEW numbers (revenge). Stores the template id,
-- not the exact instance — the client re-rolls the template on review.
CREATE TABLE IF NOT EXISTS revenge (
  pin         TEXT NOT NULL,
  template_id TEXT NOT NULL,
  due_day     TEXT NOT NULL,        -- spaced-repetition next-due date
  misses      INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (pin, template_id)
);

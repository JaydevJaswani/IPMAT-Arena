# IPMAT Arena — Backend Runbook

Cloudflare Worker + D1. Same account/pattern as IPMAT-Sectionals.
PIN-verified login · re-uploadable roster · leaderboards.

## One-time setup
```bash
cd ~/Downloads/IPMAT-Arena/backend

# 1. create the database, paste the printed id into wrangler.toml -> database_id
npx wrangler d1 create ipmat-arena

# 2. create tables
npx wrangler d1 execute ipmat-arena --file=schema.sql --remote

# 3. set the admin key (used by the roster-upload page). Pick a long random string.
npx wrangler secret put ADMIN_KEY

# 4. deploy
npx wrangler deploy
# -> https://ipmat-arena.<your-subdomain>.workers.dev
```

## Load / refresh the roster (two ways)

**A. From the admin page (no terminal) — for new-student uploads**
1. Open `backend/admin.html` (locally or hosted).
2. Paste the Worker URL + your ADMIN_KEY.
3. Drop the latest masterdata `.xlsx`. It cleans client-side (Active + Ahmedabad IPMAT,
   dedupe PINs) and shows a preview count.
4. Click **Replace roster**. Done.

**B. From the terminal (bulk)**
```bash
cd ~/Downloads/ims_toolkit_pkg   # has pandas
./.venv/bin/python ~/Downloads/IPMAT-Arena/tools/build_roster.py "~/Downloads/Masterdata.xlsx"
cd ~/Downloads/IPMAT-Arena/backend
npx wrangler d1 execute ipmat-arena --file=../build/roster.sql --remote
```

## Add a question test (PDF → playable test), any time
Needs `ADMIN_KEY` set (above). Two ways:

**A. Browser (no install)** — open `backend/add-test.html`, paste Worker URL + ADMIN_KEY,
name the test, drop the PDF. It parses in-browser, previews the questions (flagging any with
no answer), then **Publish test**. Answers stay server-side; the app grades via `/grade`.

**B. CLI** — `pip install pypdf`, then:
```bash
API=https://ipmat-arena.<sub>.workers.dev ADMIN_KEY=... \
python3 tools/ingest_pdf.py questions.pdf --name "Number System — Sprint 3" --topic "Number System" --push
```
PDF format (tolerant): questions start `Q1.` / `1.`; options `(A) …`; `Ans: B` (MCQ) or
`Ans: 133` (numeric); `Sol: …` optional.

Deck seed already loaded: **Numbers 1 — Workshop (30 Qs)** and **Linear, Surds & Indices (21 Qs)**.

## Roster scope (edit in ONE place)
`tools/build_roster.py` → `AHMEDABAD_BATCH_PATTERNS`. The admin page mirrors the same
rules. Toggle the `26MGMT`/`27MGMT` lines to include or exclude those 520 students.

## Point the app at the backend
In the frontend, set `API = "https://ipmat-arena.<subdomain>.workers.dev"`.

## Never commit
`build/`, `roster.*`, `pin_conflicts.txt`, `.dev.vars` — all student PII (already git-ignored).

/**
 * IPMAT Arena — Cloudflare Worker API (D1-backed)
 *
 * Endpoints
 *   POST /login              { pin }                     -> { ok, name, batch } | { ok:false }
 *   POST /submit             { pin, setId, day, score, correct, total, timeSec }
 *                                                        -> { rank, of, percentile, streak, xp }
 *   GET  /leaderboard?type=daily|accuracy|streak|batch&day=YYYY-MM-DD&pin=...
 *   POST /admin/upload-roster  (X-Admin-Key)  { students:[{pin,name,batch}] }
 *                                                        -> replaces the whole roster
 *   GET  /admin/roster-count   (X-Admin-Key)
 *
 * Secrets:  ADMIN_KEY   ·  Binding: DB (D1)
 * Auth note: the IMS PIN is the login secret (closed classroom cohort). If PIN-sharing
 * to farm the board becomes real, add a per-student device token — schema is ready for it.
 */

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Admin-Key",
};
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", ...CORS } });

export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
    const url = new URL(req.url);
    const p = url.pathname.replace(/\/+$/, "") || "/";
    try {
      if (p === "/" )                    return json({ ok: true, service: "ipmat-arena" });
      if (p === "/login")                return login(req, env);
      if (p === "/me")                   return me(url, env);
      if (p === "/submit")               return submit(req, env);
      if (p === "/leaderboard")          return leaderboard(url, env);
      if (p === "/tests")                return listTests(env);
      if (p === "/test")                 return getTest(url, env);
      if (p === "/grade")                return grade(req, env);
      if (p === "/admin/upload-roster")  return uploadRoster(req, env);
      if (p === "/admin/upload-test")    return uploadTest(req, env);
      if (p === "/admin/roster-count")   return rosterCount(req, env);
      return json({ ok: false, error: "not found" }, 404);
    } catch (e) {
      return json({ ok: false, error: String(e && e.message || e) }, 500);
    }
  },
};

const cleanPin = (s) => String(s || "").trim().toUpperCase();

async function login(req, env) {
  const { pin } = await req.json();
  const key = cleanPin(pin);
  if (!key) return json({ ok: false, error: "missing pin" }, 400);
  const row = await env.DB.prepare("SELECT name, batch FROM students WHERE pin = ?").bind(key).first();
  if (!row) return json({ ok: false, error: "PIN not found" }, 200);
  return json({ ok: true, name: row.name, batch: row.batch });
}

async function me(url, env) {
  const pin = cleanPin(url.searchParams.get("pin"));
  const stu = await env.DB.prepare("SELECT name, batch FROM students WHERE pin=?").bind(pin).first();
  if (!stu) return json({ ok: false }, 200);
  const pr = await env.DB.prepare("SELECT xp,current_streak,best_streak,last_day FROM progress WHERE pin=?").bind(pin).first();
  const day = new Date().toISOString().slice(0, 10);
  const done = await env.DB.prepare("SELECT 1 FROM attempts WHERE pin=? AND set_id=?").bind(pin, "daily-" + day).first();
  return json({ ok: true, name: stu.name, batch: stu.batch,
    xp: pr ? pr.xp : 0, streak: pr ? pr.current_streak : 0, best: pr ? pr.best_streak : 0,
    dailyDone: !!done });
}

async function submit(req, env) {
  const b = await req.json();
  const pin = cleanPin(b.pin);
  const stu = await env.DB.prepare("SELECT batch FROM students WHERE pin = ?").bind(pin).first();
  if (!stu) return json({ ok: false, error: "unknown pin" }, 403);

  const day = b.day, setId = b.setId || ("daily-" + day);
  const { score, correct, total, timeSec } = b;

  // one scored attempt per set (ignore replays)
  await env.DB.prepare(
    `INSERT INTO attempts (pin,set_id,day,score,correct,total,time_sec)
     VALUES (?,?,?,?,?,?,?) ON CONFLICT(pin,set_id) DO NOTHING`
  ).bind(pin, setId, day, score, correct, total, timeSec).run();

  // streak + xp
  const prog = await env.DB.prepare("SELECT * FROM progress WHERE pin = ?").bind(pin).first();
  const xpGain = correct * 20 + (correct >= 8 ? 60 : 0);
  let streak = 1, best = 1, xp = xpGain;
  if (prog) {
    const cont = isYesterday(prog.last_day, day);
    streak = prog.last_day === day ? prog.current_streak : (cont ? prog.current_streak + 1 : 1);
    best = Math.max(prog.best_streak, streak);
    xp = prog.xp + (prog.last_day === day ? 0 : xpGain);
  }
  await env.DB.prepare(
    `INSERT INTO progress (pin,xp,current_streak,best_streak,last_day) VALUES (?,?,?,?,?)
     ON CONFLICT(pin) DO UPDATE SET xp=?, current_streak=?, best_streak=?, last_day=?`
  ).bind(pin, xp, streak, best, day, xp, streak, best, day).run();

  // rank on this set
  const better = await env.DB.prepare(
    "SELECT COUNT(*) n FROM attempts WHERE set_id = ? AND (score > ? OR (score = ? AND time_sec < ?))"
  ).bind(setId, score, score, timeSec).first();
  const of = await env.DB.prepare("SELECT COUNT(*) n FROM attempts WHERE set_id = ?").bind(setId).first();
  const rank = (better.n || 0) + 1;
  const pct = of.n > 1 ? Math.round((1 - (rank - 1) / of.n) * 100) : 100;

  return json({ ok: true, rank, of: of.n, percentile: pct, streak, xp });
}

async function leaderboard(url, env) {
  const type = url.searchParams.get("type") || "daily";
  const day = url.searchParams.get("day");
  const pin = cleanPin(url.searchParams.get("pin"));
  let rows = [];
  if (type === "daily") {
    rows = (await env.DB.prepare(
      `SELECT s.name, s.batch, a.score, a.time_sec FROM attempts a JOIN students s ON s.pin=a.pin
       WHERE a.day = ? ORDER BY a.score DESC, a.time_sec ASC LIMIT 50`).bind(day).all()).results;
  } else if (type === "accuracy") {
    rows = (await env.DB.prepare(
      `SELECT s.name, s.batch, ROUND(100.0*SUM(a.correct)/SUM(a.total)) score
       FROM attempts a JOIN students s ON s.pin=a.pin GROUP BY a.pin HAVING SUM(a.total)>=20
       ORDER BY score DESC LIMIT 50`).all()).results;
  } else if (type === "streak") {
    rows = (await env.DB.prepare(
      `SELECT s.name, s.batch, p.current_streak score FROM progress p JOIN students s ON s.pin=p.pin
       ORDER BY p.current_streak DESC LIMIT 50`).all()).results;
  } else if (type === "batch") {
    rows = (await env.DB.prepare(
      `SELECT s.batch name, s.batch, ROUND(AVG(a.score),1) score FROM attempts a JOIN students s ON s.pin=a.pin
       GROUP BY s.batch HAVING COUNT(*)>=5 ORDER BY score DESC LIMIT 50`).all()).results;
  }
  return json({ ok: true, type, rows });
}

// ---- tests / static questions ----
async function listTests(env) {
  const r = await env.DB.prepare(
    "SELECT id, name, topic, q_count FROM tests WHERE live = 1 ORDER BY created_at DESC").all();
  return json({ ok: true, tests: r.results });
}
async function getTest(url, env) {
  const id = url.searchParams.get("id");
  if (!id) return json({ ok: false, error: "missing id" }, 400);
  const t = await env.DB.prepare("SELECT id,name,topic,q_count FROM tests WHERE id=?").bind(id).first();
  if (!t) return json({ ok: false, error: "not found" }, 404);
  // never ship answers/solutions to the client — grading is server-side
  const qs = await env.DB.prepare(
    "SELECT id,seq,topic,tier,type,mode,stem,options FROM questions WHERE test_id=? ORDER BY seq").bind(id).all();
  return json({ ok: true, test: t, questions: qs.results.map(q => ({ ...q, options: q.options ? JSON.parse(q.options) : null })) });
}
const normAns = (s) => String(s == null ? "" : s).toLowerCase().replace(/\s+/g, "").replace(/[·×]/g, "*");
async function grade(req, env) {
  const { testId, answers } = await req.json();           // answers: { qId: given }
  const qs = (await env.DB.prepare(
    "SELECT id,type,mode,answer,answer_display,solution,trap FROM questions WHERE test_id=?").bind(testId).all()).results;
  let score = 0, correct = 0, gradeable = 0;
  const detail = qs.map(q => {
    const given = answers ? answers[q.id] : undefined;
    let ok = null;
    if (q.mode === "auto" && given != null && given !== "") {
      gradeable++;
      ok = q.type === "int" ? Number(given) === Number(q.answer) : normAns(given) === normAns(q.answer);
      if (ok) { correct++; score += 4; } else { score -= 1; }
    }
    return { id: q.id, correct: ok, answer: q.answer_display || q.answer, solution: q.solution, trap: q.trap };
  });
  return json({ ok: true, score, correct, gradeable, detail });
}

// ---- admin ----
function requireAdmin(req, env) {
  return req.headers.get("X-Admin-Key") && req.headers.get("X-Admin-Key") === env.ADMIN_KEY;
}
async function uploadRoster(req, env) {
  if (!requireAdmin(req, env)) return json({ ok: false, error: "unauthorized" }, 401);
  const { students } = await req.json();
  if (!Array.isArray(students) || !students.length) return json({ ok: false, error: "no students" }, 400);
  await env.DB.prepare("DELETE FROM students").run();
  const stmt = env.DB.prepare("INSERT INTO students (pin,name,batch) VALUES (?,?,?)");
  const batch = students
    .filter(s => s && s.pin && s.name)
    .map(s => stmt.bind(cleanPin(s.pin), String(s.name).trim(), String(s.batch || "").trim()));
  // D1 batch cap ~ chunk to be safe
  for (let i = 0; i < batch.length; i += 500) await env.DB.batch(batch.slice(i, i + 500));
  return json({ ok: true, inserted: batch.length });
}
async function rosterCount(req, env) {
  if (!requireAdmin(req, env)) return json({ ok: false, error: "unauthorized" }, 401);
  const n = await env.DB.prepare("SELECT COUNT(*) n FROM students").first();
  return json({ ok: true, students: n.n });
}
// Create/replace a named test from parsed questions (deck or PDF upload).
async function uploadTest(req, env) {
  if (!requireAdmin(req, env)) return json({ ok: false, error: "unauthorized" }, 401);
  const { id, name, topic, questions } = await req.json();
  if (!name || !Array.isArray(questions) || !questions.length)
    return json({ ok: false, error: "need name + questions" }, 400);
  const tid = (id || name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
  await env.DB.prepare("DELETE FROM questions WHERE test_id=?").bind(tid).run();
  await env.DB.prepare(
    "INSERT INTO tests (id,name,topic,q_count,live) VALUES (?,?,?,?,1) ON CONFLICT(id) DO UPDATE SET name=?,topic=?,q_count=?"
  ).bind(tid, name, topic || "", questions.length, name, topic || "", questions.length).run();
  const stmt = env.DB.prepare(
    "INSERT INTO questions (id,test_id,seq,topic,tier,type,mode,stem,options,answer,answer_display,solution,trap,source) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
  const rows = questions.map((q, i) => stmt.bind(
    `${tid}:${i + 1}`, tid, i + 1, q.topic || topic || "", q.tier || "Exam-Relevant",
    q.type || "int", q.mode || "auto", q.stem, q.options ? JSON.stringify(q.options) : null,
    q.answer ?? "", q.answer_display ?? q.answer ?? "", q.solution || "", q.trap || "", q.source || "PDF"));
  for (let i = 0; i < rows.length; i += 400) await env.DB.batch(rows.slice(i, i + 400));
  return json({ ok: true, testId: tid, inserted: rows.length });
}

function isYesterday(prev, today) {
  if (!prev) return false;
  const d = new Date(today + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10) === prev;
}

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
      if (p === "/test-status")          return testStatus(url, env);
      if (p === "/review")               return review(url, env);
      if (p === "/extra")                return extra(url, env);
      if (p === "/redo")                 return redo(req, env);
      if (p === "/practice")             return practice(url, env);
      if (p === "/pgrade")               return pgrade(req, env);
      if (p === "/plog")                 return plog(req, env);
      if (p === "/campaign")             return campaign(url, env);
      if (p === "/level-save")           return levelSave(req, env);
      if (p === "/level-review")         return levelReview(url, env);
      if (p === "/report")               return report(req, env);
      if (p === "/switch")               return logSwitch(req, env);
      if (p === "/admin/issues")         return adminIssues(req, env);
      if (p === "/admin/switches")       return adminSwitches(req, env);
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

const qlogStmt = (env) => env.DB.prepare(
  "INSERT INTO q_log (pin,topic,tier,qkey,source,correct,is_redo) VALUES (?,?,?,?,?,?,?)");
const tierWeightSQL = "(CASE tier WHEN 'Warm-Up' THEN 1 WHEN 'Exam-Relevant' THEN 2 ELSE 3 END)";

async function me(url, env) {
  const pin = cleanPin(url.searchParams.get("pin"));
  const stu = await env.DB.prepare("SELECT name, batch FROM students WHERE pin=?").bind(pin).first();
  if (!stu) return json({ ok: false }, 200);
  const pr = await env.DB.prepare("SELECT xp,current_streak,best_streak,last_day FROM progress WHERE pin=?").bind(pin).first();
  const day = new Date().toISOString().slice(0, 10);
  const done = await env.DB.prepare("SELECT 1 FROM attempts WHERE pin=? AND set_id=?").bind(pin, "daily-" + day).first();
  // topic × level tally
  const mastery = (await env.DB.prepare(
    "SELECT topic,tier,COUNT(*) seen,COALESCE(SUM(correct),0) solved FROM q_log WHERE pin=? GROUP BY topic,tier").bind(pin).all()).results;
  const cp = await env.DB.prepare(
    `SELECT COALESCE(SUM(CASE WHEN correct=1 THEN ${tierWeightSQL} ELSE 0 END),0) cp,
     COUNT(*) seen, COALESCE(SUM(correct),0) solved FROM q_log WHERE pin=?`).bind(pin).first();
  // Comeback Index
  const w = await env.DB.prepare("SELECT COUNT(*) total, COALESCE(SUM(resolved),0) resolved FROM wrongs WHERE pin=?").bind(pin).first();
  const myRedos = (await env.DB.prepare("SELECT COUNT(*) n FROM q_log WHERE pin=? AND is_redo=1").bind(pin).first()).n;
  const peer = (await env.DB.prepare("SELECT COALESCE(AVG(c),0) avg FROM (SELECT COUNT(*) c FROM q_log WHERE is_redo=1 GROUP BY pin)").first()).avg;
  return json({ ok: true, name: stu.name, batch: stu.batch,
    xp: pr ? pr.xp : 0, streak: pr ? pr.current_streak : 0, best: pr ? pr.best_streak : 0, dailyDone: !!done,
    conquest: cp.cp || 0, seen: cp.seen || 0, solved: cp.solved || 0, mastery,
    comeback: { resolved: w.resolved || 0, total: w.total || 0, open: (w.total || 0) - (w.resolved || 0),
      redos: myRedos, peerAvg: Math.round((peer || 0) * 10) / 10 } });
}

async function submit(req, env) {
  const b = await req.json();
  const pin = cleanPin(b.pin);
  const stu = await env.DB.prepare("SELECT batch FROM students WHERE pin = ?").bind(pin).first();
  if (!stu) return json({ ok: false, error: "unknown pin" }, 403);

  const day = b.day, setId = b.setId || ("daily-" + day);
  const { score, correct, total, timeSec } = b;

  // fresh attempt? (only log per-question data once per set)
  const prior = await env.DB.prepare("SELECT 1 FROM attempts WHERE pin=? AND set_id=?").bind(pin, setId).first();
  await env.DB.prepare(
    `INSERT INTO attempts (pin,set_id,day,score,correct,total,time_sec)
     VALUES (?,?,?,?,?,?,?) ON CONFLICT(pin,set_id) DO NOTHING`
  ).bind(pin, setId, day, score, correct, total, timeSec).run();

  if (!prior && Array.isArray(b.items)) {
    const logs = b.items.map(it => qlogStmt(env).bind(pin, it.topic || "", it.tier || "", "g:" + (it.genId || ""), "daily", it.correct ? 1 : 0, 0));
    if (logs.length) await env.DB.batch(logs);
    for (const it of b.items) {
      if (!it.genId) continue;
      if (it.correct) await env.DB.prepare("UPDATE wrongs SET resolved=1 WHERE pin=? AND gen_id=? AND resolved=0").bind(pin, it.genId).run();
      else await env.DB.prepare(
        "INSERT INTO wrongs (pin,qkey,topic,tier,gen_id,misses,resolved) VALUES (?,?,?,?,?,1,0) ON CONFLICT(pin,qkey) DO UPDATE SET misses=misses+1, resolved=0"
      ).bind(pin, "g:" + it.genId, it.topic || "", it.tier || "", it.genId).run();
    }
  }

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
    // accuracy across ALL answered questions (daily + practice + drills), min 10 attempted
    rows = (await env.DB.prepare(
      `SELECT s.name, s.batch, ROUND(100.0*SUM(q.correct)/COUNT(*)) score
       FROM q_log q JOIN students s ON s.pin=q.pin GROUP BY q.pin HAVING COUNT(*)>=10
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
  const { testId, answers, pin } = await req.json();       // answers: { qId: given }
  const cpin = cleanPin(pin);
  const alreadyDone = cpin ? await env.DB.prepare("SELECT 1 FROM test_done WHERE pin=? AND test_id=?").bind(cpin, testId).first() : null;
  const qs = (await env.DB.prepare(
    "SELECT id,seq,topic,tier,type,mode,answer,answer_display,solution,trap FROM questions WHERE test_id=?").bind(testId).all()).results;
  let score = 0, correct = 0, gradeable = 0;
  const detail = qs.map(q => {
    const given = answers ? answers[q.id] : undefined;
    let ok = null;
    if (q.mode === "auto" && given != null && given !== "") {
      gradeable++;
      ok = q.type === "int" ? Number(given) === Number(q.answer) : normAns(given) === normAns(q.answer);
      if (ok) { correct++; score += 4; } else { score -= 1; }
    }
    return { id: q.id, seq: q.seq, topic: q.topic, tier: q.tier, correct: ok, answer: q.answer_display || q.answer, solution: q.solution, trap: q.trap };
  });
  // log once — first time this student finishes this test
  if (cpin && !alreadyDone) {
    const logs = detail.filter(d => d.correct !== null).map(d =>
      qlogStmt(env).bind(cpin, d.topic || "", d.tier || "", testId + ":" + d.seq, "test", d.correct ? 1 : 0, 0));
    if (logs.length) await env.DB.batch(logs);
    for (const d of detail) {
      if (d.correct === false) await env.DB.prepare(
        "INSERT INTO wrongs (pin,qkey,topic,tier,gen_id,misses,resolved) VALUES (?,?,?,?,NULL,1,0) ON CONFLICT(pin,qkey) DO UPDATE SET misses=misses+1, resolved=0"
      ).bind(cpin, testId + ":" + d.seq, d.topic || "", d.tier || "").run();
    }
    await env.DB.prepare("INSERT OR IGNORE INTO test_done (pin,test_id,score,correct,total) VALUES (?,?,?,?,?)")
      .bind(cpin, testId, score, correct, gradeable).run();
  }
  return json({ ok: true, score, correct, gradeable, detail, alreadyDone: !!alreadyDone });
}

async function testStatus(url, env) {
  const pin = cleanPin(url.searchParams.get("pin"));
  const r = (await env.DB.prepare("SELECT test_id,score,correct,total FROM test_done WHERE pin=?").bind(pin).all()).results;
  return json({ ok: true, done: r });
}
async function review(url, env) {
  const pin = cleanPin(url.searchParams.get("pin")), id = url.searchParams.get("testId");
  const t = await env.DB.prepare("SELECT id,name,topic FROM tests WHERE id=?").bind(id).first();
  const qs = (await env.DB.prepare(
    "SELECT id,seq,topic,tier,type,mode,stem,options,answer_display,solution,trap FROM questions WHERE test_id=? ORDER BY seq").bind(id).all()).results;
  const logs = (await env.DB.prepare("SELECT qkey,correct FROM q_log WHERE pin=? AND source='test' AND qkey LIKE ?").bind(pin, id + ":%").all()).results;
  const lm = {}; logs.forEach(l => lm[l.qkey] = l.correct);
  return json({ ok: true, test: t, questions: qs.map(q => ({ ...q, options: q.options ? JSON.parse(q.options) : null,
    correct: (id + ":" + q.seq) in lm ? !!lm[id + ":" + q.seq] : null })) });
}
async function extra(url, env) {
  const pin = cleanPin(url.searchParams.get("pin"));
  const r = (await env.DB.prepare(
    "SELECT qkey,topic,tier,gen_id,misses FROM wrongs WHERE pin=? AND resolved=0 ORDER BY misses DESC, rowid DESC LIMIT 20").bind(pin).all()).results;
  return json({ ok: true, wrongs: r });
}
async function redo(req, env) {
  const { pin, items } = await req.json();
  const cpin = cleanPin(pin);
  if (!Array.isArray(items) || !items.length) return json({ ok: false, error: "no items" }, 400);
  const logs = items.map(it => qlogStmt(env).bind(cpin, it.topic || "", it.tier || "", it.qkey || ("g:" + (it.genId || "")), "extra", it.correct ? 1 : 0, 1));
  await env.DB.batch(logs);
  let resolved = 0;
  for (const it of items) {
    if (it.correct && it.qkey) {
      const r = await env.DB.prepare("UPDATE wrongs SET resolved=1 WHERE pin=? AND qkey=? AND resolved=0").bind(cpin, it.qkey).run();
      resolved += (r.meta && r.meta.changes) || 0;
    }
  }
  return json({ ok: true, resolved });
}

// ---- campaign / practice ----
const LVL_TIER = { L1: "Warm-Up", L2: "Exam-Relevant", L3: "Heavy & Tricky", L4: "Killer" };
const CLEAR = { L1: 10, L2: 10, L3: 10 };  // correct-answers threshold per level (no Killer)

async function practice(url, env) {
  const topic = url.searchParams.get("topic"), level = url.searchParams.get("level");
  const tier = LVL_TIER[level] || "Exam-Relevant";
  const qs = (await env.DB.prepare(
    "SELECT id,topic,tier,type,mode,stem,options FROM questions WHERE test_id='practice' AND topic=? AND tier=? ORDER BY RANDOM() LIMIT 12"
  ).bind(topic, tier).all()).results;
  return json({ ok: true, questions: qs.map(q => ({ ...q, options: q.options ? JSON.parse(q.options) : null })) });
}
// grade a batch of static pool questions (answers stay server-side)
async function pgrade(req, env) {
  const { pin, topic, level, items } = await req.json();  // items: [{id, given}]
  const cpin = cleanPin(pin), tier = LVL_TIER[level] || "Exam-Relevant";
  const ids = (items || []).map(i => i.id);
  if (!ids.length) return json({ ok: true, detail: [] });
  const ph = ids.map(() => "?").join(",");
  const qs = (await env.DB.prepare(
    `SELECT id,type,answer,answer_display,solution,trap,topic,tier FROM questions WHERE id IN (${ph})`).bind(...ids).all()).results;
  const byId = {}; qs.forEach(q => byId[q.id] = q);
  const logs = []; const detail = [];
  for (const it of items) {
    const q = byId[it.id]; if (!q) continue;
    const ok = q.type === "int" ? Number(it.given) === Number(q.answer) : normAns(it.given) === normAns(q.answer);
    logs.push(qlogStmt(env).bind(cpin, q.topic, q.tier, q.id, "practice", ok ? 1 : 0, 0));
    if (!ok) await env.DB.prepare("INSERT INTO wrongs (pin,qkey,topic,tier,gen_id,misses,resolved) VALUES (?,?,?,?,NULL,1,0) ON CONFLICT(pin,qkey) DO UPDATE SET misses=misses+1,resolved=0").bind(cpin, q.id, q.topic, q.tier).run();
    detail.push({ id: q.id, correct: ok, answer: q.answer_display || q.answer, solution: q.solution, trap: q.trap });
  }
  if (logs.length) await env.DB.batch(logs);
  return json({ ok: true, detail });
}
// log generator-based practice (client-graded), update wrongs/mastery
async function plog(req, env) {
  const { pin, items } = await req.json();  // [{genId, topic, tier, correct}]
  const cpin = cleanPin(pin);
  if (!Array.isArray(items) || !items.length) return json({ ok: false }, 400);
  const logs = items.map(it => qlogStmt(env).bind(cpin, it.topic || "", it.tier || "", "g:" + (it.genId || ""), "practice", it.correct ? 1 : 0, 0));
  await env.DB.batch(logs);
  for (const it of items) {
    if (!it.genId) continue;
    if (it.correct) await env.DB.prepare("UPDATE wrongs SET resolved=1 WHERE pin=? AND gen_id=? AND resolved=0").bind(cpin, it.genId).run();
    else await env.DB.prepare("INSERT INTO wrongs (pin,qkey,topic,tier,gen_id,misses,resolved) VALUES (?,?,?,?,?,1,0) ON CONFLICT(pin,qkey) DO UPDATE SET misses=misses+1,resolved=0").bind(cpin, "g:" + it.genId, it.topic || "", it.tier || "", it.genId).run();
  }
  return json({ ok: true });
}
// per-topic per-level cleared/progress for the campaign map
async function campaign(url, env) {
  const pin = cleanPin(url.searchParams.get("pin"));
  const rows = (await env.DB.prepare(
    "SELECT topic,tier,COALESCE(SUM(correct),0) solved,COUNT(*) seen FROM q_log WHERE pin=? GROUP BY topic,tier").bind(pin).all()).results;
  const pool = (await env.DB.prepare(
    "SELECT topic,tier,COUNT(*) n FROM questions WHERE test_id='practice' GROUP BY topic,tier").all()).results;
  const done = (await env.DB.prepare("SELECT topic,level FROM lattempts WHERE pin=?").bind(pin).all()).results;
  return json({ ok: true, progress: rows, thresholds: CLEAR, pool, done });
}
async function levelSave(req, env) {
  const b = await req.json();
  await env.DB.prepare(
    "INSERT OR IGNORE INTO lattempts (pin,topic,level,correct,total,detail) VALUES (?,?,?,?,?,?)")
    .bind(cleanPin(b.pin), b.topic, b.level, b.correct | 0, b.total | 0, JSON.stringify(b.detail || [])).run();
  return json({ ok: true });
}
async function levelReview(url, env) {
  const pin = cleanPin(url.searchParams.get("pin")), t = url.searchParams.get("topic"), l = url.searchParams.get("level");
  const r = await env.DB.prepare("SELECT correct,total,detail FROM lattempts WHERE pin=? AND topic=? AND level=?").bind(pin, t, l).first();
  if (!r) return json({ ok: false }, 404);
  return json({ ok: true, correct: r.correct, total: r.total, detail: JSON.parse(r.detail || "[]") });
}

// student flags a bad question
async function report(req, env) {
  const b = await req.json();
  await env.DB.prepare("INSERT INTO issues (pin,qkey,source,stem,note) VALUES (?,?,?,?,?)")
    .bind(cleanPin(b.pin), String(b.qkey || "").slice(0, 120), String(b.source || "").slice(0, 40),
      String(b.stem || "").slice(0, 400), String(b.note || "").slice(0, 500)).run();
  return json({ ok: true });
}
async function adminIssues(req, env) {
  if (!requireAdmin(req, env)) return json({ ok: false, error: "unauthorized" }, 401);
  const r = await env.DB.prepare(
    "SELECT id,pin,qkey,source,stem,note,created_at FROM issues WHERE resolved=0 ORDER BY id DESC LIMIT 200").all();
  return json({ ok: true, issues: r.results });
}
async function logSwitch(req, env) {
  const b = await req.json();
  await env.DB.prepare("INSERT INTO switches (pin,context,day) VALUES (?,?,?)")
    .bind(cleanPin(b.pin), String(b.context || "").slice(0, 60), b.day || new Date().toISOString().slice(0, 10)).run();
  return json({ ok: true });
}
async function adminSwitches(req, env) {
  if (!requireAdmin(req, env)) return json({ ok: false, error: "unauthorized" }, 401);
  const r = await env.DB.prepare(
    `SELECT s.pin, st.name, st.batch, COUNT(*) n, MAX(s.created_at) last
     FROM switches s LEFT JOIN students st ON st.pin=s.pin
     GROUP BY s.pin ORDER BY n DESC LIMIT 200`).all();
  return json({ ok: true, switches: r.results });
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

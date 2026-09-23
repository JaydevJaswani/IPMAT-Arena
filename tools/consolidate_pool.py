#!/usr/bin/env python3
"""Merge all harvested real questions into one level-tagged practice pool -> SQL for D1.
Pool lives in `questions` with test_id='practice' (not listed as a Test). Campaign /practice
serves by topic+tier; answers stay server-side."""
import json, os, re
D = os.path.expanduser("~/Downloads/IPMAT-Arena/data")
OUT = os.path.expanduser("~/Downloads/IPMAT-Arena/build/practice_pool.sql")

# topic normalisation to the syllabus map
TOPIC = {
    "Number System": "Number System", "Number Theory": "Remainders & Number Theory",
    "Surds & Indices": "Surds & Indices", "Linear Equations": "Linear & Quadratic Equations",
    "Sequences & Series": "Sequences & Series", "Inequalities & Modulus": "Inequalities & Modulus",
}
TIER_LEVEL = {"Warm-Up": "L1", "Exam-Relevant": "L2", "Heavy & Tricky": "L3", "Killer": "L4"}

def load(f):
    p = os.path.join(D, f)
    return json.load(open(p)) if os.path.exists(f if os.path.exists(f) else p) else []

files = ["bank_static.json", "bank_remainders.json", "src_number_system_40.json",
         "src_sequences.json", "src_inequalities.json"]
rows, seen = [], set()
for f in files:
    for q in load(f):
        stem = re.sub(r"\s+", " ", q.get("stem", "")).strip()
        k = stem[:60].lower()
        if not stem or k in seen:
            continue
        seen.add(k)
        topic = TOPIC.get(q.get("topic", ""), q.get("topic", "Number System"))
        tier = q.get("tier", "Exam-Relevant")
        # RULE: a TITA (type-in / 'int') must have a WHOLE-NUMBER answer.
        # If not whole (decimal / fraction / symbol): make it MCQ when options exist, else short-answer.
        typ = q.get("type", "int"); ans = str(q.get("answer", "")).strip(); opts = q.get("options")
        if typ == "int" and not re.fullmatch(r"-?\d+", ans):
            typ = "mcq" if opts else "short"
        rows.append({"topic": topic, "tier": tier, "type": typ,
                     "mode": q.get("mode", "auto"), "stem": stem,
                     "options": q.get("options"), "answer": str(q.get("answer", "")),
                     "answer_display": str(q.get("answer_display", q.get("answer", ""))),
                     "solution": q.get("solution", ""), "source": q.get("source", "deck")})

def esc(s):
    return "'" + str(s).replace("'", "''") + "'" if s is not None else "NULL"

lines = ["DELETE FROM questions WHERE test_id='practice';"]
for i, q in enumerate(rows, 1):
    opts = esc(json.dumps(q["options"])) if q["options"] else "NULL"
    lines.append("INSERT INTO questions (id,test_id,seq,topic,tier,type,mode,stem,options,answer,answer_display,solution,trap,source) VALUES ("
        + f"{esc('practice:'+str(i))},'practice',{i},{esc(q['topic'])},{esc(q['tier'])},{esc(q['type'])},{esc(q['mode'])},{esc(q['stem'])},{opts},{esc(q['answer'])},{esc(q['answer_display'])},{esc(q['solution'])},NULL,{esc(q['source'])});")

os.makedirs(os.path.dirname(OUT), exist_ok=True)
open(OUT, "w").write("\n".join(lines) + "\n")

from collections import Counter
print(f"Practice pool: {len(rows)} questions -> {OUT}")
print("By topic:", dict(Counter(q["topic"] for q in rows)))
print("By level:", dict(Counter(TIER_LEVEL.get(q["tier"], "L?") for q in rows)))

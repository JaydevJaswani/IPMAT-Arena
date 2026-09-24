#!/usr/bin/env python3
"""Import IMS_UG_QA_Bank_SET1.xlsx into the Conquest practice pool (D1 `questions`, test_id='practice').
Subtopic->topic, Difficulty->tier, MCQ/TITA, images embedded in stem. Enforces whole-number TITA."""
import pandas as pd, json, re, sys
from pathlib import Path
SRC = sys.argv[1] if len(sys.argv) > 1 else str(Path.home()/"Downloads"/"IMS_UG_QA_Bank_SET1.xlsx")
OUT = Path.home()/"Downloads"/"IPMAT-Arena"/"build"/"bank_set1.sql"
TIER = {"Easy": "Warm-Up", "Moderate": "Exam-Relevant", "Difficult": "Heavy & Tricky"}

def esc(s): return "'" + str(s).replace("'", "''") + "'" if s is not None else "NULL"
def clean(s): return re.sub(r"\s+", " ", str(s)).strip()

df = pd.read_excel(SRC, sheet_name="Set 1 Upload")
lines = ["DELETE FROM questions WHERE test_id='practice';"]
n = 0; skipped = 0
for _, r in df.iterrows():
    qid = clean(r["Question ID"]); topic = clean(r["Subtopic"]); tier = TIER.get(clean(r["Difficulty"]))
    if not tier or not topic: skipped += 1; continue
    stem = clean(r["Question"])
    img = r["Image"]
    if pd.notna(img) and str(img).strip():
        stem += f'<div style="margin-top:12px"><img src="img/{clean(img)}" alt="figure" style="max-width:100%;border-radius:12px"></div>'
    qtype = clean(r["Question Type"]).upper()
    if qtype == "MCQ":
        opts = [clean(r[c]) for c in ("Option A", "Option B", "Option C", "Option D")]
        letter = clean(r["Correct Option"]).upper()
        if letter not in "ABCD": skipped += 1; continue
        ans = opts["ABCD".index(letter)]
        typ, options = "mcq", json.dumps(opts, ensure_ascii=False)
    else:  # TITA
        ans = clean(r["Correct Answer"])
        typ = "int" if re.fullmatch(r"-?\d+", ans) else "short"   # whole-number rule
        options = None
    sol = clean(r["Solution"]) if pd.notna(r["Solution"]) else ""
    n += 1
    lines.append("INSERT INTO questions (id,test_id,seq,topic,tier,type,mode,stem,options,answer,answer_display,solution,trap,source) VALUES ("
        + f"{esc('practice:'+qid)},'practice',{n},{esc(topic)},{esc(tier)},{esc(typ)},'auto',{esc(stem)},{esc(options)},{esc(ans)},{esc(ans)},{esc(sol)},NULL,'SET1'"+");")
OUT.write_text("\n".join(lines) + "\n")
from collections import Counter
print(f"Imported {n} questions ({skipped} skipped) -> {OUT}")
print("by section-tier:", dict(Counter(TIER.get(clean(r['Difficulty'])) for _, r in df.iterrows())))
print("topics:", df['Subtopic'].nunique())

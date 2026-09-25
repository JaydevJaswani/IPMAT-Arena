#!/usr/bin/env python3
"""Import QA_Question_Bank.xlsx into the Daily Duel bank (D1 `questions`, test_id='daily-bank').
MCQ answer=letter->option text; TITA answer=value (whole only). Figures embedded by Q_ID. Skips
review-flagged rows, MCQs missing an option, and non-whole TITA (can't be typed on the 0-9 keypad)."""
import pandas as pd, json, re, zipfile
from pathlib import Path
SRC = Path.home()/"Downloads"/"QA_Question_Bank.xlsx"
FIG = Path.home()/"Downloads"/"QA_Figures.zip"
OUT = Path.home()/"Downloads"/"IPMAT-Arena"/"build"/"daily_bank.sql"

def esc(s): return "'" + str(s).replace("'", "''") + "'" if s is not None else "NULL"
def clean(s): return re.sub(r"\s+", " ", str(s)).strip()

df = pd.read_excel(SRC, sheet_name="Question Bank")
figmap = {}
for n in zipfile.ZipFile(FIG).namelist():
    figmap[n.split("_")[0]] = n

lines = ["DELETE FROM questions WHERE test_id='daily-bank';"]
n = 0; sk_rev = sk_mcq = sk_dec = sk_fig = 0
for _, r in df.iterrows():
    if pd.notna(r.get("Review Flag")): sk_rev += 1; continue
    qid = clean(r["Q_ID"]); topic = clean(r["Subtopic"]) if pd.notna(r.get("Subtopic")) else clean(r.get("Topic", ""))
    stem = clean(r["Question"])
    # NOTE: QA_Figures.zip images are full slide screenshots that include the printed
    # solution + answer, so embedding them leaks the answer. Skip figure-needed rows until
    # clean, cropped diagrams are supplied. Re-enable by cropping figures then embedding here.
    if clean(r.get("Figure Needed", "")).lower() == "yes":
        sk_fig += 1; continue
    typ = clean(r["Type"]).upper()
    if typ == "MCQ":
        opts = [clean(r[c]) for c in ("Option A", "Option B", "Option C", "Option D")]
        if any(o == "" or o.lower() == "nan" for o in opts): sk_mcq += 1; continue
        letter = clean(r["Answer"]).upper()
        if letter not in "ABCD": sk_mcq += 1; continue
        ans = opts["ABCD".index(letter)]; qtype = "mcq"; options = json.dumps(opts, ensure_ascii=False)
    else:  # TITA
        ans = clean(r["Answer"])
        if not re.fullmatch(r"-?\d+", ans): sk_dec += 1; continue   # non-whole -> skip (keypad is 0-9)
        qtype = "int"; options = None
    sol = clean(r["Solution"]) if pd.notna(r.get("Solution")) else ""
    n += 1
    lines.append("INSERT INTO questions (id,test_id,seq,topic,tier,type,mode,stem,options,answer,answer_display,solution,trap,source) VALUES ("
        + f"{esc('daily-bank:'+qid)},'daily-bank',{n},{esc(topic)},'Exam-Relevant',{esc(qtype)},'auto',{esc(stem)},{esc(options)},{esc(ans)},{esc(ans)},{esc(sol)},NULL,'QA-Bank'"+");")
OUT.write_text("\n".join(lines) + "\n")
print(f"Daily Duel bank: {n} questions imported")
print(f"  skipped: {sk_rev} review-flagged, {sk_fig} figure-needed (answer-leaking slides), {sk_mcq} bad-MCQ, {sk_dec} non-whole TITA")

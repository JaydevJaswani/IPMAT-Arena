#!/usr/bin/env python3
"""
extract_questions.py — harvest MCQs from JJ's house-format practice PDFs.
Format: numbered stem -> A./B./C./D. options -> answer key '(B)' + worked solution.
Outputs structured questions with the correct option text as the answer.
  python3 extract_questions.py file.pdf --topic "Number System" --level L3
"""
import re, sys, json, argparse
from pypdf import PdfReader

def load(path):
    t = "\n".join((p.extract_text() or "") for p in PdfReader(path).pages)
    t = t.replace("\t", " ")
    t = re.sub(r"[  ]+", " ", t)
    return t

def split_key(text):
    # key section starts at first  "<n>. (A-D)"  or "(a-d) <n>"
    m = re.search(r"\n?\s*\d+\.\s*\([A-Da-d]\)", text)
    if m: return text[:m.start()], text[m.start():]
    m = re.search(r"\([A-Da-d]\)\s*\n?\s*\d+\b", text)
    if m: return text[:m.start()], text[m.start():]
    return text, ""

def parse_questions(qtext):
    body = " ".join(qtext.split("\n"))
    pat = re.compile(r"(\d{1,2})\.\s+(.*?)\s+A[\.\)]\s*(.*?)\s+B[\.\)]\s*(.*?)\s+C[\.\)]\s*(.*?)\s+D[\.\)]\s*(.*?)(?=\s+\d{1,2}\.\s|\Z)", re.S)
    out = {}
    for m in pat.finditer(body):
        n = int(m.group(1))
        stem = m.group(2).strip()
        opts = [re.sub(r"\s+", " ", m.group(i)).strip() for i in range(3, 7)]
        # trim trailing junk (footers) from D
        opts[3] = re.split(r"\s{2,}| Prepared| IMS | QA-| Jaydev", opts[3])[0].strip()
        if stem and all(opts) and len(stem) > 5:
            out[n] = {"stem": re.sub(r"\s+", " ", stem), "options": opts}
    return out

def parse_questions_b(qtext):
    # Format B: stem  a) o1 b) o2 c) o3 d) o4  <qnum>
    body = " ".join(qtext.split("\n"))
    pat = re.compile(r"(.*?)\s+a\)\s*(.*?)\s+b\)\s*(.*?)\s+c\)\s*(.*?)\s+d\)\s*(.*?)\s+(\d{1,2})\b", re.S)
    out = {}
    prev = 0
    for m in pat.finditer(body):
        n = int(m.group(6))
        stem = re.sub(r"\s+", " ", m.group(2 - 1)).strip()
        # stem is group(1) but may include tail of previous option; trim to last sentence-ish
        stem = re.sub(r"^.*?(?:[.?:]\s)(?=[A-Z(])", "", stem) if len(stem) > 160 else stem
        opts = [re.sub(r"\s+", " ", m.group(i)).strip() for i in range(2, 6)]
        if stem and all(opts) and 1 <= n <= 60 and len(stem) > 5:
            out[n] = {"stem": stem, "options": opts}
    return out

def parse_key(ktext):
    body = " ".join(ktext.split("\n"))
    ans = {}
    for m in re.finditer(r"(\d{1,2})\.\s*\(([A-Da-d])\)\s*(.*?)(?=\s+\d{1,2}\.\s*\(|\Z)", body, re.S):
        ans[int(m.group(1))] = {"letter": m.group(2).upper(), "sol": re.sub(r"\s+", " ", m.group(3)).strip()[:400]}
    if not ans:  # 'letter then number' variant
        for m in re.finditer(r"\(([A-Da-d])\)\s*(\d{1,2})\s+(.*?)(?=\s*\([A-Da-d]\)\s*\d|\Z)", body, re.S):
            ans[int(m.group(2))] = {"letter": m.group(1).upper(), "sol": re.sub(r"\s+", " ", m.group(3)).strip()[:400]}
    return ans

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("pdf"); ap.add_argument("--topic", required=True); ap.add_argument("--level", default="L2")
    ap.add_argument("--source", default=""); ap.add_argument("--out", default="")
    a = ap.parse_args()
    text = load(a.pdf)
    qsec, ksec = split_key(text)
    qs, key = parse_questions(qsec), parse_key(ksec)
    L2T = {"L1":"Warm-Up","L2":"Exam-Relevant","L3":"Heavy & Tricky","L4":"Killer"}
    bank = []
    for n in sorted(qs):
        q = qs[n]; k = key.get(n)
        if not k: continue
        idx = "ABCD".index(k["letter"])
        if idx >= len(q["options"]): continue
        bank.append({"topic": a.topic, "level": a.level, "tier": L2T.get(a.level, "Exam-Relevant"),
                     "type": "mcq", "mode": "auto", "stem": q["stem"], "options": q["options"],
                     "answer": q["options"][idx], "answer_display": q["options"][idx],
                     "solution": k["sol"], "source": a.source or a.pdf.split("/")[-1]})
    print(f"{a.pdf.split('/')[-1]}: {len(qs)} stems, {len(key)} keyed, {len(bank)} matched & usable")
    if a.out: json.dump(bank, open(a.out, "w"), indent=1, ensure_ascii=False)
    for b in bank[:2]:
        print("  Q:", b["stem"][:70]); print("   opts:", b["options"], "=>", b["answer"])
    return bank

if __name__ == "__main__": main()

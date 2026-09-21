#!/usr/bin/env python3
"""
ingest_pdf.py — CLI fallback for turning a question PDF into a named test.
(The no-install path is backend/add-test.html, which parses in the browser.)

  pip install pypdf          # one-time
  python3 ingest_pdf.py questions.pdf --name "Number System — Sprint 3" --topic "Number System"
  # add --push  with  API=... ADMIN_KEY=...  env vars to publish to the Worker

Format (tolerant): questions start "Q1." or "1."; options "(A) …"; "Ans: B" or "Ans: 133"; "Sol: …".
"""
import re, sys, json, os, argparse, urllib.request

def parse(text):
    blocks = re.split(r"\n(?=\s*(?:Q\s*\d+[.).]|\d+[.)])\s)", text)
    qs = []
    for b in blocks:
        b = b.strip()
        if not re.match(r"^\s*(Q\s*\d+|\d+)[.)]", b, re.I): continue
        stem, options, ans, sol, in_sol = [], [], None, [], False
        for l in [x.strip() for x in b.split("\n") if x.strip()]:
            m = re.match(r"^(?:Ans(?:wer)?)\s*[:.\-]\s*(.+)", l, re.I)
            if m: ans = m.group(1).strip(); in_sol = False; continue
            m = re.match(r"^(?:Sol(?:ution)?)\s*[:.\-]\s*(.*)", l, re.I)
            if m:
                in_sol = True
                if m.group(1): sol.append(m.group(1))
                continue
            if in_sol: sol.append(l); continue
            om = re.match(r"^\(?([A-Da-d])[).]\s*(.+)", l)
            if om and len(options) < 4: options.append((om.group(1).upper(), om.group(2).strip())); continue
            stem.append(re.sub(r"^\s*(?:Q\s*\d+|\d+)[.)]\s*", "", l, flags=re.I))
        if not stem: continue
        typ, answer, display, opts, mode = "int", ans or "", ans or "", None, "auto"
        if len(options) >= 2:
            typ = "mcq"; opts = [v for _, v in options]
            if ans and re.fullmatch(r"[A-Da-d]", ans.strip()):
                hit = dict(options).get(ans.strip().upper())
                if hit: answer = display = hit
        elif ans and not re.fullmatch(r"-?\d+(\.\d+)?", ans.replace(" ", "")):
            typ = "short"
        if not ans: mode = "open"
        qs.append({"stem": " ".join(stem), "type": typ, "mode": mode, "options": opts,
                   "answer": answer, "answer_display": display, "solution": " ".join(sol), "tier": "Exam-Relevant"})
    return qs

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("pdf"); ap.add_argument("--name", required=True); ap.add_argument("--topic", default="")
    ap.add_argument("--push", action="store_true")
    a = ap.parse_args()
    try:
        from pypdf import PdfReader
    except ImportError:
        sys.exit("Need pypdf:  pip install pypdf   (or just use backend/add-test.html — no install).")
    text = "\n".join((pg.extract_text() or "") for pg in PdfReader(a.pdf).pages)
    qs = parse(text)
    json.dump(qs, open("parsed_test.json", "w"), indent=2, ensure_ascii=False)
    auto = sum(1 for q in qs if q["mode"] == "auto")
    print(f"Parsed {len(qs)} questions ({auto} auto-gradeable) -> parsed_test.json")
    for i, q in enumerate(qs[:5], 1):
        print(f"  Q{i}. {q['stem'][:70]}  => {q['answer_display'] or '⚠ no Ans:'}")
    if a.push:
        api, key = os.environ.get("API"), os.environ.get("ADMIN_KEY")
        if not api or not key: sys.exit("Set API and ADMIN_KEY env vars to --push.")
        body = json.dumps({"name": a.name, "topic": a.topic, "questions": qs}).encode()
        req = urllib.request.Request(api.rstrip("/") + "/admin/upload-test", body,
              {"Content-Type": "application/json", "X-Admin-Key": key})
        print(urllib.request.urlopen(req).read().decode())

if __name__ == "__main__": main()

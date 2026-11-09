import os, sqlite3, random, math
from datetime import datetime, timedelta
from collections import defaultdict
from pathlib import Path
from typing import Optional
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

DB = str(Path(__file__).parent / "signalbridge.db")
GRID = 0.005        # ~500 m privacy grid
MIN_REPORTS = 5     # hide cells with fewer reports

app = FastAPI(title="LumiBridge")
ALLOWED_ORIGINS = [o.strip() for o in os.getenv("ALLOWED_ORIGINS", "*"). split(",")]
app.add_middleware(CORSMiddleware, allow_origins=ALLOWED_ORIGINS,
                   allow_methods=["*"], allow_headers=["*"])

def db():
    c = sqlite3.connect(DB)
    c.row_factory = sqlite3.Row
    return c

def snap(v):
    return round(round(v / GRID) * GRID, 4)

import hashlib, hmac, secrets
from fastapi import Depends, HTTPException, Header

def hash_pw(pw):
    salt = secrets.token_bytes(16)
    h = hashlib.pbkdf2_hmac("sha256", pw.encode(), salt, 200_000)
    return salt.hex() + ":" + h.hex()

def check_pw(pw, stored):
    salt_hex, h_hex = stored.split(":")
    h = hashlib.pbkdf2_hmac("sha256", pw.encode(), bytes.fromhex(salt_hex), 200_000)
    return hmac.compare_digest(h.hex(), h_hex)

def tok_hash(t):
    return hashlib.sha256(t.encode()).hexdigest()

@app.on_event("startup")
def init_auth():
    c = db()
    c.execute("CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, email TEXT UNIQUE, name TEXT, role TEXT, pw TEXT)")
    c.execute("CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user_id INTEGER, expires TEXT)")
    c.execute("""CREATE TABLE IF NOT EXISTS cases(id INTEGER PRIMARY KEY, title TEXT, area TEXT,
        provider TEXT, priority TEXT, status TEXT, note TEXT, created_by TEXT,
        created_at TEXT, updated_at TEXT)""")
    if c.execute("SELECT COUNT(*) FROM users").fetchone()[0] == 0:
        for email, name, role, pw in [
            ("analyst@demo.signalbridge", "Demo Analyst", "analyst", "analyst-demo-2026"),
            ("manager@demo.signalbridge", "Demo Manager", "manager", "manager-demo-2026")]:
            c.execute("INSERT INTO users(email,name,role,pw) VALUES(?,?,?,?)",
                      (email, name, role, hash_pw(pw)))
    c.commit()
    c.close()

def require_user(authorization: Optional[str] = Header(None)):
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(401, "Login required")
    c = db()
    row = c.execute(
        "SELECT u.id,u.email,u.name,u.role,s.expires FROM sessions s "
        "JOIN users u ON u.id=s.user_id WHERE s.token=?",
        (tok_hash(authorization[7:]),)).fetchone()
    c.close()
    if not row or row["expires"] < datetime.now().isoformat():
        raise HTTPException(401, "Session expired")
    return dict(row)

FAILS = {}   # failed login counter per email

class Login(BaseModel):
    email: str
    password: str

@app.post("/api/login")
def login(d: Login):
    key = d.email.lower().strip()
    n, until = FAILS.get(key, (0, None))
    if until and datetime.now() < until:
        raise HTTPException(429, "Too many attempts. Try again in a few minutes.")
    c = db()
    u = c.execute("SELECT * FROM users WHERE email=?", (key,)).fetchone()
    if not u or not check_pw(d.password, u["pw"]):
        c.close()
        n += 1
        FAILS[key] = (n, datetime.now() + timedelta(minutes=5) if n >= 5 else None)
        raise HTTPException(401, "Wrong email or password")
    FAILS.pop(key, None)
    token = secrets.token_urlsafe(32)
    c.execute("INSERT INTO sessions VALUES(?,?,?)",
              (tok_hash(token), u["id"], (datetime.now() + timedelta(hours=8)).isoformat()))
    c.commit()
    c.close()
    return {"token": token, "name": u["name"], "role": u["role"]}

def seed(c):
    areas = {"Lekki": (6.4478, 3.4723), "Ikeja": (6.6018, 3.3515),
             "Yaba": (6.5095, 3.3711), "Victoria Island": (6.4281, 3.4219)}
    providers = ["MTN", "Airtel", "GLO"]  # fictional
    now = datetime.now()
    for _ in range(2500):
        name = random.choice(list(areas))
        lat, lng = areas[name]
        lat += random.uniform(-.008, .008)
        lng += random.uniform(-.008, .008)
        ts = now - timedelta(days=random.randint(0, 13), hours=random.randint(0, 23))
        p = 0.12
        if name == "Lekki" and 19 <= ts.hour <= 22:
            p = 0.72   # the hidden pattern the engine should find
        slow = random.random() < p
        dl = random.uniform(.5, 4.5) if slow else random.uniform(6, 60)
        c.execute(
            "INSERT INTO reports(provider,issue,lat,lng,ts,download,latency,slow) VALUES(?,?,?,?,?,?,?,?)",
            (random.choice(providers), "slow_data" if slow else "none",
             snap(lat), snap(lng), ts.isoformat(), round(dl, 1),
             round(random.uniform(25, 400 if slow else 90)), int(slow)))

@app.on_event("startup")
def init():
    c = db()
    c.execute("""CREATE TABLE IF NOT EXISTS reports(
        id INTEGER PRIMARY KEY, provider TEXT, issue TEXT, lat REAL, lng REAL,
        ts TEXT, download REAL, latency REAL, slow INTEGER)""")
    if c.execute("SELECT COUNT(*) FROM reports").fetchone()[0] == 0:
        seed(c)
    c.commit()
    c.close()

class Report(BaseModel):
    provider: str = Field(max_length=40)
    issue: str = Field(max_length=40)
    lat: float = Field(ge=-90, le=90)
    lng: float = Field(ge=-180, le=180)
    download: float = Field(ge=0, le=10000)
    latency: Optional[float] = Field(default=None, ge=0, le=60000)

@app.post("/api/reports")
def add_report(r: Report):
    c = db()
    c.execute(
        "INSERT INTO reports(provider,issue,lat,lng,ts,download,latency,slow) VALUES(?,?,?,?,?,?,?,?)",
        (r.provider, r.issue, snap(r.lat), snap(r.lng), datetime.now().isoformat(),
         r.download, r.latency, int(r.download < 5)))
    c.commit()
    c.close()
    return {"ok": True}

@app.get("/api/aggregates")
def aggregates(provider: Optional[str] = None):
    q = "SELECT lat,lng,COUNT(*) n,AVG(slow) rate,MAX(ts) last FROM reports"
    args = []
    if provider:
        q += " WHERE provider=?"
        args.append(provider)
    q += " GROUP BY lat,lng HAVING n>=?"
    args.append(MIN_REPORTS)
    c = db()
    rows = c.execute(q, args).fetchall()
    c.close()
    return [{"lat": r["lat"], "lng": r["lng"], "count": r["n"],
             "slow_rate": round(r["rate"], 2), "last": r["last"]} for r in rows]

@app.get("/api/insights")
def insights():
    c = db()
    rows = c.execute("SELECT lat,lng,ts,slow FROM reports").fetchall()
    c.close()
    cells = defaultdict(lambda: defaultdict(list))
    for r in rows:
        cells[(r["lat"], r["lng"])][datetime.fromisoformat(r["ts"]).hour].append(r["slow"])
    out = []
    for (lat, lng), hours in cells.items():
        for h, v in hours.items():
            others = [x for hh, vv in hours.items() if hh != h for x in vv]
            if len(v) < MIN_REPORTS or len(others) < 20:
                continue
            p = sum(v) / len(v)
            b = min(max(sum(others) / len(others), .02), .98)
            z = (p - b) / math.sqrt(b * (1 - b) / len(v))
            if z >= 3 and p - b >= .25:
                out.append({"lat": lat, "lng": lng, "hour": h, "reports": len(v),
                            "slow_rate": round(p, 2), "baseline": round(b, 2), "z": round(z, 1),
                            "message": f"Slow reports reach {p:.0%} around {h:02d}:00 vs {b:.0%} baseline. Pattern worth investigating."})
    return sorted(out, key=lambda x: -x["z"])[:8]
@app.get("/api/hourly")
def hourly(lat: float = 6.4478, lng: float = 3.4723, radius: float = 0.02):
    c = db()
    rows = c.execute(
        "SELECT ts,slow FROM reports WHERE ABS(lat-?)<? AND ABS(lng-?)<?",
        (lat, radius, lng, radius)).fetchall()
    c.close()
    tot = [0] * 24
    slow = [0] * 24
    for r in rows:
        h = datetime.fromisoformat(r["ts"]).hour
        tot[h] += 1
        slow[h] += r["slow"]
    return [{"hour": h, "reports": tot[h],
             "slow_rate": round(slow[h] / tot[h], 2) if tot[h] else 0} for h in range(24)]
import csv, io
from fastapi import Response

AREAS = {"Lekki": (6.4478, 3.4723), "Ikeja": (6.6018, 3.3515),
         "Yaba": (6.5095, 3.3711), "Victoria Island": (6.4281, 3.4219)}

def area_of(lat, lng):
    name, d = min(((n, math.hypot(lat - a, lng - b)) for n, (a, b) in AREAS.items()),
                  key=lambda x: x[1])
    return name if d < 0.03 else "Other"

def rate(v):
    return round(sum(v) / len(v), 2) if v else 0

def get_rows(provider=None, area=None, days=14, issue=None):
    since = (datetime.now() - timedelta(days=days)).isoformat()
    q = "SELECT * FROM reports WHERE ts>=?"
    args = [since]
    if provider:
        q += " AND provider=?"
        args.append(provider)
    if issue:
        q += " AND issue=?"
        args.append(issue)
    c = db()
    rows = [dict(r) for r in c.execute(q, args).fetchall()]
    c.close()
    for r in rows:
        r["area"] = area_of(r["lat"], r["lng"])
        r["hour"] = datetime.fromisoformat(r["ts"]).hour
    if area:
        rows = [r for r in rows if r["area"] == area]
    return rows

@app.get("/api/dashboard", dependencies=[Depends(require_user)])
def dashboard(provider: Optional[str] = None, area: Optional[str] = None,
              days: int = 14, issue: Optional[str] = None):
    rows = get_rows(provider, area, days, issue)
    n = len(rows)
    lats = [r["latency"] for r in rows if r["latency"] is not None]
    kpis = {"reports": n,
            "slow_rate": rate([r["slow"] for r in rows]),
            "avg_download": round(sum(r["download"] for r in rows) / n, 1) if n else 0,
            "avg_latency": round(sum(lats) / len(lats)) if lats else 0}

    hourly = []
    for h in range(24):
        v = [r["slow"] for r in rows if r["hour"] == h]
        hourly.append({"hour": h, "reports": len(v), "slow_rate": rate(v)})

    by_area = defaultdict(list)
    for r in rows:
        by_area[r["area"]].append(r)
    areas = []
    for name, rs in by_area.items():
        if len(rs) < MIN_REPORTS:
            continue
        hrs = defaultdict(list)
        for r in rs:
            hrs[r["hour"]].append(r["slow"])
        best = None
        for h, v in hrs.items():
            others = [x for hh, vv in hrs.items() if hh != h for x in vv]
            if len(v) < MIN_REPORTS or len(others) < 20:
                continue
            p = sum(v) / len(v)
            b = min(max(sum(others) / len(others), .02), .98)
            z = (p - b) / math.sqrt(b * (1 - b) / len(v))
            if best is None or z > best[0]:
                best = (z, h, p, b)
        overall = rate([r["slow"] for r in rs])
        status, peak = "Normal", "·"
        if best and best[0] >= 3 and best[2] - best[3] >= .25:
            status, peak = "Investigate", f"around {best[1]:02d}:00"
        elif overall > .25:
            status = "Monitor"
        areas.append({"area": name, "reports": len(rs), "slow_rate": overall,
                      "peak": peak, "status": status})
    order = {"Investigate": 0, "Monitor": 1, "Normal": 2}
    areas.sort(key=lambda a: (order[a["status"]], -a["slow_rate"]))

    by_prov = defaultdict(list)
    for r in rows:
        by_prov[r["provider"]].append(r)
    providers = [{"provider": p, "reports": len(rs),
                  "slow_rate": rate([r["slow"] for r in rs]),
                  "avg_download": round(sum(r["download"] for r in rs) / len(rs), 1)}
                 for p, rs in by_prov.items()]

    cutoff = (datetime.now() - timedelta(days=days / 2)).isoformat()
    trend = {"earlier": rate([r["slow"] for r in rows if r["ts"] < cutoff]),
             "recent": rate([r["slow"] for r in rows if r["ts"] >= cutoff])}

    return {"kpis": kpis, "hourly": hourly, "areas": areas,
            "providers": providers, "trend": trend}

@app.get("/api/export.csv", dependencies=[Depends(require_user)])
def export_csv(provider: Optional[str] = None, area: Optional[str] = None,
               days: int = 14, issue: Optional[str] = None):
    rows = get_rows(provider, area, days, issue)
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["timestamp", "area", "provider", "issue", "lat", "lng",
                "download_mbps", "latency_ms", "slow"])
    for r in rows:
        w.writerow([r["ts"], r["area"], r["provider"], r["issue"], r["lat"],
                    r["lng"], r["download"], r["latency"], r["slow"]])
    return Response(content=buf.getvalue(), media_type="text/csv",
                    headers={"Content-Disposition": "attachment; filename=signalbridge_export.csv"})
@app.get("/api/nearby")
def nearby(lat: float, lng: float, hours: int = 72, radius: float = 0.01):
    since = (datetime.now() - timedelta(hours=hours)).isoformat()
    c = db()
    rows = c.execute(
        "SELECT slow FROM reports WHERE ts>=? AND ABS(lat-?)<? AND ABS(lng-?)<?",
        (since, lat, radius, lng, radius)).fetchall()
    c.close()
    return {"reports": len(rows), "slow": sum(r["slow"] for r in rows)}
@app.post("/api/logout")
def logout(authorization: Optional[str] = Header(None), user=Depends(require_user)):
    c = db()
    c.execute("DELETE FROM sessions WHERE token=?", (tok_hash(authorization[7:]),))
    c.commit()
    c.close()
    return {"ok": True}

STATUSES = ["Open", "Investigating", "Resolved"]
PRIORITIES = ["low", "medium", "high"]

class CaseIn(BaseModel):
    title: str
    area: str
    provider: Optional[str] = None
    priority: str = "medium"
    note: str = ""

class CaseUpdate(BaseModel):
    status: Optional[str] = None
    priority: Optional[str] = None
    note: Optional[str] = None

@app.get("/api/cases")
def list_cases(user=Depends(require_user)):
    c = db()
    rows = c.execute(
        "SELECT * FROM cases ORDER BY CASE status WHEN 'Open' THEN 0 "
        "WHEN 'Investigating' THEN 1 ELSE 2 END, updated_at DESC").fetchall()
    c.close()
    return [dict(r) for r in rows]

@app.post("/api/cases")
def create_case(d: CaseIn, user=Depends(require_user)):
    title = d.title.strip()
    if not title or len(title) > 150:
        raise HTTPException(400, "Title is required (max 150 characters)")
    if d.priority not in PRIORITIES:
        raise HTTPException(400, "Invalid priority")
    now = datetime.now().isoformat()
    c = db()
    c.execute(
        "INSERT INTO cases(title,area,provider,priority,status,note,created_by,created_at,updated_at) "
        "VALUES(?,?,?,?,?,?,?,?,?)",
        (title, d.area, d.provider, d.priority, "Open", d.note[:2000], user["name"], now, now))
    c.commit()
    c.close()
    return {"ok": True}

@app.patch("/api/cases/{case_id}")
def update_case(case_id: int, d: CaseUpdate, user=Depends(require_user)):
    if d.status is not None and d.status not in STATUSES:
        raise HTTPException(400, "Invalid status")
    if d.priority is not None and d.priority not in PRIORITIES:
        raise HTTPException(400, "Invalid priority")
    c = db()
    cur = c.execute("SELECT * FROM cases WHERE id=?", (case_id,)).fetchone()
    if not cur:
        c.close()
        raise HTTPException(404, "Case not found")
    if d.status == "Resolved" and cur["status"] != "Resolved" and user["role"] != "manager":
        c.close()
        raise HTTPException(403, "Only managers can resolve cases")
    c.execute("UPDATE cases SET status=?,priority=?,note=?,updated_at=? WHERE id=?",
              (d.status or cur["status"], d.priority or cur["priority"],
               cur["note"] if d.note is None else d.note[:2000],
               datetime.now().isoformat(), case_id))
    c.commit()
    c.close()
    return {"ok": True}

# ---------- Before / after comparison ----------
@app.on_event("startup")
def init_intervention():
    c = db()
    for col in ("intervention_at TEXT", "intervention_note TEXT"):
        try:
            c.execute("ALTER TABLE cases ADD COLUMN " + col)
        except sqlite3.OperationalError:
            pass   # column already exists
    c.commit()
    c.close()

class Intervention(BaseModel):
    date: str          # YYYY-MM-DD
    note: str = ""

@app.post("/api/cases/{case_id}/intervention")
def set_intervention(case_id: int, d: Intervention, user=Depends(require_user)):
    try:
        day = datetime.strptime(d.date, "%Y-%m-%d")
    except ValueError:
        raise HTTPException(400, "Date must look like 2026-10-20")
    if day.date() > datetime.now().date():
        raise HTTPException(400, "The intervention date cannot be in the future")
    c = db()
    cur = c.execute(
        "UPDATE cases SET intervention_at=?, intervention_note=?, updated_at=? WHERE id=?",
        (d.date, d.note[:300], datetime.now().isoformat(), case_id))
    c.commit()
    found = cur.rowcount
    c.close()
    if not found:
        raise HTTPException(404, "Case not found")
    return {"ok": True}

def window_stats(rows):
    n = len(rows)
    slow = sum(r["slow"] for r in rows)
    return {"reports": n, "slow_count": slow,
            "slow_rate": round(slow / n, 2) if n else 0,
            "avg_download": round(sum(r["download"] for r in rows) / n, 1) if n else 0}

def verdict(b, a):
    pct = lambda x: f"{round(x * 100)}%"
    if b["reports"] < 20 or a["reports"] < 20:
        return "unclear", "Not enough reports in one of the periods to compare reliably (at least 20 are needed in each)."
    p1, p2 = b["slow_count"] / b["reports"], a["slow_count"] / a["reports"]
    pool = (b["slow_count"] + a["slow_count"]) / (b["reports"] + a["reports"])
    se = math.sqrt(pool * (1 - pool) * (1 / b["reports"] + 1 / a["reports"])) or 1e-9
    z = (p2 - p1) / se
    if z <= -2:
        return "improved", f"Slow reports fell from {pct(p1)} to {pct(p2)}. That change is unlikely to be random noise."
    if z >= 2:
        return "worse", f"Slow reports rose from {pct(p1)} to {pct(p2)}. That change is unlikely to be random noise."
    return "no_change", f"No clear change: {pct(p1)} slow before, {pct(p2)} after. The difference is within normal variation."

@app.get("/api/cases/{case_id}/compare")
def compare_case(case_id: int, user=Depends(require_user)):
    c = db()
    case = c.execute("SELECT * FROM cases WHERE id=?", (case_id,)).fetchone()
    if not case:
        c.close()
        raise HTTPException(404, "Case not found")
    if not case["intervention_at"]:
        c.close()
        raise HTTPException(400, "Set an intervention date first")

    start = datetime.strptime(case["intervention_at"], "%Y-%m-%d")
    span = min(datetime.now() - start, timedelta(days=14))
    if span < timedelta(days=1):
        c.close()
        raise HTTPException(400, "Wait at least one day after the intervention before comparing")

    rows = [dict(r) for r in c.execute(
        "SELECT * FROM reports WHERE ts>=? AND ts<?",
        ((start - span).isoformat(), (start + span).isoformat())).fetchall()]
    c.close()

    rows = [r for r in rows if area_of(r["lat"], r["lng"]) == case["area"]]
    if case["provider"]:
        rows = [r for r in rows if r["provider"] == case["provider"]]
    for r in rows:
        r["hour"] = datetime.fromisoformat(r["ts"]).hour
    before = [r for r in rows if r["ts"] < start.isoformat()]
    after = [r for r in rows if r["ts"] >= start.isoformat()]

    overall = {"before": window_stats(before), "after": window_stats(after)}

    # Peak window: the area's worst hour (and the hours either side) in the BEFORE period
    peak = None
    hrs = defaultdict(list)
    for r in before:
        hrs[r["hour"]].append(r["slow"])
    cand = [(sum(v) / len(v), h) for h, v in hrs.items() if len(v) >= 5]
    if cand:
        ph = max(cand)[1]
        win = {(ph + k) % 24 for k in (-1, 0, 1)}
        pb = [r for r in before if r["hour"] in win]
        pa = [r for r in after if r["hour"] in win]
        peak = {"hours": f"{(ph - 1) % 24:02d}:00 to {(ph + 2) % 24:02d}:00",
                "before": window_stats(pb), "after": window_stats(pa)}

    # Judge on the peak window when it has enough data, otherwise the whole area
    use = peak if peak and peak["before"]["reports"] >= 20 and peak["after"]["reports"] >= 20 else overall
    v, msg = verdict(use["before"], use["after"])

    return {
        "verdict": v, "message": msg,
        "overall": overall, "peak": peak,
        "note": case["intervention_note"] or "",
        "window": f"Compared {span.days} days before vs {span.days} days after {case['intervention_at']}.",
        "caveat": "User reports show what people experienced, not what caused it. Weather, holidays and who chooses to report can also shift results, so treat this as supporting evidence, not proof the intervention worked."}

@app.post("/api/cases/{case_id}/demo-improvement")
def demo_improvement(case_id: int, user=Depends(require_user)):
    # DEMO ONLY: replaces this area's reports after the intervention date with synthetic "improved" data
    if user["role"] != "manager":
        raise HTTPException(403, "Only managers can generate demo data")
    c = db()
    case = c.execute("SELECT * FROM cases WHERE id=?", (case_id,)).fetchone()
    if not case or not case["intervention_at"] or case["area"] not in AREAS:
        c.close()
        raise HTTPException(400, "Case needs a known area and an intervention date")
    start = datetime.strptime(case["intervention_at"], "%Y-%m-%d")
    now = datetime.now()
    area = case["area"]
    old = [r["id"] for r in c.execute(
        "SELECT id,lat,lng FROM reports WHERE ts>=?", (start.isoformat(),)).fetchall()
        if area_of(r["lat"], r["lng"]) == area]
    c.executemany("DELETE FROM reports WHERE id=?", [(i,) for i in old])

    lat0, lng0 = AREAS[area]
    providers = [case["provider"]] if case["provider"] else ["AlphaNet", "BetaCell", "GammaWave"]
    total_secs = int((now - start).total_seconds())
    for _ in range(max(1, (now - start).days) * 45):
        ts = start + timedelta(seconds=random.randint(0, total_secs))
        p = 0.20 if (area == "Lekki" and 19 <= ts.hour <= 22) else 0.12
        slow = random.random() < p
        dl = random.uniform(.5, 4.5) if slow else random.uniform(6, 60)
        c.execute(
            "INSERT INTO reports(provider,issue,lat,lng,ts,download,latency,slow) VALUES(?,?,?,?,?,?,?,?)",
            (random.choice(providers), "slow_data" if slow else "none",
             snap(lat0 + random.uniform(-.008, .008)), snap(lng0 + random.uniform(-.008, .008)),
             ts.isoformat(), round(dl, 1),
             round(random.uniform(25, 400 if slow else 90)), int(slow)))
    c.commit()
    c.close()
    return {"ok": True}

@app.get("/api/stats")
def stats():
    c = db()
    n = c.execute("SELECT COUNT(*) FROM reports").fetchone()[0]
    cells = c.execute(
        "SELECT COUNT(*) FROM (SELECT 1 FROM reports GROUP BY lat,lng HAVING COUNT(*)>=?)",
        (MIN_REPORTS,)).fetchone()[0]
    c.close()
    return {"reports": n, "cells": cells}
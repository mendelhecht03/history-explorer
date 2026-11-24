"""Send this computer's Chrome history to your History Explorer account.

Chrome on this PC also holds visits that Chrome sync brought in from your other
devices (for example Chrome on your iPhone); those are sent too and shown separately.

    python chrome_sync.py --setup https://your-app.workers.dev hx_yourkey
        Saves the key, sends existing history, and adds a Windows scheduled task
        that runs every 15 minutes.
    python chrome_sync.py            Send anything new now.
    python chrome_sync.py --remove   Delete the scheduled task and the saved key.

Only the link, page title and visit time are sent. Uses only the Python standard library.
"""
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

CHROME = Path(os.environ.get("LOCALAPPDATA", "")) / "Google" / "Chrome" / "User Data"
HOME = Path(os.environ.get("LOCALAPPDATA", Path.home())) / "HistoryExplorer"
CONFIG = HOME / "config.json"
TASK = "History Explorer Chrome sync"
EPOCH_DELTA = 11644473600  # seconds between 1601-01-01 and 1970-01-01
BATCH = 300


def load():
    try:
        return json.loads(CONFIG.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def save(cfg):
    HOME.mkdir(parents=True, exist_ok=True)
    CONFIG.write_text(json.dumps(cfg, indent=1), encoding="utf-8")


def post(cfg, visits):
    req = urllib.request.Request(
        cfg["origin"].rstrip("/") + "/api/chrome/batch",
        data=json.dumps({"visits": visits}).encode(),
        headers={"Content-Type": "application/json", "Authorization": "Bearer " + cfg["key"],
                 "User-Agent": "history-explorer-chrome-sync"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r).get("added", 0)


def profiles():
    if not CHROME.exists():
        return []
    return [p for p in CHROME.iterdir() if p.is_dir() and (p / "History").exists()]


def read_new(pdir, after_id, tmp):
    """Chrome locks History while running, so read a copy."""
    dst = tmp / f"{pdir.name}.db"
    shutil.copy2(pdir / "History", dst)
    for ext in ("-wal", "-journal"):
        side = Path(str(pdir / "History") + ext)
        if side.exists():
            shutil.copy2(side, Path(str(dst) + ext))
    con = sqlite3.connect(dst)
    cols = {r[1] for r in con.execute("pragma table_info(visits)")}
    origin = "v.originator_cache_guid" if "originator_cache_guid" in cols else "''"
    rows = con.execute(
        f"""select v.id, u.url, u.title, v.visit_time, {origin}, v.transition & 255
            from visits v join urls u on u.id = v.url where v.id > ? order by v.id""",
        (after_id,),
    ).fetchall()
    con.close()
    return rows


def sync(quiet=False):
    cfg = load()
    if not cfg:
        sys.exit("Not set up yet. Run: python chrome_sync.py --setup <app address> <key>")
    cur = cfg.setdefault("cursor", {})
    total = 0
    tmp = Path(tempfile.mkdtemp(prefix="hx-"))
    try:
        for pdir in profiles():
            rows = read_new(pdir, cur.get(pdir.name, 0), tmp)
            batch, last_id = [], cur.get(pdir.name, 0)
            for vid, url, title, vt, guid, core in rows:
                last_id = vid
                if core == 3 or not url.startswith(("http://", "https://")):
                    continue  # auto-loaded subframes and chrome:// pages
                batch.append({"url": url, "title": title or None, "t": int(vt / 1e6 - EPOCH_DELTA), "synced": bool(guid)})
                if len(batch) == BATCH:
                    total += post(cfg, batch)
                    batch = []
                    cur[pdir.name] = last_id
                    save(cfg)
            if batch:
                total += post(cfg, batch)
            cur[pdir.name] = last_id
            save(cfg)
    except urllib.error.HTTPError as e:
        msg = e.read().decode(errors="ignore")[:200]
        if e.code == 401:
            sys.exit("This key was removed in Settings. Make a new one and run --setup again.")
        sys.exit(f"Upload stopped ({e.code} {msg}). It will continue from here next time.")
    except urllib.error.URLError as e:
        sys.exit(f"Couldn't reach the app ({e.reason}). It will try again next time.")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    if not quiet:
        print(f"Sent {total:,} new Chrome visits.")


def schedule():
    script = Path(__file__).resolve()
    pyw = Path(sys.executable).with_name("pythonw.exe")
    exe = pyw if pyw.exists() else Path(sys.executable)
    cmd = f'"{exe}" "{script}" --quiet'
    subprocess.run(["schtasks", "/Create", "/F", "/SC", "MINUTE", "/MO", "15", "/TN", TASK, "/TR", cmd], check=True,
                   stdout=subprocess.DEVNULL)


def main():
    args = sys.argv[1:]
    if args[:1] == ["--setup"]:
        if len(args) != 3:
            sys.exit("Usage: python chrome_sync.py --setup <app address> <key>")
        save({"origin": args[1].rstrip("/"), "key": args[2], "cursor": {}})
        print("Sending your Chrome history (the first run can take a minute)…")
        sync()
        if os.name == "nt":
            schedule()
            print(f'Done. Windows will send new visits every 15 minutes (task "{TASK}").')
    elif args[:1] == ["--remove"]:
        if os.name == "nt":
            subprocess.run(["schtasks", "/Delete", "/F", "/TN", TASK], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        shutil.rmtree(HOME, ignore_errors=True)
        print("Removed the scheduled task and the saved key.")
    else:
        sync(quiet="--quiet" in args)


if __name__ == "__main__":
    main()

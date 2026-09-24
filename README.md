# Annotator Progress Workbench

Lightweight attendance & annotation-progress workbench for small labeling teams.  
No company branding. Demo data is generated on first run.

This repository contains **two complete editions** of the same app:

| Folder | UI language | Role label |
|--------|-------------|------------|
| [`zh/`](zh/) | Chinese | 组员 |
| [`en/`](en/) | English | Annotator |

Each folder runs independently (own `server.py`, own local SQLite DB).

## Quick start

Requires **Python 3.10+** (stdlib only — no `pip install`).

```bash
# English UI
cd en
python3 server.py

# Chinese UI
cd zh
python3 server.py
```

Open the URL printed in the terminal (often `http://127.0.0.1:8765/`).

**Default admin:** `admin` / `admin123` — change this password after first login.

Or use the helper script:

```bash
./start.sh          # from zh/ or en/
# PORT=9000 ./start.sh
```

## What it does

- Daily task assignment & submission quotas
- Attendance (present / half-day / leave) with calendar
- Project totals, personal progress, workload history
- Admin / annotator roles (optional group lead & online lead)
- Optional deploy notes under `deploy/`

## Change theme colors

Edit `static/theme.css` in the edition you run:

- `--accent` — primary button / CTA color  
- `--accent-rgb` — same color as `R, G, B` (used for translucent borders)

Hard-refresh the browser after edits. Default theme is blue.

## Data & privacy

- SQLite file: `data/progress.db` (created automatically; gitignored)
- First launch seeds **fake demo people** only
- Runs on **your machine / your server** — nothing phones home

## Deploy on your own server

Copy either `zh/` or `en/` to a VPS, keep Python 3 running (systemd example in `deploy/`), and put nginx/Caddy in front if you want a domain + HTTPS.

## License

Use freely for your own teams. No warranty.

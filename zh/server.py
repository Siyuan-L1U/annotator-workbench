#!/usr/bin/env python3
"""Annotation Intern Progress：账号登录 + 权限（管理员 / 组员）。"""
from __future__ import annotations

import hashlib
import json
import os
import re
import secrets
import sqlite3
import threading
from contextlib import contextmanager
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from http.cookies import SimpleCookie
from pathlib import Path
from typing import Any, Iterator
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parent
DB_PATH = ROOT / "data" / "progress.db"
STATIC = ROOT / "static"
HOST = os.environ.get("HOST", "0.0.0.0")
PORT = int(os.environ.get("PORT", "8765"))
# 子路径部署，例如 BASE_PATH=/progress → http://host/progress/
BASE_PATH = (os.environ.get("BASE_PATH") or "").rstrip("/")
COOKIE_PATH = BASE_PATH or "/"
LOCK = threading.RLock()
# 业务日按中国时区，避免 UTC 跨日与前端本地日期不一致
APP_TZ = ZoneInfo("Asia/Shanghai")
# 业务日切日：北京时间该整点前仍算「昨天」（例：8 号 03:00 前可交 7 号任务量）
TASK_DAY_CUTOFF_HOUR = 3
SESSION_DAYS = 14
DEFAULT_ADMIN_USER = "admin"
DEFAULT_ADMIN_PASS = "admin123"
DAY_STATUSES = ("present", "leave", "leave_half")
STATUS_SCORE = {"present": 1.0, "leave_half": 0.5, "leave": 0.0}
WORK_CAL_KINDS = ("work", "off")
# Python weekday(): Mon=0 … Sun=6
WEEKDAY_CN_LABELS = ("一", "二", "三", "四", "五", "六", "日")
MAX_DAY_PROJECTS = 2
# 管理员兼岗每天可分配更多任务（按姓名；空集则仅看 is_admin_work）
MAX_DAY_PROJECTS_FLEX = 10
FLEX_DAY_PROJECT_NAMES: set[str] = set()
# 可写管理员用户名/显示名；两者都为空时 = 所有 admin 可写
WRITE_ADMIN_USERNAMES: set[str] = set()
WRITE_ADMIN_NAMES: set[str] = set()
TASK_UNITS = ("节", "条")
MAKEUP_MAX_DAYS = 60  # 组员可补交最近 N 天（不含今天）
# 可参与任务分配的项目（未停用且未标记完成）
ASSIGNABLE_PROJECT_WHERE = "active=1 AND COALESCE(completed,0)=0"
TEAM_GROUPS = ("A", "B")
# 初始分组（可在「账号管理」里改）
DEFAULT_TEAM_GROUPS: dict[str, str] = {}
# 现场办公（其余在职同学默认线上）
DEFAULT_ONSITE_NAMES: set[str] = set()
WORK_MODES = ("onsite", "remote")
DEFAULT_HUB_LINKS = [
    {
        "title": "填写本周/下周出勤",
        "url": "#attendance",
        "category": "日常",
        "note": "周五预填下周，中途可改",
    },
    {
        "title": "今日登记",
        "url": "#today",
        "category": "日常",
        "note": "提交今日完成量",
    },
]


def normalize_team_group(value: Any) -> str:
    g = str(value or "").strip().upper()
    if g in ("甲", "组A", "A组"):
        g = "A"
    elif g in ("乙", "组B", "B组"):
        g = "B"
    return g if g in TEAM_GROUPS else ""


def normalize_work_mode(value: Any) -> str:
    v = str(value or "").strip().lower()
    if v in ("onsite", "现场", "现场办公"):
        return "onsite"
    if v in ("remote", "online", "线上", "远程"):
        return "remote"
    return ""


def normalize_unit(value: Any) -> str:
    u = str(value or "节").strip()
    return u if u in TASK_UNITS else "节"


def normalize_platform_url(value: Any) -> str:
    """外链：空串或 http(s) URL（标注平台 / 在线文档等）。"""
    url = str(value or "").strip()
    if not url:
        return ""
    if not re.match(r"^https?://", url, re.I):
        raise ValueError("链接需以 http:// 或 https:// 开头")
    if len(url) > 500:
        raise ValueError("链接过长")
    return url


normalize_doc_url = normalize_platform_url
normalize_qc_url = normalize_platform_url


def now() -> str:
    return datetime.now(APP_TZ).isoformat(timespec="seconds")


def today_local() -> date:
    """看板业务「今天」：Asia/Shanghai；凌晨 TASK_DAY_CUTOFF_HOUR 点前仍算前一天。"""
    now = datetime.now(APP_TZ)
    d = now.date()
    if now.hour < TASK_DAY_CUTOFF_HOUR:
        d = d - timedelta(days=1)
    return d


def num(value: Any) -> float:
    try:
        return max(0.0, round(float(value or 0), 1))
    except (TypeError, ValueError):
        return 0.0


def percent(done: int, total: int) -> float:
    return round(100 * done / total, 1) if total else 0.0


def hash_password(password: str, salt: str | None = None) -> tuple[str, str]:
    salt = salt or secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt.encode("utf-8"), 120_000)
    return digest.hex(), salt


@contextmanager
def connect() -> Iterator[sqlite3.Connection]:
    """每次请求开连并在结束时关闭（sqlite 自带 with 只提交不关闭）。"""
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(DB_PATH), check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def init_db() -> None:
    with LOCK, connect() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS interns (
                id INTEGER PRIMARY KEY,
                name TEXT NOT NULL UNIQUE,
                active INTEGER NOT NULL DEFAULT 1,
                note TEXT DEFAULT '',
                team_group TEXT NOT NULL DEFAULT '',
                work_mode TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS projects (
                id INTEGER PRIMARY KEY,
                name TEXT NOT NULL UNIQUE,
                code TEXT DEFAULT '',
                target_total INTEGER NOT NULL DEFAULT 0,
                description TEXT DEFAULT '',
                active INTEGER NOT NULL DEFAULT 1,
                unit TEXT NOT NULL DEFAULT '节',
                platform_url TEXT NOT NULL DEFAULT '',
                doc_url TEXT NOT NULL DEFAULT '',
                qc_url TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS assignments (
                id INTEGER PRIMARY KEY,
                intern_id INTEGER NOT NULL REFERENCES interns(id) ON DELETE CASCADE,
                project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                target INTEGER NOT NULL DEFAULT 0,
                done INTEGER NOT NULL DEFAULT 0,
                status TEXT NOT NULL DEFAULT 'active',
                updated_at TEXT NOT NULL,
                UNIQUE(intern_id, project_id)
            );
            CREATE TABLE IF NOT EXISTS daily_progress (
                id INTEGER PRIMARY KEY,
                intern_id INTEGER NOT NULL REFERENCES interns(id) ON DELETE CASCADE,
                project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                day TEXT NOT NULL,
                assigned INTEGER NOT NULL DEFAULT 0,
                done INTEGER NOT NULL DEFAULT 0,
                note TEXT DEFAULT '',
                updated_at TEXT NOT NULL,
                UNIQUE(intern_id, project_id, day)
            );
            CREATE TABLE IF NOT EXISTS day_board (
                id INTEGER PRIMARY KEY,
                intern_id INTEGER NOT NULL REFERENCES interns(id) ON DELETE CASCADE,
                day TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'present',
                project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
                note TEXT DEFAULT '',
                updated_at TEXT NOT NULL,
                UNIQUE(intern_id, day)
            );
            CREATE TABLE IF NOT EXISTS day_board_projects (
                id INTEGER PRIMARY KEY,
                intern_id INTEGER NOT NULL REFERENCES interns(id) ON DELETE CASCADE,
                day TEXT NOT NULL,
                project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                slot INTEGER NOT NULL DEFAULT 1,
                task_label TEXT NOT NULL DEFAULT '',
                quota INTEGER NOT NULL DEFAULT 0,
                unit TEXT NOT NULL DEFAULT '节',
                UNIQUE(intern_id, day, project_id),
                UNIQUE(intern_id, day, slot)
            );
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY,
                username TEXT NOT NULL UNIQUE,
                password_hash TEXT NOT NULL,
                salt TEXT NOT NULL,
                role TEXT NOT NULL CHECK(role IN ('admin', 'intern')),
                intern_id INTEGER REFERENCES interns(id) ON DELETE SET NULL,
                display_name TEXT DEFAULT '',
                active INTEGER NOT NULL DEFAULT 1,
                group_admin INTEGER NOT NULL DEFAULT 0,
                online_admin INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS sessions (
                token TEXT PRIMARY KEY,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                expires_at TEXT NOT NULL
            );
            """
        )


def migrate_day_board() -> None:
    """旧版单项目 → day_board_projects；旧状态映射到出勤/请假。"""
    with LOCK, connect() as conn:
        conn.execute(
            """CREATE TABLE IF NOT EXISTS day_board_projects (
                id INTEGER PRIMARY KEY,
                intern_id INTEGER NOT NULL REFERENCES interns(id) ON DELETE CASCADE,
                day TEXT NOT NULL,
                project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                slot INTEGER NOT NULL DEFAULT 1,
                task_label TEXT NOT NULL DEFAULT '',
                quota INTEGER NOT NULL DEFAULT 0,
                unit TEXT NOT NULL DEFAULT '节',
                UNIQUE(intern_id, day, project_id),
                UNIQUE(intern_id, day, slot)
            )"""
        )
        # 补列：当日任务说明 + 配额 + 单位
        cols = {
            r[1]
            for r in conn.execute("PRAGMA table_info(day_board_projects)").fetchall()
        }
        if "task_label" not in cols:
            conn.execute(
                "ALTER TABLE day_board_projects ADD COLUMN task_label TEXT NOT NULL DEFAULT ''"
            )
        if "quota" not in cols:
            conn.execute(
                "ALTER TABLE day_board_projects ADD COLUMN quota INTEGER NOT NULL DEFAULT 0"
            )
        if "unit" not in cols:
            conn.execute(
                "ALTER TABLE day_board_projects ADD COLUMN unit TEXT NOT NULL DEFAULT '节'"
            )
        # 项目默认单位（节/条）
        proj_cols = {
            r[1] for r in conn.execute("PRAGMA table_info(projects)").fetchall()
        }
        if "unit" not in proj_cols:
            conn.execute(
                "ALTER TABLE projects ADD COLUMN unit TEXT NOT NULL DEFAULT '节'"
            )
        if "completed" not in proj_cols:
            conn.execute(
                "ALTER TABLE projects ADD COLUMN completed INTEGER NOT NULL DEFAULT 0"
            )
        if "platform_url" not in proj_cols:
            conn.execute(
                "ALTER TABLE projects ADD COLUMN platform_url TEXT NOT NULL DEFAULT ''"
            )
        if "doc_url" not in proj_cols:
            conn.execute(
                "ALTER TABLE projects ADD COLUMN doc_url TEXT NOT NULL DEFAULT ''"
            )
        if "qc_url" not in proj_cols:
            conn.execute(
                "ALTER TABLE projects ADD COLUMN qc_url TEXT NOT NULL DEFAULT ''"
            )
        user_cols = {
            r[1] for r in conn.execute("PRAGMA table_info(users)").fetchall()
        }
        if "group_admin" not in user_cols:
            conn.execute(
                "ALTER TABLE users ADD COLUMN group_admin INTEGER NOT NULL DEFAULT 0"
            )
        if "online_admin" not in user_cols:
            conn.execute(
                "ALTER TABLE users ADD COLUMN online_admin INTEGER NOT NULL DEFAULT 0"
            )
        # Hub 常用入口
        conn.execute(
            """CREATE TABLE IF NOT EXISTS hub_links (
                id INTEGER PRIMARY KEY,
                title TEXT NOT NULL,
                url TEXT NOT NULL,
                category TEXT NOT NULL DEFAULT '其他',
                note TEXT NOT NULL DEFAULT '',
                sort_order INTEGER NOT NULL DEFAULT 0,
                active INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL
            )"""
        )
        # 调休 / 特殊工作日与休息日
        conn.execute(
            """CREATE TABLE IF NOT EXISTS work_calendar (
                day TEXT PRIMARY KEY,
                kind TEXT NOT NULL CHECK(kind IN ('work','off')),
                note TEXT NOT NULL DEFAULT '',
                updated_at TEXT NOT NULL
            )"""
        )
        # 去掉旧 Demo 里的沟通群 / 笼统规范入口（规范改挂在项目上）
        conn.execute(
            "DELETE FROM hub_links WHERE title LIKE '%组员沟通群%'"
        )
        conn.execute(
            "DELETE FROM hub_links WHERE title LIKE '%标注规范（示例）%'"
        )
        # 确保默认日常入口存在
        for i, item in enumerate(DEFAULT_HUB_LINKS):
            exists = conn.execute(
                "SELECT id FROM hub_links WHERE title=?", (item["title"],)
            ).fetchone()
            if exists:
                conn.execute(
                    """UPDATE hub_links
                       SET url=?, category=?, note=?, sort_order=?, active=1
                       WHERE id=?""",
                    (
                        item["url"],
                        item["category"],
                        item.get("note") or "",
                        i,
                        exists["id"],
                    ),
                )
            else:
                conn.execute(
                    """INSERT INTO hub_links(title,url,category,note,sort_order,active,created_at)
                       VALUES (?,?,?,?,?,1,?)""",
                    (
                        item["title"],
                        item["url"],
                        item["category"],
                        item.get("note") or "",
                        i,
                        now(),
                    ),
                )
        n_links = conn.execute("SELECT COUNT(*) FROM hub_links").fetchone()[0]
        if n_links == 0:
            for i, item in enumerate(DEFAULT_HUB_LINKS):
                conn.execute(
                    """INSERT INTO hub_links(title,url,category,note,sort_order,active,created_at)
                       VALUES (?,?,?,?,?,1,?)""",
                    (
                        item["title"],
                        item["url"],
                        item["category"],
                        item.get("note") or "",
                        i,
                        now(),
                    ),
                )
        # 组员 A/B 分组
        intern_cols = {
            r[1] for r in conn.execute("PRAGMA table_info(interns)").fetchall()
        }
        if "team_group" not in intern_cols:
            conn.execute(
                "ALTER TABLE interns ADD COLUMN team_group TEXT NOT NULL DEFAULT ''"
            )
        for name, group in DEFAULT_TEAM_GROUPS.items():
            row = conn.execute(
                "SELECT id, team_group FROM interns WHERE name=?", (name,)
            ).fetchone()
            if not row:
                continue
            # 仅在尚未分组时写入默认值，避免覆盖管理员手动调整
            if not str(row["team_group"] or "").strip():
                conn.execute(
                    "UPDATE interns SET team_group=? WHERE id=?",
                    (group, row["id"]),
                )
        if "work_mode" not in intern_cols:
            conn.execute(
                "ALTER TABLE interns ADD COLUMN work_mode TEXT NOT NULL DEFAULT ''"
            )
        # 现场名单：仅在尚未设置时写入，避免覆盖管理员手动改成 online
        for name in DEFAULT_ONSITE_NAMES:
            conn.execute(
                """UPDATE interns SET work_mode='onsite'
                   WHERE name=? AND COALESCE(work_mode,'')=''""",
                (name,),
            )
        # 已离职且尚未设置办公方式的，默认 onsite（不覆盖已有设置）
        conn.execute(
            """UPDATE interns SET work_mode='onsite'
               WHERE active=0 AND COALESCE(work_mode,'')=''"""
        )
        # 名称含 TTS/音素时默认「条」（可按需改）
        conn.execute(
            """UPDATE projects SET unit='条'
               WHERE unit='节' AND (
                 name LIKE '%TTS%' OR name LIKE '%音素%' OR name LIKE '%条%'
               )"""
        )
        # 迁移旧 project_id
        rows = conn.execute(
            "SELECT intern_id, day, project_id FROM day_board WHERE project_id IS NOT NULL"
        ).fetchall()
        for r in rows:
            exists = conn.execute(
                "SELECT 1 FROM day_board_projects WHERE intern_id=? AND day=?",
                (r["intern_id"], r["day"]),
            ).fetchone()
            if not exists:
                conn.execute(
                    """INSERT OR IGNORE INTO day_board_projects(intern_id, day, project_id, slot)
                       VALUES (?,?,?,1)""",
                    (r["intern_id"], r["day"], r["project_id"]),
                )
        # 状态收成出勤/请假
        conn.execute("UPDATE day_board SET status='present' WHERE status IN ('remote','present')")
        conn.execute("UPDATE day_board SET status='leave' WHERE status IN ('absent','leave')")
        conn.execute(
            "UPDATE day_board SET status='present' WHERE status NOT IN ('present','leave','leave_half')"
        )
        # 每人 active 分配超过上限的，保留较早的，其余停用
        over = conn.execute(
            """SELECT intern_id FROM assignments
               WHERE status='active'
               GROUP BY intern_id
               HAVING COUNT(*) > 1"""
        ).fetchall()
        for row in over:
            iid = row["intern_id"]
            limit = max_day_projects_for(conn, int(iid))
            n_active = conn.execute(
                "SELECT COUNT(*) FROM assignments WHERE intern_id=? AND status='active'",
                (iid,),
            ).fetchone()[0]
            if n_active <= limit:
                continue
            keep_ids = {
                r["project_id"]
                for r in conn.execute(
                    """SELECT project_id FROM day_board_projects
                       WHERE intern_id=? ORDER BY day DESC, slot
                       LIMIT ?""",
                    (iid, limit),
                ).fetchall()
            }
            active = conn.execute(
                """SELECT id, project_id FROM assignments
                   WHERE intern_id=? AND status='active' ORDER BY id""",
                (iid,),
            ).fetchall()
            kept = []
            for a in active:
                if a["project_id"] in keep_ids and len(kept) < limit:
                    kept.append(a["id"])
            for a in active:
                if len(kept) >= limit:
                    break
                if a["id"] not in kept:
                    kept.append(a["id"])
            for a in active:
                if a["id"] not in kept:
                    conn.execute(
                        "UPDATE assignments SET status='inactive', updated_at=? WHERE id=?",
                        (now(), a["id"]),
                    )


def ensure_admin() -> None:
    with LOCK, connect() as conn:
        row = conn.execute("SELECT id FROM users WHERE role='admin' LIMIT 1").fetchone()
        if row:
            return
        pw_hash, salt = hash_password(DEFAULT_ADMIN_PASS)
        conn.execute(
            """INSERT INTO users(username, password_hash, salt, role, intern_id, display_name, active, created_at)
               VALUES (?,?,?,'admin',NULL,'管理员',1,?)""",
            (DEFAULT_ADMIN_USER, pw_hash, salt, now()),
        )
        print(f"已创建默认管理员：{DEFAULT_ADMIN_USER} / {DEFAULT_ADMIN_PASS}（请登录后尽快改密）")


def seed_if_empty() -> None:
    """仅在库完全为空时写入演示数据；有项目或组员时不自动补种。"""
    with LOCK, connect() as conn:
        n_interns = conn.execute("SELECT COUNT(*) FROM interns").fetchone()[0]
        n_projects = conn.execute("SELECT COUNT(*) FROM projects").fetchone()[0]
        if n_interns or n_projects:
            return
        stamp = now()
        for name in ("张三", "李四", "王五", "赵六", "陈七", "周八", "吴九", "郑十"):
            conn.execute("INSERT INTO interns(name,created_at) VALUES (?,?)", (name, stamp))
        for name, code, target, desc in (
            ("Demo Project A", "demo-a", 1000, "示例项目 A"),
            ("Demo Project B", "demo-b", 800, "示例项目 B"),
            ("Demo Project C", "demo-c", 600, "示例项目 C"),
        ):
            conn.execute(
                "INSERT INTO projects(name,code,target_total,description,created_at) VALUES (?,?,?,?,?)",
                (name, code, target, desc, stamp),
            )
        for i in range(1, 9):
            conn.execute(
                "INSERT INTO assignments(intern_id,project_id,target,done,updated_at) VALUES (?,?,?,?,?)",
                (i, 1 if i < 6 else 3, 700 if i < 6 else 180, 0, stamp),
            )


def _sync_assignment(conn: sqlite3.Connection, intern_id: int, project_id: int) -> None:
    done = conn.execute(
        "SELECT COALESCE(SUM(done),0) FROM daily_progress WHERE intern_id=? AND project_id=?",
        (intern_id, project_id),
    ).fetchone()[0]
    row = conn.execute(
        "SELECT id FROM assignments WHERE intern_id=? AND project_id=?",
        (intern_id, project_id),
    ).fetchone()
    if row:
        conn.execute(
            "UPDATE assignments SET done=?,updated_at=? WHERE id=?",
            (done, now(), row["id"]),
        )
    else:
        conn.execute(
            "INSERT INTO assignments(intern_id,project_id,target,done,updated_at) VALUES (?,?,?,?,?)",
            (intern_id, project_id, 0, done, now()),
        )


def fmt_amount(value: Any) -> str:
    """反馈文案里的数量：整数不带小数，否则保留一位。"""
    x = float(value or 0)
    if abs(x - round(x)) < 1e-9:
        return str(int(round(x)))
    return str(round(x, 1))



def user_is_write_admin(user: dict | None) -> bool:
    """可写管理员。WRITE_ADMIN_* 都为空时，所有 admin 可写。"""
    if not user or user.get("role") != "admin":
        return False
    if not WRITE_ADMIN_USERNAMES and not WRITE_ADMIN_NAMES:
        return True
    if str(user.get("username") or "") in WRITE_ADMIN_USERNAMES:
        return True
    if str(user.get("display_name") or "") in WRITE_ADMIN_NAMES:
        return True
    return False


def user_is_readonly_admin(user: dict | None) -> bool:
    return bool(user) and user.get("role") == "admin" and not user_is_write_admin(user)


def max_day_projects_for(conn: sqlite3.Connection, intern_id: int) -> int:
    """普通组员每天 2 个；管理员兼岗 / 指定名单可更多。"""
    row = conn.execute(
        """SELECT i.name,
                  EXISTS(
                    SELECT 1 FROM users u
                    WHERE u.intern_id=i.id AND u.role='admin' AND u.active=1
                  ) AS is_admin_work
           FROM interns i WHERE i.id=?""",
        (int(intern_id),),
    ).fetchone()
    if not row:
        return MAX_DAY_PROJECTS
    if int(row["is_admin_work"] or 0) == 1 or str(row["name"] or "") in FLEX_DAY_PROJECT_NAMES:
        return MAX_DAY_PROJECTS_FLEX
    return MAX_DAY_PROJECTS


def user_is_group_admin(user: dict | None) -> bool:
    """组员账号且被设为组内管理。"""
    if not user:
        return False
    return (
        user.get("role") == "intern"
        and int(user.get("group_admin") or 0) == 1
        and bool(user.get("intern_id"))
    )


def user_is_online_admin(user: dict | None) -> bool:
    """组员账号且被设为线上管理（看 A/B 全部 online）。"""
    if not user:
        return False
    return (
        user.get("role") == "intern"
        and int(user.get("online_admin") or 0) == 1
        and bool(user.get("intern_id"))
    )


def user_is_scope_admin(user: dict | None) -> bool:
    """组内管理或线上管理（只读查看权限）。"""
    return user_is_group_admin(user) or user_is_online_admin(user)


def user_can_view_day_board(user: dict | None) -> bool:
    return bool(user) and (user.get("role") == "admin" or user_is_scope_admin(user))


def is_online_work_mode(value: Any) -> bool:
    """未标 onsite 的都算 online（含尚未写入、页面上显示为 online 的）。"""
    return normalize_work_mode(value) != "onsite"


def intern_team_group(conn: sqlite3.Connection, intern_id: Any) -> str:
    if not intern_id:
        return ""
    row = conn.execute(
        "SELECT COALESCE(team_group,'') AS team_group FROM interns WHERE id=?",
        (int(intern_id),),
    ).fetchone()
    return normalize_team_group(row["team_group"] if row else "")


def public_user(row: sqlite3.Row | dict) -> dict:
    d = dict(row)
    user = {
        "id": d["id"],
        "username": d["username"],
        "role": d["role"],
        "intern_id": d.get("intern_id"),
        "display_name": d.get("display_name") or d["username"],
        "active": d.get("active", 1),
        "group_admin": int(d.get("group_admin") or 0),
        "online_admin": int(d.get("online_admin") or 0),
        "team_group": normalize_team_group(d.get("team_group") or ""),
    }
    user["readonly"] = bool(user_is_readonly_admin(user))
    return user


def get_user_by_token(token: str | None) -> dict | None:
    if not token:
        return None
    with LOCK, connect() as conn:
        row = conn.execute(
            """SELECT u.*, COALESCE(i.team_group,'') AS team_group
               FROM sessions s
               JOIN users u ON u.id = s.user_id
               LEFT JOIN interns i ON i.id = u.intern_id
               WHERE s.token=? AND s.expires_at > ? AND u.active=1""",
            (token, now()),
        ).fetchone()
        return public_user(row) if row else None


def login(username: str, password: str) -> tuple[dict, str]:
    username = (username or "").strip()
    if not username or not password:
        raise ValueError("请输入账号和密码")
    with LOCK, connect() as conn:
        row = conn.execute(
            "SELECT * FROM users WHERE username=? AND active=1", (username,)
        ).fetchone()
        if not row:
            raise ValueError("账号或密码错误")
        check, _ = hash_password(password, row["salt"])
        if not secrets.compare_digest(check, row["password_hash"]):
            raise ValueError("账号或密码错误")
        token = secrets.token_urlsafe(32)
        expires = (datetime.now() + timedelta(days=SESSION_DAYS)).isoformat(timespec="seconds")
        conn.execute(
            "INSERT INTO sessions(token, user_id, expires_at) VALUES (?,?,?)",
            (token, row["id"], expires),
        )
        enriched = dict(row)
        if enriched.get("intern_id"):
            tg = conn.execute(
                "SELECT COALESCE(team_group,'') AS team_group FROM interns WHERE id=?",
                (enriched["intern_id"],),
            ).fetchone()
            enriched["team_group"] = tg["team_group"] if tg else ""
        else:
            enriched["team_group"] = ""
        return public_user(enriched), token


def logout(token: str | None) -> None:
    if not token:
        return
    with LOCK, connect() as conn:
        conn.execute("DELETE FROM sessions WHERE token=?", (token,))


def list_users() -> list[dict]:
    with LOCK, connect() as conn:
        rows = conn.execute(
            """SELECT u.id, u.username, u.role, u.intern_id, u.display_name, u.active,
                      u.created_at,
                      COALESCE(u.group_admin,0) AS group_admin,
                      COALESCE(u.online_admin,0) AS online_admin,
                      i.name AS intern_name,
                      COALESCE(i.team_group,'') AS team_group
               FROM users u
               LEFT JOIN interns i ON i.id = u.intern_id
               ORDER BY u.role DESC, u.username"""
        ).fetchall()
        return [dict(r) for r in rows]


def set_user_account(body: dict) -> dict:
    """管理员：设置账号。组员须绑 intern；管理员可选 also_work 兼做任务。"""
    role = (body.get("role") or "intern").strip()
    username = (body.get("username") or "").strip()
    password = body.get("password") or ""
    display_name = (body.get("display_name") or "").strip()
    if not username:
        raise ValueError("账号不能为空")
    if len(password) < 4:
        raise ValueError("密码至少 4 位")
    if role not in ("admin", "intern"):
        raise ValueError("角色无效")

    pw_hash, salt = hash_password(password)
    with LOCK, connect() as conn:
        intern_id = None
        if role == "intern":
            intern_id = body.get("intern_id")
            if not intern_id:
                raise ValueError("请选择对应的组员")
            intern_id = int(intern_id)
            ir = conn.execute("SELECT name FROM interns WHERE id=?", (intern_id,)).fetchone()
            if not ir:
                raise ValueError("组员不存在")
            if not display_name:
                display_name = ir["name"]
            other = conn.execute(
                "SELECT id FROM users WHERE intern_id=? AND username!=?",
                (intern_id, username),
            ).fetchone()
            if other:
                raise ValueError("该组员已有账号，请直接改密码或换账号名")
        elif role == "admin" and (
            body.get("also_work") or body.get("intern_id") not in (None, "", 0, "0")
        ):
            # 管理员兼做任务：绑已有组员，或按姓名创建
            if body.get("intern_id") not in (None, "", 0, "0"):
                intern_id = int(body["intern_id"])
                ir = conn.execute(
                    "SELECT id, name FROM interns WHERE id=?", (intern_id,)
                ).fetchone()
                if not ir:
                    raise ValueError("组员不存在")
                if not display_name:
                    display_name = ir["name"]
            else:
                name = display_name or username
                ir = conn.execute(
                    "SELECT id, name FROM interns WHERE name=?", (name,)
                ).fetchone()
                if ir:
                    intern_id = int(ir["id"])
                else:
                    cur = conn.execute(
                        "INSERT INTO interns(name,active,note,created_at) VALUES (?,?,?,?)",
                        (name, 1, "", now()),
                    )
                    intern_id = int(cur.lastrowid)
            other = conn.execute(
                "SELECT id, username FROM users WHERE intern_id=? AND username!=?",
                (intern_id, username),
            ).fetchone()
            if other:
                # 释放旧绑定，避免一人两账号
                conn.execute(
                    "UPDATE users SET intern_id=NULL WHERE id=?", (other["id"],)
                )

        existing = conn.execute("SELECT id FROM users WHERE username=?", (username,)).fetchone()
        if existing:
            conn.execute(
                """UPDATE users SET password_hash=?, salt=?, role=?, intern_id=?,
                   display_name=?, active=1 WHERE id=?""",
                (pw_hash, salt, role, intern_id, display_name or username, existing["id"]),
            )
            uid = existing["id"]
        else:
            cur = conn.execute(
                """INSERT INTO users(username, password_hash, salt, role, intern_id,
                   display_name, active, created_at) VALUES (?,?,?,?,?,?,1,?)""",
                (username, pw_hash, salt, role, intern_id, display_name or username, now()),
            )
            uid = cur.lastrowid
        row = conn.execute(
            """SELECT u.id, u.username, u.role, u.intern_id, u.display_name, u.active,
                      i.name AS intern_name
               FROM users u LEFT JOIN interns i ON i.id=u.intern_id WHERE u.id=?""",
            (uid,),
        ).fetchone()
        return dict(row)


def change_own_password(user: dict, body: dict) -> dict:
    old_pw = body.get("old_password") or ""
    new_pw = body.get("new_password") or ""
    if len(new_pw) < 4:
        raise ValueError("新密码至少 4 位")
    with LOCK, connect() as conn:
        row = conn.execute("SELECT * FROM users WHERE id=?", (user["id"],)).fetchone()
        if not row:
            raise ValueError("用户不存在")
        check, _ = hash_password(old_pw, row["salt"])
        if not secrets.compare_digest(check, row["password_hash"]):
            raise ValueError("原密码错误")
        pw_hash, salt = hash_password(new_pw)
        conn.execute(
            "UPDATE users SET password_hash=?, salt=? WHERE id=?",
            (pw_hash, salt, user["id"]),
        )
        return {"ok": True}


def get_interns(active_only: bool = False) -> list[dict]:
    with LOCK, connect() as conn:
        q = "SELECT * FROM interns"
        if active_only:
            q += " WHERE active=1"
        q += " ORDER BY name"
        return [dict(r) for r in conn.execute(q).fetchall()]


def get_projects(active_only: bool = False) -> list[dict]:
    with LOCK, connect() as conn:
        q = "SELECT * FROM projects"
        if active_only:
            q += " WHERE active=1"
        q += " ORDER BY name"
        return [dict(r) for r in conn.execute(q).fetchall()]



def set_user_group_admin(body: dict) -> dict:
    """管理员：给组员账号开关组内管理权限。"""
    uid = int(body.get("user_id") or 0)
    if not uid:
        raise ValueError("缺少账号 id")
    enabled = 1 if body.get("group_admin") else 0
    with LOCK, connect() as conn:
        row = conn.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
        if not row:
            raise LookupError("账号不存在")
        if row["role"] != "intern":
            raise ValueError("只能给组员账号设组内管理")
        if not row["intern_id"]:
            raise ValueError("账号未绑定组员")
        tg = intern_team_group(conn, row["intern_id"])
        if enabled and tg not in ("A", "B"):
            raise ValueError("请先给该组员分到 A 组或 B 组")
        if enabled:
            conn.execute(
                "UPDATE users SET group_admin=1, online_admin=0 WHERE id=?", (uid,)
            )
        else:
            conn.execute("UPDATE users SET group_admin=0 WHERE id=?", (uid,))
        out = conn.execute(
            """SELECT u.id, u.username, u.role, u.intern_id, u.display_name, u.active,
                      COALESCE(u.group_admin,0) AS group_admin,
                      COALESCE(u.online_admin,0) AS online_admin,
                      i.name AS intern_name,
                      COALESCE(i.team_group,'') AS team_group
               FROM users u
               LEFT JOIN interns i ON i.id=u.intern_id
               WHERE u.id=?""",
            (uid,),
        ).fetchone()
        return dict(out)


def set_user_online_admin(body: dict) -> dict:
    """管理员：给组员账号开关线上管理（可看 A/B 全部 online）。"""
    uid = int(body.get("user_id") or 0)
    if not uid:
        raise ValueError("缺少账号 id")
    enabled = 1 if body.get("online_admin") else 0
    with LOCK, connect() as conn:
        row = conn.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
        if not row:
            raise LookupError("账号不存在")
        if row["role"] != "intern":
            raise ValueError("只能给组员账号设线上管理")
        if not row["intern_id"]:
            raise ValueError("账号未绑定组员")
        if enabled:
            conn.execute(
                "UPDATE users SET online_admin=1, group_admin=0 WHERE id=?", (uid,)
            )
        else:
            conn.execute("UPDATE users SET online_admin=0 WHERE id=?", (uid,))
        out = conn.execute(
            """SELECT u.id, u.username, u.role, u.intern_id, u.display_name, u.active,
                      COALESCE(u.group_admin,0) AS group_admin,
                      COALESCE(u.online_admin,0) AS online_admin,
                      i.name AS intern_name,
                      COALESCE(i.team_group,'') AS team_group
               FROM users u
               LEFT JOIN interns i ON i.id=u.intern_id
               WHERE u.id=?""",
            (uid,),
        ).fetchone()
        return dict(out)


def create_intern(body: dict) -> dict:
    """添加组员；若带 username/password，同时开登录账号。"""
    name = str(body.get("name") or "").strip()
    if not name:
        raise ValueError("姓名不能为空")
    username = (body.get("username") or "").strip()
    password = body.get("password") or ""
    team_group = normalize_team_group(body.get("team_group"))
    work_mode = normalize_work_mode(body.get("work_mode")) or "remote"
    if username and len(password) < 4:
        raise ValueError("密码至少 4 位")
    if password and not username:
        raise ValueError("请填写登录账号")
    with LOCK, connect() as conn:
        try:
            cur = conn.execute(
                """INSERT INTO interns(name,active,note,team_group,work_mode,created_at)
                   VALUES (?,?,?,?,?,?)""",
                (
                    name,
                    1 if body.get("active", True) else 0,
                    body.get("note", ""),
                    team_group,
                    work_mode,
                    now(),
                ),
            )
            intern_id = cur.lastrowid
        except sqlite3.IntegrityError as exc:
            raise ValueError(f"组员已存在：{name}") from exc

        user_row = None
        if username:
            if conn.execute("SELECT id FROM users WHERE username=?", (username,)).fetchone():
                raise ValueError(f"账号已存在：{username}")
            pw_hash, salt = hash_password(password)
            group_admin = 1 if body.get("group_admin") else 0
            if group_admin and not team_group:
                raise ValueError("设为组内管理前请先选择 A/B 组")
            ucur = conn.execute(
                """INSERT INTO users(username, password_hash, salt, role, intern_id,
                   display_name, active, group_admin, created_at)
                   VALUES (?,?,?,?,?,?,1,?,?)""",
                (username, pw_hash, salt, "intern", intern_id, name, group_admin, now()),
            )
            user_row = dict(
                conn.execute(
                    """SELECT u.id, u.username, u.role, u.intern_id, u.display_name, u.active,
                              COALESCE(u.group_admin,0) AS group_admin
                       FROM users u WHERE u.id=?""",
                    (ucur.lastrowid,),
                ).fetchone()
            )

        intern = dict(
            conn.execute("SELECT * FROM interns WHERE id=?", (intern_id,)).fetchone()
        )
        if user_row:
            intern["user"] = user_row
        return intern


def create_project(body: dict) -> dict:
    name = str(body.get("name") or "").strip()
    if not name:
        raise ValueError("项目名不能为空")
    unit = normalize_unit(body.get("unit"))
    platform_url = normalize_platform_url(body.get("platform_url"))
    doc_url = normalize_doc_url(body.get("doc_url"))
    qc_url = normalize_qc_url(body.get("qc_url"))
    # 名称含 TTS/音素时默认「条」，除非显式传入单位
    if "unit" not in body and ("TTS" in name.upper() or "音素" in name):
        unit = "条"
    with LOCK, connect() as conn:
        try:
            cur = conn.execute(
                """INSERT INTO projects(
                     name,code,target_total,description,active,unit,platform_url,doc_url,qc_url,created_at
                   ) VALUES (?,?,?,?,?,?,?,?,?,?)""",
                (
                    name,
                    body.get("code", ""),
                    num(body.get("target_total")),
                    body.get("description", ""),
                    1 if body.get("active", True) else 0,
                    unit,
                    platform_url,
                    doc_url,
                    qc_url,
                    now(),
                ),
            )
            return dict(
                conn.execute("SELECT * FROM projects WHERE id=?", (cur.lastrowid,)).fetchone()
            )
        except sqlite3.IntegrityError as exc:
            raise ValueError(f"项目已存在：{name}") from exc


def update_project(body: dict) -> dict:
    """管理员：改项目名、最终总量、说明、启用状态、单位、标注平台链接。"""
    pid = int(body.get("project_id") or body.get("id") or 0)
    if not pid:
        raise ValueError("缺少项目 id")
    with LOCK, connect() as conn:
        row = conn.execute("SELECT * FROM projects WHERE id=?", (pid,)).fetchone()
        if not row:
            raise LookupError("项目不存在")
        name = body.get("name")
        if name is not None:
            name = str(name).strip()
            if not name:
                raise ValueError("项目名不能为空")
        else:
            name = row["name"]
        if "target_total" in body:
            target_total = num(body.get("target_total"))
        else:
            target_total = row["target_total"]
        if "description" in body:
            description = str(body.get("description") or "")
        else:
            description = row["description"] or ""
        if "code" in body:
            code = str(body.get("code") or "")
        else:
            code = row["code"] or ""
        if "active" in body:
            active = 1 if body.get("active") else 0
        else:
            active = row["active"]
        if "unit" in body:
            unit = normalize_unit(body.get("unit"))
        else:
            unit = normalize_unit(row["unit"] if "unit" in row.keys() else "节")
        if "completed" in body:
            completed = 1 if body.get("completed") else 0
        else:
            completed = int(row["completed"] if "completed" in row.keys() else 0)
        if "platform_url" in body:
            platform_url = normalize_platform_url(body.get("platform_url"))
        else:
            platform_url = str(
                row["platform_url"] if "platform_url" in row.keys() else ""
            ) or ""
        if "doc_url" in body:
            doc_url = normalize_doc_url(body.get("doc_url"))
        else:
            doc_url = str(row["doc_url"] if "doc_url" in row.keys() else "") or ""
        if "qc_url" in body:
            qc_url = normalize_qc_url(body.get("qc_url"))
        else:
            qc_url = str(row["qc_url"] if "qc_url" in row.keys() else "") or ""
        try:
            conn.execute(
                """UPDATE projects SET name=?, code=?, target_total=?, description=?,
                   active=?, unit=?, completed=?, platform_url=?, doc_url=?, qc_url=?
                   WHERE id=?""",
                (
                    name,
                    code,
                    target_total,
                    description,
                    active,
                    unit,
                    completed,
                    platform_url,
                    doc_url,
                    qc_url,
                    pid,
                ),
            )
        except sqlite3.IntegrityError as exc:
            raise ValueError(f"项目名已存在：{name}") from exc
        if active == 0 or completed == 1:
            if completed == 1 and active == 1:
                # 完成：清掉当日及未来的任务安排，历史完成量保留
                conn.execute("DELETE FROM day_board_projects WHERE project_id=?", (pid,))
            if active == 0:
                conn.execute(
                    "UPDATE assignments SET status='inactive', updated_at=? WHERE project_id=?",
                    (now(), pid),
                )
                conn.execute("DELETE FROM day_board_projects WHERE project_id=?", (pid,))
        return dict(conn.execute("SELECT * FROM projects WHERE id=?", (pid,)).fetchone())


def delete_project(project_id: int) -> dict:
    """停用项目，并清理相关分配与当日安排。"""
    with LOCK, connect() as conn:
        row = conn.execute("SELECT id, name FROM projects WHERE id=?", (project_id,)).fetchone()
        if not row:
            raise LookupError("项目不存在")
        conn.execute("UPDATE projects SET active=0 WHERE id=?", (project_id,))
        conn.execute(
            "UPDATE assignments SET status='inactive', updated_at=? WHERE project_id=?",
            (now(), project_id),
        )
        conn.execute("DELETE FROM day_board_projects WHERE project_id=?", (project_id,))
        return {"ok": True, "id": project_id, "name": row["name"]}


def set_intern_group(body: dict) -> dict:
    """设置组员 A/B 分组；空字符串表示未分组。"""
    iid = int(body.get("intern_id") or 0)
    team_group = normalize_team_group(body.get("team_group"))
    with LOCK, connect() as conn:
        row = conn.execute("SELECT * FROM interns WHERE id=?", (iid,)).fetchone()
        if not row:
            raise LookupError("组员不存在")
        conn.execute(
            "UPDATE interns SET team_group=? WHERE id=?", (team_group, iid)
        )
        return {
            "ok": True,
            "id": iid,
            "name": row["name"],
            "team_group": team_group,
        }


def set_intern_work_mode(body: dict) -> dict:
    """设置组员 onsite / online。"""
    iid = int(body.get("intern_id") or 0)
    work_mode = normalize_work_mode(body.get("work_mode")) or "remote"
    with LOCK, connect() as conn:
        row = conn.execute("SELECT * FROM interns WHERE id=?", (iid,)).fetchone()
        if not row:
            raise LookupError("组员不存在")
        conn.execute(
            "UPDATE interns SET work_mode=? WHERE id=?", (work_mode, iid)
        )
        return {
            "ok": True,
            "id": iid,
            "name": row["name"],
            "work_mode": work_mode,
        }


def set_intern_active(body: dict) -> dict:
    """标记组员在职/离职。离职后不出现在出勤与任务分配，历史完成量保留。"""
    iid = int(body.get("intern_id") or 0)
    active = 1 if body.get("active") else 0
    with LOCK, connect() as conn:
        row = conn.execute("SELECT * FROM interns WHERE id=?", (iid,)).fetchone()
        if not row:
            raise LookupError("组员不存在")
        conn.execute("UPDATE interns SET active=? WHERE id=?", (active, iid))
        if active == 0:
            conn.execute(
                "UPDATE assignments SET status='inactive', updated_at=? WHERE intern_id=?",
                (now(), iid),
            )
            # 停用登录，清掉会话；历史 daily_progress 不动
            for u in conn.execute(
                "SELECT id FROM users WHERE intern_id=?", (iid,)
            ).fetchall():
                conn.execute("UPDATE users SET active=0 WHERE id=?", (u["id"],))
                conn.execute("DELETE FROM sessions WHERE user_id=?", (u["id"],))
        else:
            conn.execute(
                "UPDATE users SET active=1 WHERE intern_id=?",
                (iid,),
            )
        return {
            "ok": True,
            "id": iid,
            "name": row["name"],
            "active": active,
        }


def delete_user(user_id: int, actor: dict) -> dict:
    """删除账号。组员账号一并停用其人；不可删自己；不可删最后一个管理员。"""
    with LOCK, connect() as conn:
        row = conn.execute("SELECT * FROM users WHERE id=?", (user_id,)).fetchone()
        if not row:
            raise LookupError("账号不存在")
        if int(user_id) == int(actor["id"]):
            raise ValueError("不能删除当前登录账号")
        if row["role"] == "admin":
            n = conn.execute(
                "SELECT COUNT(*) FROM users WHERE role='admin' AND active=1"
            ).fetchone()[0]
            if n <= 1:
                raise ValueError("不能删除最后一个管理员账号")
        conn.execute("DELETE FROM sessions WHERE user_id=?", (user_id,))
        conn.execute("DELETE FROM users WHERE id=?", (user_id,))
        if row["intern_id"]:
            conn.execute("UPDATE interns SET active=0 WHERE id=?", (row["intern_id"],))
            conn.execute(
                "UPDATE assignments SET status='inactive', updated_at=? WHERE intern_id=?",
                (now(), row["intern_id"]),
            )
        return {"ok": True, "id": user_id, "username": row["username"]}


def upsert_assignment(body: dict) -> dict:
    iid, pid = int(body["intern_id"]), int(body["project_id"])
    with LOCK, connect() as conn:
        existing = conn.execute(
            "SELECT * FROM assignments WHERE intern_id=? AND project_id=?", (iid, pid)
        ).fetchone()
        target, status = num(body.get("target")), body.get("status") or "active"
        already_active = bool(existing and existing["status"] == "active")
        if status == "active" and not already_active:
            n = conn.execute(
                """SELECT COUNT(*) FROM assignments
                   WHERE intern_id=? AND status='active'""",
                (iid,),
            ).fetchone()[0]
            limit = max_day_projects_for(conn, iid)
            if n >= limit:
                raise ValueError(f"每人最多同时分配 {limit} 个项目，请先删除再换")
        if existing:
            conn.execute(
                "UPDATE assignments SET target=?,status=?,updated_at=? WHERE id=?",
                (target, status, now(), existing["id"]),
            )
        else:
            conn.execute(
                """INSERT INTO assignments(intern_id,project_id,target,done,status,updated_at)
                   VALUES (?,?,?,?,?,?)""",
                (iid, pid, target, 0, status, now()),
            )
        _sync_assignment(conn, iid, pid)
        row = dict(
            conn.execute(
                """SELECT a.*, i.name intern_name, p.name project_name
                   FROM assignments a
                   JOIN interns i ON i.id=a.intern_id
                   JOIN projects p ON p.id=a.project_id
                   WHERE a.intern_id=? AND a.project_id=?""",
                (iid, pid),
            ).fetchone()
        )
        row["pct"] = percent(row["done"], row["target"])
        return row


def delete_assignment(intern_id: int, project_id: int) -> dict:
    with LOCK, connect() as conn:
        cur = conn.execute(
            "DELETE FROM assignments WHERE intern_id=? AND project_id=?",
            (intern_id, project_id),
        )
        if cur.rowcount == 0:
            raise LookupError("未找到该项目分配")
        # 同步清掉相关日期面板项目位
        conn.execute(
            "DELETE FROM day_board_projects WHERE intern_id=? AND project_id=?",
            (intern_id, project_id),
        )
        return {"ok": True, "intern_id": intern_id, "project_id": project_id}


def list_assignments() -> list[dict]:
    with LOCK, connect() as conn:
        return [
            dict(r)
            for r in conn.execute(
                """SELECT a.id, a.intern_id, a.project_id, a.done, a.target, a.status,
                          i.name AS intern_name, p.name AS project_name
                   FROM assignments a
                   JOIN interns i ON i.id=a.intern_id
                   JOIN projects p ON p.id=a.project_id
                   WHERE a.status='active' AND i.active=1 AND p.active=1
                   ORDER BY i.name, p.name"""
            ).fetchall()
        ]


def _ensure_assignment(conn: sqlite3.Connection, intern_id: int, project_id: int) -> None:
    existing = conn.execute(
        "SELECT id, status FROM assignments WHERE intern_id=? AND project_id=?",
        (intern_id, project_id),
    ).fetchone()
    if existing:
        conn.execute(
            "UPDATE assignments SET status='active', updated_at=? WHERE id=?",
            (now(), existing["id"]),
        )
        return
    n = conn.execute(
        "SELECT COUNT(*) FROM assignments WHERE intern_id=? AND status='active'",
        (intern_id,),
    ).fetchone()[0]
    limit = max_day_projects_for(conn, intern_id)
    if n >= limit:
        raise ValueError(f"每人最多 {limit} 个项目，请先换掉日期面板里的旧项目")
    conn.execute(
        """INSERT INTO assignments(intern_id,project_id,target,done,status,updated_at)
           VALUES (?,?,0,0,'active',?)""",
        (intern_id, project_id, now()),
    )


def _sync_assignments_to_projects(
    conn: sqlite3.Connection, intern_id: int, project_ids: list[int]
) -> None:
    """把活跃分配对齐到给定项目（日期面板选中的），超出上限的旧项停用。"""
    keep = set(project_ids)
    for r in conn.execute(
        "SELECT id, project_id FROM assignments WHERE intern_id=? AND status='active'",
        (intern_id,),
    ).fetchall():
        if r["project_id"] not in keep:
            conn.execute(
                "UPDATE assignments SET status='inactive', updated_at=? WHERE id=?",
                (now(), r["id"]),
            )
    for pid in project_ids:
        _ensure_assignment(conn, intern_id, pid)


def attendance_score(status: str | None) -> float:
    return float(STATUS_SCORE.get(status or "", 0.0))


def _monday_of(day_value: str) -> date:
    d = date.fromisoformat(day_value)
    return d - timedelta(days=d.weekday())


def _month_workdays(
    year: int, month: int, kind_map: dict[str, str] | None = None
) -> list[str]:
    """当月实际工作日：默认周一到周五，叠加日历例外。"""
    kind_map = kind_map or {}
    first = date(year, month, 1)
    if month == 12:
        nxt = date(year + 1, 1, 1)
    else:
        nxt = date(year, month + 1, 1)
    days: list[str] = []
    cur = first
    while cur < nxt:
        if _is_workday(cur, kind_map):
            days.append(cur.isoformat())
        cur += timedelta(days=1)
    return days


def _load_work_calendar(
    conn: sqlite3.Connection,
    *,
    day_from: str | None = None,
    day_to: str | None = None,
) -> dict[str, dict]:
    """返回 {day: {day, kind, note}}。"""
    clauses: list[str] = []
    args: list[str] = []
    if day_from:
        clauses.append("day >= ?")
        args.append(day_from)
    if day_to:
        clauses.append("day <= ?")
        args.append(day_to)
    where = f" WHERE {' AND '.join(clauses)}" if clauses else ""
    rows = conn.execute(
        f"SELECT day, kind, note FROM work_calendar{where} ORDER BY day",
        args,
    ).fetchall()
    return {
        r["day"]: {"day": r["day"], "kind": r["kind"], "note": r["note"] or ""}
        for r in rows
    }


def _calendar_kind_map(cal: dict[str, dict]) -> dict[str, str]:
    return {d: v["kind"] for d, v in cal.items()}


def _is_workday(d: date, kind_map: dict[str, str]) -> bool:
    key = d.isoformat()
    kind = kind_map.get(key)
    if kind == "work":
        return True
    if kind == "off":
        return False
    return d.weekday() < 5


def _week_workdays(monday: date, kind_map: dict[str, str]) -> list[str]:
    """该自然周（周一至周日）内的实际工作日。"""
    days: list[str] = []
    for i in range(7):
        d = monday + timedelta(days=i)
        if _is_workday(d, kind_map):
            days.append(d.isoformat())
    return days


def _weekday_label(day_value: str) -> str:
    return WEEKDAY_CN_LABELS[date.fromisoformat(day_value).weekday()]


def list_work_calendar(
    *, day_from: str | None = None, day_to: str | None = None
) -> list[dict]:
    with LOCK, connect() as conn:
        cal = _load_work_calendar(conn, day_from=day_from, day_to=day_to)
        return list(cal.values())


def upsert_work_calendar(body: dict) -> dict:
    day_value = str(body.get("day") or "").strip()
    if not day_value:
        raise ValueError("缺少日期")
    try:
        date.fromisoformat(day_value)
    except ValueError as exc:
        raise ValueError("日期格式无效") from exc
    kind = str(body.get("kind") or "").strip()
    if kind not in WORK_CAL_KINDS:
        raise ValueError("类型只能是 work（上班）或 off（休息）")
    note = str(body.get("note") or "").strip()
    with LOCK, connect() as conn:
        conn.execute(
            """INSERT INTO work_calendar(day, kind, note, updated_at)
               VALUES (?,?,?,?)
               ON CONFLICT(day) DO UPDATE SET
                 kind=excluded.kind,
                 note=excluded.note,
                 updated_at=excluded.updated_at""",
            (day_value, kind, note, now()),
        )
        row = conn.execute(
            "SELECT day, kind, note FROM work_calendar WHERE day=?", (day_value,)
        ).fetchone()
        return {"day": row["day"], "kind": row["kind"], "note": row["note"] or ""}


def delete_work_calendar(day_value: str) -> dict:
    day_value = str(day_value or "").strip()
    if not day_value:
        raise ValueError("缺少日期")
    try:
        date.fromisoformat(day_value)
    except ValueError as exc:
        raise ValueError("日期格式无效") from exc
    with LOCK, connect() as conn:
        cur = conn.execute("DELETE FROM work_calendar WHERE day=?", (day_value,))
        if cur.rowcount == 0:
            raise LookupError("该日期没有特殊设置")
        return {"ok": True, "day": day_value}


def attendance_overview(
    user: dict,
    *,
    month: str | None = None,
    week: str | None = None,
) -> dict:
    """出勤周视图 + 月度统计。组员仅看自己；管理员看全员。"""
    today = today_local()
    if week:
        monday = _monday_of(week)
    else:
        # 默认：周五及以后看「下周」，否则看「本周」
        monday = _monday_of(today.isoformat())
        if today.weekday() >= 4:  # Fri/Sat/Sun → next week
            monday = monday + timedelta(days=7)

    if month:
        try:
            y_str, m_str = month.split("-", 1)
            year, mon = int(y_str), int(m_str)
            date(year, mon, 1)
        except Exception as exc:
            raise ValueError("月份格式应为 YYYY-MM") from exc
    else:
        year, mon = today.year, today.month
        month = f"{year:04d}-{mon:02d}"

    week_end = monday + timedelta(days=6)
    month_first = date(year, mon, 1)
    if mon == 12:
        month_last = date(year + 1, 1, 1) - timedelta(days=1)
    else:
        month_last = date(year, mon + 1, 1) - timedelta(days=1)
    cal_from = min(monday, month_first).isoformat()
    cal_to = max(week_end, month_last).isoformat()

    with LOCK, connect() as conn:
        cal = _load_work_calendar(conn, day_from=cal_from, day_to=cal_to)
        kind_map = _calendar_kind_map(cal)
        week_days = _week_workdays(monday, kind_map)
        month_days = _month_workdays(year, mon, kind_map)

        admin_work_ids = {
            int(r["intern_id"])
            for r in conn.execute(
                """SELECT intern_id FROM users
                   WHERE role='admin' AND active=1 AND intern_id IS NOT NULL"""
            ).fetchall()
            if r["intern_id"] is not None
        }
        if user["role"] == "admin":
            interns = [
                dict(r)
                for r in conn.execute(
                    """SELECT id, name, active,
                              COALESCE(team_group,'') AS team_group,
                              COALESCE(work_mode,'') AS work_mode
                       FROM interns WHERE active=1 ORDER BY name"""
                ).fetchall()
            ]
        elif user_is_group_admin(user):
            tg = intern_team_group(conn, user.get("intern_id"))
            if tg not in ("A", "B"):
                raise PermissionError("组内管理需先加入 A/B 组")
            interns = [
                dict(r)
                for r in conn.execute(
                    """SELECT id, name, active,
                              COALESCE(team_group,'') AS team_group,
                              COALESCE(work_mode,'') AS work_mode
                       FROM interns
                       WHERE active=1 AND COALESCE(team_group,'')=?
                       ORDER BY name""",
                    (tg,),
                ).fetchall()
            ]
        elif user_is_online_admin(user):
            self_iid = int(user.get("intern_id") or 0)
            admin_iids = {
                int(r["intern_id"])
                for r in conn.execute(
                    """SELECT intern_id FROM users
                       WHERE role='admin' AND active=1 AND intern_id IS NOT NULL"""
                ).fetchall()
                if r["intern_id"] is not None
            }
            interns = [
                dict(r)
                for r in conn.execute(
                    """SELECT id, name, active,
                              COALESCE(team_group,'') AS team_group,
                              COALESCE(work_mode,'') AS work_mode
                       FROM interns WHERE active=1 ORDER BY name"""
                ).fetchall()
                if (
                    is_online_work_mode(r["work_mode"])
                    and int(r["id"]) not in admin_iids
                )
                or int(r["id"]) == self_iid
            ]
        else:
            iid = user.get("intern_id")
            if not iid:
                raise PermissionError("账号未绑定组员")
            interns = [
                dict(r)
                for r in conn.execute(
                    """SELECT id, name, active,
                              COALESCE(team_group,'') AS team_group,
                              COALESCE(work_mode,'') AS work_mode
                       FROM interns WHERE id=? AND active=1""",
                    (iid,),
                ).fetchall()
            ]
            if not interns:
                raise ValueError("组员不存在或已停用")

        # 取本周 + 当月相关记录
        need_days = sorted(set(week_days + month_days))
        if not need_days:
            boards = {}
        else:
            placeholders = ",".join("?" * len(need_days))
            boards = {
                (int(r["intern_id"]), r["day"]): r["status"]
                for r in conn.execute(
                    f"""SELECT intern_id, day, status FROM day_board
                        WHERE day IN ({placeholders})""",
                    need_days,
                ).fetchall()
            }

        people = []
        for i in interns:
            iid = int(i["id"])
            skip = iid in admin_work_ids
            week_map = {}
            for d in week_days:
                st = boards.get((iid, d))
                if st not in DAY_STATUSES:
                    st = "unset"
                week_map[d] = st
            present_days = 0.0
            leave_days = 0
            leave_half_days = 0
            filled = 0
            day_cells = []
            for d in month_days:
                st = boards.get((iid, d))
                if st not in DAY_STATUSES:
                    st = "unset"
                else:
                    filled += 1
                if st == "present":
                    present_days += 1.0
                elif st == "leave_half":
                    present_days += 0.5
                    leave_half_days += 1
                elif st == "leave":
                    leave_days += 1
                day_cells.append({"day": d, "status": st})
            people.append(
                {
                    "intern_id": iid,
                    "intern_name": i["name"],
                    "team_group": normalize_team_group(i.get("team_group")),
                    "work_mode": normalize_work_mode(i.get("work_mode")),
                    "skip_attendance": skip,
                    "week": week_map,
                    "month": {
                        "present_days": present_days,
                        "leave_days": leave_days,
                        "leave_half_days": leave_half_days,
                        "filled_days": filled,
                        "workdays": len(month_days),
                        "days": day_cells,
                    },
                }
            )

        people.sort(
            key=lambda p: (
                0 if p["team_group"] == "A" else 1 if p["team_group"] == "B" else 2,
                0 if p.get("work_mode") == "onsite" else 1,
                p["intern_name"],
            )
        )
        if user["role"] == "admin":
            scope = "all"
        elif user_is_online_admin(user):
            scope = "online"
        elif user_is_group_admin(user):
            scope = "group"
        else:
            scope = "self"
        return {
            "today": today.isoformat(),
            "month": month,
            "month_days": month_days,
            "week_start": monday.isoformat(),
            "week_days": week_days,
            "people": people,
            "statuses": list(DAY_STATUSES),
            "calendar_exceptions": list(cal.values()),
            "view_scope": scope,
            "readonly_team": bool(user_is_scope_admin(user) or user_is_readonly_admin(user)),
            "readonly": bool(user_is_readonly_admin(user)),
        }


def upsert_attendance(body: dict, user: dict) -> dict:
    """批量写入出勤状态。管理员可改全员；组员只能改自己。"""
    day_value = body.get("day")
    if not day_value:
        raise ValueError("缺少日期")
    try:
        date.fromisoformat(day_value)
    except ValueError as exc:
        raise ValueError("日期格式无效") from exc
    status = body.get("status")
    if status not in DAY_STATUSES:
        raise ValueError("状态只能是：出勤、请假半天、请假")

    iid = int(body.get("intern_id") or 0)
    if user["role"] != "admin":
        if not user.get("intern_id") or int(user["intern_id"]) != iid:
            raise PermissionError("只能填写自己的出勤")
    if not iid:
        raise ValueError("缺少组员 id")

    # 复用 day_board 写入
    return upsert_day_board(
        {"intern_id": iid, "day": day_value, "status": status, "note": body.get("note")}
    )


def upsert_attendance_batch(body: dict, user: dict) -> dict:
    """一次提交多天/多人出勤。items: [{intern_id, day, status}, ...]"""
    items = body.get("items") or []
    if not isinstance(items, list) or not items:
        raise ValueError("请提供要保存的出勤项")
    saved = 0
    for item in items:
        if not item:
            continue
        upsert_attendance(item, user)
        saved += 1
    return {"ok": True, "saved": saved}


def list_hub_links(active_only: bool = True) -> list[dict]:
    with LOCK, connect() as conn:
        q = "SELECT * FROM hub_links"
        if active_only:
            q += " WHERE active=1"
        q += " ORDER BY sort_order, id"
        return [dict(r) for r in conn.execute(q).fetchall()]


def upsert_hub_link(body: dict) -> dict:
    """管理员：新增或更新 Hub 入口。"""
    lid = int(body.get("id") or 0)
    title = str(body.get("title") or "").strip()
    url = str(body.get("url") or "").strip()
    category = str(body.get("category") or "其他").strip() or "其他"
    note = str(body.get("note") or "").strip()
    sort_order = int(body.get("sort_order") or 0)
    active = 1 if body.get("active", True) else 0
    if not title:
        raise ValueError("入口名称不能为空")
    if not url:
        raise ValueError("入口链接不能为空")
    # 允许站内锚点 #attendance / #today，或 http(s)
    if not (url.startswith("#") or re.match(r"^https?://", url, re.I)):
        raise ValueError("链接需为 http(s) 或站内锚点（如 #attendance）")
    with LOCK, connect() as conn:
        if lid:
            row = conn.execute("SELECT id FROM hub_links WHERE id=?", (lid,)).fetchone()
            if not row:
                raise LookupError("入口不存在")
            conn.execute(
                """UPDATE hub_links SET title=?, url=?, category=?, note=?,
                   sort_order=?, active=? WHERE id=?""",
                (title, url, category, note, sort_order, active, lid),
            )
            return dict(conn.execute("SELECT * FROM hub_links WHERE id=?", (lid,)).fetchone())
        cur = conn.execute(
            """INSERT INTO hub_links(title,url,category,note,sort_order,active,created_at)
               VALUES (?,?,?,?,?,?,?)""",
            (title, url, category, note, sort_order, active, now()),
        )
        return dict(
            conn.execute("SELECT * FROM hub_links WHERE id=?", (cur.lastrowid,)).fetchone()
        )


def delete_hub_link(link_id: int) -> dict:
    with LOCK, connect() as conn:
        row = conn.execute("SELECT id, title FROM hub_links WHERE id=?", (link_id,)).fetchone()
        if not row:
            raise LookupError("入口不存在")
        conn.execute("DELETE FROM hub_links WHERE id=?", (link_id,))
        return {"ok": True, "id": link_id, "title": row["title"]}


def hub_home(user: dict) -> dict:
    """工作台：今日待办 + 出勤摘要 + 常用入口。"""
    day_value = today_local().isoformat()
    links = list_hub_links(active_only=True)

    with LOCK, connect() as conn:
        admin_work_ids = {
            int(r["intern_id"])
            for r in conn.execute(
                """SELECT intern_id FROM users
                   WHERE role='admin' AND active=1 AND intern_id IS NOT NULL"""
            ).fetchall()
            if r["intern_id"] is not None
        }

        # 管理员摘要：今日出勤 + 布置/提交总量
        admin_summary = None
        if user["role"] == "admin":
            board = day_board(day_value)
            # 按项目汇总今日布置配额与已提交量
            project_rows = conn.execute(
                """SELECT d.project_id,
                          p.name AS project_name,
                          COALESCE(p.unit, '') AS project_unit,
                          SUM(COALESCE(d.quota, 0)) AS assigned,
                          SUM(CASE WHEN pr.done IS NOT NULL THEN pr.done ELSE 0 END) AS submitted,
                          COUNT(d.intern_id) AS assignees,
                          SUM(CASE WHEN pr.done IS NOT NULL THEN 1 ELSE 0 END) AS submitters
                   FROM day_board_projects d
                   JOIN projects p ON p.id = d.project_id
                   LEFT JOIN daily_progress pr
                     ON pr.intern_id = d.intern_id
                    AND pr.project_id = d.project_id
                    AND pr.day = d.day
                   WHERE d.day = ?
                   GROUP BY d.project_id, p.name, p.unit
                   ORDER BY p.name""",
                (day_value,),
            ).fetchall()
            projects_out: list[dict] = []
            assigned_by_unit: dict[str, float] = {}
            submitted_by_unit: dict[str, float] = {}
            for r in project_rows:
                unit = normalize_unit(r["project_unit"] or "节")
                assigned = float(r["assigned"] or 0)
                submitted = float(r["submitted"] or 0)
                projects_out.append(
                    {
                        "project_id": int(r["project_id"]),
                        "project_name": r["project_name"],
                        "unit": unit,
                        "assigned": assigned,
                        "submitted": submitted,
                        "assignees": int(r["assignees"] or 0),
                        "submitters": int(r["submitters"] or 0),
                    }
                )
                assigned_by_unit[unit] = assigned_by_unit.get(unit, 0) + assigned
                submitted_by_unit[unit] = submitted_by_unit.get(unit, 0) + submitted

            def _empty_att() -> dict:
                return {"present": 0, "leave_half": 0, "leave": 0}

            group_counts = {"A": _empty_att(), "B": _empty_att()}
            for row in board.get("rows") or []:
                if int(row.get("active") or 0) != 1:
                    continue
                if row.get("skip_attendance"):
                    continue
                g = normalize_team_group(row.get("team_group"))
                if g not in group_counts:
                    continue
                st = row.get("status") or "unset"
                if st in group_counts[g]:
                    group_counts[g][st] += 1

            def _task_met(t: dict) -> bool:
                if not t.get("submitted"):
                    return False
                quota = float(t.get("quota") or 0)
                if quota <= 0:
                    return True
                done = t.get("done_today")
                if done is None:
                    return False
                return float(done) + 1e-9 >= quota

            task_people = {"done": 0, "incomplete": 0, "unsubmitted": 0}
            for row in board.get("rows") or []:
                if int(row.get("active") or 0) != 1:
                    continue
                tasks = [
                    t
                    for t in (row.get("day_projects") or [])
                    if t
                    and t.get("project_id")
                    and int(t.get("slot") or 0) < 99
                ]
                if not tasks:
                    continue
                any_sub = any(bool(t.get("submitted")) for t in tasks)
                all_met = all(_task_met(t) for t in tasks)
                if all_met:
                    task_people["done"] += 1
                elif any_sub:
                    task_people["incomplete"] += 1
                else:
                    task_people["unsubmitted"] += 1

            # 在职人数不含管理员兼岗身份
            active_rows = conn.execute(
                """SELECT COALESCE(i.team_group,'') AS team_group
                   FROM interns i
                   WHERE i.active=1
                     AND i.id NOT IN (
                       SELECT intern_id FROM users
                       WHERE role='admin' AND active=1 AND intern_id IS NOT NULL
                     )"""
            ).fetchall()
            active_by_group = {"A": 0, "B": 0, "other": 0}
            for r in active_rows:
                g = normalize_team_group(r["team_group"])
                if g in ("A", "B"):
                    active_by_group[g] += 1
                else:
                    active_by_group["other"] += 1
            active_interns = len(active_rows)
            admin_summary = {
                "active_interns": active_interns,
                "active_by_group": active_by_group,
                "counts": {
                    "present": int((board.get("counts") or {}).get("present") or 0),
                    "leave_half": int(
                        (board.get("counts") or {}).get("leave_half") or 0
                    ),
                    "leave": int((board.get("counts") or {}).get("leave") or 0),
                },
                "group_counts": group_counts,
                "task_people": task_people,
                "projects": projects_out,
                "assigned_total": [
                    {"unit": u, "amount": a} for u, a in assigned_by_unit.items()
                ],
                "submitted_total": [
                    {"unit": u, "amount": a} for u, a in submitted_by_unit.items()
                ],
            }

        # 个人今日
        my_tasks: list[dict] = []
        attendance_today = "unset"
        team_group = ""
        work_mode = ""
        intern_name = user.get("display_name") or ""
        iid = user.get("intern_id")
        if iid:
            intern = conn.execute(
                """SELECT id, name, active,
                          COALESCE(team_group,'') AS team_group,
                          COALESCE(work_mode,'') AS work_mode
                   FROM interns WHERE id=?""",
                (iid,),
            ).fetchone()
            if intern:
                intern_name = intern["name"]
                team_group = normalize_team_group(intern["team_group"])
                work_mode = normalize_work_mode(intern["work_mode"])
            b = conn.execute(
                "SELECT status FROM day_board WHERE intern_id=? AND day=?",
                (iid, day_value),
            ).fetchone()
            if b and b["status"] in DAY_STATUSES:
                attendance_today = b["status"]
            done_map = {
                r["project_id"]: r["done"]
                for r in conn.execute(
                    "SELECT project_id, done FROM daily_progress WHERE intern_id=? AND day=?",
                    (iid, day_value),
                ).fetchall()
            }
            for r in conn.execute(
                """SELECT d.project_id, d.slot, d.task_label, d.quota, d.unit,
                          p.name AS project_name,
                          COALESCE(p.unit,'') AS project_unit,
                          COALESCE(p.platform_url,'') AS platform_url,
                          COALESCE(p.doc_url,'') AS doc_url,
                          COALESCE(p.qc_url,'') AS qc_url
                   FROM day_board_projects d
                   JOIN projects p ON p.id=d.project_id
                   WHERE d.intern_id=? AND d.day=?
                   ORDER BY d.slot""",
                (iid, day_value),
            ).fetchall():
                pid = int(r["project_id"])
                submitted = pid in done_map
                done = float(done_map[pid]) if submitted else None
                quota = float(r["quota"] or 0)
                unit = normalize_unit(
                    r["project_unit"]
                    or (r["unit"] if "unit" in r.keys() else "节")
                )
                my_tasks.append(
                    {
                        "project_id": pid,
                        "project_name": r["project_name"],
                        "platform_url": r["platform_url"] or "",
                        "doc_url": r["doc_url"] or "",
                        "qc_url": r["qc_url"] or "",
                        "task_label": r["task_label"] or "",
                        "quota": quota,
                        "unit": unit,
                        "done_today": done,
                        "submitted": submitted,
                        "met": bool(
                            submitted
                            and quota > 0
                            and done is not None
                            and done + 1e-9 >= quota
                        ),
                    }
                )

        # 本周打卡条 + 连续出勤天数
        monday = _monday_of(day_value)
        week_end = (monday + timedelta(days=6)).isoformat()
        cal = _load_work_calendar(
            conn, day_from=monday.isoformat(), day_to=week_end
        )
        # streak 需要往前看，多取一段日历例外
        streak_from = (date.fromisoformat(day_value) - timedelta(days=60)).isoformat()
        cal_streak = _load_work_calendar(
            conn, day_from=streak_from, day_to=day_value
        )
        kind_map = _calendar_kind_map({**cal_streak, **cal})
        week_days = _week_workdays(monday, kind_map)
        week_checkins: list[dict] = []
        week_filled = 0
        week_map: dict[str, str] = {}
        if iid:
            for d in week_days:
                row = conn.execute(
                    "SELECT status FROM day_board WHERE intern_id=? AND day=?",
                    (iid, d),
                ).fetchone()
                st = (
                    row["status"]
                    if row and row["status"] in DAY_STATUSES
                    else "unset"
                )
                week_map[d] = st
                if st in DAY_STATUSES:
                    week_filled += 1
        for d in week_days:
            st = week_map.get(d, "unset")
            week_checkins.append(
                {
                    "day": d,
                    "label": _weekday_label(d),
                    "status": st,
                    "is_today": d == day_value,
                }
            )

        # 连续工作日有出勤/半天（不含全天请假），最多统计 30 天
        streak = 0
        if iid:
            cursor = date.fromisoformat(day_value)
            for _ in range(45):
                if not _is_workday(cursor, kind_map):
                    cursor -= timedelta(days=1)
                    continue
                d = cursor.isoformat()
                st = week_map.get(d)
                if st is None:
                    row = conn.execute(
                        "SELECT status FROM day_board WHERE intern_id=? AND day=?",
                        (iid, d),
                    ).fetchone()
                    st = (
                        row["status"]
                        if row and row["status"] in DAY_STATUSES
                        else "unset"
                    )
                if st in ("present", "leave_half"):
                    streak += 1
                    cursor -= timedelta(days=1)
                    continue
                # 今天未填不算断，继续往前；其它未填/请假则中断
                if d == day_value and st == "unset":
                    cursor -= timedelta(days=1)
                    continue
                break

        # 有平台或规范链接的启用项目（作为工具目录补充）
        project_tools = [
            {
                "id": r["id"],
                "name": r["name"],
                "platform_url": r["platform_url"] or "",
                "doc_url": r["doc_url"] or "",
                "qc_url": r["qc_url"] or "",
                "unit": normalize_unit(r["unit"] if "unit" in r.keys() else "节"),
            }
            for r in conn.execute(
                f"""SELECT id, name, unit,
                           COALESCE(platform_url,'') AS platform_url,
                           COALESCE(doc_url,'') AS doc_url,
                           COALESCE(qc_url,'') AS qc_url
                    FROM projects
                    WHERE {ASSIGNABLE_PROJECT_WHERE}
                      AND (
                        COALESCE(platform_url,'') != ''
                        OR COALESCE(doc_url,'') != ''
                        OR COALESCE(qc_url,'') != ''
                      )
                    ORDER BY name"""
            ).fetchall()
        ]

        return {
            "day": day_value,
            "demo": True,
            "me": {
                "role": user["role"],
                "intern_id": iid,
                "intern_name": intern_name,
                "team_group": team_group,
                "work_mode": work_mode,
                # 管理员本人不计出勤；绑定了组员账号的管理员兼岗也不计
                "skip_attendance": bool(
                    user["role"] == "admin"
                    or (iid and int(iid) in admin_work_ids)
                ),
            },
            "attendance_today": attendance_today,
            "week_days": week_days,
            "week_filled": week_filled,
            "week_checkins": week_checkins,
            "streak": streak,
            "today_tasks": my_tasks,
            "links": links,
            "project_tools": project_tools,
            "admin_summary": admin_summary,
        }


def day_board(day_value: str | None = None, user: dict | None = None) -> dict:
    """日期面板：每人当天状态 + 任务提交。
    管理员看全员；组内管理只看本组；线上管理看 A/B 全部 online（只读由前端限制写操作）。
    在职与已离职全员展示；离职无当天任务时显示「历史无当天任务」。
    """
    day_value = day_value or today_local().isoformat()
    with LOCK, connect() as conn:
        group_only = ""
        group_params: tuple = ()
        online_only = user_is_online_admin(user)
        if user_is_group_admin(user):
            tg = intern_team_group(conn, user.get("intern_id") if user else None)
            if tg not in ("A", "B"):
                raise PermissionError("组内管理需先加入 A/B 组")
            group_only = " AND COALESCE(team_group,'')=? "
            group_params = (tg,)
        active_interns = [
            dict(r)
            for r in conn.execute(
                f"""SELECT id, name, active,
                          COALESCE(team_group,'') AS team_group,
                          COALESCE(work_mode,'') AS work_mode
                   FROM interns WHERE active=1{group_only} ORDER BY name""",
                group_params,
            ).fetchall()
        ]
        # 离职同学一直显示在日期面板（含无当天记录的）；组内管理同组可见
        left_extra = [
            dict(r)
            for r in conn.execute(
                f"""SELECT id, name, active,
                          COALESCE(team_group,'') AS team_group,
                          COALESCE(work_mode,'') AS work_mode
                   FROM interns WHERE active=0{group_only} ORDER BY name""",
                group_params,
            ).fetchall()
        ]

        interns = active_interns + left_extra
        if online_only:
            self_iid = int((user or {}).get("intern_id") or 0)
            admin_iids = {
                int(r["intern_id"])
                for r in conn.execute(
                    """SELECT intern_id FROM users
                       WHERE role='admin' AND active=1 AND intern_id IS NOT NULL"""
                ).fetchall()
                if r["intern_id"] is not None
            }
            interns = [
                i
                for i in interns
                if (
                    is_online_work_mode(i.get("work_mode"))
                    and int(i["id"]) not in admin_iids
                )
                or int(i["id"]) == self_iid
            ]
        projects = [
            dict(r)
            for r in conn.execute(
                f"""SELECT id, name, unit,
                           COALESCE(platform_url,'') AS platform_url,
                           COALESCE(doc_url,'') AS doc_url,
                           COALESCE(qc_url,'') AS qc_url
                    FROM projects WHERE {ASSIGNABLE_PROJECT_WHERE} ORDER BY name"""
            ).fetchall()
        ]
        proj_name = {
            int(p["id"]): p["name"]
            for p in conn.execute("SELECT id, name, unit FROM projects").fetchall()
        }
        proj_unit = {
            int(p["id"]): normalize_unit(p["unit"] if "unit" in p.keys() else "节")
            for p in conn.execute("SELECT id, unit FROM projects").fetchall()
        }
        proj_url = {
            int(p["id"]): str(p["platform_url"] or "")
            for p in conn.execute(
                "SELECT id, COALESCE(platform_url,'') AS platform_url FROM projects"
            ).fetchall()
        }
        proj_doc = {
            int(p["id"]): str(p["doc_url"] or "")
            for p in conn.execute(
                "SELECT id, COALESCE(doc_url,'') AS doc_url FROM projects"
            ).fetchall()
        }
        proj_qc = {
            int(p["id"]): str(p["qc_url"] or "")
            for p in conn.execute(
                "SELECT id, COALESCE(qc_url,'') AS qc_url FROM projects"
            ).fetchall()
        }
        assignments = conn.execute(
            """SELECT a.intern_id, a.project_id, p.name AS project_name
               FROM assignments a
               JOIN projects p ON p.id=a.project_id
               WHERE a.status='active' AND p.active=1
               ORDER BY p.name"""
        ).fetchall()
        asg_by_intern: dict[int, list[dict]] = {}
        for a in assignments:
            asg_by_intern.setdefault(a["intern_id"], []).append(
                {"project_id": a["project_id"], "project_name": a["project_name"]}
            )
        boards = {
            r["intern_id"]: dict(r)
            for r in conn.execute(
                "SELECT * FROM day_board WHERE day=?", (day_value,)
            ).fetchall()
        }
        day_projs = conn.execute(
            """SELECT d.intern_id, d.project_id, d.slot, d.task_label, d.quota, d.unit,
                      p.name AS project_name,
                      COALESCE(p.unit,'') AS project_unit,
                      COALESCE(p.platform_url,'') AS platform_url,
                      COALESCE(p.doc_url,'') AS doc_url,
                      COALESCE(p.qc_url,'') AS qc_url
               FROM day_board_projects d
               JOIN projects p ON p.id=d.project_id
               WHERE d.day=?
               ORDER BY d.slot""",
            (day_value,),
        ).fetchall()
        projs_by_intern: dict[int, list[dict]] = {}
        for r in day_projs:
            projs_by_intern.setdefault(r["intern_id"], []).append(
                {
                    "project_id": r["project_id"],
                    "project_name": r["project_name"],
                    "platform_url": r["platform_url"] or "",
                    "doc_url": r["doc_url"] or "",
                    "qc_url": r["qc_url"] or "",
                    "slot": r["slot"],
                    "task_label": r["task_label"] or "",
                    "quota": int(r["quota"] or 0),
                    "unit": normalize_unit(
                        r["project_unit"]
                        or (r["unit"] if "unit" in r.keys() else "节")
                    ),
                }
            )
        done_today = {
            (r["intern_id"], r["project_id"]): r["done"]
            for r in conn.execute(
                "SELECT intern_id, project_id, done FROM daily_progress WHERE day=?",
                (day_value,),
            ).fetchall()
        }
        progress_by_intern: dict[int, list[tuple[int, float]]] = {}
        for (iid, pid), done in done_today.items():
            progress_by_intern.setdefault(int(iid), []).append((int(pid), float(done)))

        # 管理员兼做任务的组员身份：不计入出勤/请假/未填
        admin_work_ids = {
            int(r["intern_id"])
            for r in conn.execute(
                """SELECT intern_id FROM users
                   WHERE role='admin' AND active=1 AND intern_id IS NOT NULL"""
            ).fetchall()
            if r["intern_id"] is not None
        }

        rows = []
        counts = {"present": 0, "leave": 0, "leave_half": 0, "unset": 0, "left": 0}
        for i in interns:
            is_left = int(i.get("active") or 0) != 1
            skip_attendance = (not is_left) and int(i["id"]) in admin_work_ids
            b = boards.get(i["id"])
            status = b["status"] if b else "unset"
            if status not in DAY_STATUSES:
                status = "unset"
            if is_left:
                counts["left"] += 1
            elif skip_attendance:
                pass
            else:
                counts[status if status in counts else "unset"] += 1
            day_ps = list(projs_by_intern.get(i["id"], []))
            seen_pids = {int(dp["project_id"]) for dp in day_ps}
            # 仅有历史提交、没有任务位时，也把提交结果挂出来
            for pid, done in progress_by_intern.get(i["id"], []):
                if pid in seen_pids:
                    continue
                day_ps.append(
                    {
                        "project_id": pid,
                        "project_name": proj_name.get(pid, f"项目{pid}"),
                        "platform_url": proj_url.get(pid, ""),
                        "doc_url": proj_doc.get(pid, ""),
                        "qc_url": proj_qc.get(pid, ""),
                        "slot": 99,
                        "task_label": "",
                        "quota": done,
                        "unit": proj_unit.get(pid, "节"),
                    }
                )
                seen_pids.add(pid)
            slots = []
            for dp in sorted(day_ps, key=lambda x: int(x["slot"])):
                quota = float(dp["quota"] or 0)
                raw = done_today.get((i["id"], dp["project_id"]))
                submitted = raw is not None
                done = float(raw) if submitted else None
                slots.append(
                    {
                        "project_id": dp["project_id"],
                        "project_name": dp["project_name"],
                        "platform_url": dp.get("platform_url")
                        or proj_url.get(int(dp["project_id"]), ""),
                        "doc_url": dp.get("doc_url")
                        or proj_doc.get(int(dp["project_id"]), ""),
                        "qc_url": dp.get("qc_url")
                        or proj_qc.get(int(dp["project_id"]), ""),
                        "task_label": dp["task_label"],
                        "quota": quota,
                        "unit": dp.get("unit")
                        or proj_unit.get(int(dp["project_id"]), "节"),
                        "done_today": done,
                        "submitted": submitted,
                        "met": bool(
                            submitted
                            and quota > 0
                            and done is not None
                            and done + 1e-9 >= quota
                        ),
                    }
                )
            rows.append(
                {
                    "intern_id": i["id"],
                    "intern_name": i["name"],
                    "team_group": normalize_team_group(
                        i["team_group"] if "team_group" in i.keys() else ""
                    ),
                    "work_mode": normalize_work_mode(
                        i["work_mode"] if "work_mode" in i.keys() else ""
                    ),
                    "active": 0 if is_left else 1,
                    "status": "left" if is_left else status,
                    "board_status": status,
                    "skip_attendance": skip_attendance,
                    "note": b.get("note") if b else "",
                    "day_projects": slots,
                    "assignments": asg_by_intern.get(i["id"], []),
                    "max_projects": max_day_projects_for(conn, int(i["id"])),
                }
            )
        return {
            "day": day_value,
            "rows": rows,
            "projects": projects,
            "counts": counts,
            "max_projects": MAX_DAY_PROJECTS,
            "view_scope": (
                "online"
                if user_is_online_admin(user)
                else "group"
                if user_is_group_admin(user)
                else "all"
            ),
            "readonly": bool(user_is_scope_admin(user) or user_is_readonly_admin(user)),
        }


def upsert_day_board(body: dict) -> dict:
    """更新当天状态，和/或当天项目列表（默认可清空；普通 2 个，管理员兼岗可更多）。"""
    iid = int(body["intern_id"])
    day_value = body.get("day") or today_local().isoformat()

    with LOCK, connect() as conn:
        intern = conn.execute(
            "SELECT id, active FROM interns WHERE id=?", (iid,)
        ).fetchone()
        if not intern:
            raise ValueError("组员不存在")
        if int(intern["active"] or 0) != 1:
            raise ValueError("该组员已离职，无法再安排出勤或任务")

        existing = conn.execute(
            "SELECT * FROM day_board WHERE intern_id=? AND day=?", (iid, day_value)
        ).fetchone()
        status = body.get("status")
        if status is None:
            status = existing["status"] if existing else "present"
        if status not in DAY_STATUSES:
            raise ValueError("状态只能是：出勤、请假半天、请假")

        note = body.get("note")
        if note is None:
            note = existing["note"] if existing else ""

        conn.execute(
            """INSERT INTO day_board(intern_id, day, status, project_id, note, updated_at)
               VALUES (?,?,?,NULL,?,?)
               ON CONFLICT(intern_id, day) DO UPDATE SET
                 status=excluded.status,
                 note=excluded.note,
                 updated_at=excluded.updated_at""",
            (iid, day_value, status, note, now()),
        )

        # day_tasks: [{project_id, task_label?, quota?}, ...] 整体替换（0~2）
        if "day_tasks" in body:
            raw_tasks = body.get("day_tasks") or []
            if not isinstance(raw_tasks, list):
                raise ValueError("day_tasks 应为数组")
            cleaned: list[dict] = []
            seen: set[int] = set()
            for item in raw_tasks:
                if not item:
                    continue
                if isinstance(item, (int, str)):
                    pid = int(item)
                    label, quota = "", 0
                    prow = conn.execute(
                        "SELECT unit FROM projects WHERE id=?", (pid,)
                    ).fetchone()
                    unit = normalize_unit(
                        prow["unit"] if prow and "unit" in prow.keys() else "节"
                    )
                else:
                    if item.get("project_id") in ("", None):
                        continue
                    pid = int(item["project_id"])
                    label = str(item.get("task_label") or "").strip()
                    quota = max(0, num(item.get("quota")))
                    if item.get("unit") in (None, ""):
                        prow = conn.execute(
                            "SELECT unit FROM projects WHERE id=?", (pid,)
                        ).fetchone()
                        unit = normalize_unit(
                            prow["unit"] if prow and "unit" in prow.keys() else "节"
                        )
                    else:
                        unit = normalize_unit(item.get("unit"))
                if pid in seen:
                    continue
                seen.add(pid)
                cleaned.append(
                    {
                        "project_id": pid,
                        "task_label": label,
                        "quota": quota,
                        "unit": unit,
                    }
                )
            limit = max_day_projects_for(conn, iid)
            if len(cleaned) > limit:
                raise ValueError(f"一天最多 {limit} 个项目")
            pids: list[int] = []
            for item in cleaned:
                if not conn.execute(
                    f"SELECT id FROM projects WHERE id=? AND {ASSIGNABLE_PROJECT_WHERE}",
                    (item["project_id"],),
                ).fetchone():
                    prow = conn.execute(
                        "SELECT COALESCE(completed,0) AS completed FROM projects WHERE id=?",
                        (item["project_id"],),
                    ).fetchone()
                    if prow and int(prow["completed"] or 0):
                        raise ValueError("该项目已标记完成，无法分配")
                    raise ValueError("项目不存在")
                pids.append(item["project_id"])
            _sync_assignments_to_projects(conn, iid, pids)
            conn.execute(
                "DELETE FROM day_board_projects WHERE intern_id=? AND day=?",
                (iid, day_value),
            )
            for idx, item in enumerate(cleaned, start=1):
                conn.execute(
                    """INSERT INTO day_board_projects(
                         intern_id, day, project_id, slot, task_label, quota, unit
                       ) VALUES (?,?,?,?,?,?,?)""",
                    (
                        iid,
                        day_value,
                        item["project_id"],
                        idx,
                        item["task_label"],
                        item["quota"],
                        item["unit"],
                    ),
                )
        # project_ids: 显式传入则整体替换（长度 0~2），尽量保留旧配额
        elif "project_ids" in body:
            raw_ids = body.get("project_ids") or []
            if not isinstance(raw_ids, list):
                raise ValueError("project_ids 应为数组")
            old_meta = {
                r["project_id"]: {
                    "task_label": r["task_label"] or "",
                    "quota": int(r["quota"] or 0),
                    "unit": normalize_unit(r["unit"] if "unit" in r.keys() else "节"),
                }
                for r in conn.execute(
                    """SELECT project_id, task_label, quota, unit FROM day_board_projects
                       WHERE intern_id=? AND day=?""",
                    (iid, day_value),
                ).fetchall()
            }
            cleaned_ids: list[int] = []
            for x in raw_ids:
                if x in ("", None):
                    continue
                pid = int(x)
                if pid not in cleaned_ids:
                    cleaned_ids.append(pid)
            limit = max_day_projects_for(conn, iid)
            if len(cleaned_ids) > limit:
                raise ValueError(f"一天最多 {limit} 个项目")
            for pid in cleaned_ids:
                if not conn.execute(
                    f"SELECT id FROM projects WHERE id=? AND {ASSIGNABLE_PROJECT_WHERE}",
                    (pid,),
                ).fetchone():
                    prow = conn.execute(
                        "SELECT COALESCE(completed,0) AS completed FROM projects WHERE id=?",
                        (pid,),
                    ).fetchone()
                    if prow and int(prow["completed"] or 0):
                        raise ValueError("该项目已标记完成，无法分配")
                    raise ValueError("项目不存在")
            _sync_assignments_to_projects(conn, iid, cleaned_ids)
            conn.execute(
                "DELETE FROM day_board_projects WHERE intern_id=? AND day=?",
                (iid, day_value),
            )
            for idx, pid in enumerate(cleaned_ids, start=1):
                meta = old_meta.get(pid, {"task_label": "", "quota": 0, "unit": "节"})
                conn.execute(
                    """INSERT INTO day_board_projects(
                         intern_id, day, project_id, slot, task_label, quota, unit
                       ) VALUES (?,?,?,?,?,?,?)""",
                    (
                        iid,
                        day_value,
                        pid,
                        idx,
                        meta["task_label"],
                        meta["quota"],
                        meta["unit"],
                    ),
                )
        # 兼容旧字段：单 project_id / clear
        elif "project_id" in body or body.get("clear_project"):
            pid = body.get("project_id")
            if body.get("clear_project") or pid in ("", None):
                slot = int(body.get("slot") or 1)
                conn.execute(
                    "DELETE FROM day_board_projects WHERE intern_id=? AND day=? AND slot=?",
                    (iid, day_value, slot),
                )
                left = [
                    dict(r)
                    for r in conn.execute(
                        """SELECT project_id, task_label, quota, unit FROM day_board_projects
                           WHERE intern_id=? AND day=? ORDER BY slot""",
                        (iid, day_value),
                    ).fetchall()
                ]
                conn.execute(
                    "DELETE FROM day_board_projects WHERE intern_id=? AND day=?",
                    (iid, day_value),
                )
                for idx, p in enumerate(left, start=1):
                    conn.execute(
                        """INSERT INTO day_board_projects(
                             intern_id, day, project_id, slot, task_label, quota, unit
                           ) VALUES (?,?,?,?,?,?,?)""",
                        (
                            iid,
                            day_value,
                            p["project_id"],
                            idx,
                            p["task_label"] or "",
                            int(p["quota"] or 0),
                            normalize_unit(p["unit"] if "unit" in p.keys() else "节"),
                        ),
                    )
            else:
                pid = int(pid)
                slot = int(body.get("slot") or 1)
                if slot not in (1, 2):
                    raise ValueError("项目位只能是 1 或 2")
                if not conn.execute(
                    f"SELECT id FROM projects WHERE id=? AND {ASSIGNABLE_PROJECT_WHERE}", (pid,)
                ).fetchone():
                    prow = conn.execute(
                        "SELECT COALESCE(completed,0) AS completed FROM projects WHERE id=?",
                        (pid,),
                    ).fetchone()
                    if prow and int(prow["completed"] or 0):
                        raise ValueError("该项目已标记完成，无法分配")
                    raise ValueError("项目不存在")
                other = conn.execute(
                    """SELECT project_id FROM day_board_projects
                       WHERE intern_id=? AND day=? AND slot!=?""",
                    (iid, day_value, slot),
                ).fetchone()
                if other and other["project_id"] == pid:
                    raise ValueError("两个项目位不能选同一个项目")
                _ensure_assignment(conn, iid, pid)
                prev = conn.execute(
                    """SELECT task_label, quota, unit FROM day_board_projects
                       WHERE intern_id=? AND day=? AND slot=?""",
                    (iid, day_value, slot),
                ).fetchone()
                label = body.get("task_label")
                if label is None:
                    label = prev["task_label"] if prev else ""
                quota = body.get("quota")
                if quota is None:
                    quota = int(prev["quota"]) if prev else 0
                else:
                    quota = max(0, num(quota))
                unit = body.get("unit")
                if unit is None:
                    unit = normalize_unit(prev["unit"] if prev and "unit" in prev.keys() else "节")
                else:
                    unit = normalize_unit(unit)
                conn.execute(
                    "DELETE FROM day_board_projects WHERE intern_id=? AND day=? AND slot=?",
                    (iid, day_value, slot),
                )
                conn.execute(
                    """INSERT INTO day_board_projects(
                         intern_id, day, project_id, slot, task_label, quota, unit
                       ) VALUES (?,?,?,?,?,?,?)""",
                    (iid, day_value, pid, slot, str(label).strip(), quota, unit),
                )

    return day_board(day_value)


def clear_daily(body: dict, user: dict) -> dict:
    """管理员删除某人某天某项目的提交，便于对方重新提交。"""
    if user.get("role") != "admin":
        raise PermissionError("只有管理员可以删除提交记录")
    iid = int(body["intern_id"])
    pid = int(body["project_id"])
    day_value = body.get("day") or today_local().isoformat()
    with LOCK, connect() as conn:
        existing = conn.execute(
            "SELECT id, done FROM daily_progress WHERE intern_id=? AND project_id=? AND day=?",
            (iid, pid, day_value),
        ).fetchone()
        if not existing:
            raise ValueError("当天没有提交记录")
        conn.execute("DELETE FROM daily_progress WHERE id=?", (existing["id"],))
        _sync_assignment(conn, iid, pid)
        name = conn.execute("SELECT name FROM interns WHERE id=?", (iid,)).fetchone()
        proj = conn.execute("SELECT name FROM projects WHERE id=?", (pid,)).fetchone()
        return {
            "ok": True,
            "cleared": True,
            "intern_id": iid,
            "project_id": pid,
            "day": day_value,
            "feedback": {
                "message": (
                    f"已删除 {(name['name'] if name else '')} "
                    f"{day_value} · {(proj['name'] if proj else '项目')} 的提交，可让对方重新提交"
                )
            },
        }


def upsert_daily(body: dict, user: dict) -> dict:
    iid = int(body["intern_id"])
    pid = int(body["project_id"])
    day_value = body.get("day") or today_local().isoformat()
    is_makeup = bool(body.get("makeup"))
    today = today_local().isoformat()
    if user["role"] != "admin":
        if not user.get("intern_id") or int(user["intern_id"]) != iid:
            raise PermissionError("只能填写自己的完成量")
        if day_value > today:
            raise ValueError("不能填写未来日期")
        if day_value != today:
            # 补交：只允许最近 MAKEUP_MAX_DAYS 天
            try:
                d = date.fromisoformat(day_value)
            except ValueError as exc:
                raise ValueError("日期格式无效") from exc
            earliest = today_local() - timedelta(days=MAKEUP_MAX_DAYS)
            if d < earliest:
                raise ValueError(f"只能补交最近 {MAKEUP_MAX_DAYS} 天内的记录")
            is_makeup = True
        elif not is_makeup:
            is_makeup = False
    with LOCK, connect() as conn:
        # 当天安排 / 当前或历史分配均可补交；没有则自动建立分配
        on_board = conn.execute(
            """SELECT 1 FROM day_board_projects
               WHERE intern_id=? AND day=? AND project_id=?""",
            (iid, day_value, pid),
        ).fetchone()
        asg = conn.execute(
            "SELECT id, status FROM assignments WHERE intern_id=? AND project_id=?",
            (iid, pid),
        ).fetchone()
        proj = conn.execute(
            "SELECT id, name, COALESCE(completed,0) AS completed FROM projects WHERE id=? AND active=1",
            (pid,),
        ).fetchone()
        if not proj:
            raise ValueError("项目不存在")
        if int(proj["completed"] or 0) and not asg and not on_board:
            raise ValueError("该项目已标记完成，无法新建登记")
        if not asg and not on_board:
            # 补交时允许选当前活跃项目；今日提交仍要求已分配
            active_n = conn.execute(
                """SELECT COUNT(*) FROM assignments
                   WHERE intern_id=? AND status='active'""",
                (iid,),
            ).fetchone()[0]
            if not is_makeup:
                raise ValueError("该项目未分配给你，无法登记")
            if active_n >= max_day_projects_for(conn, iid):
                # 仍允许写入进度，但不强行激活超过上限的新分配
                conn.execute(
                    """INSERT INTO assignments(intern_id,project_id,target,done,status,updated_at)
                       VALUES (?,?,0,0,'inactive',?)""",
                    (iid, pid, now()),
                )
            else:
                conn.execute(
                    """INSERT INTO assignments(intern_id,project_id,target,done,status,updated_at)
                       VALUES (?,?,0,0,'active',?)""",
                    (iid, pid, now()),
                )
        elif asg and asg["status"] != "active" and on_board:
            conn.execute(
                "UPDATE assignments SET status='active', updated_at=? WHERE id=?",
                (now(), asg["id"]),
            )

        existing = conn.execute(
            "SELECT id, done FROM daily_progress WHERE intern_id=? AND project_id=? AND day=?",
            (iid, pid, day_value),
        ).fetchone()
        # 今日登记：同一项目每天只能提交一次；补交允许改
        if existing and not is_makeup:
            raise ValueError("该项目今日已提交过，不能再改。如需修正请用「补交」。")

        if "done" not in body or body.get("done") is None or body.get("done") == "":
            raise ValueError("请填写完成数量")
        done = num(body.get("done"))
        assigned = num(body.get("assigned") if body.get("assigned") is not None else done)
        note = body.get("note") or ""
        if is_makeup and not note:
            note = f"补交 {day_value}"
        conn.execute(
            """INSERT INTO daily_progress(intern_id,project_id,day,assigned,done,note,updated_at)
               VALUES (?,?,?,?,?,?,?)
               ON CONFLICT(intern_id,project_id,day) DO UPDATE SET
                 assigned=excluded.assigned, done=excluded.done,
                 note=excluded.note, updated_at=excluded.updated_at""",
            (iid, pid, day_value, assigned, done, note, now()),
        )
        _sync_assignment(conn, iid, pid)
        row = dict(
            conn.execute(
                """SELECT d.*, i.name intern_name, p.name project_name
                   FROM daily_progress d
                   JOIN interns i ON i.id=d.intern_id
                   JOIN projects p ON p.id=d.project_id
                   WHERE d.intern_id=? AND d.project_id=? AND d.day=?""",
                (iid, pid, day_value),
            ).fetchone()
        )
        task = conn.execute(
            """SELECT task_label, quota, unit FROM day_board_projects
               WHERE intern_id=? AND day=? AND project_id=?""",
            (iid, day_value, pid),
        ).fetchone()
        quota = int(task["quota"]) if task else 0
        task_label = (task["task_label"] if task else "") or ""
        unit = normalize_unit(
            body.get("unit")
            if body.get("unit")
            else (task["unit"] if task and "unit" in task.keys() else "节")
        )
        met = bool(quota > 0 and done + 1e-9 >= quota)
        exact = bool(quota > 0 and abs(done - quota) <= 1e-9)
        over = bool(quota > 0 and done > quota + 1e-9)
        day_tasks = conn.execute(
            """SELECT d.project_id, d.quota, p.done AS done
               FROM day_board_projects d
               LEFT JOIN daily_progress p
                 ON p.intern_id=d.intern_id AND p.project_id=d.project_id AND p.day=d.day
               WHERE d.intern_id=? AND d.day=? AND d.quota > 0""",
            (iid, day_value),
        ).fetchall()
        all_met = bool(day_tasks) and all(
            t["done"] is not None and float(t["done"] or 0) + 1e-9 >= float(t["quota"] or 0)
            for t in day_tasks
        )
        if is_makeup:
            if over:
                msg = f"已补交 {day_value} · {done} {unit}，超量完成，非常棒 👏"
            elif exact:
                msg = f"已补交 {day_value} · {done} {unit}，刚好完成 🎉"
            elif quota > 0:
                left = max(0, quota - done)
                msg = f"已补交 {day_value} · {done} {unit}，还差 {left} {unit}，继续加油，明天补上"
            else:
                msg = f"已补交 {day_value} · {done} {unit}"
            feedback = {
                "celebrate": met and quota > 0,
                "encourage": bool(quota > 0 and not met),
                "overachieved": over,
                "exact": exact,
                "quota": quota,
                "done": done,
                "met": met,
                "all_met": all_met,
                "task_label": task_label,
                "unit": unit,
                "makeup": True,
                "message": msg,
            }
        elif quota <= 0:
            feedback = {
                "celebrate": False,
                "encourage": False,
                "overachieved": False,
                "exact": False,
                "quota": 0,
                "done": done,
                "met": False,
                "all_met": False,
                "task_label": task_label,
                "unit": unit,
                "message": "已保存完成量",
            }
        elif over:
            feedback = {
                "celebrate": True,
                "encourage": False,
                "overachieved": True,
                "exact": False,
                "quota": quota,
                "done": done,
                "met": True,
                "all_met": all_met,
                "task_label": task_label,
                "unit": unit,
                "message": f"非常棒！超量完成了（{fmt_amount(done)}/{fmt_amount(quota)} {unit}）👏",
            }
        elif exact:
            feedback = {
                "celebrate": True,
                "encourage": False,
                "overachieved": False,
                "exact": True,
                "quota": quota,
                "done": done,
                "met": True,
                "all_met": all_met,
                "task_label": task_label,
                "unit": unit,
                "message": (
                    "今日分配任务全部完成！撒花庆祝 🎉"
                    if all_met
                    else "刚好完成今日配额！撒花 🎉"
                ),
            }
        else:
            left = max(0, quota - done)
            feedback = {
                "celebrate": False,
                "encourage": True,
                "overachieved": False,
                "exact": False,
                "quota": quota,
                "done": done,
                "met": False,
                "all_met": False,
                "task_label": task_label,
                "unit": unit,
                "message": f"还差 {fmt_amount(left)} {unit}，继续加油，明天补上",
            }
        row["feedback"] = feedback
        return row


def makeup_options(day_value: str | None, user: dict) -> dict:
    """组员补交：某日可选项目 + 已填数量。"""
    if user["role"] != "admin" and not user.get("intern_id"):
        raise PermissionError("账号未绑定组员")
    today = today_local()
    if not day_value:
        day_value = (today - timedelta(days=1)).isoformat()
    try:
        d = date.fromisoformat(day_value)
    except ValueError as exc:
        raise ValueError("日期格式无效") from exc
    if d > today:
        raise ValueError("不能补交未来日期")
    earliest = today - timedelta(days=MAKEUP_MAX_DAYS)
    if d < earliest:
        raise ValueError(f"只能补交最近 {MAKEUP_MAX_DAYS} 天")

    iid = user.get("intern_id")
    if not iid:
        raise PermissionError("未绑定任务身份，无法补交")
    iid = int(iid)

    with LOCK, connect() as conn:
        board_rows = [
            dict(r)
            for r in conn.execute(
                """SELECT d.project_id, d.quota, d.unit, p.name AS project_name,
                          COALESCE(p.unit,'') AS project_unit
                   FROM day_board_projects d
                   JOIN projects p ON p.id=d.project_id
                   WHERE d.intern_id=? AND d.day=? AND p.active=1
                   ORDER BY d.slot""",
                (iid, day_value),
            ).fetchall()
        ]
        asg_rows = [
            dict(r)
            for r in conn.execute(
                """SELECT a.project_id, p.name AS project_name,
                          COALESCE(p.unit,'') AS project_unit
                   FROM assignments a
                   JOIN projects p ON p.id=a.project_id
                   WHERE a.intern_id=? AND a.status='active' AND p.active=1
                   ORDER BY p.name""",
                (iid,),
            ).fetchall()
        ]
        done_map = {
            r["project_id"]: r["done"]
            for r in conn.execute(
                "SELECT project_id, done FROM daily_progress WHERE intern_id=? AND day=?",
                (iid, day_value),
            ).fetchall()
        }
        by_id: dict[int, dict] = {}
        for r in board_rows:
            by_id[r["project_id"]] = {
                "project_id": r["project_id"],
                "project_name": r["project_name"],
                "quota": int(r["quota"] or 0),
                "unit": normalize_unit(
                    r["project_unit"]
                    or (r["unit"] if "unit" in r.keys() else "节")
                ),
                "done": int(done_map.get(r["project_id"], 0)),
                "from_board": True,
            }
        for r in asg_rows:
            if r["project_id"] in by_id:
                continue
            by_id[r["project_id"]] = {
                "project_id": r["project_id"],
                "project_name": r["project_name"],
                "quota": 0,
                "unit": normalize_unit(r["project_unit"] or "节"),
                "done": int(done_map.get(r["project_id"], 0)),
                "from_board": False,
            }
        # 也带上该日已有进度但不在上面的项目
        for pid, done in done_map.items():
            if pid in by_id:
                continue
            prow = conn.execute(
                "SELECT name, COALESCE(unit,'') AS unit FROM projects WHERE id=? AND active=1",
                (pid,),
            ).fetchone()
            if not prow:
                continue
            by_id[pid] = {
                "project_id": pid,
                "project_name": prow["name"],
                "quota": 0,
                "unit": normalize_unit(prow["unit"] or "节"),
                "done": int(done),
                "from_board": False,
            }
        return {
            "day": day_value,
            "today": today.isoformat(),
            "earliest": earliest.isoformat(),
            "projects": list(by_id.values()),
            "max_days": MAKEUP_MAX_DAYS,
        }


def my_workload(user: dict, days_back: int | None = None) -> dict:
    """组员个人：每日分配 / 完成 / 是否已提交，以及累计总量。"""
    if not user.get("intern_id"):
        raise PermissionError("账号未绑定组员")
    iid = int(user["intern_id"])
    today = today_local()
    span = days_back if days_back is not None else max(MAKEUP_MAX_DAYS, 120)
    earliest = today - timedelta(days=span)

    with LOCK, connect() as conn:
        intern = conn.execute(
            "SELECT id, name FROM interns WHERE id=? AND active=1", (iid,)
        ).fetchone()
        if not intern:
            raise ValueError("组员不存在或已停用")

        boards = {
            r["day"]: dict(r)
            for r in conn.execute(
                """SELECT day, status, note FROM day_board
                   WHERE intern_id=? AND day>=? AND day<=?
                   ORDER BY day""",
                (iid, earliest.isoformat(), today.isoformat()),
            ).fetchall()
        }
        board_tasks = [
            dict(r)
            for r in conn.execute(
                """SELECT d.day, d.project_id, d.quota, d.unit, d.slot, p.name AS project_name,
                          COALESCE(p.unit,'') AS project_unit
                   FROM day_board_projects d
                   JOIN projects p ON p.id=d.project_id
                   WHERE d.intern_id=? AND d.day>=? AND d.day<=?
                   ORDER BY d.day DESC, d.slot""",
                (iid, earliest.isoformat(), today.isoformat()),
            ).fetchall()
        ]
        progress = [
            dict(r)
            for r in conn.execute(
                """SELECT d.day, d.project_id, d.assigned, d.done, d.note, p.name AS project_name,
                          COALESCE(p.unit,'') AS project_unit
                   FROM daily_progress d
                   JOIN projects p ON p.id=d.project_id
                   WHERE d.intern_id=? AND d.day>=? AND d.day<=?
                   ORDER BY d.day DESC, p.name""",
                (iid, earliest.isoformat(), today.isoformat()),
            ).fetchall()
        ]

        tasks_by_day: dict[str, list[dict]] = {}
        for t in board_tasks:
            tasks_by_day.setdefault(t["day"], []).append(t)
        prog_by_day_proj: dict[tuple[str, int], dict] = {
            (r["day"], int(r["project_id"])): r for r in progress
        }
        prog_by_day: dict[str, list[dict]] = {}
        for r in progress:
            prog_by_day.setdefault(r["day"], []).append(r)

        all_days = sorted(
            set(boards) | set(tasks_by_day) | set(prog_by_day),
            reverse=True,
        )

        days_out: list[dict] = []
        miss_days = 0
        sum_assigned = 0.0
        sum_done = 0.0
        by_project: dict[int, dict] = {}

        for day in all_days:
            b = boards.get(day)
            status = (b["status"] if b else None) or "unset"
            if status not in DAY_STATUSES:
                status = "unset"
            day_tasks = tasks_by_day.get(day, [])
            day_progs = prog_by_day.get(day, [])

            items: list[dict] = []
            seen_pids: set[int] = set()

            if status == "leave" and not day_tasks and not day_progs:
                days_out.append(
                    {
                        "day": day,
                        "status": "leave",
                        "submit_status": "leave",
                        "note": (b or {}).get("note") or "",
                        "items": [],
                        "assigned_sum": 0,
                        "done_sum": 0,
                    }
                )
                continue

            note = (b or {}).get("note") or ""
            if not day_tasks and not day_progs:
                # 出勤但无本项目任务（如 tts / 产测）
                other = note if note in ("tts", "产测", "质检") else "empty"
                days_out.append(
                    {
                        "day": day,
                        "status": status if status != "unset" else "present",
                        "submit_status": other if other != "empty" else "empty",
                        "note": note,
                        "items": [],
                        "assigned_sum": 0,
                        "done_sum": 0,
                    }
                )
                continue

            for t in day_tasks:
                pid = int(t["project_id"])
                seen_pids.add(pid)
                pr = prog_by_day_proj.get((day, pid))
                quota = float(t["quota"] or 0)
                done = float(pr["done"]) if pr else None
                unit = normalize_unit(
                    t["project_unit"]
                    if "project_unit" in t.keys() and t["project_unit"]
                    else (t["unit"] if "unit" in t.keys() else "节")
                )
                submitted = pr is not None
                if status == "leave":
                    submit_status = "leave"
                elif not submitted:
                    submit_status = "missing"
                elif quota > 0 and done is not None and done + 1e-9 < quota:
                    submit_status = "short"
                else:
                    submit_status = "ok"
                assigned_show = quota if quota > 0 else (float(pr["assigned"]) if pr else 0)
                items.append(
                    {
                        "project_id": pid,
                        "project_name": t["project_name"],
                        "assigned": assigned_show,
                        "done": done,
                        "unit": unit,
                        "submitted": submitted,
                        "submit_status": submit_status,
                    }
                )
                if submitted:
                    sum_assigned += assigned_show
                    sum_done += float(done or 0)
                    bp = by_project.setdefault(
                        pid,
                        {
                            "project_id": pid,
                            "project_name": t["project_name"],
                            "assigned": 0.0,
                            "done": 0.0,
                        },
                    )
                    bp["assigned"] += assigned_show
                    bp["done"] += float(done or 0)

            for pr in day_progs:
                pid = int(pr["project_id"])
                if pid in seen_pids:
                    continue
                done = float(pr["done"] or 0)
                assigned_show = float(pr["assigned"] or done)
                unit = normalize_unit(
                    pr["project_unit"]
                    if "project_unit" in pr.keys() and pr["project_unit"]
                    else "节"
                )
                items.append(
                    {
                        "project_id": pid,
                        "project_name": pr["project_name"],
                        "assigned": assigned_show,
                        "done": done,
                        "unit": unit,
                        "submitted": True,
                        "submit_status": "ok",
                    }
                )
                sum_assigned += assigned_show
                sum_done += done
                bp = by_project.setdefault(
                    pid,
                    {
                        "project_id": pid,
                        "project_name": pr["project_name"],
                        "assigned": 0.0,
                        "done": 0.0,
                    },
                )
                bp["assigned"] += assigned_show
                bp["done"] += done

            if status == "leave":
                day_submit = "leave"
            elif not items:
                day_submit = "empty"
            elif any(it["submit_status"] == "missing" for it in items):
                day_submit = "missing"
                miss_days += 1
            elif any(it["submit_status"] == "short" for it in items):
                day_submit = "short"
            else:
                day_submit = "ok"

            days_out.append(
                {
                    "day": day,
                    "status": status if status != "unset" else ("present" if items else "unset"),
                    "submit_status": day_submit,
                    "items": items,
                    "assigned_sum": round(sum(it["assigned"] or 0 for it in items), 1),
                    "done_sum": round(
                        sum(it["done"] or 0 for it in items if it["done"] is not None), 1
                    ),
                }
            )

        # cumulative all-time (not only window) for totals
        all_time = conn.execute(
            """SELECT COALESCE(SUM(assigned),0) assigned, COALESCE(SUM(done),0) done
               FROM daily_progress WHERE intern_id=?""",
            (iid,),
        ).fetchone()
        proj_all = [
            dict(r)
            for r in conn.execute(
                """SELECT p.id AS project_id, p.name AS project_name,
                          COALESCE(p.unit, '节') AS unit,
                          COALESCE(SUM(d.assigned),0) AS assigned,
                          COALESCE(SUM(d.done),0) AS done
                   FROM daily_progress d
                   JOIN projects p ON p.id=d.project_id
                   WHERE d.intern_id=?
                   GROUP BY p.id
                   ORDER BY done DESC""",
                (iid,),
            ).fetchall()
        ]

        return {
            "intern_id": iid,
            "intern_name": intern["name"],
            "today": today.isoformat(),
            "earliest": earliest.isoformat(),
            "missing_days": miss_days,
            "window": {
                "assigned": round(sum_assigned, 1),
                "done": round(sum_done, 1),
            },
            "totals": {
                "assigned": float(all_time["assigned"] or 0),
                "done": float(all_time["done"] or 0),
            },
            "projects": proj_all,
            "days": days_out,
        }


def daily_progress(day_value: str | None, user: dict) -> dict:
    day_value = day_value or today_local().isoformat()
    with LOCK, connect() as conn:
        if user["role"] == "admin":
            rows = [
                dict(r)
                for r in conn.execute(
                    """SELECT d.*, i.name intern_name, p.name project_name
                       FROM daily_progress d
                       JOIN interns i ON i.id=d.intern_id
                       JOIN projects p ON p.id=d.project_id
                       WHERE d.day=? ORDER BY i.name, p.name""",
                    (day_value,),
                ).fetchall()
            ]
        else:
            iid = user.get("intern_id")
            rows = [
                dict(r)
                for r in conn.execute(
                    """SELECT d.*, i.name intern_name, p.name project_name
                       FROM daily_progress d
                       JOIN interns i ON i.id=d.intern_id
                       JOIN projects p ON p.id=d.project_id
                       WHERE d.day=? AND d.intern_id=? ORDER BY p.name""",
                    (day_value, iid),
                ).fetchall()
            ]
        totals = conn.execute(
            "SELECT COALESCE(SUM(assigned),0) assigned, COALESCE(SUM(done),0) done FROM daily_progress WHERE day=?",
            (day_value,),
        ).fetchone()
        cumulative = conn.execute(
            "SELECT COALESCE(SUM(assigned),0) assigned, COALESCE(SUM(done),0) done FROM daily_progress"
        ).fetchone()
        by_project = [
            dict(r)
            for r in conn.execute(
                """SELECT p.id project_id, p.name project_name,
                          COALESCE(SUM(d.assigned),0) assigned, COALESCE(SUM(d.done),0) done
                   FROM projects p
                   LEFT JOIN daily_progress d ON d.project_id=p.id
                   GROUP BY p.id ORDER BY p.name"""
            ).fetchall()
        ]
    return {
        "day": day_value,
        "records": rows,
        "totals": {
            "today": dict(totals),
            "cumulative": dict(cumulative),
            "projects": by_project,
        },
    }


def dashboard(day_value: str | None, user: dict) -> dict:
    day_value = day_value or today_local().isoformat()
    with LOCK, connect() as conn:
        if user["role"] == "admin":
            interns = [
                dict(r)
                for r in conn.execute(
                    "SELECT * FROM interns WHERE active=1 ORDER BY name"
                ).fetchall()
            ]
        else:
            iid = user.get("intern_id")
            interns = [
                dict(r)
                for r in conn.execute(
                    "SELECT * FROM interns WHERE id=? AND active=1", (iid,)
                ).fetchall()
            ]
        projects = [
            dict(r)
            for r in conn.execute(
                "SELECT * FROM projects WHERE active=1 ORDER BY name"
            ).fetchall()
        ]
        assignments = [
            dict(r)
            for r in conn.execute(
                """SELECT a.*, i.name intern_name, p.name project_name
                   FROM assignments a
                   JOIN interns i ON i.id=a.intern_id
                   JOIN projects p ON p.id=a.project_id
                   WHERE a.status='active' AND i.active=1 AND p.active=1"""
            ).fetchall()
        ]
        if user["role"] != "admin":
            iid = user.get("intern_id")
            assignments_me = [a for a in assignments if a["intern_id"] == iid]
        else:
            assignments_me = assignments

        project_stats, people = [], []
        done_map = {
            (r["intern_id"], r["project_id"]): r["done"]
            for r in conn.execute(
                "SELECT intern_id, project_id, done FROM daily_progress WHERE day=?",
                (day_value,),
            ).fetchall()
        }
        # 项目总量按历史提交汇总（含已离职），不随在职状态丢失
        progress_by_project: dict[int, list[dict]] = {}
        for r in conn.execute(
            """SELECT d.project_id, d.intern_id, i.name AS intern_name,
                      i.active AS intern_active,
                      COALESCE(SUM(d.done),0) AS done,
                      COALESCE(SUM(d.assigned),0) AS assigned
               FROM daily_progress d
               JOIN interns i ON i.id=d.intern_id
               GROUP BY d.project_id, d.intern_id
               ORDER BY done DESC"""
        ).fetchall():
            progress_by_project.setdefault(int(r["project_id"]), []).append(dict(r))

        for p in projects:
            rows = progress_by_project.get(p["id"], [])
            done = sum(float(a["done"] or 0) for a in rows)
            target = p["target_total"] or 0
            project_stats.append(
                {
                    **p,
                    "marked_complete": int(p.get("completed") or 0) == 1,
                    "done_sum": done,
                    "target": target,
                    "pct": percent(done, target) if target else 0,
                    "people_count": len(rows),
                    "people": [
                        {
                            "intern_id": a["intern_id"],
                            "intern_name": a["intern_name"],
                            "active": int(a["intern_active"] or 0),
                            "project_id": p["id"],
                            "done": a["done"],
                            "target": 0,
                            "assigned": a["assigned"],
                            "pct": 0,
                        }
                        for a in rows
                    ],
                    "view": "project",
                }
            )
        for i in interns:
            rows = [a for a in assignments_me if a["intern_id"] == i["id"]]
            done = sum(a["done"] for a in rows)
            target = sum(a["target"] for a in rows)
            today_tasks = [
                {
                    "project_id": r["project_id"],
                    "project_name": r["project_name"],
                    "platform_url": r["platform_url"] or "",
                    "doc_url": r["doc_url"] or "",
                    "qc_url": r["qc_url"] or "",
                    "task_label": r["task_label"] or "",
                    "quota": int(r["quota"] or 0),
                    "unit": normalize_unit(
                        r["project_unit"]
                        or (r["unit"] if "unit" in r.keys() else "节")
                    ),
                    "slot": r["slot"],
                    "done_today": (
                        float(done_map[(i["id"], r["project_id"])])
                        if (i["id"], r["project_id"]) in done_map
                        else None
                    ),
                    "submitted": (i["id"], r["project_id"]) in done_map,
                }
                for r in conn.execute(
                    """SELECT d.project_id, d.slot, d.task_label, d.quota, d.unit,
                              p.name AS project_name,
                              COALESCE(p.unit,'') AS project_unit,
                              COALESCE(p.platform_url,'') AS platform_url,
                              COALESCE(p.doc_url,'') AS doc_url,
                              COALESCE(p.qc_url,'') AS qc_url
                       FROM day_board_projects d
                       JOIN projects p ON p.id=d.project_id
                       WHERE d.intern_id=? AND d.day=?
                       ORDER BY d.slot""",
                    (i["id"], day_value),
                ).fetchall()
            ]
            people.append(
                {
                    **i,
                    "done_sum": done,
                    "target_sum": target,
                    "pct": percent(done, target),
                    "projects": [
                        {**a, "pct": percent(a["done"], a["target"])} for a in rows
                    ],
                    "today_tasks": today_tasks,
                }
            )
    return {
        "day": day_value,
        "me": user,
        "summary": {
            "intern_count": len(interns) if user["role"] == "admin" else 1,
            "project_count": len(projects),
        },
        "projects": project_stats,
        "people": people,
    }


MIME = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt: str, *args: Any) -> None:
        print(f"[{self.log_date_time_string()}] {args[0]}")

    def _token_from_cookie(self) -> str | None:
        raw = self.headers.get("Cookie") or ""
        cookie = SimpleCookie()
        try:
            cookie.load(raw)
        except Exception:
            return None
        morsel = cookie.get("session")
        return morsel.value if morsel else None

    def _current_user(self) -> dict | None:
        return get_user_by_token(self._token_from_cookie())

    def _json(
        self,
        code: int,
        data: Any,
        *,
        set_cookie: str | None = None,
        clear_cookie: bool = False,
    ) -> None:
        raw = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        if set_cookie:
            self.send_header(
                "Set-Cookie",
                f"session={set_cookie}; Path={COOKIE_PATH}; HttpOnly; SameSite=Lax; Max-Age={SESSION_DAYS * 86400}",
            )
        if clear_cookie:
            self.send_header(
                "Set-Cookie",
                f"session=; Path={COOKIE_PATH}; HttpOnly; SameSite=Lax; Max-Age=0",
            )
        self.end_headers()
        self.wfile.write(raw)

    def _route_path(self) -> str | None:
        """去掉 BASE_PATH 前缀；带前缀部署时拒绝无前缀请求。"""
        path = urlparse(self.path).path
        if not BASE_PATH:
            return path
        if path == BASE_PATH:
            return "/"
        if path.startswith(BASE_PATH + "/"):
            return path[len(BASE_PATH) :] or "/"
        return None

    def _read_json(self) -> dict:
        n = int(self.headers.get("Content-Length") or 0)
        if n <= 0:
            return {}
        return json.loads(self.rfile.read(n).decode("utf-8") or "{}")

    def _require_login(self) -> dict:
        user = self._current_user()
        if not user:
            raise PermissionError("请先登录")
        return user

    def _require_admin(self) -> dict:
        user = self._require_login()
        if user["role"] != "admin":
            raise PermissionError("需要管理员权限")
        return user

    def _require_write_admin(self) -> dict:
        user = self._require_admin()
        if user_is_readonly_admin(user):
            raise PermissionError("只读管理员账号，仅可查看，不能修改")
        return user

    def _deny_readonly_admin(self) -> None:
        user = self._current_user()
        if user_is_readonly_admin(user):
            raise PermissionError("只读管理员账号，仅可查看，不能修改")

    def do_OPTIONS(self) -> None:  # noqa: N802
        self.send_response(204)
        self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Credentials", "true")
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        path = self._route_path()
        qs = parse_qs(urlparse(self.path).query)
        if path is None:
            return self._json(404, {"detail": "Not found"})
        try:
            if path in ("/", "/index.html"):
                return self._index()
            if path.startswith("/static/"):
                return self._file(STATIC / path[len("/static/") :])

            if path == "/api/me":
                user = self._current_user()
                return self._json(200, {"user": user})

            if path == "/api/dashboard":
                user = self._require_login()
                return self._json(200, dashboard((qs.get("day") or [None])[0], user))
            if path == "/api/daily":
                user = self._require_login()
                return self._json(200, daily_progress((qs.get("day") or [None])[0], user))
            if path == "/api/interns":
                self._require_admin()
                return self._json(
                    200,
                    get_interns((qs.get("active_only") or ["false"])[0].lower() == "true"),
                )
            if path == "/api/projects":
                self._require_login()
                return self._json(
                    200,
                    get_projects((qs.get("active_only") or ["false"])[0].lower() == "true"),
                )
            if path == "/api/users":
                self._require_admin()
                return self._json(200, list_users())
            if path == "/api/day-board":
                user = self._require_login()
                if not user_can_view_day_board(user):
                    raise PermissionError("需要管理员或组内管理权限")
                return self._json(
                    200, day_board((qs.get("day") or [None])[0], user=user)
                )
            if path == "/api/assignments":
                self._require_admin()
                return self._json(200, list_assignments())
            if path == "/api/makeup":
                user = self._require_login()
                return self._json(200, makeup_options((qs.get("day") or [None])[0], user))
            if path == "/api/my-workload":
                user = self._require_login()
                qs_days = (qs.get("days") or [None])[0]
                days_back = int(qs_days) if qs_days else None
                return self._json(200, my_workload(user, days_back))
            if path == "/api/attendance":
                user = self._require_login()
                return self._json(
                    200,
                    attendance_overview(
                        user,
                        month=(qs.get("month") or [None])[0],
                        week=(qs.get("week") or [None])[0],
                    ),
                )
            if path == "/api/work-calendar":
                self._require_login()
                return self._json(
                    200,
                    list_work_calendar(
                        day_from=(qs.get("from") or [None])[0],
                        day_to=(qs.get("to") or [None])[0],
                    ),
                )
            if path == "/api/hub":
                user = self._require_login()
                return self._json(200, hub_home(user))
            if path == "/api/hub/links":
                self._require_admin()
                return self._json(
                    200,
                    list_hub_links(
                        active_only=(qs.get("active_only") or ["false"])[0].lower()
                        == "true"
                    ),
                )

            return self._json(404, {"detail": "Not found"})
        except PermissionError as exc:
            return self._json(401, {"detail": str(exc)})
        except Exception as exc:  # noqa: BLE001
            return self._json(500, {"detail": str(exc)})

    def do_POST(self) -> None:  # noqa: N802
        path = self._route_path()
        if path is None:
            return self._json(404, {"detail": "Not found"})
        try:
            if path == "/api/login":
                body = self._read_json()
                user, token = login(body.get("username") or "", body.get("password") or "")
                return self._json(200, {"user": user}, set_cookie=token)

            if path == "/api/logout":
                logout(self._token_from_cookie())
                return self._json(200, {"ok": True}, clear_cookie=True)

            body = self._read_json()

            if path == "/api/change-password":
                user = self._require_login()
                return self._json(200, change_own_password(user, body))

            # 只读管理员：除改自己密码外，禁止一切写入
            self._deny_readonly_admin()

            if path == "/api/daily/clear":
                user = self._require_write_admin()
                return self._json(200, clear_daily(body, user))

            if path == "/api/daily":
                user = self._require_login()
                return self._json(200, upsert_daily(body, user))

            if path == "/api/attendance":
                user = self._require_login()
                if "items" in body:
                    return self._json(200, upsert_attendance_batch(body, user))
                return self._json(200, upsert_attendance(body, user))

            if path == "/api/work-calendar":
                self._require_write_admin()
                return self._json(200, upsert_work_calendar(body))
            if path == "/api/work-calendar/delete":
                self._require_write_admin()
                return self._json(200, delete_work_calendar(body.get("day") or ""))

            if path == "/api/hub/links":
                self._require_write_admin()
                return self._json(200, upsert_hub_link(body))
            if path == "/api/hub/links/delete":
                self._require_write_admin()
                return self._json(200, delete_hub_link(int(body["id"])))

            # 以下仅可写管理员
            self._require_write_admin()
            if path == "/api/interns":
                return self._json(200, create_intern(body))
            if path == "/api/interns/active":
                return self._json(200, set_intern_active(body))
            if path == "/api/interns/group":
                return self._json(200, set_intern_group(body))
            if path == "/api/interns/work-mode":
                return self._json(200, set_intern_work_mode(body))
            if path == "/api/projects":
                return self._json(200, create_project(body))
            if path == "/api/projects/update":
                return self._json(200, update_project(body))
            if path == "/api/projects/delete":
                return self._json(200, delete_project(int(body["project_id"])))
            if path == "/api/assignments":
                return self._json(200, upsert_assignment(body))
            if path == "/api/assignments/delete":
                return self._json(
                    200,
                    delete_assignment(int(body["intern_id"]), int(body["project_id"])),
                )
            if path == "/api/users":
                return self._json(200, set_user_account(body))
            if path == "/api/users/group-admin":
                return self._json(200, set_user_group_admin(body))
            if path == "/api/users/online-admin":
                return self._json(200, set_user_online_admin(body))
            if path == "/api/users/delete":
                actor = self._current_user()
                return self._json(200, delete_user(int(body["user_id"]), actor))
            if path == "/api/day-board":
                return self._json(200, upsert_day_board(body))

            return self._json(404, {"detail": "Not found"})
        except PermissionError as exc:
            return self._json(401, {"detail": str(exc)})
        except LookupError as exc:
            return self._json(404, {"detail": str(exc)})
        except ValueError as exc:
            return self._json(400, {"detail": str(exc)})
        except Exception as exc:  # noqa: BLE001
            return self._json(500, {"detail": str(exc)})

    def _index(self) -> None:
        html = (STATIC / "index.html").read_text(encoding="utf-8")
        if BASE_PATH:
            html = html.replace('href="/static/', f'href="{BASE_PATH}/static/')
            html = html.replace('src="/static/', f'src="{BASE_PATH}/static/')
            inject = f"<script>window.APP_BASE={json.dumps(BASE_PATH)};</script>\n  "
            html = html.replace("<script src=", inject + "<script src=", 1)
        data = html.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", MIME[".html"])
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-cache, must-revalidate")
        self.end_headers()
        self.wfile.write(data)

    def _file(self, path: Path) -> None:
        try:
            resolved = path.resolve()
            resolved.relative_to(STATIC.resolve())
        except ValueError:
            return self._json(404, {"detail": "Not found"})
        if not resolved.is_file():
            return self._json(404, {"detail": "Not found"})
        data = resolved.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", MIME.get(resolved.suffix, "application/octet-stream"))
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-cache, must-revalidate")
        self.end_headers()
        self.wfile.write(data)


def main() -> None:
    init_db()
    migrate_day_board()
    seed_if_empty()
    ensure_admin()
    public = f"http://127.0.0.1:{PORT}{BASE_PATH or ''}/"
    print(f"Annotation Intern Progress → {public}", flush=True)
    if BASE_PATH:
        print(f"BASE_PATH={BASE_PATH}", flush=True)
    print(f"默认管理员：{DEFAULT_ADMIN_USER} / {DEFAULT_ADMIN_PASS}", flush=True)
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()

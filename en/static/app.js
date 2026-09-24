const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];

let me = null;
let state = null;
let interns = [];
let projects = [];
let allProjects = [];
let daily = null;
let users = [];
let board = null; // 任务分配面板数据
let dayViewBoard = null; // 日期面板数据（可与任务分配不同日）
let myTodayState = null; // 管理员兼做任务时，今日登记用今天的数据
let myTodayDaily = null;
let workload = null;
let dayViewDay = null; // 日期面板当前日期
let boardDay = null; // 任务分配当前日期（可提前排明天）

/** 与后端一致：Asia/Shanghai，凌晨 3 点前仍算前一天 */
const TASK_DAY_CUTOFF_HOUR = 3;
const todayISO = () => {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(new Date())
      .filter((p) => p.type !== "literal")
      .map((p) => [p.type, p.value])
  );
  let y = Number(parts.year);
  let m = Number(parts.month);
  let d = Number(parts.day);
  let h = Number(parts.hour);
  if (h < TASK_DAY_CUTOFF_HOUR) {
    const dt = new Date(Date.UTC(y, m - 1, d));
    dt.setUTCDate(dt.getUTCDate() - 1);
    y = dt.getUTCFullYear();
    m = dt.getUTCMonth() + 1;
    d = dt.getUTCDate();
  }
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
};
const addDaysISO = (iso, days) => {
  const d = new Date(`${iso}T12:00:00`);
  d.setDate(d.getDate() + days);
  return d.toLocaleDateString("en-CA");
};
const tomorrowISO = () => addDaysISO(todayISO(), 1);
const yesterdayISO = () => addDaysISO(todayISO(), -1);
const dayRelLabel = (iso) => {
  const t = todayISO();
  if (iso === t) return "Today";
  if (iso === addDaysISO(t, 1)) return "Tomorrow";
  if (iso === addDaysISO(t, -1)) return "Yesterday";
  return iso;
};
const WEEKDAY_CN = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const dayFullLabel = (iso) => {
  const d = new Date(`${iso}T12:00:00`);
  const wd = WEEKDAY_CN[d.getDay()];
  const rel = dayRelLabel(iso);
  return rel === iso ? `${iso} (${wd})` : `${rel} · ${iso} (${wd})`;
};
const STATUS_LABELS = {
  present: "Present",
  leave_half: "Half day",
  leave: "Leave",
  unset: "Unset",
};
const STATUS_ORDER = ["present", "leave_half", "leave"];
const STATUS_CYCLE = ["present", "leave_half", "leave"];
const ATT_STATUS_OPTIONS = [
  ["unset", "Unset"],
  ["present", "Present"],
  ["leave_half", "Half day"],
  ["leave", "Leave"],
];
function statusSelectHtml(status, { className = "att-select", disabled = false, attrs = "" } = {}) {
  const st = STATUS_LABELS[status] ? status : "unset";
  // 「未填」仅作初始占位；已选Present/半天/请假后不可再选回未填
  const opts =
    st === "unset"
      ? ATT_STATUS_OPTIONS
      : ATT_STATUS_OPTIONS.filter(([v]) => v !== "unset");
  return `<select class="${className} ${st}" ${disabled ? "disabled" : ""} ${attrs}>
    ${opts
      .map(
        ([v, label]) =>
          `<option value="${v}" ${st === v ? "selected" : ""}>${label}</option>`
      )
      .join("")}
  </select>`;
}
function statusChipHtml(status) {
  const st = STATUS_LABELS[status] ? status : "unset";
  const cls =
    st === "present"
      ? "ok"
      : st === "leave_half"
        ? "half"
        : st === "leave"
          ? "leave"
          : "muted";
  return `<span class="wl-chip att-status-chip ${cls}">${STATUS_LABELS[st] || "Unset"}</span>`;
}
let assignmentsList = [];
let attendance = null;
let attendanceWeek = null; // Present页当前周（周一）
let attendanceMonth = null; // YYYY-MM
let attendanceView = "week"; // week | month | workcal
let workCalendarList = null; // 调休/特殊日独立列表
let hub = null;
let hubLinksAll = []; // 管理员编辑用
const e = (v) =>
  String(v ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
/** 两字姓名中间加全角空格，与三字名视觉对齐 */
const displayName = (name) => {
  const chars = [...String(name ?? "").trim()];
  if (chars.length === 2) return `${chars[0]}\u3000${chars[1]}`;
  return chars.join("");
};
const isAdmin = () => me?.role === "admin";
/** 其他管理员只读；可写管理员由服务端 WRITE_ADMIN_* 配置 */
const isReadonlyAdmin = () => isAdmin() && Boolean(me?.readonly);
const isWriteAdmin = () => isAdmin() && !isReadonlyAdmin();
const isGroupAdmin = () =>
  me?.role === "intern" && Boolean(Number(me?.group_admin || 0));
const isOnlineAdmin = () =>
  me?.role === "intern" && Boolean(Number(me?.online_admin || 0));
const isScopeAdmin = () => isGroupAdmin() || isOnlineAdmin();
const canViewDayBoard = () => isAdmin() || isScopeAdmin();
const hasInternWork = () => Boolean(me?.intern_id);
const projectUnit = (p) => (p?.unit === "items" ? "items" : "clips");
/** 管理员在项目管理里勾选的「已结项」，与累计完成量无关 */
const isProjectMarkedComplete = (p) =>
  p?.marked_complete === true || Number(p?.completed) === 1;
function projectSealHtml() {
  return `<div class="proj-seal" aria-label="Completed"><span>Completed</span></div>`;
}
const normalizeTeamGroup = (g) => {
  const v = String(g || "").trim().toUpperCase();
  return v === "A" || v === "B" ? v : "";
};
const teamGroupLabel = (g) => {
  const v = normalizeTeamGroup(g);
  if (v === "A") return "Team A";
  if (v === "B") return "Team B";
  return "Unassigned";
};
const teamGroupSortKey = (g) => {
  const v = normalizeTeamGroup(g);
  if (v === "A") return 0;
  if (v === "B") return 1;
  return 2;
};
const teamGroupBadge = (g) => {
  const v = normalizeTeamGroup(g);
  if (!v) return `<span class="team-badge none" title="Unassigned">—</span>`;
  return `<span class="team-badge team-${v.toLowerCase()}" title="Team ${v}">${v}</span>`;
};
const normalizeWorkMode = (m) => {
  const v = String(m || "").trim().toLowerCase();
  if (v === "onsite" || v === "onsite" || v === "onsite") return "onsite";
  if (v === "remote" || v === "online" || v === "online" || v === "remote") return "remote";
  return "";
};
const workModeSortKey = (m) => (normalizeWorkMode(m) === "onsite" ? 0 : 1);
const workModeBadge = (m) => {
  if (normalizeWorkMode(m) === "onsite") {
    return `<span class="work-mode-badge onsite" title="Onsite">onsite</span>`;
  }
  return `<span class="work-mode-badge online" title="Online">online</span>`;
};
const nameMetaBadges = (row) => {
  const team = teamGroupBadge(row?.team_group);
  // 管理员兼岗不计Present，也不显示 online/onsite
  if (row?.skip_attendance) return team;
  return `${team}${workModeBadge(row?.work_mode)}`;
};
const platformLinkHtml = (url, { compact = false, label } = {}) => {
  const href = String(url || "").trim();
  if (!/^https?:\/\//i.test(href)) return "";
  const text = label || (compact ? "Annotate" : "Open platform");
  return `<a class="platform-link${compact ? " compact" : ""}" href="${e(
    href
  )}" target="_blank" rel="noopener noreferrer">${e(text)}</a>`;
};
const docLinkHtml = (url, { compact = false, label } = {}) => {
  const href = String(url || "").trim();
  if (!/^https?:\/\//i.test(href)) return "";
  const text = label || (compact ? "guidelines" : "Guidelines");
  return `<a class="doc-link${compact ? " compact" : ""}" href="${e(
    href
  )}" target="_blank" rel="noopener noreferrer">${e(text)}</a>`;
};
const qcLinkHtml = (url, { compact = false, label } = {}) => {
  const href = String(url || "").trim();
  if (!/^https?:\/\//i.test(href)) return "";
  const text = label || (compact ? "QC" : "QC results");
  return `<a class="qc-link${compact ? " compact" : ""}" href="${e(
    href
  )}" target="_blank" rel="noopener noreferrer">${e(text)}</a>`;
};
const taskResourceLinksHtml = (
  item,
  { compact = false, docLabel, qcLabel, platformLabel } = {}
) => {
  const doc = docLinkHtml(item?.doc_url, { compact, label: docLabel });
  const qc = qcLinkHtml(item?.qc_url, { compact, label: qcLabel });
  const platform = platformLinkHtml(item?.platform_url, {
    compact,
    label: platformLabel,
  });
  if (!doc && !qc && !platform) return "";
  return `<div class="task-resource-links">${doc}${qc}${platform}</div>`;
};
const tagClass = (projectId, projectName = "") => {
  if (projectId == null) return "empty";
  const name = String(projectName || "");
  // 同黄橙系里用深浅拉开：质检最深、Check 最浅
  if (name.includes("QC")) return "c2";
  if (/TTS|音素/i.test(name)) return "c1";
  if (/产品测试|产测/i.test(name)) return "c5";
  if (/Check|抽检|Speech/i.test(name)) return "c0";
  return `c${Math.abs(Number(projectId)) % 8}`;
};

function showFeedback(feedback) {
  if (!feedback) return;
  let toast = $("#feedbackToast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "feedbackToast";
    toast.className = "feedback-toast";
    document.body.appendChild(toast);
  }
  toast.textContent = feedback.message || "Saved";
  toast.classList.remove("celebrate", "encourage", "overachieved", "show");
  if (feedback.celebrate) toast.classList.add("celebrate");
  if (feedback.overachieved) toast.classList.add("overachieved");
  if (feedback.encourage) toast.classList.add("encourage");
  requestAnimationFrame(() => toast.classList.add("show"));
  clearTimeout(showFeedback._t);
  showFeedback._t = setTimeout(() => toast.classList.remove("show"), 4200);
  if (feedback.overachieved) burstApplause();
  else if (feedback.celebrate) burstConfetti(feedback.all_met ? 90 : 55);
  else if (feedback.encourage) burstEncourage();
}

function burstEmojiRain(emojis, className, count = 14, clearMs = 3200) {
  let layer = $("#applause-layer");
  if (!layer) {
    layer = document.createElement("div");
    layer.id = "applause-layer";
    document.body.appendChild(layer);
  }
  layer.innerHTML = "";
  for (let i = 0; i < count; i++) {
    const span = document.createElement("span");
    span.className = className;
    span.textContent = emojis[i % emojis.length];
    span.style.left = `${10 + Math.random() * 80}%`;
    span.style.animationDelay = `${Math.random() * 0.4}s`;
    span.style.fontSize = `${1.35 + Math.random() * 1.35}rem`;
    layer.appendChild(span);
  }
  clearTimeout(burstEmojiRain._t);
  burstEmojiRain._t = setTimeout(() => {
    layer.innerHTML = "";
  }, clearMs);
}

function burstApplause() {
  burstEmojiRain(["👏", "🙌", "✨", "💪", "👏"], "applause-emoji", 14, 3200);
}

function burstEncourage() {
  burstEmojiRain(["💪"], "encourage-emoji", 16, 3400);
}

function burstConfetti(count = 60) {
  let canvas = $("#confetti-canvas");
  if (!canvas) {
    canvas = document.createElement("canvas");
    canvas.id = "confetti-canvas";
    document.body.appendChild(canvas);
  }
  const ctx = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  const w = window.innerWidth;
  const h = window.innerHeight;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  canvas.style.width = w + "px";
  canvas.style.height = h + "px";
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const colors = ["#2563eb", "#3b82f6", "#60a5fa", "#93c5fd", "#bfdbfe", "#1d4ed8"];
  const parts = Array.from({ length: count }, () => ({
    x: w * 0.5 + (Math.random() - 0.5) * w * 0.35,
    y: h * 0.35 + Math.random() * 40,
    vx: (Math.random() - 0.5) * 10,
    vy: -Math.random() * 10 - 4,
    g: 0.18 + Math.random() * 0.12,
    s: 4 + Math.random() * 6,
    r: Math.random() * Math.PI,
    vr: (Math.random() - 0.5) * 0.3,
    color: colors[Math.floor(Math.random() * colors.length)],
    life: 190 + Math.random() * 30,
  }));
  let frame = 0;
  function tick() {
    frame += 1;
    ctx.clearRect(0, 0, w, h);
    let alive = false;
    for (const p of parts) {
      p.life -= 1;
      if (p.life <= 0) continue;
      alive = true;
      p.vy += p.g;
      p.x += p.vx;
      p.y += p.vy;
      p.r += p.vr;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.r);
      ctx.globalAlpha = Math.max(0, p.life / 200);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.s / 2, -p.s / 2, p.s, p.s * 0.6);
      ctx.restore();
    }
    if (alive && frame < 240) requestAnimationFrame(tick);
    else ctx.clearRect(0, 0, w, h);
  }
  requestAnimationFrame(tick);
}



const APP_BASE = typeof window !== "undefined" && window.APP_BASE ? window.APP_BASE : "";

async function api(path, options = {}) {
  const res = await fetch(APP_BASE + path, {
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const body = await res.json().catch(() => ({}));
  if (res.status === 401) {
    showLogin(body.detail || "Please sign in");
    throw new Error(body.detail || "Please sign in");
  }
  if (!res.ok) throw new Error(body.detail || res.statusText);
  return body;
}

function showLogin(err = "") {
  me = null;
  $("#loginView").classList.remove("hidden");
  $("#appView").classList.add("hidden");
  $("#loginErr").textContent = err || "";
}

function activateTab(name) {
  if (
    isReadonlyAdmin() &&
    (name === "board" || name === "projmgmt")
  ) {
    name = "dayview";
  }
  $$(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
  $$(".panel").forEach((p) => p.classList.toggle("active", p.id === `panel-${name}`));
}

function syncTabOrder() {
  const nav = document.querySelector(".tabs");
  const proj = document.querySelector('.tab[data-tab="projects"]');
  const attendance = document.querySelector('.tab[data-tab="attendance"]');
  if (!nav || !proj) return;
  if (isAdmin()) {
    // 管理员：工作台 → Present → 日期面板 → 任务分配 → …
    const hub = document.querySelector('.tab[data-tab="hub"]');
    const dayview = document.querySelector('.tab[data-tab="dayview"]');
    const board = document.querySelector('.tab[data-tab="board"]');
    const today = document.querySelector('.tab[data-tab="today"]');
    const mgmt = document.querySelector('.tab[data-tab="projmgmt"]');
    const afterHub = hub?.nextSibling || null;
    if (attendance) nav.insertBefore(attendance, afterHub);
    if (dayview) nav.insertBefore(dayview, attendance?.nextSibling || afterHub);
    if (board) nav.insertBefore(board, dayview?.nextSibling || attendance?.nextSibling || afterHub);
    nav.insertBefore(proj, today || mgmt || null);
  } else if (isScopeAdmin()) {
    // 组内/线上管理：Present、任务完成紧跟工作台
    const dayview = document.querySelector('.tab[data-tab="dayview"]');
    const today = document.querySelector('.tab[data-tab="today"]');
    if (attendance) nav.insertBefore(attendance, today || proj);
    if (dayview) nav.insertBefore(dayview, today || proj);
    const workload = document.querySelector('.tab[data-tab="workload"]');
    nav.insertBefore(proj, workload || null);
  } else {
    // 组员：项目总量在我的进度后面
    const workload = document.querySelector('.tab[data-tab="workload"]');
    nav.insertBefore(proj, workload || null);
  }
}

function showApp() {
  $("#loginView").classList.add("hidden");
  $("#appView").classList.remove("hidden");
  const roleTxt = isAdmin()
    ? isReadonlyAdmin()
      ? "Admin · read-only"
      : hasInternWork()
        ? "Admin · can submit"
        : "Admin"
    : isOnlineAdmin()
      ? "Annotator · online lead"
      : isGroupAdmin()
        ? "Annotator · group lead"
        : "Annotator";
  $("#whoLabel").textContent = `${me.display_name}（${roleTxt}）`;
  $$(".admin-only").forEach((el) => {
    if (el.classList.contains("group-admin-ok")) {
      el.style.display = canViewDayBoard() ? "" : "none";
    } else {
      el.style.display = isAdmin() ? "" : "none";
    }
  });
  $$(".intern-only").forEach((el) => {
    el.style.display = hasInternWork() ? "" : "none";
  });
  // 只读管理员：不显示任务分配、项目管理（用日期面板查看即可）
  const boardTab = document.querySelector('.tab[data-tab="board"]');
  const projmgmtTab = document.querySelector('.tab[data-tab="projmgmt"]');
  if (boardTab) boardTab.style.display = isWriteAdmin() ? "" : "none";
  if (projmgmtTab) projmgmtTab.style.display = isWriteAdmin() ? "" : "none";
  if (!isWriteAdmin()) {
    const bp = $("#panel-board");
    const pp = $("#panel-projmgmt");
    if (bp) bp.innerHTML = "";
    if (pp) pp.innerHTML = "";
  }
  // 管理员面板不显示「工作记录」
  const workloadTab = document.querySelector('.tab[data-tab="workload"]');
  if (isAdmin() && workloadTab) workloadTab.style.display = "none";
  const projTab = document.querySelector('.tab[data-tab="projects"]');
  if (projTab) projTab.textContent = "ProjectTarget";
  const dayviewTab = document.querySelector('.tab[data-tab="dayview"]');
  if (dayviewTab && isScopeAdmin() && !isAdmin()) {
    dayviewTab.textContent = "TasksDone";
  } else if (dayviewTab) {
    dayviewTab.textContent = "Day board";
  }
  syncTabOrder();
  activateTab("hub");
  if (canViewDayBoard()) {
    const t = todayISO();
    if (!dayViewDay) dayViewDay = t;
  }
  if (isWriteAdmin()) {
    const t = todayISO();
    if (!boardDay) boardDay = t;
  }
}

async function boot() {
  try {
    const { user } = await api("/api/me");
    if (!user) return showLogin();
    me = user;
    showApp();
    await loadAll();
  } catch {
    showLogin();
  }
}

async function loadAll() {
  const t = todayISO();
  if (canViewDayBoard()) {
    dayViewDay = dayViewDay || t;
  }
  if (isWriteAdmin()) {
    boardDay = boardDay || t;
  }
  const day = canViewDayBoard() ? dayViewDay : t;
  attendanceMonth = attendanceMonth || t.slice(0, 7);

  const attQs = new URLSearchParams();
  attQs.set("month", attendanceMonth);
  if (attendanceWeek) attQs.set("week", attendanceWeek);

  const tasks = [
    api(`/api/dashboard?day=${encodeURIComponent(t)}`),
    api(`/api/daily?day=${encodeURIComponent(t)}`),
    api("/api/projects?active_only=true"),
    api(`/api/attendance?${attQs.toString()}`),
    api("/api/hub"),
  ];
  if (isAdmin()) {
    tasks.push(api("/api/interns?active_only=false"));
    tasks.push(api("/api/users"));
    tasks.push(api(`/api/day-board?day=${encodeURIComponent(dayViewDay)}`));
    if (isWriteAdmin() && boardDay !== dayViewDay) {
      tasks.push(api(`/api/day-board?day=${encodeURIComponent(boardDay)}`));
    }
    if (isWriteAdmin()) {
      tasks.push(api("/api/assignments"));
      tasks.push(api("/api/projects?active_only=false"));
      tasks.push(api("/api/hub/links"));
    }
    if (hasInternWork()) {
      tasks.push(api("/api/my-workload"));
      if (dayViewDay !== t) {
        tasks.push(api(`/api/dashboard?day=${encodeURIComponent(t)}`));
        tasks.push(api(`/api/daily?day=${encodeURIComponent(t)}`));
      }
    }
  } else if (isScopeAdmin()) {
    tasks.push(api(`/api/day-board?day=${encodeURIComponent(dayViewDay || t)}`));
    if (me?.intern_id) tasks.push(api("/api/my-workload"));
  } else if (me?.intern_id) {
    tasks.push(api("/api/my-workload"));
  }

  const results = await Promise.all(tasks);
  state = results[0];
  daily = results[1];
  projects = results[2];
  attendance = results[3];
  hub = results[4];
  if (attendance?.week_start) attendanceWeek = attendance.week_start;
  if (attendance?.month) attendanceMonth = attendance.month;
  let idx = 5;
  if (isAdmin()) {
    interns = results[idx++];
    users = results[idx++];
    dayViewBoard = results[idx++];
    if (isWriteAdmin() && boardDay !== dayViewDay) {
      board = results[idx++];
    } else {
      board = isWriteAdmin() ? dayViewBoard : null;
    }
    if (isWriteAdmin()) {
      assignmentsList = results[idx++];
      allProjects = results[idx++] || [];
      hubLinksAll = results[idx++] || [];
    } else {
      assignmentsList = [];
      allProjects = [];
      hubLinksAll = [];
    }
    if (hasInternWork()) {
      workload = results[idx++];
      if (dayViewDay !== t) {
        myTodayState = results[idx++];
        myTodayDaily = results[idx++];
      } else {
        myTodayState = state;
        myTodayDaily = daily;
      }
    } else {
      workload = null;
      myTodayState = null;
      myTodayDaily = null;
    }
    if (dayViewBoard?.day) dayViewDay = dayViewBoard.day;
    if (board?.day) boardDay = board.day;
  } else if (isScopeAdmin()) {
    dayViewBoard = results[idx++];
    board = null;
    interns = state.people || [];
    users = [];
    assignmentsList = [];
    allProjects = [];
    hubLinksAll = [];
    workload = me?.intern_id ? results[idx++] : null;
    myTodayState = state;
    myTodayDaily = daily;
    if (dayViewBoard?.day) dayViewDay = dayViewBoard.day;
  } else {
    interns = state.people || [];
    users = [];
    board = null;
    dayViewBoard = null;
    assignmentsList = [];
    allProjects = [];
    hubLinksAll = [];
    workload = me?.intern_id ? results[idx] : null;
    myTodayState = state;
    myTodayDaily = daily;
  }
  render();
  if (isAdmin()) fillManageSelects();
}

function todayDone(internId, projectId) {
  const src = hasInternWork() && isAdmin() ? myTodayDaily : daily;
  const row = (src?.records || []).find(
    (r) => r.intern_id === internId && r.project_id === projectId
  );
  return row ? row.done : null;
}

function render() {
  snapshotTodayDrafts();
  renderHub();
  if (canViewDayBoard()) {
    renderDayView();
  } else {
    const dayview = $("#panel-dayview");
    if (dayview) dayview.innerHTML = "";
  }
  if (isAdmin()) {
    if (isWriteAdmin()) renderBoard();
  } else {
    const boardPanel = $("#panel-board");
    if (boardPanel) boardPanel.innerHTML = "";
  }
  renderAttendance();
  renderToday();
  renderMine();
  renderWorkload();
  renderProjects();
  if (isWriteAdmin()) renderProjMgmt();
  else {
    const pp = $("#panel-projmgmt");
    if (pp) pp.innerHTML = "";
  }
}

function goTab(name) {
  const tab = document.querySelector(`.tab[data-tab="${name}"]`);
  if (tab && tab.style.display === "none") return;
  activateTab(name);
}

function hubLinkHref(url) {
  const u = String(url || "").trim();
  if (u.startsWith("#")) return u;
  return u;
}

function renderHub() {
  const el = $("#panel-hub");
  if (!el) return;
  if (!hub) {
    el.innerHTML = `<div class="empty">Loading home…</div>`;
    return;
  }
  const day = hub.day || todayISO();
  const info = hub.me || {};
  const att = hub.attendance_today || "unset";
  const tasks = hub.today_tasks || [];
  const summary = hub.admin_summary;
  const pending = tasks.filter((t) => !t.submitted).length;
  const checkins = hub.week_checkins || [];
  const skipAtt = Boolean(info.skip_attendance);
  const checkedIn =
    skipAtt || att === "present" || att === "leave_half" || att === "leave";
  const allClear = tasks.length > 0 && pending === 0;
  const greetingName = displayName(info.intern_name || me?.display_name || "teammate");
  const groupTag = info.team_group ? teamGroupBadge(info.team_group) : "";
  const workTag =
    info.intern_id && !skipAtt ? workModeBadge(info.work_mode) : "";

  const isRestDay = !(hub.week_days || []).includes(day);
  const onLeave = att === "leave";
  const shortOfQuota = tasks.some(
    (t) => t.submitted && Number(t.quota || 0) > 0 && !t.met
  );
  let cheer = "AllDone，Nice work。";
  if (!skipAtt && (onLeave || isRestDay)) {
    cheer = "Have a good day off.";
  } else if (pending > 0) {
    cheer = "Tasks not submitted yet — keep going to hit today’s quota.";
  } else if (shortOfQuota) {
    cheer = "Keep going，Almost at quota。";
  } else if (isAdmin() && !tasks.length) {
    cheer = "Check the team’s attendance and assignments today.";
  }

  const weekStamp = `
    <div class="hub-week" aria-label="This week’s attendance">
      ${(checkins.length
        ? checkins
        : (hub.week_days || []).map((d) => ({
            day: d,
            label: WEEKDAY_CN[new Date(`${d}T12:00:00`).getDay()] || "",
            status: "unset",
            is_today: d === day,
          }))
      )
        .map((c) => {
          const st = c.status || "unset";
          const cls =
            st === "present"
              ? "on"
              : st === "leave_half"
                ? "half"
                : st === "leave"
                  ? "off"
                  : "empty";
          return `<div class="hub-stamp ${cls}${c.is_today ? " today" : ""}" title="${e(
            c.day
          )} ${STATUS_LABELS[st] || "未填"}">
            <span>${e(c.label)}</span>
            <em>${
              st === "present"
                ? "Present"
                : st === "leave_half"
                  ? "Half"
                  : st === "leave"
                    ? "Leave"
                    : ""
            }</em>
          </div>`;
        })
        .join("")}
    </div>`;

  const taskCards = tasks.length
    ? `<section class="hub-section hub-today-card">
        <header class="hub-section-head">
          <h3>Today’s tasks</h3>
        </header>
        <div class="hub-task-stack">${tasks
          .map((t) => {
            const unit = t.unit === "items" ? "items" : "clips";
            const quota = Number(t.quota || 0);
            const done = t.submitted ? Number(t.done_today || 0) : 0;
            const platform = platformLinkHtml(t.platform_url, {
              label: "Start annotating",
            });
            const doc = docLinkHtml(t.doc_url, { label: "Viewguidelines" });
            const qc = qcLinkHtml(t.qc_url, { label: "QC results" });
            const links =
              platform || doc || qc
                ? `<div class="task-resource-links">${doc}${qc}${platform}</div>`
                : `<div class="task-resource-links hub-task-links-empty"></div>`;
            const quotaHtml =
              quota > 0
                ? `<span class="quota-chip ${
                    t.submitted && t.met ? "met" : ""
                  }">今日 ${t.submitted ? fmtNum(done) : "—"}/${fmtNum(
                    quota
                  )} ${unit}</span>`
                : t.submitted
                  ? `<span class="quota-chip">已交 ${fmtNum(done)}${unit}</span>`
                  : `<span class="meta">未设今日配额</span>`;
            const action = t.submitted
              ? `<span class="wl-chip ok">已提交</span>`
              : `<button type="button" class="btn sm hub-go-today">提交</button>`;
            return `
            <article class="hub-task-item ${t.submitted ? "is-done" : ""}">
              <div class="hub-task-top">
                <span class="proj-tag ${tagClass(
                  t.project_id,
                  t.project_name
                )}">${e(t.project_name)}</span>
              </div>
              ${
                t.task_label
                  ? `<p class="hub-task-note">${e(t.task_label)}</p>`
                  : ""
              }
              <div class="hub-task-actions">
                ${links}
                <div class="hub-task-end">
                  ${quotaHtml}
                  ${action}
                </div>
              </div>
            </article>`;
          })
          .join("")}</div>
      </section>`
    : `<section class="hub-section hub-today-card">
        <header class="hub-section-head">
          <h3>Today’s tasks</h3>
        </header>
        <p class="meta hub-today-empty">No tasks assigned yet — they appear here after an admin assigns them.</p>
      </section>`;

  const fmtUnitTotal = (items) => {
    const list = (items || []).filter((x) => Number(x.amount || 0) > 0);
    if (!list.length) return "0 clips";
    return list
      .map((x) => `${fmtNum(x.amount)} ${x.unit === "items" ? "items" : "clips"}`)
      .join(" · ");
  };
  const adminProjects = summary?.projects || [];
  const adminCompareRows = adminProjects.length
    ? adminProjects
        .map((p) => {
          const unit = p.unit === "items" ? "items" : "clips";
          return `<li>
            <span class="hub-admin-proj-name">${e(p.project_name)}</span>
            <span class="hub-admin-proj-amt is-assign">${fmtNum(p.assigned || 0)} ${unit}</span>
            <span class="hub-admin-proj-amt is-submit">${fmtNum(p.submitted || 0)} ${unit}</span>
          </li>`;
        })
        .join("")
    : `<li class="hub-admin-proj-empty"><span>No tasks assigned today</span></li>`;
  const assignedTotalTxt = fmtUnitTotal(summary?.assigned_total);
  const submittedTotalTxt = fmtUnitTotal(summary?.submitted_total);
  const taskPeople = summary?.task_people || {};
  const taskPeopleBlock = `
    <div class="hub-admin-people-line" aria-label="People with tasks today">
      <span class="hub-admin-people-title">People</span>
      <span class="hub-admin-people-item is-done">已Done <strong>${taskPeople.done || 0}</strong></span>
      <span class="hub-admin-people-item is-incomplete">Incomplete <strong>${taskPeople.incomplete || 0}</strong></span>
      <span class="hub-admin-people-item is-miss">Not submitted <strong>${taskPeople.unsubmitted || 0}</strong></span>
    </div>`;
  const groupCounts = summary?.group_counts || {};
  const attTotal = summary?.counts || {};
  const adminGroupAtt = ["A", "B"]
    .map((g) => {
      const c = groupCounts[g] || {};
      return `
        <div class="hub-admin-group">
          <div class="hub-admin-group-label">Team ${g}</div>
          <div class="hub-admin-grid hub-admin-grid-3">
            <div class="hub-admin-stat present">
              <strong>${c.present || 0}</strong>
              <span>Present</span>
            </div>
            <div class="hub-admin-stat half">
              <strong>${c.leave_half || 0}</strong>
              <span>Half day</span>
            </div>
            <div class="hub-admin-stat leave">
              <strong>${c.leave || 0}</strong>
              <span>Leave</span>
            </div>
          </div>
        </div>`;
    })
    .join("");
  const attTotalBlock = `
    <div class="hub-admin-people-line" aria-label="todayPresentTotal">
      <span class="hub-admin-people-title">Total</span>
      <span class="hub-admin-people-item is-done">Present <strong>${attTotal.present || 0}</strong></span>
      <span class="hub-admin-people-item is-incomplete">Half day <strong>${attTotal.leave_half || 0}</strong></span>
      <span class="hub-admin-people-item is-miss">Leave <strong>${attTotal.leave || 0}</strong></span>
    </div>`;
  const adminBlock =
    isAdmin() && summary
      ? `
    <section class="hub-section hub-admin">
      <header class="hub-section-head hub-admin-head">
        <div>
          <h3>Today’s management</h3>
          <p class="meta">${e(dayFullLabel(day))}</p>
        </div>
        <div class="hub-admin-headcount" title="Active annotators (excluding admins)">
          <span>目前在职</span>
          <strong>${summary.active_interns || 0}</strong>
          <em>People</em>
          <span class="hub-admin-headcount-split">Team A <strong>${summary.active_by_group?.A || 0}</strong></span>
          <span class="hub-admin-headcount-split">Team B <strong>${summary.active_by_group?.B || 0}</strong></span>
        </div>
      </header>
      <div class="hub-admin-att-panel">
        <div class="hub-admin-att-head">
          <span class="hub-admin-compare-label">Present</span>
        </div>
        <div class="hub-admin-att">
          ${adminGroupAtt}
        </div>
        ${attTotalBlock}
      </div>
      <div class="hub-admin-compare">
        <div class="hub-admin-compare-head">
          <span class="hub-admin-compare-label">Tasks</span>
          <span class="hub-admin-compare-col">Assigned<br><strong>${assignedTotalTxt}</strong></span>
          <span class="hub-admin-compare-col is-submit">Submitted<br><strong>${submittedTotalTxt}</strong></span>
        </div>
        <ul class="hub-admin-proj-list hub-admin-compare-list">${adminCompareRows}</ul>
        ${taskPeopleBlock}
      </div>
    </section>`
      : "";

  const attCls = skipAtt
    ? "skip"
    : att === "present"
      ? "present"
      : att === "leave_half"
        ? "half"
        : att === "leave"
          ? "leave"
          : "unset";
  const attText = skipAtt
    ? isAdmin()
      ? "Admin"
      : "Dual role · not counted"
    : STATUS_LABELS[att] || "Unset";

  el.innerHTML = `
    <div class="hub-page is-game">
      <section class="hub-hero hub-checkin ${allClear ? "cleared" : ""}">
        <div class="hub-hero-copy">
          <h2>
            Hi, ${e(greetingName)}
            ${groupTag}${workTag}
          </h2>
          <p class="hub-cheer">${e(cheer)}</p>
        </div>
        <div class="hub-hero-aside">
          <div class="hub-hero-meta">
            <span class="hub-hero-date">${e(dayFullLabel(day))}</span>
            <span class="hub-att-status ${attCls}" title="todayPresentStatus（仅展示）">${e(attText)}</span>
          </div>
        </div>
      </section>

      ${
        skipAtt
          ? ""
          : `
      <section class="hub-section hub-week-card">
        <header class="hub-section-head">
          <h3>本周Present</h3>
          <button type="button" class="btn ghost sm hub-go" data-tab="attendance">${
            isReadonlyAdmin() ? "View" : "Edit"
          }</button>
        </header>
        ${weekStamp}
      </section>`
      }

      ${adminBlock}

      ${
        isAdmin()
          ? ""
          : taskCards
      }
    </div>
  `;

  el.querySelectorAll(".hub-go").forEach((btn) => {
    btn.addEventListener("click", () => goTab(btn.dataset.tab));
  });
  el.querySelectorAll(".hub-go-today").forEach((btn) => {
    btn.addEventListener("click", () => goTab("today"));
  });
}

function renderDayView() {
  const el = $("#panel-dayview");
  if (!el || !dayViewBoard) return;
  const day = dayViewBoard.day || dayViewDay || todayISO();
  const c = dayViewBoard.counts || {};

  const myIid = Number(me?.intern_id || 0);
  const sorted = (dayViewBoard.rows || []).slice().sort((a, b) => {
    const aLeft = Number(a.active) === 0 || a.status === "left";
    const bLeft = Number(b.active) === 0 || b.status === "left";
    if (aLeft !== bLeft) return aLeft ? 1 : -1; // 离职靠后
    const aTasks = (a.day_projects || []).filter((p) => p && p.project_id);
    const bTasks = (b.day_projects || []).filter((p) => p && p.project_id);
    const aKey =
      a.status === "leave" && !aTasks.length
        ? "\ufffeLeave"
        : aLeft
          ? "\ufffdLeft"
          : aTasks.length
            ? aTasks.map((t) => t.project_name || "").sort().join(" · ")
            : "\uffffUnassigned";
    const bKey =
      b.status === "leave" && !bTasks.length
        ? "\ufffeLeave"
        : bLeft
          ? "\ufffdLeft"
          : bTasks.length
            ? bTasks.map((t) => t.project_name || "").sort().join(" · ")
            : "\uffffUnassigned";
    if (aKey !== bKey) return aKey.localeCompare(bKey, "en");
    // 同一任务下：本人最前 → 同组聚一起 → onsite 优先 → 姓名
    const aMe = myIid && Number(a.intern_id) === myIid;
    const bMe = myIid && Number(b.intern_id) === myIid;
    if (aMe !== bMe) return aMe ? -1 : 1;
    const ga = teamGroupSortKey(a.team_group);
    const gb = teamGroupSortKey(b.team_group);
    if (ga !== gb) return ga - gb;
    const wa = workModeSortKey(a.work_mode);
    const wb = workModeSortKey(b.work_mode);
    if (wa !== wb) return wa - wb;
    return String(a.intern_name || "").localeCompare(
      String(b.intern_name || ""),
      "zh-CN"
    );
  });

  const groupLabel = (r) => {
    const left = Number(r.active) === 0 || r.status === "left";
    const tasks = (r.day_projects || []).filter((p) => p && p.project_id);
    if (left) return "Left";
    if (r.status === "leave" && !tasks.length) return "Leave";
    if (!tasks.length) return "Not assigned";
    return tasks
      .map((t) => t.project_name)
      .filter(Boolean)
      .sort((x, y) => String(x).localeCompare(String(y), "en"))
      .join(" · ");
  };

  let lastGroup = null;
  const rows = sorted
    .map((r) => {
      const left = Number(r.active) === 0 || r.status === "left";
      const tasks = (r.day_projects || []).filter((p) => p && p.project_id);
      const isSubmitted = (t) =>
        t.submitted === true || (t.done_today != null && t.done_today !== "");
      const taskMet = (t) => {
        if (!isSubmitted(t)) return false;
        const q = Number(t.quota || 0);
        if (q <= 0) return true; // 已交且未设配额，算完成
        return Number(t.done_today || 0) + 1e-9 >= q;
      };
      const allDone = !left && tasks.length > 0 && tasks.every(taskMet);
      const incomplete =
        !left &&
        tasks.some(
          (t) =>
            isSubmitted(t) &&
            Number(t.quota || 0) > 0 &&
            Number(t.done_today || 0) + 1e-9 < Number(t.quota || 0)
        );
      const statusLabel = left
        ? "Left"
        : r.skip_attendance
          ? "Dual role"
          : r.status === "present"
            ? "Present"
            : r.status === "leave_half"
              ? "Half day"
              : r.status === "leave"
                ? "Leave"
                : "Unset";
      const canTone =
        !left &&
        (r.skip_attendance ||
          r.status === "present" ||
          r.status === "leave_half" ||
          (tasks.length > 0 && r.status !== "leave"));
      const tone = left
        ? "is-left"
        : r.status === "leave" && !r.skip_attendance
          ? "is-leave"
          : r.status === "leave_half" && !r.skip_attendance
            ? "is-leave-half"
            : canTone
              ? allDone
                ? "is-present is-done"
                : incomplete
                  ? "is-present is-undone"
                  : "is-present"
              : "is-unset";
      const taskCell = tasks.length
        ? `<div class="dayview-inline">
            ${tasks
              .map((t) => {
                const unit = t.unit === "items" ? "items" : "clips";
                const submitted = isSubmitted(t);
                const done = submitted ? Number(t.done_today || 0) : null;
                const quota = t.quota || 0;
                const met = submitted && quota > 0 && done + 1e-9 >= quota;
                const doneTxt = submitted ? fmtNum(done) : "—";
                const taskProg = !submitted
                  ? `<span class="wl-chip muted">未提交</span>`
                  : quota > 0 && done + 1e-9 >= quota
                    ? `<span class="wl-chip done">完成</span>`
                    : quota > 0
                      ? `<span class="wl-chip undone">未完成</span>`
                      : `<span class="wl-chip ok">已交</span>`;
                return `<span class="dayview-pill" data-iid="${r.intern_id}" data-pid="${t.project_id}">
                  <span class="proj-tag ${tagClass(t.project_id, t.project_name)}">${e(t.project_name)}</span>
                  <span class="dayview-stat${met ? " met" : ""}">
                    <span class="dv-kv"><em>分配</em><b>${fmtNum(quota)}</b>${unit}</span>
                    <span class="dv-kv"><em>提交</em><b>${doneTxt}</b>${submitted ? unit : ""}</span>
                  </span>
                  ${taskProg}
                  ${
                    submitted && !left && isWriteAdmin()
                      ? `<button type="button" class="btn ghost sm admin-clear-done" title="Clear submission so they can resubmit">Clear submit</button>`
                      : ""
                  }
                </span>`;
              })
              .join("")}
          </div>`
        : left
          ? `<span class="meta">No tasks that day</span>`
          : r.status === "leave"
            ? `<span class="meta">—</span>`
            : `<span class="meta">Not assigned yet</span>`;

      const group = groupLabel(r);
      const header =
        group !== lastGroup
          ? `<tr class="dayview-group"><td colspan="3"><span>${e(group)}</span></td></tr>`
          : "";
      lastGroup = group;

      return `${header}
      <tr class="${tone}">
        <td class="name-cell">
          <div class="name-wrap">
            <strong>${e(displayName(r.intern_name))}</strong>
            ${nameMetaBadges(r)}
          </div>
        </td>
        <td><span class="wl-chip ${
          left
            ? "left"
            : r.skip_attendance
              ? "muted"
              : r.status === "present"
                ? "ok"
                : r.status === "leave_half"
                  ? "half"
                  : r.status === "leave"
                    ? "leave"
                    : ""
        }">${statusLabel}</span></td>
        <td>${taskCell}</td>
      </tr>`;
    })
    .join("");

  el.innerHTML = `
    <div class="dayview">
      <div class="board-head">
        <div class="board-counts">
          <span class="pill present">Present ${c.present || 0}</span>
          <span class="pill half">Half day ${c.leave_half || 0}</span>
          <span class="pill leave">Leave ${c.leave || 0}</span>
          <span class="pill unset">Unset ${c.unset || 0}</span>
          ${
            c.left
              ? `<span class="pill left">离职 ${c.left || 0}</span>`
              : ""
          }
        </div>
        <div class="day-jump">
          <button type="button" class="day-jump-btn ${day === yesterdayISO() ? "on" : ""}" data-jump="yesterday">Yesterday</button>
          <button type="button" class="day-jump-btn ${day === todayISO() ? "on" : ""}" data-jump="today">Today</button>
          <label class="day-picker">Date
            <input id="dayViewInput" type="date" value="${e(day)}">
          </label>
        </div>
      </div>
      <p class="hint" style="margin:0 0 .35rem">${
        isWriteAdmin()
          ? "Use Clear submit if entered by mistake."
          : isReadonlyAdmin()
            ? "Read-only: cannot clear submissions or edit tasks."
            : isOnlineAdmin()
              ? "Read-only: completion for all online members in teams A/B (today and earlier)."
              : isGroupAdmin()
                ? `只读查看本组任务完成（今日及之前）。当前组：${e(
                    teamGroupLabel(me?.team_group)
                  )}。`
                : ""
      }</p>
      <div class="table-wrap">
        <table class="board-table dayview-table">
          <colgroup>
            <col class="dv-col-name">
            <col class="dv-col-status">
            <col class="dv-col-tasks">
          </colgroup>
          <thead>
            <tr>
              <th>People</th>
              <th>Status</th>
              <th>Today’s projects & logs</th>
            </tr>
          </thead>
          <tbody>${rows || `<tr><td colspan="3" class="empty-cell">暂无组员</td></tr>`}</tbody>
        </table>
      </div>
    </div>`;

  async function switchDayViewDay(next) {
    dayViewDay = next || todayISO();
    try {
      await loadAll();
      activateTab("dayview");
    } catch (err) {
      alert(err.message);
    }
  }

  $("#dayViewInput")?.addEventListener("change", async (ev) => {
    let next = ev.target.value || todayISO();
    if (isScopeAdmin() && !isAdmin() && next > todayISO()) {
      alert("You can only view today and earlier dates");
      next = todayISO();
      ev.target.value = next;
    }
    await switchDayViewDay(next);
  });
  el.querySelectorAll(".day-jump-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const next =
        btn.dataset.jump === "yesterday" ? yesterdayISO() : todayISO();
      switchDayViewDay(next);
    });
  });

  el.querySelectorAll(".admin-clear-done").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const pill = btn.closest(".dayview-pill");
      const name =
        btn.closest("tr")?.querySelector(".name-cell strong")?.textContent || "this person";
      if (
        !confirm(
          `Clear ${name}’s submission on ${day}?\nThey can submit again afterward.`
        )
      )
        return;
      try {
        const res = await api("/api/daily/clear", {
          method: "POST",
          body: JSON.stringify({
            intern_id: Number(pill.dataset.iid),
            project_id: Number(pill.dataset.pid),
            day,
          }),
        });
        showFeedback(res.feedback || { message: "Submission cleared" });
        await loadAll();
        activateTab("dayview");
      } catch (err) {
        alert(err.message);
      }
    });
  });
}

function renderBoard() {
  const el = $("#panel-board");
  if (!el || !board) return;
  const day = board.day || boardDay || todayISO();
  const c = board.counts || {};
  const boardReadonly = Boolean(board.readonly) || isReadonlyAdmin();
  const defaultMaxSlots = Number(board.max_projects || 2);
  function rowMaxSlots(rOrTr) {
    if (!rOrTr || typeof rOrTr !== "object") return defaultMaxSlots;
    if (rOrTr.dataset && rOrTr.dataset.maxProjects != null) {
      const n = Number(rOrTr.dataset.maxProjects);
      if (n > 0) return n;
    }
    if (rOrTr.max_projects != null) {
      const n = Number(rOrTr.max_projects);
      if (n > 0) return n;
    }
    return defaultMaxSlots;
  }
  const rel = dayRelLabel(day);
  const optList = (board.projects || []).map((p) => ({
    id: p.id,
    name: p.name,
    unit: projectUnit(p),
  }));

  function slotRow(selected, usedIds, locked) {
    const opts = [`<option value="">Select project</option>`]
      .concat(
        optList.map((p) => {
          if (usedIds.has(Number(p.id)) && Number(selected?.project_id) !== Number(p.id)) {
            return "";
          }
          return `<option value="${p.id}" data-unit="${e(p.unit)}" ${
            Number(selected?.project_id) === Number(p.id) ? "selected" : ""
          }>${e(p.name)}</option>`;
        })
      )
      .join("");
    const has = Boolean(selected?.project_id);
    const unit = selected?.unit === "items" ? "items" : selected?.project_id
      ? projectUnit(optList.find((p) => Number(p.id) === Number(selected.project_id)))
      : "clips";
    const fieldDis = locked || !has ? "disabled" : "";
    const selDis = locked ? "disabled" : "";
    return `
      <div class="day-slot">
        <select class="board-project" ${selDis}>${opts}</select>
        <input type="number" class="task-quota" min="0" step="1"
          value="${has ? selected.quota || 0 : ""}"
          placeholder="Amount" ${fieldDis}>
        <select class="task-unit" ${fieldDis}>
          <option value="clips" ${unit === "clips" ? "selected" : ""}>clips</option>
          <option value="items" ${unit === "items" ? "selected" : ""}>items</option>
        </select>
        ${
          boardReadonly
            ? ""
            : `<button type="button" class="btn sm assign-save" ${locked ? "disabled" : ""}>分配</button>`
        }
      </div>`;
  }

  function leaveLockHtml() {
    return `<div class="assign-leave-lock" aria-disabled="true">
      <span class="leave-lock-tag">Leave</span>
      <span class="leave-lock-text">On leave today — assignments locked</span>
    </div>`;
  }

  function assignCellHtml(r) {
    const onLeave = !r.skip_attendance && r.status === "leave";
    if (onLeave) {
      return `<div class="assign-cell is-leave-locked">${leaveLockHtml()}</div>`;
    }
    const filled = (r.day_projects || []).filter((p) => p && p.project_id);
    const display = filled.length ? filled : [null];
    const used = new Set(filled.map((p) => Number(p.project_id)));
    const hasSaved = filled.length > 0;
    const locked = boardReadonly || hasSaved; // 已有任务时默认锁定，点「修改」再改
    const maxSlots = rowMaxSlots(r);
    const canAdd = !boardReadonly && display.length < maxSlots;
    const halfHint =
      !r.skip_attendance && r.status === "leave_half"
        ? `<p class="meta assign-half-hint">Half-day leave — tasks can still be assigned</p>`
        : "";
    return `
      <div class="assign-cell ${locked ? "is-locked" : "is-editing"}">
        ${halfHint}
        <div class="day-slots">
          ${display.map((s) => slotRow(s, used, locked)).join("")}
        </div>
        <div class="assign-actions">
          ${
            !boardReadonly && locked && hasSaved
              ? `<button type="button" class="btn-text slot-edit">修改</button>`
              : ""
          }
          ${
            canAdd
              ? `<button type="button" class="btn-text add-slot">添加任务</button>`
              : ""
          }
          ${
            !locked && hasSaved
              ? `<button type="button" class="btn-text slot-edit">取消</button>`
              : ""
          }
        </div>
      </div>`;
  }

  const myIid = Number(me?.intern_id || 0);
  const sortedRows = (board.rows || [])
    .filter((r) => Number(r.active) !== 0 && r.status !== "left")
    .slice()
    .sort((a, b) => {
      // 当前登录管理员（兼岗）置顶，其余按 teams A/B → onsite 优先 → 姓名
      const aMe = myIid && Number(a.intern_id) === myIid;
      const bMe = myIid && Number(b.intern_id) === myIid;
      if (aMe !== bMe) return aMe ? -1 : 1;
      const ga = teamGroupSortKey(a.team_group);
      const gb = teamGroupSortKey(b.team_group);
      if (ga !== gb) return ga - gb;
      const wa = workModeSortKey(a.work_mode);
      const wb = workModeSortKey(b.work_mode);
      if (wa !== wb) return wa - wb;
      return String(a.intern_name || "").localeCompare(
        String(b.intern_name || ""),
        "zh-CN"
      );
    });

  let lastTeam = null;
  const rows = sortedRows
    .map((r) => {
      const statusBtns = r.skip_attendance
        ? `<span class="wl-chip muted" title="Admin dual-role; attendance not counted">Dual role</span>`
        : boardReadonly
          ? statusChipHtml(r.status)
          : statusSelectHtml(r.status, {
              className: "status-select",
              attrs: `data-status-select`,
            });
      const tone = r.skip_attendance
        ? "is-present"
        : r.status === "leave"
          ? "is-leave"
          : r.status === "leave_half"
            ? "is-leave-half"
            : r.status === "present"
              ? "is-present"
              : "is-unset";
      const hasSaved = (r.day_projects || []).some((p) => p && p.project_id);
      const teamKey = normalizeTeamGroup(r.team_group) || "none";
      const teamHeader =
        teamKey !== lastTeam
          ? `<tr class="dayview-group team-group-row"><td colspan="3"><span>${e(
              teamGroupLabel(r.team_group)
            )}</span></td></tr>`
          : "";
      lastTeam = teamKey;

      return `${teamHeader}
      <tr class="${tone}" data-iid="${r.intern_id}" data-max-projects="${rowMaxSlots(r)}" data-editing="${hasSaved && r.status !== "leave" ? "0" : "1"}">
        <td class="name-cell">
          <div class="name-wrap">
            <strong>${e(displayName(r.intern_name))}</strong>
            ${nameMetaBadges(r)}
          </div>
        </td>
        <td><div class="status-group">${statusBtns}</div></td>
        <td>${assignCellHtml(r)}</td>
      </tr>`;
    })
    .join("");

  el.innerHTML = `
    <div class="board-head">
      <div class="board-counts">
        <span class="pill present">Present ${c.present || 0}</span>
        <span class="pill half">Half day ${c.leave_half || 0}</span>
        <span class="pill leave">Leave ${c.leave || 0}</span>
        <span class="pill unset">Unset ${c.unset || 0}</span>
      </div>
      <div class="day-jump">
        <button type="button" class="day-jump-btn ${day === todayISO() ? "on" : ""}" data-jump="today">Today</button>
        <button type="button" class="day-jump-btn ${day === tomorrowISO() ? "on" : ""}" data-jump="tomorrow">Tomorrow</button>
        <label class="day-picker">Date
          <input id="boardDayInput" type="date" value="${e(day)}">
        </label>
      </div>
    </div>
    <p class="hint" style="margin:0 0 .35rem">Scheduling: <strong>${e(rel)}</strong>（${e(day)}）。Sorted by team A/B; ${
      boardReadonly
        ? "Read-only — cannot change status or assignments."
        : "Click Edit, then Assign to save. Add task for more slots (usually max 2; dual-role admins can add more). Leave rows stay locked."
    }</p>
    <div class="table-wrap assign-table-wrap">
      <table class="board-table assign-table">
        <thead>
          <tr>
            <th>People</th>
            <th>Status</th>
            <th class="slot-heads">Tasks</th>
          </tr>
        </thead>
        <tbody>${rows || `<tr><td colspan="3" class="empty-cell">暂无组员</td></tr>`}</tbody>
      </table>
    </div>
  `;

  async function switchBoardDay(next) {
    boardDay = next || todayISO();
    try {
      await loadAll();
      activateTab("board");
    } catch (err) {
      alert(err.message);
    }
  }

  $("#boardDayInput")?.addEventListener("change", async (ev) => {
    await switchBoardDay(ev.target.value || todayISO());
  });
  el.querySelectorAll(".day-jump-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const next =
        btn.dataset.jump === "tomorrow" ? tomorrowISO() : todayISO();
      switchBoardDay(next);
    });
  });

  function isEditing(tr) {
    return tr.dataset.editing === "1";
  }

  function setSlotFieldsEnabled(slot, enabled) {
    const sel = slot.querySelector(".board-project");
    const has = Boolean(sel?.value);
    if (sel) sel.disabled = !enabled;
    const quota = slot.querySelector(".task-quota");
    const unit = slot.querySelector(".task-unit");
    if (quota) quota.disabled = !enabled || !has;
    if (unit) unit.disabled = !enabled || !has;
    const btn = slot.querySelector(".assign-save");
    if (btn) btn.disabled = !enabled;
  }

  function syncEditUi(tr) {
    const cell = tr.querySelector(".assign-cell");
    if (!cell || cell.classList.contains("is-leave-locked")) return;
    const editing = isEditing(tr);
    cell.classList.toggle("is-editing", editing);
    cell.classList.toggle("is-locked", !editing);
    tr.querySelectorAll(".day-slot").forEach((slot) =>
      setSlotFieldsEnabled(slot, editing)
    );
    const actions = tr.querySelector(".assign-actions");
    const hasFilled = [...tr.querySelectorAll(".board-project")].some((s) => s.value);
    const showEdit = hasFilled || tr._slotSnap?.some((s) => s.project_id);
    let editBtn = tr.querySelector(".slot-edit");
    if (showEdit) {
      if (!editBtn && actions) {
        editBtn = document.createElement("button");
        editBtn.type = "button";
        editBtn.className = "btn-text slot-edit";
        actions.appendChild(editBtn);
        editBtn.addEventListener("click", () => toggleEdit(tr));
      }
      if (editBtn) editBtn.textContent = editing ? "Cancel" : "Edit";
    } else {
      editBtn?.remove();
      editBtn = null;
    }
    syncAddBtn(tr);
    // 顺序：锁定时 修改→添加任务；编辑时 添加任务→取消
    if (actions && editBtn) {
      if (editing) actions.appendChild(editBtn);
      else actions.insertBefore(editBtn, actions.firstChild);
    }
  }

  function markDirty(tr) {
    if (!isEditing(tr)) return;
    tr.classList.add("assign-dirty");
    tr.querySelectorAll(".assign-save").forEach((btn) => {
      btn.textContent = "Assign";
    });
  }

  function snapshotSlots(tr) {
    return [...tr.querySelectorAll(".day-slot")].map((slot) => ({
      project_id: Number(slot.querySelector(".board-project")?.value || 0) || null,
      quota: slot.querySelector(".task-quota")?.value ?? "",
      unit: slot.querySelector(".task-unit")?.value || "clips",
    }));
  }

  function restoreSlots(tr, snap) {
    const wrap = tr.querySelector(".day-slots");
    if (!wrap || !snap?.length) return;
    const used = new Set();
    wrap.innerHTML = snap
      .map((s) => {
        const selected = s.project_id
          ? { project_id: s.project_id, quota: s.quota, unit: s.unit }
          : null;
        const html = slotRow(selected, used, true);
        if (s.project_id) used.add(Number(s.project_id));
        return html;
      })
      .join("");
    wrap.querySelectorAll(".day-slot").forEach((slot) => bindSlot(tr, slot));
  }

  async function refreshBoardCounts() {
    try {
      const fresh = await api(`/api/day-board?day=${encodeURIComponent(day)}`);
      board = fresh;
      if (boardDay === dayViewDay) dayViewBoard = fresh;
      const counts = el.querySelector(".board-counts");
      const c2 = fresh.counts || {};
      if (counts) {
        counts.innerHTML = `
          <span class="pill present">Present ${c2.present || 0}</span>
          <span class="pill half">Half day ${c2.leave_half || 0}</span>
          <span class="pill leave">Leave ${c2.leave || 0}</span>
          <span class="pill unset">Unset ${c2.unset || 0}</span>`;
      }
      return fresh;
    } catch (_) {
      return board;
    }
  }

  async function saveStatus(tr, status) {
    try {
      await api("/api/day-board", {
        method: "POST",
        body: JSON.stringify({ intern_id: Number(tr.dataset.iid), day, status }),
      });
      tr.classList.remove("is-leave", "is-leave-half", "is-present", "is-unset");
      tr.classList.add(
        status === "leave"
          ? "is-leave"
          : status === "leave_half"
            ? "is-leave-half"
            : "is-present"
      );
      const sel = tr.querySelector(".status-select");
      if (sel) {
        sel.value = status;
        sel.className = `status-select ${status}`;
      }
      const td = tr.querySelector("td:last-child");
      if (!td) return;
      if (status === "leave") {
        td.innerHTML = `<div class="assign-cell is-leave-locked">${leaveLockHtml()}</div>`;
        tr.dataset.editing = "0";
        tr.classList.remove("assign-dirty");
        await refreshBoardCounts();
      } else {
        const fresh = await refreshBoardCounts();
        const row = (fresh?.rows || []).find(
          (r) => Number(r.intern_id) === Number(tr.dataset.iid)
        );
        const fallback = {
          day_projects: [],
          status: "present",
          skip_attendance: false,
          max_projects: Number(tr.dataset.maxProjects || 0) || undefined,
        };
        td.innerHTML = assignCellHtml(row || fallback);
        if (row?.max_projects) tr.dataset.maxProjects = String(row.max_projects);
        const hasSaved = (row?.day_projects || []).some((p) => p && p.project_id);
        tr.dataset.editing = hasSaved ? "0" : "1";
        tr._slotSnap = null;
        bindRow(tr);
      }
    } catch (err) {
      alert(err.message);
    }
  }

  async function saveTasks(tr, clickedBtn) {
    if (!isEditing(tr)) return;
    const btns = [...tr.querySelectorAll(".assign-save")];
    const day_tasks = [...tr.querySelectorAll(".day-slot")]
      .map((slot) => {
        const sel = slot.querySelector(".board-project");
        if (!sel?.value) return null;
        return {
          project_id: Number(sel.value),
          task_label: "",
          quota: Number(slot.querySelector(".task-quota")?.value || 0),
          unit: slot.querySelector(".task-unit")?.value || "clips",
        };
      })
      .filter(Boolean);
    btns.forEach((btn) => {
      btn.disabled = true;
      if (btn === clickedBtn || !clickedBtn) btn.textContent = "…";
    });
    try {
      await api("/api/day-board", {
        method: "POST",
        body: JSON.stringify({
          intern_id: Number(tr.dataset.iid),
          day,
          day_tasks,
        }),
      });
      tr.classList.remove("assign-dirty");
      tr.dataset.editing = "0";
      tr._slotSnap = snapshotSlots(tr);
      btns.forEach((btn) => {
        btn.disabled = false;
        btn.textContent = "Assigned";
      });
      setTimeout(() => {
        btns.forEach((btn) => {
          if (btn.textContent === "Assigned") btn.textContent = "Assign";
        });
      }, 2200);
      syncEditUi(tr);
      showFeedback({ message: "Assigned" });
      const fresh = await api(`/api/day-board?day=${encodeURIComponent(day)}`);
      if (boardDay === dayViewDay) {
        dayViewBoard = fresh;
        board = fresh;
      } else {
        board = fresh;
      }
    } catch (err) {
      alert(err.message);
      btns.forEach((btn) => {
        btn.disabled = false;
        btn.textContent = "Assign";
      });
    }
  }

  function syncAddBtn(tr) {
    const actions = tr.querySelector(".assign-actions");
    if (!actions || tr.querySelector(".assign-cell")?.classList.contains("is-leave-locked")) {
      return;
    }
    const maxSlots = rowMaxSlots(tr);
    const n = tr.querySelectorAll(".day-slot").length;
    let addBtn = tr.querySelector(".add-slot");
    if (n >= maxSlots) {
      addBtn?.remove();
      return;
    }
    if (!addBtn) {
      addBtn = document.createElement("button");
      addBtn.type = "button";
      addBtn.className = "btn-text add-slot";
      addBtn.textContent = "Add task";
      addBtn.addEventListener("click", () => addSlot(tr));
    }
    const editBtn = tr.querySelector(".slot-edit");
    // 编辑中：添加任务在取消前面；锁定：添加任务在修改后面
    if (isEditing(tr) && editBtn) {
      actions.insertBefore(addBtn, editBtn);
    } else if (editBtn && !isEditing(tr)) {
      actions.insertBefore(addBtn, editBtn.nextSibling);
    } else {
      actions.appendChild(addBtn);
    }
  }

  function bindSlot(tr, slot) {
    const sel = slot.querySelector(".board-project");
    sel.addEventListener("change", () => {
      if (!isEditing(tr)) return;
      const has = Boolean(sel.value);
      slot.querySelector(".task-quota").disabled = !has;
      slot.querySelector(".task-unit").disabled = !has;
      if (!has) slot.querySelector(".task-quota").value = "";
      else {
        if (!slot.querySelector(".task-quota").value) {
          slot.querySelector(".task-quota").value = 0;
        }
        const opt = sel.selectedOptions?.[0];
        const defUnit = opt?.dataset?.unit === "items" ? "items" : "clips";
        slot.querySelector(".task-unit").value = defUnit;
      }
      refreshProjectOptions(tr);
      markDirty(tr);
    });
    slot.querySelectorAll(".task-quota, .task-unit").forEach((inp) => {
      inp.addEventListener("input", () => markDirty(tr));
      inp.addEventListener("change", () => markDirty(tr));
    });
    slot.querySelector(".assign-save")?.addEventListener("click", (ev) => {
      saveTasks(tr, ev.currentTarget);
    });
  }

  function refreshProjectOptions(tr) {
    const selected = [...tr.querySelectorAll(".board-project")].map((s) =>
      Number(s.value || 0)
    );
    tr.querySelectorAll(".board-project").forEach((sel) => {
      const cur = Number(sel.value || 0);
      const html = [`<option value="">Select project</option>`]
        .concat(
          optList.map((p) => {
            const id = Number(p.id);
            if (selected.includes(id) && id !== cur) return "";
            return `<option value="${p.id}" data-unit="${e(p.unit)}" ${
              id === cur ? "selected" : ""
            }>${e(p.name)}</option>`;
          })
        )
        .join("");
      sel.innerHTML = html;
    });
  }

  function addSlot(tr) {
    if (tr.querySelector(".assign-cell")?.classList.contains("is-leave-locked")) return;
    if (!isEditing(tr)) {
      beginEdit(tr);
    }
    const wrap = tr.querySelector(".day-slots");
    const maxSlots = rowMaxSlots(tr);
    if (!wrap || tr.querySelectorAll(".day-slot").length >= maxSlots) return;
    const used = new Set(
      [...tr.querySelectorAll(".board-project")]
        .map((s) => Number(s.value))
        .filter(Boolean)
    );
    const tmp = document.createElement("div");
    tmp.innerHTML = slotRow(null, used, false).trim();
    const slot = tmp.firstElementChild;
    wrap.appendChild(slot);
    bindSlot(tr, slot);
    syncAddBtn(tr);
    markDirty(tr);
  }

  function beginEdit(tr) {
    if (tr.querySelector(".assign-cell")?.classList.contains("is-leave-locked")) return;
    tr._slotSnap = snapshotSlots(tr);
    tr.dataset.editing = "1";
    syncEditUi(tr);
  }

  function cancelEdit(tr) {
    if (tr._slotSnap) {
      restoreSlots(tr, tr._slotSnap);
    }
    tr.dataset.editing = "0";
    tr.classList.remove("assign-dirty");
    // 若本来就没有任务，取消后仍保持可编辑空槽
    const has = [...tr.querySelectorAll(".board-project")].some((s) => s.value);
    if (!has) {
      tr.dataset.editing = "1";
    }
    syncEditUi(tr);
  }

  function toggleEdit(tr) {
    if (isEditing(tr)) cancelEdit(tr);
    else beginEdit(tr);
  }

  function bindRow(tr) {
    if (boardReadonly) return;
    const statusSel = tr.querySelector(".status-select");
    if (statusSel) {
      statusSel.onchange = () => {
        if (statusSel.value === "unset") return;
        saveStatus(tr, statusSel.value);
      };
    }
    if (tr.querySelector(".assign-cell")?.classList.contains("is-leave-locked")) {
      return;
    }
    tr.querySelectorAll(".day-slot").forEach((slot) => bindSlot(tr, slot));
    tr.querySelector(".add-slot")?.addEventListener("click", () => addSlot(tr));
    tr.querySelector(".slot-edit")?.addEventListener("click", () => toggleEdit(tr));
    if (!tr._slotSnap) tr._slotSnap = snapshotSlots(tr);
    syncEditUi(tr);
  }

  el.querySelectorAll("tr[data-iid]").forEach((tr) => bindRow(tr));
}

function renderToday() {
  const el = $("#panel-today");
  if (!el) return;
  if (!hasInternWork()) {
    el.innerHTML = "";
    return;
  }
  const day = todayISO();
  const dayLabel = dayFullLabel(day);
  const src = isAdmin() ? myTodayState || state : state;
  let people = src?.people || [];
  if (isAdmin()) {
    people = people.filter((p) => Number(p.id) === Number(me.intern_id));
  }

  const dateBar = `<div class="today-date-bar">
         <span class="today-date-k">Today</span>
         <strong>${e(dayLabel.replace(/^Today · /, ""))}</strong>
       </div>`;
  const cutoffHint = `<p class="hint today-cutoff-hint">Before ${TASK_DAY_CUTOFF_HOUR}:00 Beijing time next day, you can still submit the previous business day’s amount (e.g. before ${String(TASK_DAY_CUTOFF_HOUR).padStart(2,"0")}:00 on the 8th counts as the 7th).</p>`;
  const makeupBar = `<div class="today-makeup">
         <span class="meta">Forgot a day? Click for makeup submit</span>
         <button type="button" class="btn ghost" id="openMakeupBtn">Makeup</button>
       </div>`;

  function bindTodayChrome() {
    $("#openMakeupBtn")?.addEventListener("click", () => openMakeupDialog());
  }

  if (!people.length) {
    el.innerHTML = `${dateBar}${cutoffHint}<div class="empty">No tasks assigned to you today. An admin can assign them on Assignments.</div>${makeupBar}`;
    bindTodayChrome();
    return;
  }

  const cards = people
    .map((p) => {
      const tasks = p.today_tasks && p.today_tasks.length
        ? p.today_tasks
        : (p.projects || []).map((pr) => ({
            project_id: pr.project_id,
            project_name: pr.project_name,
            task_label: "",
            quota: 0,
            done_today: todayDone(p.id, pr.project_id),
          }));
      const rows = tasks
        .map((pr) => {
          const rawDone =
            pr.done_today != null
              ? pr.done_today
              : todayDone(p.id, pr.project_id);
          const submitted = pr.submitted === true || rawDone != null;
          const doneToday = submitted ? Number(rawDone || 0) : null;
          const quota = Number(pr.quota || 0);
          const unit = pr.unit === "items" ? "items" : "clips";
          const met = submitted && quota > 0 && doneToday + 1e-9 >= quota;
          if (submitted) delete todayDrafts[draftKey(p.id, pr.project_id)];
          const quotaHtml = quota > 0
            ? `<span class="quota-chip ${met ? "met" : ""}">today ${
                submitted ? fmtNum(doneToday) : "—"
              }/${quota} ${unit}</span>`
            : `<span class="meta">No quota for today</span>`;
          const draft = todayDrafts[draftKey(p.id, pr.project_id)];
          const inputVal = submitted
            ? doneToday
            : draft != null && draft !== ""
              ? draft
              : "";
          const desc = pr.task_label
            ? `<div class="task-desc">${e(pr.task_label)}</div>`
            : "";
          return `
          <div class="today-row" data-iid="${p.id}" data-pid="${pr.project_id}" data-quota="${quota}">
            <div style="flex:1 1 180px;min-width:160px">
              <span class="proj-tag ${tagClass(pr.project_id, pr.project_name)}">${e(pr.project_name)}</span>
              ${desc}
            </div>
            ${quotaHtml}
            <label class="done-input">
              TodayDone
              <input type="number" min="0" step="1" value="${
                inputVal === "" ? "" : e(String(inputVal))
              }" class="done-field" placeholder="填Amount" ${
                submitted ? "disabled" : ""
              }>
              <span class="unit">${unit}</span>
            </label>
            ${
              submitted
                ? `<span class="wl-chip ok">已提交</span>`
                : `<button type="button" class="btn sm save-done">提交</button>`
            }
          </div>`;
        })
        .join("");
      return `
      <article class="person-card">
        <h3>${e(displayName(p.name))}</h3>
        ${rows || `<p class="meta">今日尚未安排任务（管理员可在「任务分配」里安排）</p>`}
      </article>`;
    })
    .join("");

  el.innerHTML = `${dateBar}${cutoffHint}<div class="people-list">${cards}</div>${makeupBar}`;

  bindTodayChrome();

  el.querySelectorAll(".done-field").forEach((input) => {
    if (input.disabled) return;
    const row = input.closest(".today-row");
    const key = draftKey(row.dataset.iid, row.dataset.pid);
    const sync = () => {
      const raw = String(input.value ?? "").trim();
      if (raw === "") delete todayDrafts[key];
      else todayDrafts[key] = raw;
    };
    input.addEventListener("input", sync);
    input.addEventListener("change", sync);
  });

  el.querySelectorAll(".save-done").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const row = btn.closest(".today-row");
      const input = row.querySelector(".done-field");
      const raw = String(input?.value ?? "").trim();
      if (raw === "") {
        alert("Enter an amount before submitting.");
        return;
      }
      const done = Number(raw);
      if (!Number.isFinite(done) || done < 0) {
        alert("Enter a valid amount.");
        return;
      }
      const key = draftKey(row.dataset.iid, row.dataset.pid);
      btn.disabled = true;
      try {
        const res = await api("/api/daily", {
          method: "POST",
          body: JSON.stringify({
            intern_id: Number(row.dataset.iid),
            project_id: Number(row.dataset.pid),
            day,
            assigned: done,
            done,
          }),
        });
        delete todayDrafts[key];
        showFeedback(res.feedback);
        await loadAll();
        if (!isAdmin()) activateTab("today");
      } catch (err) {
        alert(err.message);
        btn.disabled = false;
      }
    });
  });
}

let makeupProjects = [];
/** 今日登记未提交输入草稿，避免提交一项后整表刷新把另一项清空成 0 */
let todayDrafts = {};

function snapshotTodayDrafts() {
  const map = { ...todayDrafts };
  document.querySelectorAll("#panel-today .today-row").forEach((row) => {
    const input = row.querySelector(".done-field");
    if (!input || input.disabled) return;
    const key = `${row.dataset.iid}:${row.dataset.pid}`;
    const raw = String(input.value ?? "").trim();
    if (raw === "") delete map[key];
    else map[key] = raw;
  });
  todayDrafts = map;
  return map;
}

function draftKey(internId, projectId) {
  return `${internId}:${projectId}`;
}

async function refreshMakeupOptions() {
  const dayEl = $("#makeupDay");
  if (!dayEl?.value) return;
  try {
    const data = await api(`/api/makeup?day=${encodeURIComponent(dayEl.value)}`);
    makeupProjects = data.projects || [];
    const sel = $("#makeupProject");
    sel.innerHTML = makeupProjects.length
      ? makeupProjects
          .map(
            (p) =>
              `<option value="${p.project_id}">${e(p.project_name)}</option>`
          )
          .join("")
      : `<option value="">NoneoptionalProject</option>`;
    dayEl.min = data.earliest;
    dayEl.max = (() => {
      const t = new Date(data.today + "T12:00:00");
      t.setDate(t.getDate() - 1);
      return t.toLocaleDateString("en-CA");
    })();
    applyMakeupProject();
  } catch (err) {
    $("#makeupHint").textContent = err.message;
    $("#makeupProject").innerHTML = `<option value="">—</option>`;
  }
}

function applyMakeupProject() {
  const pid = Number($("#makeupProject").value);
  const p = makeupProjects.find((x) => Number(x.project_id) === pid);
  const hint = $("#makeupHint");
  if (!p) {
    hint.textContent = "If nothing is scheduled that day, pick from your current assignments.";
    return;
  }
  $("#makeupDone").value = p.done || 0;
  $("#makeupUnit").value = p.unit === "items" ? "items" : "clips";
  if (p.quota > 0) {
    hint.textContent = `Quota ${p.quota} ${p.unit} · filled ${p.done}`;
  } else if (p.from_board) {
    hint.textContent = `Scheduled · filled ${p.done}`;
  } else {
    hint.textContent = `Filled ${p.done}（Not on the day board; makeup for current project）`;
  }
}

async function openMakeupDialog() {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const y = yesterday.toLocaleDateString("en-CA");
  const dayEl = $("#makeupDay");
  dayEl.value = y;
  dayEl.max = y;
  $("#makeupMsg").textContent = "";
  await refreshMakeupOptions();
  $("#makeupDialog").showModal();
}

const SUBMIT_LABELS = {
  ok: "Submitted",
  missing: "Not submitted",
  short: "Below quota",
  leave: "Leave",
  empty: "No tasks",
  tts: "TTS",
  prodTest: "Prod test",
  "QC": "QC",
};

function renderMine() {
  const el = $("#panel-mine");
  if (!el) return;
  if (!hasInternWork()) {
    el.innerHTML = "";
    return;
  }
  const list = workload?.projects || [];
  if (!list.length) {
    el.innerHTML = `<div class="empty">No submissions yet. Log them on Today and they will show up here.</div>`;
    return;
  }
  const units = [...new Set(list.map((p) => projectUnit(p)))];
  const total = list.reduce((s, p) => s + Number(p.done || 0), 0);
  const totalUnit = units.length === 1 ? units[0] : "";
  el.innerHTML = `
    <div class="mine-page">
      <p class="hint">Only your own submitted totals across projects.</p>
      <div class="mine-total">
        <span class="k">我TotalSubmit</span>
        <strong>${fmtNum(total)}</strong>${totalUnit ? `<span class="unit">${totalUnit}</span>` : ""}
      </div>
      <div class="mine-list">
        ${list
          .map((p) => {
            const done = Number(p.done || 0);
            const unit = projectUnit(p);
            return `
            <article class="mine-card">
              <span class="proj-tag ${tagClass(p.project_id, p.project_name)}">${e(p.project_name)}</span>
              <div class="mine-num">
                <em>已提交</em>
                <strong>${fmtNum(done)}</strong><span class="unit">${unit}</span>
              </div>
            </article>`;
          })
          .join("")}
      </div>
    </div>`;
}

function fmtAttNum(n) {
  const x = Number(n || 0);
  return Number.isInteger(x) ? String(x) : String(Math.round(x * 10) / 10);
}

function weekRangeLabel(weekDays) {
  if (!weekDays?.length) return "";
  const a = weekDays[0];
  const b = weekDays[weekDays.length - 1];
  return `${a} ~ ${b}`;
}

function thisMondayISO() {
  const t = todayISO();
  return addDaysISO(t, -((new Date(`${t}T12:00:00`).getDay() + 6) % 7));
}

function attMonthCalHtml(ym, person, monthDays) {
  const workSet = new Set(monthDays || []);
  const statusMap = Object.fromEntries(
    (person?.month?.days || []).map((x) => [x.day, x.status || "unset"])
  );
  const [y, m] = String(ym || "")
    .split("-")
    .map(Number);
  if (!y || !m) return "";
  const daysInMonth = new Date(y, m, 0).getDate();
  const firstDow = new Date(y, m - 1, 1).getDay(); // 0=Sun
  const startPad = (firstDow + 6) % 7; // Mon-first
  const heads = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
    .map((w) => `<span>${w}</span>`)
    .join("");
  const cells = [];
  for (let i = 0; i < startPad; i++) {
    cells.push(`<span class="att-cal-cell pad"></span>`);
  }
  for (let d = 1; d <= daysInMonth; d++) {
    const iso = `${ym}-${String(d).padStart(2, "0")}`;
    const isWork = workSet.has(iso);
    const st = statusMap[iso] || "unset";
    const cls = !isWork ? "rest" : st;
    const label = !isWork ? "Off" : STATUS_LABELS[st] || "Unset";
    cells.push(
      `<span class="att-cal-cell ${cls}" title="${e(iso)} ${e(label)}"><em>${d}</em></span>`
    );
  }
  return `
    <div class="att-cal" aria-label="${e(displayName(person.intern_name))} ${e(ym)} PresentCalendar">
      <div class="att-cal-weekdays">${heads}</div>
      <div class="att-cal-grid">${cells.join("")}</div>
    </div>`;
}

function shiftMonth(ym, delta) {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

async function loadAttendance(opts = {}) {
  if (opts.week) attendanceWeek = opts.week;
  if (opts.month) attendanceMonth = opts.month;
  if (opts.view) attendanceView = opts.view;
  const qs = new URLSearchParams();
  qs.set("month", attendanceMonth || todayISO().slice(0, 7));
  if (attendanceWeek) qs.set("week", attendanceWeek);
  attendance = await api(`/api/attendance?${qs.toString()}`);
  if (attendance?.week_start) attendanceWeek = attendance.week_start;
  if (attendance?.month) attendanceMonth = attendance.month;
  renderAttendance();
}

function renderAttendance() {
  const el = $("#panel-attendance");
  if (!el) return;
  if (!attendance) {
    el.innerHTML = `<div class="empty">Loading attendance…</div>`;
    return;
  }
  const weekDays = attendance.week_days || [];
  const people = (attendance.people || [])
    .filter((p) => !p.skip_attendance)
    .slice()
    .sort((a, b) => {
      const ga = teamGroupSortKey(a.team_group);
      const gb = teamGroupSortKey(b.team_group);
      if (ga !== gb) return ga - gb;
      const wa = workModeSortKey(a.work_mode);
      const wb = workModeSortKey(b.work_mode);
      if (wa !== wb) return wa - wb;
      return String(a.intern_name || "").localeCompare(
        String(b.intern_name || ""),
        "zh-CN"
      );
    });
  const month = attendance.month || todayISO().slice(0, 7);
  const myAttId = Number(me?.intern_id || 0);
  const canEditPerson = (p) =>
    isWriteAdmin() || (myAttId && Number(p.intern_id) === myAttId);
  const view =
    attendanceView === "month" && !isScopeAdmin()
      ? "month"
      : attendanceView === "workcal" && isAdmin()
        ? "workcal"
        : "week";
  if (
    (attendanceView === "workcal" && !isAdmin()) ||
    (attendanceView === "month" && isScopeAdmin() && !isAdmin())
  ) {
    attendanceView = "week";
  }

  const weekHeads = weekDays
    .map((d) => {
      const wd = WEEKDAY_CN[new Date(`${d}T12:00:00`).getDay()];
      const md = d.slice(5);
      return `<th class="att-day-h"><span>${wd}</span><em>${md}</em></th>`;
    })
    .join("");

  const isGaView = isScopeAdmin() && !isAdmin();
  const mePerson = myAttId
    ? people.find((p) => Number(p.intern_id) === myAttId)
    : null;

  const weekScoreOf = (p) =>
    weekDays.reduce((s, d) => {
      const st = p.week?.[d];
      if (st === "present") return s + 1;
      if (st === "leave_half") return s + 0.5;
      return s;
    }, 0);

  const weekCellsHtml = (p, { editable }) =>
    weekDays
      .map((d) => {
        const st = p.week?.[d] || "unset";
        const cell = editable
          ? statusSelectHtml(st, {
              className: "att-select",
              disabled: false,
              attrs: `data-iid="${p.intern_id}" data-day="${d}"`,
            })
          : statusChipHtml(st);
        return `<td>${cell}</td>`;
      })
      .join("");

  // 组内管理：自己的Present单独可编辑；组表只读
  const myAttBlock =
    isGaView && mePerson
      ? `
    <section class="att-my-card">
      <header class="att-my-head">
        <h3>My attendance</h3>
        <span class="meta">${e(weekRangeLabel(weekDays))}</span>
      </header>
      <div class="table-wrap">
        <table class="board-table att-week-table att-my-table">
          <thead>
            <tr>
              <th>People</th>
              ${weekHeads}
              <th>This week’s attendance</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td class="name-cell">
                <div class="name-wrap">
                  <strong>${e(displayName(mePerson.intern_name))}</strong>
                  ${nameMetaBadges(mePerson)}
                </div>
              </td>
              ${weekCellsHtml(mePerson, { editable: true })}
              <td class="att-score">${fmtAttNum(weekScoreOf(mePerson))}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>`
      : "";

  let lastTeam = null;
  const weekRows = people
    .map((p) => {
      const teamKey = normalizeTeamGroup(p.team_group) || "none";
      const header =
        (isAdmin() || isScopeAdmin()) && teamKey !== lastTeam
          ? `<tr class="dayview-group"><td colspan="${weekDays.length + 2}"><span>${e(
              teamGroupLabel(p.team_group)
            )}</span></td></tr>`
          : "";
      lastTeam = teamKey;
      // 组内管理组表全部只读；其他人按原规则（管理员全可改 / 组员改自己）
      const editable = isGaView ? false : canEditPerson(p);
      const weekScore = weekScoreOf(p);
      return `${header}
      <tr>
        <td class="name-cell">
          <div class="name-wrap">
            <strong>${e(displayName(p.intern_name))}</strong>
            ${nameMetaBadges(p)}
          </div>
        </td>
        ${weekCellsHtml(p, { editable })}
        <td class="att-score">${fmtAttNum(weekScore)}</td>
      </tr>`;
    })
    .join("");

  const monthDays = attendance.month_days || [];
  const monthCalCards = [...people]
    .sort((a, b) => {
      const da =
        Number(b.month?.present_days || 0) - Number(a.month?.present_days || 0);
      if (da !== 0) return da;
      return String(a.intern_name).localeCompare(String(b.intern_name), "en");
    })
    .map((p) => {
      return `<article class="att-cal-card">
        <span class="att-cal-days" title="Attendance days">${fmtAttNum(
          p.month?.present_days || 0
        )}<em>days</em></span>
        <header class="att-cal-card-head">
          <strong>${e(displayName(p.intern_name))}</strong>
          ${nameMetaBadges(p)}
        </header>
        ${attMonthCalHtml(month, p, monthDays)}
      </article>`;
    })
    .join("");

  const thisMon = thisMondayISO();
  const nextMon = addDaysISO(thisMon, 7);
  const weekStart = attendance.week_start || attendanceWeek || thisMon;
  const onThisWeek = weekStart === thisMon;
  const onNextWeek = weekStart === nextMon;

  const calEx = workCalendarList || attendance.calendar_exceptions || [];
  const workCalBody = `
    <section class="work-cal-card">
      <header class="work-cal-head">
        <h3>Schedule exceptions</h3>
        <p class="meta">${
          isWriteAdmin()
            ? "Mark weekends as work or weekdays as off; attendance follows."
            : "Read-only schedule exceptions."
        }</p>
      </header>
      ${
        isWriteAdmin()
          ? `<form class="work-cal-form" id="workCalForm">
        <label>日期
          <input type="date" name="day" required>
        </label>
        <label>类型
          <select name="kind">
            <option value="work">上班（加班日）</option>
            <option value="off">休息（放假日）</option>
          </select>
        </label>
        <label>备注
          <input type="text" name="note" placeholder="e.g. schedule swap" maxlength="40">
        </label>
        <button type="submit" class="btn sm">保存</button>
      </form>`
          : ""
      }
      <div class="work-cal-list">
        ${
          calEx.length
            ? calEx
                .map((x) => {
                  const wd = WEEKDAY_CN[new Date(`${x.day}T12:00:00`).getDay()];
                  const kindLabel = x.kind === "work" ? "Work" : "Off";
                  return `<div class="work-cal-row">
                    <span class="work-cal-day">${e(x.day)} · ${wd}</span>
                    <span class="work-cal-kind ${e(x.kind)}">${kindLabel}</span>
                    <span class="meta">${e(x.note || "")}</span>
                    ${
                      isWriteAdmin()
                        ? `<button type="button" class="btn ghost sm work-cal-del" data-day="${e(
                            x.day
                          )}">Delete</button>`
                        : ""
                    }
                  </div>`;
                })
                .join("")
            : `<p class="meta" style="margin:0">还没有特殊日。${
                isWriteAdmin()
                  ? "e.g. set a Sunday to Work."
                  : ""
              }</p>`
        }
      </div>
    </section>`;

  el.innerHTML = `
    <div class="attendance-page${view === "month" ? " is-month" : ""}${
      view === "workcal" ? " is-workcal" : ""
    }">
      <div class="board-head">
        <div class="board-counts">
          <button type="button" class="day-jump-btn ${view === "week" ? "on" : ""}" data-att-view="week">${
            (isScopeAdmin() && !isAdmin()) || isReadonlyAdmin()
              ? "Weekly view"
              : "Weekly entry"
          }</button>
          ${
            isScopeAdmin() && !isAdmin()
              ? ""
              : `<button type="button" class="day-jump-btn ${view === "month" ? "on" : ""}" data-att-view="month">月度统计</button>`
          }
          ${
            isAdmin()
              ? `<button type="button" class="day-jump-btn ${
                  view === "workcal" ? "on" : ""
                }" data-att-view="workcal">调休 / 特殊日</button>`
              : ""
          }
        </div>
        <div class="day-jump">
          ${
            view === "week"
              ? `
            <button type="button" class="day-jump-btn ${onThisWeek ? "on" : ""}" data-att-week="this">本周</button>
            <button type="button" class="day-jump-btn ${onNextWeek ? "on" : ""}" data-att-week="next">下一周</button>
          `
              : view === "month"
                ? `
            <button type="button" class="day-jump-btn" data-att-month="-1">上月</button>
            <button type="button" class="day-jump-btn" data-att-month="0">本月</button>
            <button type="button" class="day-jump-btn" data-att-month="1">下月</button>
            <label class="day-picker">月份
              <input id="attMonthInput" type="month" value="${e(month)}">
            </label>
          `
                : ""
          }
        </div>
      </div>
      ${
        view === "workcal"
          ? workCalBody
          : view === "week"
            ? `
        ${myAttBlock}
        ${
          isGaView
            ? `<header class="att-team-head">
                <h3>${isOnlineAdmin() ? "Online attendance" : "Team attendance"}</h3>
                <span class="meta">Read-only · ${
                  isOnlineAdmin()
                    ? "teams A/B online"
                    : e(teamGroupLabel(me?.team_group))
                }</span>
              </header>`
            : `<p class="hint" style="margin:0 0 .45rem">
          Prefill this / next week (${e(weekRangeLabel(weekDays))}). Use the dropdown: 
          <strong>Present / Half day / Leave</strong>. Prefill next week on Fridays; edit anytime.
          ${
            isWriteAdmin()
              ? ""
              : isReadonlyAdmin()
                ? "Read-only — cannot edit attendance."
                : "You can only edit your own attendance."
          }
        </p>`
        }
        <div class="table-wrap">
          <table class="board-table att-week-table">
            <thead>
              <tr>
                <th>人</th>
                ${weekHeads}
                <th>本周Present</th>
              </tr>
            </thead>
            <tbody>
              ${
                weekRows ||
                `<tr><td colspan="${weekDays.length + 2}" class="empty-cell">No people yet</td></tr>`
              }
            </tbody>
          </table>
        </div>
      `
            : `
        <div class="att-month-view">
          <div class="att-cal-legend">
            <span><i class="present"></i>Present</span>
            <span><i class="leave_half"></i>半天</span>
            <span><i class="leave"></i>请假</span>
            <span><i class="unset"></i>未填</span>
            <span><i class="rest"></i>休息</span>
          </div>
          <div class="att-cal-grid-wrap">
            ${monthCalCards || `<p class="meta">No people yet</p>`}
          </div>
        </div>
      `
      }
    </div>
  `;

  el.querySelectorAll("[data-att-view]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const next = btn.dataset.attView;
      attendanceView = next;
      if (next === "workcal") {
        try {
          const data = await api("/api/work-calendar");
          workCalendarList = Array.isArray(data) ? data : [];
        } catch (err) {
          alert(err.message);
          return;
        }
      }
      renderAttendance();
    });
  });

  $("#workCalForm")?.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const form = ev.target;
    const day = form.day.value;
    const kind = form.kind.value;
    const note = (form.note.value || "").trim();
    if (!day) return;
    try {
      await api("/api/work-calendar", {
        method: "POST",
        body: JSON.stringify({ day, kind, note }),
      });
      form.reset();
      const data = await api("/api/work-calendar");
      workCalendarList = Array.isArray(data) ? data : [];
      await loadAttendance({});
      try {
        hub = await api("/api/hub");
        renderHub();
      } catch (_) {
        /* ignore */
      }
    } catch (err) {
      alert(err.message);
    }
  });

  el.querySelectorAll(".work-cal-del").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const day = btn.dataset.day;
      if (!day) return;
      if (!confirm(`Delete exception for ${day}?`)) return;
      try {
        await api("/api/work-calendar/delete", {
          method: "POST",
          body: JSON.stringify({ day }),
        });
        const data = await api("/api/work-calendar");
        workCalendarList = Array.isArray(data) ? data : [];
        await loadAttendance({});
        try {
          hub = await api("/api/hub");
          renderHub();
        } catch (_) {
          /* ignore */
        }
      } catch (err) {
        alert(err.message);
      }
    });
  });

  el.querySelectorAll("[data-att-week]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const which = btn.dataset.attWeek;
      try {
        const mon =
          which === "next" ? addDaysISO(thisMondayISO(), 7) : thisMondayISO();
        await loadAttendance({ week: mon, view: "week" });
      } catch (err) {
        alert(err.message);
      }
    });
  });

  el.querySelectorAll("[data-att-month]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const delta = Number(btn.dataset.attMonth);
      try {
        if (delta === 0) {
          await loadAttendance({ month: todayISO().slice(0, 7), view: "month" });
        } else {
          await loadAttendance({
            month: shiftMonth(attendanceMonth || todayISO().slice(0, 7), delta),
            view: "month",
          });
        }
      } catch (err) {
        alert(err.message);
      }
    });
  });

  $("#attMonthInput")?.addEventListener("change", async (ev) => {
    try {
      await loadAttendance({ month: ev.target.value || todayISO().slice(0, 7), view: "month" });
    } catch (err) {
      alert(err.message);
    }
  });

  el.querySelectorAll(".att-select").forEach((sel) => {
    sel.addEventListener("change", async () => {
      if (sel.disabled) return;
      const next = sel.value || "unset";
      if (next === "unset") return;
      const prev = [...sel.classList].find((c) => c !== "att-select" && STATUS_LABELS[c]) || "unset";
      sel.disabled = true;
      try {
        await api("/api/attendance", {
          method: "POST",
          body: JSON.stringify({
            intern_id: Number(sel.dataset.iid),
            day: sel.dataset.day,
            status: next,
          }),
        });
        // 局部更新，避免整页闪烁
        const person = (attendance.people || []).find(
          (p) => Number(p.intern_id) === Number(sel.dataset.iid)
        );
        if (person) {
          person.week = person.week || {};
          person.week[sel.dataset.day] = next;
          // 同步月度格子
          if (person.month?.days) {
            const cell = person.month.days.find((x) => x.day === sel.dataset.day);
            if (cell) cell.status = next;
            let present = 0;
            let half = 0;
            let leave = 0;
            let filled = 0;
            for (const x of person.month.days) {
              if (x.status === "present") {
                present += 1;
                filled += 1;
              } else if (x.status === "leave_half") {
                present += 0.5;
                half += 1;
                filled += 1;
              } else if (x.status === "leave") {
                leave += 1;
                filled += 1;
              }
            }
            person.month.present_days = present;
            person.month.leave_half_days = half;
            person.month.leave_days = leave;
            person.month.filled_days = filled;
          }
        }
        renderAttendance();
      } catch (err) {
        alert(err.message);
        sel.value = prev;
        sel.className = `att-select ${prev}`;
        sel.disabled = false;
      }
    });
  });
}

function renderWorkload() {
  const el = $("#panel-workload");
  if (!el) return;
  if (!hasInternWork()) {
    el.innerHTML = "";
    return;
  }
  if (!workload) {
    el.innerHTML = `<div class="empty">No work records.</div>`;
    return;
  }
  const days = workload.days || [];

  const dayRows = days.length
    ? `<div class="table-wrap">
        <table class="board-table workload-detail">
          <colgroup>
            <col class="col-day">
            <col class="col-proj">
            <col class="col-num">
            <col class="col-num">
            <col class="col-status">
          </colgroup>
          <thead>
            <tr>
              <th>Date</th>
              <th>Project</th>
              <th class="num">Assign</th>
              <th class="num">Done</th>
              <th>Submit</th>
            </tr>
          </thead>
          <tbody>
            ${days
              .map((d) => {
                const badge = d.submit_status || "empty";
                const items = d.items || [];
                if (!items.length) {
                  return `<tr class="wl-day ${badge}">
                    <td class="wl-day-cell">${e(d.day)}</td>
                    <td colspan="3" class="meta">${
                      d.status === "leave" || badge === "leave"
                        ? "Leave"
                        : SUBMIT_LABELS[badge] || "No tasks"
                    }</td>
                    <td><span class="wl-chip ${badge}">${SUBMIT_LABELS[badge] || badge}</span></td>
                  </tr>`;
                }
                return items
                  .map((it, idx) => {
                    const st = it.submit_status || "ok";
                    const doneTxt = it.done == null ? "—" : fmtNum(it.done);
                    const unit = e(it.unit || "clips");
                    return `<tr class="wl-day ${badge}">
                      <td class="wl-day-cell">${idx === 0 ? e(d.day) : ""}</td>
                      <td class="wl-proj">${e(it.project_name)}</td>
                      <td class="num">${fmtNum(it.assigned)}<span class="unit">${unit}</span></td>
                      <td class="num">${doneTxt}<span class="unit">${unit}</span></td>
                      <td><span class="wl-chip ${st}">${SUBMIT_LABELS[st] || st}</span></td>
                    </tr>`;
                  })
                  .join("");
              })
              .join("")}
          </tbody>
        </table>
      </div>`
    : `<div class="empty">No recent attendance or submission records.</div>`;

  el.innerHTML = `
    <div class="workload-page">
      <p class="hint">Daily submission history. Days you finished but forgot to submit show as Not submitted; makeup from Today.</p>
      <h3 class="workload-h">每日明细</h3>
      ${dayRows}
    </div>`;
}

function fmtNum(n) {
  const x = Number(n || 0);
  return Number.isInteger(x) ? String(x) : String(Math.round(x * 10) / 10);
}

function peopleBarsHtml(people, unit = "clips", highlightInternId = null) {
  const rows = [...(people || [])]
    .map((u) => ({
      name: u.intern_name || "—",
      done: Number(u.done || 0),
      intern_id: u.intern_id,
      left: Number(u.active) === 0,
    }))
    .sort((a, b) => b.done - a.done);
  if (!rows.length) return `<p class="meta">NoneAssign</p>`;
  const max = Math.max(...rows.map((u) => u.done), 1);
  const total = rows.reduce((s, u) => s + u.done, 0);
  return `
    <div class="rank-board">
      <div class="rank-board-head">
        <span>Contributions</span>
        <span class="meta">Total ${fmtNum(total)} ${unit} · 按Amountsort</span>
      </div>
      <div class="rank-list">
        ${rows
          .map((u, i) => {
            const pct = Math.max(4, (100 * u.done) / max);
            const share = total > 0 ? ((100 * u.done) / total).toFixed(1) : "0";
            const tone = `t${Math.min(i, 7)}`;
            const mine =
              highlightInternId != null &&
              Number(u.intern_id) === Number(highlightInternId);
            const leftTag = u.left
              ? `<span class="rank-left-tag" title="Left">离职</span>`
              : "";
            return `
            <div class="rank-row${mine ? " is-me" : ""}${u.left ? " is-left" : ""}" style="--bar:${pct}%; --delay:${i * 35}ms">
              <span class="rank-idx">${i + 1}</span>
              <span class="rank-name"><span class="rank-name-text">${e(displayName(u.name))}${mine ? " · me" : ""}</span>${leftTag}</span>
              <div class="rank-track"><i class="rank-fill ${tone}"></i></div>
              <span class="rank-val"><strong>${fmtNum(u.done)}</strong><em>${unit}</em></span>
              <span class="rank-share">${share}%</span>
            </div>`;
          })
          .join("")}
      </div>
    </div>`;
}

function renderProjects() {
  const el = $("#panel-projects");
  const list = [...(state?.projects || [])].sort((a, b) => {
    const ac = isProjectMarkedComplete(a);
    const bc = isProjectMarkedComplete(b);
    if (ac !== bc) return ac ? 1 : -1;
    return String(a.name).localeCompare(String(b.name), "en");
  });
  if (!list.length) {
    el.innerHTML = `<div class="empty">No projects yet.</div>`;
    return;
  }
  el.innerHTML = `
    <div class="project-list">
      ${list
        .map((p) => {
          const target = p.target || 0;
          const done = p.done_sum || 0;
          const remain = target > 0 ? Math.max(0, target - done) : null;
          const pct = target > 0 ? Math.min(100, (100 * done) / target) : 0;
          const myId = me?.intern_id;
          const unit = projectUnit(p);
          const markedComplete = isProjectMarkedComplete(p);
          return `
          <article class="project-card${markedComplete ? " is-completed" : ""}">
            ${markedComplete ? projectSealHtml() : ""}
            <header class="project-card-head">
              <div class="proj-head-row">
                <span class="proj-tag ${tagClass(p.id, p.name)}">${e(p.name)}</span>
              </div>
              ${
                p.description
                  ? `<p class="meta project-card-meta">${e(p.description)}</p>`
                  : ""
              }
            </header>
            <div class="big-stats">
              <div><span class="k">累计完成</span><strong>${fmtNum(done)}</strong><span class="unit">${unit}</span></div>
              <div><span class="k">还剩</span><strong>${remain === null ? "—" : fmtNum(remain)}</strong><span class="unit">${unit}</span></div>
              <div><span class="k">总量</span><strong>${target ? fmtNum(target) : "—"}</strong><span class="unit">${unit}</span></div>
            </div>
            <div class="bar"><i style="width:${pct}%"></i></div>
            <p class="meta">${target ? pct.toFixed(1) + "% Done" : `No total ${unit} set`}</p>
            ${peopleBarsHtml(p.people, unit, myId)}
          </article>`;
        })
        .join("")}
    </div>`;
}

function renderProjMgmt() {
  const el = $("#panel-projmgmt");
  if (!el) return;
  if (!isAdmin()) {
    el.innerHTML = "";
    return;
  }
  const doneMap = Object.fromEntries(
    (state?.projects || []).map((p) => [p.id, p.done_sum || 0])
  );
  const showOff = Boolean(renderProjMgmt._showOff);
  const list = [...(allProjects || [])]
    .filter((p) => showOff || Number(p.active) === 1)
    .sort((a, b) => {
      const ac = isProjectMarkedComplete(a);
      const bc = isProjectMarkedComplete(b);
      if (ac !== bc) return ac ? 1 : -1;
      if (Boolean(a.active) !== Boolean(b.active)) return a.active ? -1 : 1;
      return String(a.name).localeCompare(String(b.name), "en");
    });
  const offCount = (allProjects || []).filter((p) => Number(p.active) !== 1).length;

  el.innerHTML = `
    <div class="projmgmt">
      <article class="project-card projmgmt-add">
        <h3>New project</h3>
        <p class="hint">Set name, unit, and total target.</p>
        <div class="projmgmt-form">
          <label class="field-label">Project name
            <input id="pmNewName" placeholder="e.g.  Student Speech（ASR） Check">
          </label>
          <label class="field-label">Unit
            <select id="pmNewUnit">
              <option value="clips">clips</option>
              <option value="items">items</option>
            </select>
          </label>
          <label class="field-label">Total target
            <input id="pmNewTarget" type="number" min="0" step="1" placeholder="如 9700">
          </label>
          <label class="field-label">Description
            <input id="pmNewDesc" placeholder="optional">
          </label>
          <label class="field-label projmgmt-url">Platform URL
            <input id="pmNewUrl" type="url" placeholder="https://… optional，Annotator可a bit直达">
          </label>
          <label class="field-label projmgmt-url">Online doc URL
            <input id="pmNewDoc" type="url" placeholder="https://… doc URL">
          </label>
          <label class="field-label projmgmt-url">QC results (online doc)
            <input id="pmNewQc" type="url" placeholder="https://… QC doc">
          </label>
          <button type="button" class="btn" id="pmAddBtn">Add</button>
        </div>
        <div class="projmgmt-toolbar">
          <label class="pm-active">
            <input type="checkbox" id="pmShowOff" ${showOff ? "checked" : ""}>
            Show inactive (${offCount}）
          </label>
          <p class="dlg-msg" id="pmMsg" style="padding:0;min-height:1.1em"></p>
        </div>
      </article>
      <div class="projmgmt-list">
        ${
          list.length
            ? list
                .map((p) => {
                  const done = doneMap[p.id] ?? 0;
                  const target = Number(p.target_total || 0);
                  const pct =
                    target > 0 ? Math.min(100, (100 * done) / target).toFixed(1) : "—";
                  const on = Number(p.active) === 1;
                  const finished = isProjectMarkedComplete(p);
                  const unit = projectUnit(p);
                  return `
              <article class="project-card projmgmt-card ${on ? "" : "is-off"}${finished ? " is-completed" : ""}" data-pid="${p.id}">
                ${finished ? projectSealHtml() : ""}
                <header class="projmgmt-head">
                  <div class="proj-head-row">
                    <span class="proj-tag ${tagClass(p.id, p.name)}">${e(p.name)}</span>
                  </div>
                  <span class="meta project-card-meta">${on ? "" : "Inactive · "}${finished ? "Marked complete · " : ""}累计 ${fmtNum(done)}${target ? ` / ${fmtNum(target)}` : ""} ${unit}${target ? `（${pct}%）` : ""}</span>
                </header>
                <div class="projmgmt-form">
                  <label class="field-label">项目名
                    <input class="pm-name" value="${e(p.name)}">
                  </label>
                  <label class="field-label">单位
                    <select class="pm-unit">
                      <option value="clips" ${unit === "clips" ? "selected" : ""}>节</option>
                      <option value="items" ${unit === "items" ? "selected" : ""}>条</option>
                    </select>
                  </label>
                  <label class="field-label">最终总量
                    <input class="pm-target" type="number" min="0" step="1" value="${target}">
                  </label>
                  <label class="field-label">说明
                    <input class="pm-desc" value="${e(p.description || "")}">
                  </label>
                  <label class="field-label projmgmt-url">标注平台链接
                    <input class="pm-url" type="url" value="${e(p.platform_url || "")}" placeholder="https://…">
                  </label>
                  <label class="field-label projmgmt-url">Guidelines (online doc)
                    <input class="pm-doc" type="url" value="${e(p.doc_url || "")}" placeholder="https://…">
                  </label>
                  <label class="field-label projmgmt-url">QC results (online doc)
                    <input class="pm-qc" type="url" value="${e(p.qc_url || "")}" placeholder="https://…">
                  </label>
                  <label class="pm-active">
                    <input type="checkbox" class="pm-on" ${on ? "checked" : ""}>
                    启用
                  </label>
                  <label class="pm-active">
                    <input type="checkbox" class="pm-done" ${finished ? "checked" : ""} ${on ? "" : "disabled"}>
                    标记结项
                  </label>
                </div>
                <div class="projmgmt-actions">
                  <button type="button" class="btn sm pm-save">保存</button>
                  ${
                    on
                      ? `<button type="button" class="btn ghost sm pm-del">Disable</button>`
                      : `<button type="button" class="btn sm pm-restore">Re-enable</button>`
                  }
                </div>
              </article>`;
                })
                .join("")
            : `<div class="empty">${showOff ? "No projects yet." : "No active projects. Enable “Show inactive” above."}</div>`
        }
      </div>
    </div>`;

  if (isReadonlyAdmin()) {
    el.querySelector(".projmgmt-add")?.remove();
    el.querySelectorAll("input, select, button").forEach((n) => {
      n.disabled = true;
    });
    el.querySelectorAll(".projmgmt-actions").forEach((n) => n.remove());
    const banner = document.createElement("p");
    banner.className = "hint";
    banner.style.margin = "0 0 .5rem";
    banner.textContent = "Read-only admin: view projects only.";
    el.querySelector(".projmgmt")?.prepend(banner);
    $("#pmShowOff")?.addEventListener("change", (ev) => {
      renderProjMgmt._showOff = ev.target.checked;
      renderProjMgmt();
    });
    return;
  }

  $("#pmShowOff")?.addEventListener("change", (ev) => {
    renderProjMgmt._showOff = ev.target.checked;
    renderProjMgmt();
  });

  $("#pmAddBtn")?.addEventListener("click", async () => {
    const name = $("#pmNewName").value.trim();
    if (!name) return alert("Please enter Project name");
    try {
      await api("/api/projects", {
        method: "POST",
        body: JSON.stringify({
          name,
          target_total: Number($("#pmNewTarget").value || 0),
          description: $("#pmNewDesc").value.trim(),
          unit: $("#pmNewUnit")?.value || "clips",
          platform_url: $("#pmNewUrl")?.value.trim() || "",
          doc_url: $("#pmNewDoc")?.value.trim() || "",
          qc_url: $("#pmNewQc")?.value.trim() || "",
        }),
      });
      $("#pmNewName").value = "";
      $("#pmNewTarget").value = "";
      $("#pmNewDesc").value = "";
      if ($("#pmNewUrl")) $("#pmNewUrl").value = "";
      if ($("#pmNewDoc")) $("#pmNewDoc").value = "";
      if ($("#pmNewQc")) $("#pmNewQc").value = "";
      if ($("#pmNewUnit")) $("#pmNewUnit").value = "clips";
      await loadAll();
      activateTab("projmgmt");
      msg("#pmMsg", "Added");
    } catch (err) {
      alert(err.message);
    }
  });

  el.querySelectorAll(".pm-on").forEach((chk) => {
    chk.addEventListener("change", (ev) => {
      const card = ev.target.closest(".projmgmt-card");
      const doneChk = card?.querySelector(".pm-done");
      if (!doneChk) return;
      if (!ev.target.checked) {
        doneChk.checked = false;
        doneChk.disabled = true;
      } else {
        doneChk.disabled = false;
      }
    });
  });

  el.querySelectorAll(".pm-save").forEach((btn) => {
    btn.addEventListener("click", async (ev) => {
      ev.preventDefault();
      const card = btn.closest(".projmgmt-card");
      if (!card) return;
      const pid = Number(card.dataset.pid);
      if (!pid) return alert("Project id Invalid");
      try {
        await api("/api/projects/update", {
          method: "POST",
          body: JSON.stringify({
            project_id: pid,
            name: card.querySelector(".pm-name").value.trim(),
            target_total: Number(card.querySelector(".pm-target").value || 0),
            description: card.querySelector(".pm-desc").value.trim(),
            unit: card.querySelector(".pm-unit")?.value || "clips",
            active: card.querySelector(".pm-on").checked,
            completed: card.querySelector(".pm-done")?.checked || false,
            platform_url: card.querySelector(".pm-url")?.value.trim() || "",
            doc_url: card.querySelector(".pm-doc")?.value.trim() || "",
            qc_url: card.querySelector(".pm-qc")?.value.trim() || "",
          }),
        });
        await loadAll();
        activateTab("projmgmt");
        msg("#pmMsg", "Saved");
      } catch (err) {
        alert(err.message);
      }
    });
  });

  el.querySelectorAll(".pm-del").forEach((btn) => {
    btn.addEventListener("click", async (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const card = btn.closest(".projmgmt-card");
      if (!card) return;
      const pid = Number(card.dataset.pid);
      const name = card.querySelector(".pm-name")?.value || "This project";
      if (!pid) return alert("Project id Invalid");
      if (!confirm(`Disable project “${name}”?\nIt will leave assignments; history is kept.`)) {
        return;
      }
      btn.disabled = true;
      try {
        await api("/api/projects/delete", {
          method: "POST",
          body: JSON.stringify({ project_id: pid }),
        });
        await loadAll();
        activateTab("projmgmt");
        msg("#pmMsg", `Inactive「${name}」`);
      } catch (err) {
        alert(err.message);
        btn.disabled = false;
      }
    });
  });

  el.querySelectorAll(".pm-restore").forEach((btn) => {
    btn.addEventListener("click", async (ev) => {
      ev.preventDefault();
      const card = btn.closest(".projmgmt-card");
      if (!card) return;
      const pid = Number(card.dataset.pid);
      try {
        await api("/api/projects/update", {
          method: "POST",
          body: JSON.stringify({
            project_id: pid,
            name: card.querySelector(".pm-name").value.trim(),
            target_total: Number(card.querySelector(".pm-target").value || 0),
            description: card.querySelector(".pm-desc").value.trim(),
            unit: card.querySelector(".pm-unit")?.value || "clips",
            active: true,
            completed: card.querySelector(".pm-done")?.checked || false,
            platform_url: card.querySelector(".pm-url")?.value.trim() || "",
            doc_url: card.querySelector(".pm-doc")?.value.trim() || "",
            qc_url: card.querySelector(".pm-qc")?.value.trim() || "",
          }),
        });
        await loadAll();
        activateTab("projmgmt");
        msg("#pmMsg", "Re-enabled");
      } catch (err) {
        alert(err.message);
      }
    });
  });
}

function fillManageSelects() {
  const listEl = $("#userList");
  if (!listEl) return;

  const byIntern = Object.fromEntries(
    users.filter((u) => u.intern_id).map((u) => [u.intern_id, u])
  );
  const showLeft = Boolean(fillManageSelects._showLeft);
  const leftCount = (interns || []).filter((i) => Number(i.active) !== 1).length;
  // 管理员兼岗只在下方管理员区显示，不混进组员列表
  const adminInternIds = new Set(
    users.filter((u) => u.role === "admin" && u.intern_id).map((u) => Number(u.intern_id))
  );
  const visibleInterns = [...(interns || [])]
    .filter((i) => {
      if (adminInternIds.has(Number(i.id))) return false;
      return showLeft || Number(i.active) === 1;
    })
    .sort((a, b) => {
      if (Boolean(a.active) !== Boolean(b.active)) return a.active ? -1 : 1;
      const ga = teamGroupSortKey(a.team_group);
      const gb = teamGroupSortKey(b.team_group);
      if (ga !== gb) return ga - gb;
      return String(a.name || "").localeCompare(String(b.name || ""), "en");
    });

  const internRows = visibleInterns.map((i) => {
    const u = byIntern[i.id];
    const on = Number(i.active) === 1;
    const g = normalizeTeamGroup(i.team_group);
    const wm = normalizeWorkMode(i.work_mode) === "onsite" ? "onsite" : "online";
    const status = on ? "" : `<span class="meta user-left-tag">Left</span>`;
    const groupSelect = `<label class="team-select-wrap" title="Team">
      <select class="team-select" data-iid="${i.id}">
        <option value="" ${!g ? "selected" : ""}>Unassigned</option>
        <option value="A" ${g === "A" ? "selected" : ""}>Team A</option>
        <option value="B" ${g === "B" ? "selected" : ""}>Team B</option>
      </select>
    </label>`;
    const modeSelect = `<label class="team-select-wrap" title="Work mode">
      <select class="work-mode-select" data-iid="${i.id}">
        <option value="online" ${wm === "online" ? "selected" : ""}>online</option>
        <option value="onsite" ${wm === "onsite" ? "selected" : ""}>onsite</option>
      </select>
    </label>`;
    const leaveBtn = on
      ? `<button type="button" class="btn ghost user-leave">Left</button>`
      : `<button type="button" class="btn ghost user-restore">Restore active</button>`;
    if (u) {
      const gaOn = Boolean(Number(u.group_admin || 0));
      const oaOn = Boolean(Number(u.online_admin || 0));
      const gaToggle = on
        ? `<label class="pm-active ga-toggle" title="Group lead: read-only team attendance & completion">
            <input type="checkbox" class="user-group-admin" data-uid="${u.id}" ${
              gaOn ? "checked" : ""
            } ${g === "A" || g === "B" ? "" : "disabled"}>
            Group lead
          </label>`
        : "";
      const oaToggle = on
        ? `<label class="pm-active ga-toggle" title="Online lead: read-only attendance & completion for all online in A/B">
            <input type="checkbox" class="user-online-admin" data-uid="${u.id}" ${
              oaOn ? "checked" : ""
            }>
            Online lead
          </label>`
        : "";
      return `<div class="user-row${on ? "" : " is-left"}" data-uid="${u.id}" data-iid="${i.id}">
        <div class="user-row-id">
          <strong>${e(displayName(i.name))}</strong>
          <code>${e(u.username)}</code>
          ${oaOn ? `<span class="meta">线上管理</span>` : gaOn ? `<span class="meta">组内管理</span>` : ""}
          ${status}
        </div>
        <div class="user-row-actions">
          ${groupSelect}
          ${modeSelect}
          ${gaToggle}
          ${oaToggle}
          ${leaveBtn}
          <button type="button" class="btn ghost user-reset">Password</button>
          <button type="button" class="btn ghost user-del">Delete account</button>
        </div>
      </div>`;
    }
    return `<div class="user-row${on ? "" : " is-left"}" data-iid="${i.id}">
      <div class="user-row-id">
        <strong>${e(displayName(i.name))}</strong>
        <span class="meta">No login yet</span>
        ${status}
      </div>
      <div class="user-row-actions">
        ${groupSelect}
        ${modeSelect}
        ${leaveBtn}
        ${on ? `<button type="button" class="btn ghost user-bind">设账号</button>` : ""}
      </div>
    </div>`;
  });
  const adminRows = users
    .filter((u) => u.role === "admin")
    .map((u) => {
      const canDel = !(me && u.id === me.id);
      const label = u.display_name || "Admin";
      const workTag = u.intern_id
        ? ` · <span class="meta">Can submit</span>`
        : "";
      return `<div class="user-row" data-uid="${u.id}">
        <div class="user-row-id">
          <strong>${e(displayName(label))}</strong>
          <span class="meta">Admin</span>
          ${workTag}
          <code>${e(u.username)}</code>
        </div>
        <div class="user-row-actions">
          <button type="button" class="btn ghost user-reset">Password</button>
          ${
            canDel
              ? `<button type="button" class="btn ghost user-del">删除账号</button>`
              : ""
          }
        </div>
      </div>`;
    });

  listEl.innerHTML =
    `<p class="hint" style="margin-top:.5rem">${
      isReadonlyAdmin()
        ? "Read-only admin: view people only."
        : "After leave they leave attendance/assignments; history is kept."
    }</p>` +
    `<label class="pm-active" style="margin:.35rem 0 .55rem;display:inline-flex">
      <input type="checkbox" id="showLeftInterns" ${showLeft ? "checked" : ""}>
      Show left (${leftCount}）
    </label>` +
    (internRows.length || adminRows.length
      ? adminRows.concat(internRows).join("")
      : `<p class="meta">None</p>`);

  if (isReadonlyAdmin()) {
    listEl.querySelectorAll(".user-row-actions").forEach((n) => {
      n.querySelectorAll("button").forEach((b) => b.remove());
      n.querySelectorAll("select, input").forEach((inp) => {
        inp.disabled = true;
      });
    });
    // 隐藏「添加账号」表单控件，保留人员列表
    [
      "#accRole", "#accAlsoWorkWrap", "#newIntern", "#newTeamGroupWrap",
      "#newWorkModeWrap", "#accGroupAdminWrap", "#accUser", "#accPass", "#addInternBtn",
    ].forEach((sel) => {
      const n = document.querySelector(sel);
      if (n) n.style.display = "none";
    });
    const hint = document.querySelector("#manageDialog .dlg-grid fieldset > .hint");
    if (hint) hint.textContent = "Read-only admin: view people list; cannot add or edit accounts.";
  }

  const showLeftEl = $("#showLeftInterns");
  if (showLeftEl) {
    showLeftEl.addEventListener("change", () => {
      fillManageSelects._showLeft = showLeftEl.checked;
      fillManageSelects();
    });
  }

  listEl.querySelectorAll(".team-select").forEach((sel) => {
    sel.addEventListener("change", async () => {
      const iid = Number(sel.dataset.iid);
      const team_group = sel.value || "";
      try {
        await api("/api/interns/group", {
          method: "POST",
          body: JSON.stringify({ intern_id: iid, team_group }),
        });
        const row = interns.find((x) => Number(x.id) === iid);
        if (row) row.team_group = team_group;
        msg("#dlgMsg", `Set to ${teamGroupLabel(team_group)}`);
        await loadAll();
        fillManageSelects();
      } catch (err) {
        alert(err.message);
        fillManageSelects();
      }
    });
  });

  listEl.querySelectorAll(".work-mode-select").forEach((sel) => {
    sel.addEventListener("change", async () => {
      const iid = Number(sel.dataset.iid);
      const work_mode = sel.value || "online";
      try {
        await api("/api/interns/work-mode", {
          method: "POST",
          body: JSON.stringify({ intern_id: iid, work_mode }),
        });
        const row = interns.find((x) => Number(x.id) === iid);
        if (row) row.work_mode = work_mode === "onsite" ? "onsite" : "remote";
        msg("#dlgMsg", `Set to  ${work_mode === "onsite" ? "onsite" : "online"}`);
        await loadAll();
        fillManageSelects();
      } catch (err) {
        alert(err.message);
        fillManageSelects();
      }
    });
  });

  listEl.querySelectorAll(".user-group-admin").forEach((chk) => {
    chk.addEventListener("change", async () => {
      const uid = Number(chk.dataset.uid);
      const group_admin = Boolean(chk.checked);
      try {
        await api("/api/users/group-admin", {
          method: "POST",
          body: JSON.stringify({ user_id: uid, group_admin }),
        });
        const u = users.find((x) => Number(x.id) === uid);
        if (u) {
          u.group_admin = group_admin ? 1 : 0;
          if (group_admin) u.online_admin = 0;
        }
        msg("#dlgMsg", group_admin ? "Set to Group lead" : "Group lead removed");
        fillManageSelects();
      } catch (err) {
        alert(err.message);
        fillManageSelects();
      }
    });
  });

  listEl.querySelectorAll(".user-online-admin").forEach((chk) => {
    chk.addEventListener("change", async () => {
      const uid = Number(chk.dataset.uid);
      const online_admin = Boolean(chk.checked);
      try {
        await api("/api/users/online-admin", {
          method: "POST",
          body: JSON.stringify({ user_id: uid, online_admin }),
        });
        const u = users.find((x) => Number(x.id) === uid);
        if (u) {
          u.online_admin = online_admin ? 1 : 0;
          if (online_admin) u.group_admin = 0;
        }
        msg("#dlgMsg", online_admin ? "Set to Online lead" : "Online lead removed");
        fillManageSelects();
      } catch (err) {
        alert(err.message);
        fillManageSelects();
      }
    });
  });

  listEl.querySelectorAll(".user-leave").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const row = btn.closest(".user-row");
      const name = row?.querySelector("strong")?.textContent || "this annotator";
      if (
        !confirm(
          `Mark “${name}” as left?\nHistory is kept, but they leave attendance and assignments.`
        )
      )
        return;
      try {
        await api("/api/interns/active", {
          method: "POST",
          body: JSON.stringify({
            intern_id: Number(row.dataset.iid),
            active: false,
          }),
        });
        msg("#dlgMsg", `Marked “${name}” as left`);
        await loadAll();
      } catch (err) {
        alert(err.message);
      }
    });
  });

  listEl.querySelectorAll(".user-restore").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const row = btn.closest(".user-row");
      const name = row?.querySelector("strong")?.textContent || "this annotator";
      try {
        await api("/api/interns/active", {
          method: "POST",
          body: JSON.stringify({
            intern_id: Number(row.dataset.iid),
            active: true,
          }),
        });
        msg("#dlgMsg", `Restored “${name}” to active`);
        await loadAll();
      } catch (err) {
        alert(err.message);
      }
    });
  });

  listEl.querySelectorAll(".user-del").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const row = btn.closest(".user-row");
      const name = row?.querySelector("code")?.textContent || "This username";
      if (!confirm(`Delete account “${name}”? The annotator will be marked left; history is kept.`))
        return;
      try {
        await api("/api/users/delete", {
          method: "POST",
          body: JSON.stringify({ user_id: Number(row.dataset.uid) }),
        });
        msg("#dlgMsg", "Deleted");
        await loadAll();
      } catch (err) {
        alert(err.message);
      }
    });
  });

  listEl.querySelectorAll(".user-reset").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const row = btn.closest(".user-row");
      const username = row?.querySelector("code")?.textContent || "";
      const pw = prompt(`为「${username}」设置New password (min 4)：`);
      if (pw == null) return;
      if (pw.length < 4) {
        alert("Passwordat least  4 位");
        return;
      }
      const isAdminRow = row?.querySelector("strong")?.textContent === "Admin";
      const iid = row?.dataset.iid;
      try {
        await api("/api/users", {
          method: "POST",
          body: JSON.stringify(
            isAdminRow
              ? { role: "admin", username, password: pw }
              : {
                  role: "intern",
                  intern_id: Number(iid),
                  username,
                  password: pw,
                }
          ),
        });
        msg("#dlgMsg", "Password updated");
        await loadAll();
      } catch (err) {
        alert(err.message);
      }
    });
  });

  listEl.querySelectorAll(".user-bind").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const row = btn.closest(".user-row");
      const name = row?.querySelector("strong")?.textContent || "";
      const username = prompt(`为「${name}」设置Username：`);
      if (username == null || !username.trim()) return;
      const pw = prompt("设置Password (min 4)：");
      if (pw == null) return;
      if (pw.length < 4) {
        alert("Passwordat least  4 位");
        return;
      }
      try {
        await api("/api/users", {
          method: "POST",
          body: JSON.stringify({
            role: "intern",
            intern_id: Number(row.dataset.iid),
            username: username.trim(),
            password: pw,
          }),
        });
        msg("#dlgMsg", "Login created");
        await loadAll();
      } catch (err) {
        alert(err.message);
      }
    });
  });
}

function msg(id, t) {
  const el = $(id);
  el.textContent = t;
  setTimeout(() => {
    if (el.textContent === t) el.textContent = "";
  }, 3200);
}

$$(".tab").forEach((tab) => {
  tab.addEventListener("click", () => activateTab(tab.dataset.tab));
});

$("#loginForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  $("#loginErr").textContent = "";
  try {
    const data = await api("/api/login", {
      method: "POST",
      body: JSON.stringify({
        username: $("#loginUser").value.trim(),
        password: $("#loginPass").value,
      }),
    });
    me = data.user;
    $("#loginPass").value = "";
    showApp();
    await loadAll();
  } catch (err) {
    $("#loginErr").textContent = err.message;
  }
});

$("#refreshBtn").addEventListener("click", () => loadAll().catch((err) => alert(err.message)));
$("#manageBtn").addEventListener("click", () => {
  fillManageSelects();
  $("#manageDialog").showModal();
});
$("#pwdBtn").addEventListener("click", () => $("#pwdDialog").showModal());
$("#logoutBtn").addEventListener("click", async () => {
  try {
    await api("/api/logout", { method: "POST", body: "{}" });
  } catch (_) {}
  showLogin();
});

$("#accRole")?.addEventListener("change", () => {
  const wrap = $("#accAlsoWorkWrap");
  const teamWrap = $("#newTeamGroupWrap");
  const modeWrap = $("#newWorkModeWrap");
  const gaWrap = $("#accGroupAdminWrap");
  if (!wrap) return;
  const isAdm = $("#accRole").value === "admin";
  wrap.style.display = isAdm ? "" : "none";
  if (teamWrap) teamWrap.style.display = isAdm ? "none" : "";
  if (modeWrap) modeWrap.style.display = isAdm ? "none" : "";
  if (gaWrap) gaWrap.style.display = isAdm ? "none" : "";
  if (!isAdm && $("#accAlsoWork")) $("#accAlsoWork").checked = false;
  if (isAdm && $("#accGroupAdmin")) $("#accGroupAdmin").checked = false;
});

$("#addInternBtn").addEventListener("click", async () => {
  const role = $("#accRole")?.value === "admin" ? "admin" : "intern";
  const name = $("#newIntern").value.trim();
  const username = $("#accUser").value.trim();
  const password = $("#accPass").value;
  const team_group = $("#newTeamGroup")?.value || "";
  const work_mode = $("#newWorkMode")?.value || "online";
  if (!name) {
    alert(role === "admin" ? "Please enter AdminName" : "Please enter Name");
    return;
  }
  if (!username) {
    alert("Please enter Username");
    return;
  }
  if (password.length < 4) {
    alert("Passwordat least  4 位");
    return;
  }
  try {
    if (role === "admin") {
      await api("/api/users", {
        method: "POST",
        body: JSON.stringify({
          role: "admin",
          username,
          password,
          display_name: name,
          also_work: Boolean($("#accAlsoWork")?.checked),
        }),
      });
      msg(
        "#dlgMsg",
        $("#accAlsoWork")?.checked
          ? `Added admin ${name}（Can submit）`
          : `Added admin ${name}`
      );
    } else {
      await api("/api/interns", {
        method: "POST",
        body: JSON.stringify({
          name,
          username,
          password,
          team_group,
          work_mode,
          group_admin: Boolean($("#accGroupAdmin")?.checked),
        }),
      });
      const modeTxt = normalizeWorkMode(work_mode) === "onsite" ? "onsite" : "online";
      msg(
        "#dlgMsg",
        team_group
          ? `Added annotator ${name}（${teamGroupLabel(team_group)} · ${modeTxt}）`
          : `Added annotator ${name}（${modeTxt}）`
      );
    }
    $("#newIntern").value = "";
    $("#accUser").value = "";
    $("#accPass").value = "";
    if ($("#newTeamGroup")) $("#newTeamGroup").value = "";
    if ($("#newWorkMode")) $("#newWorkMode").value = "online";
    if ($("#accRole")) $("#accRole").value = "intern";
    if ($("#accAlsoWork")) $("#accAlsoWork").checked = false;
    if ($("#accGroupAdmin")) $("#accGroupAdmin").checked = false;
    if ($("#accAlsoWorkWrap")) $("#accAlsoWorkWrap").style.display = "none";
    if ($("#newTeamGroupWrap")) $("#newTeamGroupWrap").style.display = "";
    if ($("#newWorkModeWrap")) $("#newWorkModeWrap").style.display = "";
    await loadAll();
  } catch (err) {
    alert(err.message);
  }
});

$("#savePwdBtn").addEventListener("click", async () => {
  try {
    await api("/api/change-password", {
      method: "POST",
      body: JSON.stringify({
        old_password: $("#oldPass").value,
        new_password: $("#newPass").value,
      }),
    });
    $("#oldPass").value = "";
    $("#newPass").value = "";
    msg("#pwdMsg", "Password updated");
  } catch (err) {
    alert(err.message);
  }
});

$("#makeupDay")?.addEventListener("change", () => {
  refreshMakeupOptions().catch((err) => alert(err.message));
});
$("#makeupProject")?.addEventListener("change", () => applyMakeupProject());
$("#makeupSubmitBtn")?.addEventListener("click", async () => {
  const day = $("#makeupDay").value;
  const project_id = Number($("#makeupProject").value);
  const done = Number($("#makeupDone").value || 0);
  const unit = $("#makeupUnit").value || "clips";
  if (!day || !project_id) {
    alert("请选择Date和Project");
    return;
  }
  if (!me?.intern_id) {
    alert("Account is not linked to an annotator");
    return;
  }
  const btn = $("#makeupSubmitBtn");
  btn.disabled = true;
  try {
    const res = await api("/api/daily", {
      method: "POST",
      body: JSON.stringify({
        intern_id: Number(me.intern_id),
        project_id,
        day,
        done,
        assigned: done,
        unit,
        makeup: true,
      }),
    });
    showFeedback(res.feedback);
    msg("#makeupMsg", res.feedback?.message || "MakeupSuccess");
    await refreshMakeupOptions();
    await loadAll();
    if (!isAdmin()) activateTab("today");
  } catch (err) {
    alert(err.message);
  } finally {
    btn.disabled = false;
  }
});

boot();

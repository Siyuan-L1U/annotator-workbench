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
  if (iso === t) return "今天";
  if (iso === addDaysISO(t, 1)) return "明天";
  if (iso === addDaysISO(t, -1)) return "昨天";
  return iso;
};
const WEEKDAY_CN = ["日", "一", "二", "三", "四", "五", "六"];
const dayFullLabel = (iso) => {
  const d = new Date(`${iso}T12:00:00`);
  const wd = WEEKDAY_CN[d.getDay()];
  const rel = dayRelLabel(iso);
  return rel === iso ? `${iso}（周${wd}）` : `${rel} · ${iso}（周${wd}）`;
};
const STATUS_LABELS = {
  present: "出勤",
  leave_half: "半天",
  leave: "请假",
  unset: "未填",
};
const STATUS_ORDER = ["present", "leave_half", "leave"];
const STATUS_CYCLE = ["present", "leave_half", "leave"];
const ATT_STATUS_OPTIONS = [
  ["unset", "未填"],
  ["present", "出勤"],
  ["leave_half", "半天"],
  ["leave", "请假"],
];
function statusSelectHtml(status, { className = "att-select", disabled = false, attrs = "" } = {}) {
  const st = STATUS_LABELS[status] ? status : "unset";
  // 「未填」仅作初始占位；已选出勤/半天/请假后不可再选回未填
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
  return `<span class="wl-chip att-status-chip ${cls}">${STATUS_LABELS[st] || "未填"}</span>`;
}
let assignmentsList = [];
let attendance = null;
let attendanceWeek = null; // 出勤页当前周（周一）
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
const projectUnit = (p) => (p?.unit === "条" ? "条" : "节");
/** 管理员在项目管理里勾选的「已结项」，与累计完成量无关 */
const isProjectMarkedComplete = (p) =>
  p?.marked_complete === true || Number(p?.completed) === 1;
function projectSealHtml() {
  return `<div class="proj-seal" aria-label="已结项"><span>已结项</span></div>`;
}
const normalizeTeamGroup = (g) => {
  const v = String(g || "").trim().toUpperCase();
  return v === "A" || v === "B" ? v : "";
};
const teamGroupLabel = (g) => {
  const v = normalizeTeamGroup(g);
  if (v === "A") return "A组";
  if (v === "B") return "B组";
  return "未分组";
};
const teamGroupSortKey = (g) => {
  const v = normalizeTeamGroup(g);
  if (v === "A") return 0;
  if (v === "B") return 1;
  return 2;
};
const teamGroupBadge = (g) => {
  const v = normalizeTeamGroup(g);
  if (!v) return `<span class="team-badge none" title="未分组">—</span>`;
  return `<span class="team-badge team-${v.toLowerCase()}" title="${v}组">${v}</span>`;
};
const normalizeWorkMode = (m) => {
  const v = String(m || "").trim().toLowerCase();
  if (v === "onsite" || v === "现场" || v === "现场办公") return "onsite";
  if (v === "remote" || v === "online" || v === "线上" || v === "远程") return "remote";
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
  // 管理员兼岗不计出勤，也不显示 online/onsite
  if (row?.skip_attendance) return team;
  return `${team}${workModeBadge(row?.work_mode)}`;
};
const platformLinkHtml = (url, { compact = false, label } = {}) => {
  const href = String(url || "").trim();
  if (!/^https?:\/\//i.test(href)) return "";
  const text = label || (compact ? "标注" : "打开标注平台");
  return `<a class="platform-link${compact ? " compact" : ""}" href="${e(
    href
  )}" target="_blank" rel="noopener noreferrer">${e(text)}</a>`;
};
const docLinkHtml = (url, { compact = false, label } = {}) => {
  const href = String(url || "").trim();
  if (!/^https?:\/\//i.test(href)) return "";
  const text = label || (compact ? "规范" : "标注规范");
  return `<a class="doc-link${compact ? " compact" : ""}" href="${e(
    href
  )}" target="_blank" rel="noopener noreferrer">${e(text)}</a>`;
};
const qcLinkHtml = (url, { compact = false, label } = {}) => {
  const href = String(url || "").trim();
  if (!/^https?:\/\//i.test(href)) return "";
  const text = label || (compact ? "质检" : "质检结果");
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
  if (name.includes("质检")) return "c2";
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
  toast.textContent = feedback.message || "已保存";
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
    showLogin(body.detail || "请先登录");
    throw new Error(body.detail || "请先登录");
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
    // 管理员：工作台 → 出勤 → 日期面板 → 任务分配 → …
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
    // 组内/线上管理：出勤、任务完成紧跟工作台
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
      ? "管理员 · 只读"
      : hasInternWork()
        ? "管理员 · 可交任务"
        : "管理员"
    : isOnlineAdmin()
      ? "组员 · 线上管理"
      : isGroupAdmin()
        ? "组员 · 组内管理"
        : "组员";
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
  if (projTab) projTab.textContent = "项目总量";
  const dayviewTab = document.querySelector('.tab[data-tab="dayview"]');
  if (dayviewTab && isScopeAdmin() && !isAdmin()) {
    dayviewTab.textContent = "任务完成";
  } else if (dayviewTab) {
    dayviewTab.textContent = "日期面板";
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
    el.innerHTML = `<div class="empty">加载工作台…</div>`;
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
  const greetingName = displayName(info.intern_name || me?.display_name || "同学");
  const groupTag = info.team_group ? teamGroupBadge(info.team_group) : "";
  const workTag =
    info.intern_id && !skipAtt ? workModeBadge(info.work_mode) : "";

  const isRestDay = !(hub.week_days || []).includes(day);
  const onLeave = att === "leave";
  const shortOfQuota = tasks.some(
    (t) => t.submitted && Number(t.quota || 0) > 0 && !t.met
  );
  let cheer = "全部完成，干得漂亮。";
  if (!skipAtt && (onLeave || isRestDay)) {
    cheer = "好好休息。";
  } else if (pending > 0) {
    cheer = "任务还没提交，加油完成今天的配额。";
  } else if (shortOfQuota) {
    cheer = "继续加油，再补一点就达标了。";
  } else if (isAdmin() && !tasks.length) {
    cheer = "今天也关注一下同学的出勤和任务安排吧。";
  }

  const weekStamp = `
    <div class="hub-week" aria-label="本周出勤">
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
                ? "出"
                : st === "leave_half"
                  ? "半"
                  : st === "leave"
                    ? "假"
                    : ""
            }</em>
          </div>`;
        })
        .join("")}
    </div>`;

  const taskCards = tasks.length
    ? `<section class="hub-section hub-today-card">
        <header class="hub-section-head">
          <h3>今日任务</h3>
        </header>
        <div class="hub-task-stack">${tasks
          .map((t) => {
            const unit = t.unit === "条" ? "条" : "节";
            const quota = Number(t.quota || 0);
            const done = t.submitted ? Number(t.done_today || 0) : 0;
            const platform = platformLinkHtml(t.platform_url, {
              label: "开始标注",
            });
            const doc = docLinkHtml(t.doc_url, { label: "查看规范" });
            const qc = qcLinkHtml(t.qc_url, { label: "质检结果" });
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
          <h3>今日任务</h3>
        </header>
        <p class="meta hub-today-empty">今天还没有分配任务，等管理员安排后会出现在这里。</p>
      </section>`;

  const fmtUnitTotal = (items) => {
    const list = (items || []).filter((x) => Number(x.amount || 0) > 0);
    if (!list.length) return "0 节";
    return list
      .map((x) => `${fmtNum(x.amount)} ${x.unit === "条" ? "条" : "节"}`)
      .join(" · ");
  };
  const adminProjects = summary?.projects || [];
  const adminCompareRows = adminProjects.length
    ? adminProjects
        .map((p) => {
          const unit = p.unit === "条" ? "条" : "节";
          return `<li>
            <span class="hub-admin-proj-name">${e(p.project_name)}</span>
            <span class="hub-admin-proj-amt is-assign">${fmtNum(p.assigned || 0)} ${unit}</span>
            <span class="hub-admin-proj-amt is-submit">${fmtNum(p.submitted || 0)} ${unit}</span>
          </li>`;
        })
        .join("")
    : `<li class="hub-admin-proj-empty"><span>今日尚未布置任务</span></li>`;
  const assignedTotalTxt = fmtUnitTotal(summary?.assigned_total);
  const submittedTotalTxt = fmtUnitTotal(summary?.submitted_total);
  const taskPeople = summary?.task_people || {};
  const taskPeopleBlock = `
    <div class="hub-admin-people-line" aria-label="今日任务人数">
      <span class="hub-admin-people-title">人数</span>
      <span class="hub-admin-people-item is-done">已完成 <strong>${taskPeople.done || 0}</strong></span>
      <span class="hub-admin-people-item is-incomplete">未完成 <strong>${taskPeople.incomplete || 0}</strong></span>
      <span class="hub-admin-people-item is-miss">未提交 <strong>${taskPeople.unsubmitted || 0}</strong></span>
    </div>`;
  const groupCounts = summary?.group_counts || {};
  const attTotal = summary?.counts || {};
  const adminGroupAtt = ["A", "B"]
    .map((g) => {
      const c = groupCounts[g] || {};
      return `
        <div class="hub-admin-group">
          <div class="hub-admin-group-label">${g}组</div>
          <div class="hub-admin-grid hub-admin-grid-3">
            <div class="hub-admin-stat present">
              <strong>${c.present || 0}</strong>
              <span>出勤</span>
            </div>
            <div class="hub-admin-stat half">
              <strong>${c.leave_half || 0}</strong>
              <span>半天</span>
            </div>
            <div class="hub-admin-stat leave">
              <strong>${c.leave || 0}</strong>
              <span>请假</span>
            </div>
          </div>
        </div>`;
    })
    .join("");
  const attTotalBlock = `
    <div class="hub-admin-people-line" aria-label="今日出勤合计">
      <span class="hub-admin-people-title">合计</span>
      <span class="hub-admin-people-item is-done">出勤 <strong>${attTotal.present || 0}</strong></span>
      <span class="hub-admin-people-item is-incomplete">半天 <strong>${attTotal.leave_half || 0}</strong></span>
      <span class="hub-admin-people-item is-miss">请假 <strong>${attTotal.leave || 0}</strong></span>
    </div>`;
  const adminBlock =
    isAdmin() && summary
      ? `
    <section class="hub-section hub-admin">
      <header class="hub-section-head hub-admin-head">
        <div>
          <h3>今日管理</h3>
          <p class="meta">${e(dayFullLabel(day))}</p>
        </div>
        <div class="hub-admin-headcount" title="未标记离职的在职组员（不含管理员）">
          <span>目前在职</span>
          <strong>${summary.active_interns || 0}</strong>
          <em>人</em>
          <span class="hub-admin-headcount-split">A组 <strong>${summary.active_by_group?.A || 0}</strong></span>
          <span class="hub-admin-headcount-split">B组 <strong>${summary.active_by_group?.B || 0}</strong></span>
        </div>
      </header>
      <div class="hub-admin-att-panel">
        <div class="hub-admin-att-head">
          <span class="hub-admin-compare-label">出勤</span>
        </div>
        <div class="hub-admin-att">
          ${adminGroupAtt}
        </div>
        ${attTotalBlock}
      </div>
      <div class="hub-admin-compare">
        <div class="hub-admin-compare-head">
          <span class="hub-admin-compare-label">任务</span>
          <span class="hub-admin-compare-col">布置<br><strong>${assignedTotalTxt}</strong></span>
          <span class="hub-admin-compare-col is-submit">已提交<br><strong>${submittedTotalTxt}</strong></span>
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
      ? "管理员"
      : "兼岗不计"
    : STATUS_LABELS[att] || "未填";

  el.innerHTML = `
    <div class="hub-page is-game">
      <section class="hub-hero hub-checkin ${allClear ? "cleared" : ""}">
        <div class="hub-hero-copy">
          <h2>
            你好，${e(greetingName)}
            ${groupTag}${workTag}
          </h2>
          <p class="hub-cheer">${e(cheer)}</p>
        </div>
        <div class="hub-hero-aside">
          <div class="hub-hero-meta">
            <span class="hub-hero-date">${e(dayFullLabel(day))}</span>
            <span class="hub-att-status ${attCls}" title="今日出勤状态（仅展示）">${e(attText)}</span>
          </div>
        </div>
      </section>

      ${
        skipAtt
          ? ""
          : `
      <section class="hub-section hub-week-card">
        <header class="hub-section-head">
          <h3>本周出勤</h3>
          <button type="button" class="btn ghost sm hub-go" data-tab="attendance">${
            isReadonlyAdmin() ? "查看" : "修改"
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
        ? "\ufffe请假"
        : aLeft
          ? "\ufffd离职"
          : aTasks.length
            ? aTasks.map((t) => t.project_name || "").sort().join(" · ")
            : "\uffff未分配";
    const bKey =
      b.status === "leave" && !bTasks.length
        ? "\ufffe请假"
        : bLeft
          ? "\ufffd离职"
          : bTasks.length
            ? bTasks.map((t) => t.project_name || "").sort().join(" · ")
            : "\uffff未分配";
    if (aKey !== bKey) return aKey.localeCompare(bKey, "zh");
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
    if (left) return "离职";
    if (r.status === "leave" && !tasks.length) return "请假";
    if (!tasks.length) return "未分配任务";
    return tasks
      .map((t) => t.project_name)
      .filter(Boolean)
      .sort((x, y) => String(x).localeCompare(String(y), "zh"))
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
        ? "离职"
        : r.skip_attendance
          ? "兼岗"
          : r.status === "present"
            ? "出勤"
            : r.status === "leave_half"
              ? "半天"
              : r.status === "leave"
                ? "请假"
                : "未填";
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
                const unit = t.unit === "条" ? "条" : "节";
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
                      ? `<button type="button" class="btn ghost sm admin-clear-done" title="删除提交，让对方重填">删提交</button>`
                      : ""
                  }
                </span>`;
              })
              .join("")}
          </div>`
        : left
          ? `<span class="meta">历史无当天任务</span>`
          : r.status === "leave"
            ? `<span class="meta">—</span>`
            : `<span class="meta">尚未分配任务</span>`;

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
          <span class="pill present">出勤 ${c.present || 0}</span>
          <span class="pill half">半天 ${c.leave_half || 0}</span>
          <span class="pill leave">请假 ${c.leave || 0}</span>
          <span class="pill unset">未填 ${c.unset || 0}</span>
          ${
            c.left
              ? `<span class="pill left">离职 ${c.left || 0}</span>`
              : ""
          }
        </div>
        <div class="day-jump">
          <button type="button" class="day-jump-btn ${day === yesterdayISO() ? "on" : ""}" data-jump="yesterday">昨天</button>
          <button type="button" class="day-jump-btn ${day === todayISO() ? "on" : ""}" data-jump="today">今天</button>
          <label class="day-picker">日期
            <input id="dayViewInput" type="date" value="${e(day)}">
          </label>
        </div>
      </div>
      <p class="hint" style="margin:0 0 .35rem">${
        isWriteAdmin()
          ? "填错时可点「删提交」，对方即可重新提交。"
          : isReadonlyAdmin()
            ? "只读查看：不能删提交或改任务。"
            : isOnlineAdmin()
              ? "只读查看 A/B 组全部 online 同学的任务完成（今日及之前）。"
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
              <th>人</th>
              <th>状态</th>
              <th>当天项目与提交</th>
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
      alert("只能查看今日及之前的任务完成情况");
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
        btn.closest("tr")?.querySelector(".name-cell strong")?.textContent || "该同学";
      if (
        !confirm(
          `删除「${name}」在 ${day} 的这条提交？\n删除后对方可以重新提交。`
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
        showFeedback(res.feedback || { message: "已删除提交" });
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
    const opts = [`<option value="">选择项目</option>`]
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
    const unit = selected?.unit === "条" ? "条" : selected?.project_id
      ? projectUnit(optList.find((p) => Number(p.id) === Number(selected.project_id)))
      : "节";
    const fieldDis = locked || !has ? "disabled" : "";
    const selDis = locked ? "disabled" : "";
    return `
      <div class="day-slot">
        <select class="board-project" ${selDis}>${opts}</select>
        <input type="number" class="task-quota" min="0" step="1"
          value="${has ? selected.quota || 0 : ""}"
          placeholder="数量" ${fieldDis}>
        <select class="task-unit" ${fieldDis}>
          <option value="节" ${unit === "节" ? "selected" : ""}>节</option>
          <option value="条" ${unit === "条" ? "selected" : ""}>条</option>
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
      <span class="leave-lock-tag">请假</span>
      <span class="leave-lock-text">今日请假，任务分配已锁定</span>
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
        ? `<p class="meta assign-half-hint">今日请假半天，仍可分配任务</p>`
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
      // 当前登录管理员（兼岗）置顶，其余按 A/B 组 → onsite 优先 → 姓名
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
        ? `<span class="wl-chip muted" title="管理员兼做任务，不计出勤">兼岗</span>`
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
        <span class="pill present">出勤 ${c.present || 0}</span>
        <span class="pill half">半天 ${c.leave_half || 0}</span>
        <span class="pill leave">请假 ${c.leave || 0}</span>
        <span class="pill unset">未填 ${c.unset || 0}</span>
      </div>
      <div class="day-jump">
        <button type="button" class="day-jump-btn ${day === todayISO() ? "on" : ""}" data-jump="today">今天</button>
        <button type="button" class="day-jump-btn ${day === tomorrowISO() ? "on" : ""}" data-jump="tomorrow">明天</button>
        <label class="day-picker">日期
          <input id="boardDayInput" type="date" value="${e(day)}">
        </label>
      </div>
    </div>
    <p class="hint" style="margin:0 0 .35rem">正在分配：<strong>${e(rel)}</strong>（${e(day)}）。按 A/B 组排列；${
      boardReadonly
        ? "只读查看，不能改状态或分配任务。"
        : "点「修改」编辑后「分配」保存；「添加任务」可加更多（普通最多 2 个，兼岗管理员可更多）。请假行会锁定。"
    }</p>
    <div class="table-wrap assign-table-wrap">
      <table class="board-table assign-table">
        <thead>
          <tr>
            <th>人</th>
            <th>状态</th>
            <th class="slot-heads">任务</th>
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
      if (editBtn) editBtn.textContent = editing ? "取消" : "修改";
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
      btn.textContent = "分配";
    });
  }

  function snapshotSlots(tr) {
    return [...tr.querySelectorAll(".day-slot")].map((slot) => ({
      project_id: Number(slot.querySelector(".board-project")?.value || 0) || null,
      quota: slot.querySelector(".task-quota")?.value ?? "",
      unit: slot.querySelector(".task-unit")?.value || "节",
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
          <span class="pill present">出勤 ${c2.present || 0}</span>
          <span class="pill half">半天 ${c2.leave_half || 0}</span>
          <span class="pill leave">请假 ${c2.leave || 0}</span>
          <span class="pill unset">未填 ${c2.unset || 0}</span>`;
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
          unit: slot.querySelector(".task-unit")?.value || "节",
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
        btn.textContent = "已分配";
      });
      setTimeout(() => {
        btns.forEach((btn) => {
          if (btn.textContent === "已分配") btn.textContent = "分配";
        });
      }, 2200);
      syncEditUi(tr);
      showFeedback({ message: "已分配" });
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
        btn.textContent = "分配";
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
      addBtn.textContent = "添加任务";
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
        const defUnit = opt?.dataset?.unit === "条" ? "条" : "节";
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
      const html = [`<option value="">选择项目</option>`]
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
         <span class="today-date-k">今天</span>
         <strong>${e(dayLabel.replace(/^今天 · /, ""))}</strong>
       </div>`;
  const cutoffHint = `<p class="hint today-cutoff-hint">北京时间次日凌晨 ${TASK_DAY_CUTOFF_HOUR}:00 前仍可提交当日任务量（例如 8 号 ${String(TASK_DAY_CUTOFF_HOUR).padStart(2, "0")}:00 前可交 7 号）。</p>`;
  const makeupBar = `<div class="today-makeup">
         <span class="meta">如果忘记提交哪天的，点击这里补交</span>
         <button type="button" class="btn ghost" id="openMakeupBtn">补交</button>
       </div>`;

  function bindTodayChrome() {
    $("#openMakeupBtn")?.addEventListener("click", () => openMakeupDialog());
  }

  if (!people.length) {
    el.innerHTML = `${dateBar}${cutoffHint}<div class="empty">今日尚未给你安排任务。可在「任务分配」里给自己排任务后再来提交。</div>${makeupBar}`;
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
          const unit = pr.unit === "条" ? "条" : "节";
          const met = submitted && quota > 0 && doneToday + 1e-9 >= quota;
          if (submitted) delete todayDrafts[draftKey(p.id, pr.project_id)];
          const quotaHtml = quota > 0
            ? `<span class="quota-chip ${met ? "met" : ""}">今日 ${
                submitted ? fmtNum(doneToday) : "—"
              }/${quota} ${unit}</span>`
            : `<span class="meta">未设今日配额</span>`;
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
              今天完成
              <input type="number" min="0" step="1" value="${
                inputVal === "" ? "" : e(String(inputVal))
              }" class="done-field" placeholder="填数量" ${
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
        alert("请先填写完成数量，再提交。");
        return;
      }
      const done = Number(raw);
      if (!Number.isFinite(done) || done < 0) {
        alert("请填写有效的完成数量。");
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
      : `<option value="">暂无可选项目</option>`;
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
    hint.textContent = "该日没有安排项目时，可从当前分配的项目里选。";
    return;
  }
  $("#makeupDone").value = p.done || 0;
  $("#makeupUnit").value = p.unit === "条" ? "条" : "节";
  if (p.quota > 0) {
    hint.textContent = `当日配额 ${p.quota} ${p.unit} · 已填 ${p.done}`;
  } else if (p.from_board) {
    hint.textContent = `当日有安排 · 已填 ${p.done}`;
  } else {
    hint.textContent = `已填 ${p.done}（该日未在面板安排，按当前项目补交）`;
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
  ok: "已提交",
  missing: "未提交",
  short: "未达配额",
  leave: "请假",
  empty: "无任务",
  tts: "TTS",
  产测: "产测",
  质检: "质检",
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
    el.innerHTML = `<div class="empty">还没有提交记录。去「今日登记」提交后会显示在这里。</div>`;
    return;
  }
  const units = [...new Set(list.map((p) => projectUnit(p)))];
  const total = list.reduce((s, p) => s + Number(p.done || 0), 0);
  const totalUnit = units.length === 1 ? units[0] : "";
  el.innerHTML = `
    <div class="mine-page">
      <p class="hint">只统计你自己在各项目里已提交的数量。</p>
      <div class="mine-total">
        <span class="k">我累计提交</span>
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
  const heads = ["一", "二", "三", "四", "五", "六", "日"]
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
    const label = !isWork ? "休息" : STATUS_LABELS[st] || "未填";
    cells.push(
      `<span class="att-cal-cell ${cls}" title="${e(iso)} ${e(label)}"><em>${d}</em></span>`
    );
  }
  return `
    <div class="att-cal" aria-label="${e(displayName(person.intern_name))} ${e(ym)} 出勤日历">
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
    el.innerHTML = `<div class="empty">加载出勤数据中…</div>`;
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
      return `<th class="att-day-h"><span>周${wd}</span><em>${md}</em></th>`;
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

  // 组内管理：自己的出勤单独可编辑；组表只读
  const myAttBlock =
    isGaView && mePerson
      ? `
    <section class="att-my-card">
      <header class="att-my-head">
        <h3>我的出勤</h3>
        <span class="meta">${e(weekRangeLabel(weekDays))}</span>
      </header>
      <div class="table-wrap">
        <table class="board-table att-week-table att-my-table">
          <thead>
            <tr>
              <th>人</th>
              ${weekHeads}
              <th>本周出勤</th>
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
      return String(a.intern_name).localeCompare(String(b.intern_name), "zh");
    })
    .map((p) => {
      return `<article class="att-cal-card">
        <span class="att-cal-days" title="出勤天数">${fmtAttNum(
          p.month?.present_days || 0
        )}<em>天</em></span>
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
        <h3>调休 / 特殊日</h3>
        <p class="meta">${
          isWriteAdmin()
            ? "把周末设为上班，或把工作日设为休息；出勤表与月统计会跟着变。"
            : "只读查看特殊日（不能修改）。"
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
          <input type="text" name="note" placeholder="如：调休" maxlength="40">
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
                  const kindLabel = x.kind === "work" ? "上班" : "休息";
                  return `<div class="work-cal-row">
                    <span class="work-cal-day">${e(x.day)} · 周${wd}</span>
                    <span class="work-cal-kind ${e(x.kind)}">${kindLabel}</span>
                    <span class="meta">${e(x.note || "")}</span>
                    ${
                      isWriteAdmin()
                        ? `<button type="button" class="btn ghost sm work-cal-del" data-day="${e(
                            x.day
                          )}">删除</button>`
                        : ""
                    }
                  </div>`;
                })
                .join("")
            : `<p class="meta" style="margin:0">还没有特殊日。${
                isWriteAdmin()
                  ? "例如周日要上班，选那天并选「上班」即可。"
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
              ? "按周查看"
              : "按周填写"
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
                <h3>${isOnlineAdmin() ? "线上出勤" : "本组出勤"}</h3>
                <span class="meta">只读 · ${
                  isOnlineAdmin()
                    ? "A/B 组 online"
                    : e(teamGroupLabel(me?.team_group))
                }</span>
              </header>`
            : `<p class="hint" style="margin:0 0 .45rem">
          本周 / 下周出勤预填（${e(weekRangeLabel(weekDays))}）。用下拉选择：
          <strong>出勤 / 半天 / 请假</strong>。周五可先填下周，中途可随时改。
          ${
            isWriteAdmin()
              ? ""
              : isReadonlyAdmin()
                ? "当前为只读，不能改出勤。"
                : "你只能改自己的出勤。"
          }
        </p>`
        }
        <div class="table-wrap">
          <table class="board-table att-week-table">
            <thead>
              <tr>
                <th>人</th>
                ${weekHeads}
                <th>本周出勤</th>
              </tr>
            </thead>
            <tbody>
              ${
                weekRows ||
                `<tr><td colspan="${weekDays.length + 2}" class="empty-cell">暂无人员</td></tr>`
              }
            </tbody>
          </table>
        </div>
      `
            : `
        <div class="att-month-view">
          <div class="att-cal-legend">
            <span><i class="present"></i>出勤</span>
            <span><i class="leave_half"></i>半天</span>
            <span><i class="leave"></i>请假</span>
            <span><i class="unset"></i>未填</span>
            <span><i class="rest"></i>休息</span>
          </div>
          <div class="att-cal-grid-wrap">
            ${monthCalCards || `<p class="meta">暂无人员</p>`}
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
      if (!confirm(`删除 ${day} 的特殊日设置？`)) return;
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
    el.innerHTML = `<div class="empty">暂无工作记录。</div>`;
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
              <th>日期</th>
              <th>项目</th>
              <th class="num">分配</th>
              <th class="num">完成</th>
              <th>提交</th>
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
                        ? "请假"
                        : SUBMIT_LABELS[badge] || "无任务"
                    }</td>
                    <td><span class="wl-chip ${badge}">${SUBMIT_LABELS[badge] || badge}</span></td>
                  </tr>`;
                }
                return items
                  .map((it, idx) => {
                    const st = it.submit_status || "ok";
                    const doneTxt = it.done == null ? "—" : fmtNum(it.done);
                    const unit = e(it.unit || "节");
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
    : `<div class="empty">近一段还没有出勤或提交记录。</div>`;

  el.innerHTML = `
    <div class="workload-page">
      <p class="hint">这里是每日完成量的历史记录。任务做完了却忘了提交数量的日期，会标成「未提交」；可到「今日登记」里补交。</p>
      <h3 class="workload-h">每日明细</h3>
      ${dayRows}
    </div>`;
}

function fmtNum(n) {
  const x = Number(n || 0);
  return Number.isInteger(x) ? String(x) : String(Math.round(x * 10) / 10);
}

function peopleBarsHtml(people, unit = "节", highlightInternId = null) {
  const rows = [...(people || [])]
    .map((u) => ({
      name: u.intern_name || "—",
      done: Number(u.done || 0),
      intern_id: u.intern_id,
      left: Number(u.active) === 0,
    }))
    .sort((a, b) => b.done - a.done);
  if (!rows.length) return `<p class="meta">暂无分配</p>`;
  const max = Math.max(...rows.map((u) => u.done), 1);
  const total = rows.reduce((s, u) => s + u.done, 0);
  return `
    <div class="rank-board">
      <div class="rank-board-head">
        <span>成员贡献</span>
        <span class="meta">合计 ${fmtNum(total)} ${unit} · 按完成量排序</span>
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
              ? `<span class="rank-left-tag" title="已离职">离职</span>`
              : "";
            return `
            <div class="rank-row${mine ? " is-me" : ""}${u.left ? " is-left" : ""}" style="--bar:${pct}%; --delay:${i * 35}ms">
              <span class="rank-idx">${i + 1}</span>
              <span class="rank-name"><span class="rank-name-text">${e(displayName(u.name))}${mine ? " · 我" : ""}</span>${leftTag}</span>
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
    return String(a.name).localeCompare(String(b.name), "zh");
  });
  if (!list.length) {
    el.innerHTML = `<div class="empty">还没有项目。</div>`;
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
            <p class="meta">${target ? pct.toFixed(1) + "% 完成" : `未设置总${unit}数`}</p>
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
      return String(a.name).localeCompare(String(b.name), "zh");
    });
  const offCount = (allProjects || []).filter((p) => Number(p.active) !== 1).length;

  el.innerHTML = `
    <div class="projmgmt">
      <article class="project-card projmgmt-add">
        <h3>新建项目</h3>
        <p class="hint">设置项目名、单位和最终总量。</p>
        <div class="projmgmt-form">
          <label class="field-label">项目名
            <input id="pmNewName" placeholder="例如 Student Speech（ASR） Check">
          </label>
          <label class="field-label">单位
            <select id="pmNewUnit">
              <option value="节">节</option>
              <option value="条">条</option>
            </select>
          </label>
          <label class="field-label">最终总量
            <input id="pmNewTarget" type="number" min="0" step="1" placeholder="如 9700">
          </label>
          <label class="field-label">说明
            <input id="pmNewDesc" placeholder="可选">
          </label>
          <label class="field-label projmgmt-url">标注平台链接
            <input id="pmNewUrl" type="url" placeholder="https://… 可选，组员可一点直达">
          </label>
          <label class="field-label projmgmt-url">标注规范（在线文档）
            <input id="pmNewDoc" type="url" placeholder="https://… 在线文档链接">
          </label>
          <label class="field-label projmgmt-url">质检结果（在线文档）
            <input id="pmNewQc" type="url" placeholder="https://… 质检结果文档">
          </label>
          <button type="button" class="btn" id="pmAddBtn">添加</button>
        </div>
        <div class="projmgmt-toolbar">
          <label class="pm-active">
            <input type="checkbox" id="pmShowOff" ${showOff ? "checked" : ""}>
            显示已停用（${offCount}）
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
                  <span class="meta project-card-meta">${on ? "" : "已停用 · "}${finished ? "已标记结项 · " : ""}累计 ${fmtNum(done)}${target ? ` / ${fmtNum(target)}` : ""} ${unit}${target ? `（${pct}%）` : ""}</span>
                </header>
                <div class="projmgmt-form">
                  <label class="field-label">项目名
                    <input class="pm-name" value="${e(p.name)}">
                  </label>
                  <label class="field-label">单位
                    <select class="pm-unit">
                      <option value="节" ${unit === "节" ? "selected" : ""}>节</option>
                      <option value="条" ${unit === "条" ? "selected" : ""}>条</option>
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
                  <label class="field-label projmgmt-url">标注规范（在线文档）
                    <input class="pm-doc" type="url" value="${e(p.doc_url || "")}" placeholder="https://…">
                  </label>
                  <label class="field-label projmgmt-url">质检结果（在线文档）
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
                      ? `<button type="button" class="btn ghost sm pm-del">停用</button>`
                      : `<button type="button" class="btn sm pm-restore">恢复启用</button>`
                  }
                </div>
              </article>`;
                })
                .join("")
            : `<div class="empty">${showOff ? "还没有项目。" : "没有启用中的项目。可勾选上方「显示已停用」。"}</div>`
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
    banner.textContent = "只读管理员：可查看项目，不能新建或修改。";
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
    if (!name) return alert("请填写项目名");
    try {
      await api("/api/projects", {
        method: "POST",
        body: JSON.stringify({
          name,
          target_total: Number($("#pmNewTarget").value || 0),
          description: $("#pmNewDesc").value.trim(),
          unit: $("#pmNewUnit")?.value || "节",
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
      if ($("#pmNewUnit")) $("#pmNewUnit").value = "节";
      await loadAll();
      activateTab("projmgmt");
      msg("#pmMsg", "已添加");
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
      if (!pid) return alert("项目 id 无效");
      try {
        await api("/api/projects/update", {
          method: "POST",
          body: JSON.stringify({
            project_id: pid,
            name: card.querySelector(".pm-name").value.trim(),
            target_total: Number(card.querySelector(".pm-target").value || 0),
            description: card.querySelector(".pm-desc").value.trim(),
            unit: card.querySelector(".pm-unit")?.value || "节",
            active: card.querySelector(".pm-on").checked,
            completed: card.querySelector(".pm-done")?.checked || false,
            platform_url: card.querySelector(".pm-url")?.value.trim() || "",
            doc_url: card.querySelector(".pm-doc")?.value.trim() || "",
            qc_url: card.querySelector(".pm-qc")?.value.trim() || "",
          }),
        });
        await loadAll();
        activateTab("projmgmt");
        msg("#pmMsg", "已保存");
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
      const name = card.querySelector(".pm-name")?.value || "该项目";
      if (!pid) return alert("项目 id 无效");
      if (!confirm(`停用项目「${name}」？\n停用后不会出现在任务分配里，历史完成量仍保留。`)) {
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
        msg("#pmMsg", `已停用「${name}」`);
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
            unit: card.querySelector(".pm-unit")?.value || "节",
            active: true,
            completed: card.querySelector(".pm-done")?.checked || false,
            platform_url: card.querySelector(".pm-url")?.value.trim() || "",
            doc_url: card.querySelector(".pm-doc")?.value.trim() || "",
            qc_url: card.querySelector(".pm-qc")?.value.trim() || "",
          }),
        });
        await loadAll();
        activateTab("projmgmt");
        msg("#pmMsg", "已恢复启用");
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
      return String(a.name || "").localeCompare(String(b.name || ""), "zh");
    });

  const internRows = visibleInterns.map((i) => {
    const u = byIntern[i.id];
    const on = Number(i.active) === 1;
    const g = normalizeTeamGroup(i.team_group);
    const wm = normalizeWorkMode(i.work_mode) === "onsite" ? "onsite" : "online";
    const status = on ? "" : `<span class="meta user-left-tag">已离职</span>`;
    const groupSelect = `<label class="team-select-wrap" title="分组">
      <select class="team-select" data-iid="${i.id}">
        <option value="" ${!g ? "selected" : ""}>未分组</option>
        <option value="A" ${g === "A" ? "selected" : ""}>A组</option>
        <option value="B" ${g === "B" ? "selected" : ""}>B组</option>
      </select>
    </label>`;
    const modeSelect = `<label class="team-select-wrap" title="办公方式">
      <select class="work-mode-select" data-iid="${i.id}">
        <option value="online" ${wm === "online" ? "selected" : ""}>online</option>
        <option value="onsite" ${wm === "onsite" ? "selected" : ""}>onsite</option>
      </select>
    </label>`;
    const leaveBtn = on
      ? `<button type="button" class="btn ghost user-leave">离职</button>`
      : `<button type="button" class="btn ghost user-restore">恢复在职</button>`;
    if (u) {
      const gaOn = Boolean(Number(u.group_admin || 0));
      const oaOn = Boolean(Number(u.online_admin || 0));
      const gaToggle = on
        ? `<label class="pm-active ga-toggle" title="组内管理：可只读查看本组出勤与任务完成">
            <input type="checkbox" class="user-group-admin" data-uid="${u.id}" ${
              gaOn ? "checked" : ""
            } ${g === "A" || g === "B" ? "" : "disabled"}>
            组内管理
          </label>`
        : "";
      const oaToggle = on
        ? `<label class="pm-active ga-toggle" title="线上管理：可只读查看 A/B 组全部 online 出勤与任务完成">
            <input type="checkbox" class="user-online-admin" data-uid="${u.id}" ${
              oaOn ? "checked" : ""
            }>
            线上管理
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
          <button type="button" class="btn ghost user-reset">改密</button>
          <button type="button" class="btn ghost user-del">删除账号</button>
        </div>
      </div>`;
    }
    return `<div class="user-row${on ? "" : " is-left"}" data-iid="${i.id}">
      <div class="user-row-id">
        <strong>${e(displayName(i.name))}</strong>
        <span class="meta">未设账号</span>
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
      const label = u.display_name || "管理员";
      const workTag = u.intern_id
        ? ` · <span class="meta">可交任务</span>`
        : "";
      return `<div class="user-row" data-uid="${u.id}">
        <div class="user-row-id">
          <strong>${e(displayName(label))}</strong>
          <span class="meta">管理员</span>
          ${workTag}
          <code>${e(u.username)}</code>
        </div>
        <div class="user-row-actions">
          <button type="button" class="btn ghost user-reset">改密</button>
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
        ? "只读管理员：可查看人员，不能改账号、分组、离职等。"
        : "已有账号：离职后不再出现在出勤/任务分配，历史数据保留。"
    }</p>` +
    `<label class="pm-active" style="margin:.35rem 0 .55rem;display:inline-flex">
      <input type="checkbox" id="showLeftInterns" ${showLeft ? "checked" : ""}>
      显示已离职（${leftCount}）
    </label>` +
    (internRows.length || adminRows.length
      ? adminRows.concat(internRows).join("")
      : `<p class="meta">暂无</p>`);

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
    if (hint) hint.textContent = "只读管理员：可查看人员列表，不能添加或修改账号。";
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
        msg("#dlgMsg", `已设为${teamGroupLabel(team_group)}`);
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
        msg("#dlgMsg", `已设为 ${work_mode === "onsite" ? "onsite" : "online"}`);
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
        msg("#dlgMsg", group_admin ? "已设为组内管理" : "已取消组内管理");
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
        msg("#dlgMsg", online_admin ? "已设为线上管理" : "已取消线上管理");
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
      const name = row?.querySelector("strong")?.textContent || "该组员";
      if (
        !confirm(
          `将「${name}」标记为离职？\n历史完成量保留，但不再出现在出勤和任务分配里。`
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
        msg("#dlgMsg", `已标记「${name}」离职`);
        await loadAll();
      } catch (err) {
        alert(err.message);
      }
    });
  });

  listEl.querySelectorAll(".user-restore").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const row = btn.closest(".user-row");
      const name = row?.querySelector("strong")?.textContent || "该组员";
      try {
        await api("/api/interns/active", {
          method: "POST",
          body: JSON.stringify({
            intern_id: Number(row.dataset.iid),
            active: true,
          }),
        });
        msg("#dlgMsg", `已恢复「${name}」在职`);
        await loadAll();
      } catch (err) {
        alert(err.message);
      }
    });
  });

  listEl.querySelectorAll(".user-del").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const row = btn.closest(".user-row");
      const name = row?.querySelector("code")?.textContent || "该账号";
      if (!confirm(`删除账号「${name}」？对应组员也会标记离职，历史数据仍保留。`))
        return;
      try {
        await api("/api/users/delete", {
          method: "POST",
          body: JSON.stringify({ user_id: Number(row.dataset.uid) }),
        });
        msg("#dlgMsg", "已删除");
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
      const pw = prompt(`为「${username}」设置新密码（至少4位）：`);
      if (pw == null) return;
      if (pw.length < 4) {
        alert("密码至少 4 位");
        return;
      }
      const isAdminRow = row?.querySelector("strong")?.textContent === "管理员";
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
        msg("#dlgMsg", "密码已更新");
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
      const username = prompt(`为「${name}」设置登录账号：`);
      if (username == null || !username.trim()) return;
      const pw = prompt("设置密码（至少4位）：");
      if (pw == null) return;
      if (pw.length < 4) {
        alert("密码至少 4 位");
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
        msg("#dlgMsg", "账号已设置");
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
    alert(role === "admin" ? "请填写管理员姓名" : "请填写姓名");
    return;
  }
  if (!username) {
    alert("请填写登录账号");
    return;
  }
  if (password.length < 4) {
    alert("密码至少 4 位");
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
          ? `已添加管理员 ${name}（可交任务）`
          : `已添加管理员 ${name}`
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
          ? `已添加组员 ${name}（${teamGroupLabel(team_group)} · ${modeTxt}）`
          : `已添加组员 ${name}（${modeTxt}）`
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
    msg("#pwdMsg", "密码已更新");
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
  const unit = $("#makeupUnit").value || "节";
  if (!day || !project_id) {
    alert("请选择日期和项目");
    return;
  }
  if (!me?.intern_id) {
    alert("账号未绑定组员");
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
    msg("#makeupMsg", res.feedback?.message || "补交成功");
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

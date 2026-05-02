// ═══════════════ State ═══════════════
let JOBS = [];
let PROFILES = [];
let ACTIVE_PROFILE = null;
let SCANS = [];
let TRACKED = [];
let TRACKED_IDS = new Set();

// ═══════════════ Cost guard ═══════════════
const EXPENSIVE_OPS = {
  "deep-dive": { cost: "$0.04", time: "20-30s", web: true },
  "interview-prep": { cost: "$0.03", time: "20-40s", web: true },
  "salary": { cost: "$0.03", time: "15-25s", web: true },
  "skill-gap": { cost: "$0.02", time: "15-25s", web: true },
  "ai-opportunities": { cost: "$0.04", time: "30-60s", web: true },
  "wlb-ranking": { cost: "$0.04", time: "30-60s", web: true },
  "company-dive": { cost: "$0.04", time: "20-30s", web: true },
  "github-analysis": { cost: "$0.03", time: "15-25s", web: false },
  "compact": { cost: "$0.02", time: "15-25s", web: false },
  "improve": { cost: "$0.025", time: "15-25s", web: false },
  "analyze": { cost: "$0.015", time: "15-25s", web: false },
  "profile-insights": { cost: "$0.03", time: "15-25s", web: true },
};

function confirmCost(opType) {
  const info = EXPENSIVE_OPS[opType];
  if (!info) return true;
  const webNote = info.web ? " (כולל חיפוש באינטרנט)" : "";
  return confirm(`💰 פעולה זו תעלה ~${info.cost} (Claude API)${webNote}\n⏱️ זמן משוער: ${info.time}\n\nלהמשיך?`);
}

// ═══════════════ API helpers ═══════════════
async function api(path, opts = {}) {
  const r = await fetch(path, opts);
  const ct = r.headers.get("content-type") || "";
  const data = ct.includes("json") ? await r.json() : await r.text();
  if (!r.ok || (data && data.error)) {
    throw new Error((data && data.error) || `HTTP ${r.status}`);
  }
  return data;
}
function toast(msg, err = false) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.className = "toast show" + (err ? " err" : "");
  clearTimeout(el._t);
  el._t = setTimeout(() => el.className = "toast" + (err ? " err" : ""), 3500);
}
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c =>
    ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
}
function escapeAttr(s) { return escapeHtml(s).replace(/'/g, "&#39;"); }
function fmtDate(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("he-IL", { dateStyle: "short", timeStyle: "short" });
}
function fmtNumber(n) { return new Intl.NumberFormat("he-IL").format(n); }

// ═══════════════ Tabs ═══════════════
document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    const target = tab.dataset.tab;
    document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
    document.querySelectorAll(".page").forEach(p => p.classList.remove("active"));
    tab.classList.add("active");
    document.getElementById("page-" + target).classList.add("active");
    if (target === "profile") loadProfilePage();
    if (target === "history") loadHistoryPage();
    if (target === "tracker") loadTrackerPage();
    if (target === "dashboard") loadDashboardPage();
    if (target === "automation") loadAutomationPage();
    if (target === "mentor") loadMentorPage();
    if (target === "cveditor") loadCVEditor();
    if (target === "companies") loadCompaniesPage();
    if (target === "ai") loadAIPage();
    if (target === "leetcode") loadLeetcodePage();
    if (target === "portfolio") loadPortfolioPage();
  });
});

// ═══════════════ Refresh active page ═══════════════
function refreshActivePage() {
  const active = document.querySelector(".page.active");
  if (!active) return;
  const id = active.id.replace("page-", "");
  if (id === "profile") loadProfilePage();
  else if (id === "dashboard") loadDashboardPage();
  else if (id === "jobs") renderJobs();
  else if (id === "tracker") loadTrackerPage();
  else if (id === "history") loadHistoryPage();
}

// ═══════════════ Profiles ═══════════════
async function loadProfiles() {
  const r = await api("/api/profiles");
  PROFILES = r.profiles;
  const sel = document.getElementById("profile-select");
  sel.innerHTML = "";
  if (!PROFILES.length) {
    sel.innerHTML = '<option value="">— אין פרופילים —</option>';
    sel.disabled = true;
    ACTIVE_PROFILE = null;
  } else {
    sel.disabled = false;
    PROFILES.forEach(p => {
      const opt = new Option(p.label + (p.active ? "  ✓" : ""), p.id);
      if (p.active) opt.selected = true;
      sel.add(opt);
    });
    if (r.active) {
      const a = await api("/api/profiles/active");
      ACTIVE_PROFILE = a.active;
    }
  }
}

document.getElementById("profile-select").addEventListener("change", async (e) => {
  if (!e.target.value) return;
  try {
    await api("/api/profiles/activate", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: e.target.value }),
    });
    toast("✅ פרופיל שונה");
    await loadProfiles();
    await loadJobs();
    refreshActivePage();
  } catch (err) { toast("❌ " + err.message, true); }
});

document.getElementById("manage-profiles-btn").addEventListener("click", openProfilesModal);
document.getElementById("profiles-modal-close").addEventListener("click", () =>
  document.getElementById("profiles-modal-backdrop").classList.remove("open"));
document.getElementById("profiles-modal-backdrop").addEventListener("click", (e) => {
  if (e.target.id === "profiles-modal-backdrop") e.target.classList.remove("open");
});
document.getElementById("add-profile-btn").addEventListener("click", () => {
  document.getElementById("profiles-modal-backdrop").classList.remove("open");
  document.getElementById("cv-file-input").click();
});

async function openProfilesModal() {
  await loadProfiles();
  const body = document.getElementById("profiles-modal-body");
  if (!PROFILES.length) {
    body.innerHTML = '<div class="empty">אין פרופילים. הוסף אחד מ-CV שלך.</div>';
  } else {
    body.innerHTML = PROFILES.map(p => {
      const avHtml = p.avatar
        ? `<img src="${p.avatar}" class="avatar-small" />`
        : `<span style="font-size:24px">👤</span>`;
      const cvCount = (p.cvs || []).length;
      return `
      <div class="profile-row ${p.active ? "active" : ""}">
        ${avHtml}
        <div>
          <div class="pr-name"><b>${escapeHtml(p.label)}</b></div>
          <div class="pr-meta">${cvCount} CV${cvCount !== 1 ? "s" : ""} · ${fmtDate(p.created_at)}</div>
        </div>
        <div class="pr-actions">
          ${p.active ? '<span class="muted">פעיל</span>'
                     : `<button class="btn small" onclick="activateProfile('${escapeAttr(p.id)}')">הפעל</button>`}
          <button class="btn small danger" onclick="removeProfile('${escapeAttr(p.id)}')">🗑️</button>
        </div>
      </div>`;
    }).join("");
  }
  document.getElementById("profiles-modal-backdrop").classList.add("open");
}

window.activateProfile = async (id) => {
  try {
    await api("/api/profiles/activate", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    toast("✅ פרופיל שונה");
    await loadProfiles();
    await loadJobs();
    refreshActivePage();
    openProfilesModal();
  } catch (e) { toast("❌ " + e.message, true); }
};

window.removeProfile = async (id) => {
  if (!confirm("למחוק את הפרופיל הזה?")) return;
  try {
    await api("/api/profiles/delete", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    toast("🗑️ פרופיל נמחק");
    await loadProfiles();
    openProfilesModal();
  } catch (e) { toast("❌ " + e.message, true); }
};

// ═══════════════ CV upload ═══════════════
document.getElementById("upload-cv-btn").addEventListener("click", () =>
  document.getElementById("cv-file-input").click());

document.getElementById("cv-file-input").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  toast(`📤 מעלה ${file.name}... (5-10 שניות)`);
  try {
    const fd = new FormData();
    fd.append("cv", file);
    const r = await api("/api/profiles/upload", { method: "POST", body: fd });
    toast(`✅ פרופיל נוצר: ${r.label}`);
    await loadProfiles();
    await loadJobs();
    if (document.getElementById("page-profile").classList.contains("active")) loadProfilePage();
  } catch (err) { toast("❌ " + err.message, true); }
  finally { e.target.value = ""; }
});

// ═══════════════ Refresh jobs ═══════════════
document.getElementById("refresh-jobs-btn").addEventListener("click", async () => {
  const btn = document.getElementById("refresh-jobs-btn");
  const orig = btn.textContent;
  btn.disabled = true;
  btn.innerHTML = "סורק... <span class='spinner'></span>";
  try {
    const r = await api("/api/scan", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    });
    toast(`✅ ${r.total_jobs} משרות (${r.errors.length} שגיאות) · נשמר בארכיון`);
    await loadJobs();
  } catch (err) { toast("❌ " + err.message, true); }
  finally { btn.disabled = false; btn.textContent = orig; }
});

// ═══════════════ Jobs ═══════════════
const REMOTE_SOURCES = new Set(["remotive", "remoteok"]);
function sourceTag(ats) {
  if (ats === "remotive") return { icon: "🌍", label: "Remotive", class: "src-remote" };
  if (ats === "remoteok") return { icon: "🌎", label: "RemoteOK", class: "src-remote" };
  return { icon: "🇮🇱", label: ats, class: "src-il" };
}

async function loadJobs() {
  try {
    const r = await fetch("/jobs.json");
    JOBS = r.ok ? await r.json() : [];
  } catch { JOBS = []; }
  await loadTrackedIds();
  initJobFilters();
  renderJobs();
}

async function loadTrackedIds() {
  try {
    const r = await api("/api/tracker");
    TRACKED = r.tracked;
    TRACKED_IDS = new Set(TRACKED.map(t => t.id));
  } catch { TRACKED = []; TRACKED_IDS = new Set(); }
}

function initJobFilters() {
  const companies = [...new Set(JOBS.map(j => j.company))].sort();
  const locations = [...new Set(JOBS.map(j => j.location).filter(Boolean))].sort();
  const cSel = document.getElementById("company");
  const lSel = document.getElementById("location");
  const prevC = cSel.value, prevL = lSel.value;
  cSel.innerHTML = '<option value="">כל החברות</option>';
  lSel.innerHTML = '<option value="">כל המיקומים</option>';
  companies.forEach(c => cSel.add(new Option(c, c)));
  locations.forEach(l => lSel.add(new Option(l.length > 40 ? l.slice(0, 40) + "…" : l, l)));
  cSel.value = prevC; lSel.value = prevL;
}

["q", "grade", "source", "special", "company", "location", "sort"].forEach(id =>
  document.getElementById(id).addEventListener("input", renderJobs));

function renderJobs() {
  const q = document.getElementById("q").value.toLowerCase();
  const grade = document.getElementById("grade").value;
  const source = document.getElementById("source").value;
  const special = document.getElementById("special").value;
  const company = document.getElementById("company").value;
  const location = document.getElementById("location").value;
  const sort = document.getElementById("sort").value;

  let f = JOBS.filter(j => {
    if (q) {
      const t = `${j.title} ${j.company} ${j.department} ${j.description}`.toLowerCase();
      if (!t.includes(q)) return false;
    }
    if (grade) {
      const allowed = grade === "A" ? ["A"] : grade === "AB" ? ["A","B"] : ["A","B","C"];
      if (!allowed.includes(j.grade)) return false;
    }
    if (source === "il" && REMOTE_SOURCES.has(j.ats)) return false;
    if (source === "remote" && !REMOTE_SOURCES.has(j.ats)) return false;
    if (special === "new" && !j.is_new) return false;
    if (special === "restored" && !j.is_restored) return false;
    if (company && j.company !== company) return false;
    if (location && j.location !== location) return false;
    return true;
  });

  if (sort === "score") f.sort((a,b) => (b.score||0) - (a.score||0));
  else if (sort === "date") f.sort((a,b) => (b.scanned_at||"").localeCompare(a.scanned_at||""));
  else if (sort === "title") f.sort((a,b) => (a.title||"").localeCompare(b.title||""));

  const newCount = JOBS.filter(j => j.is_new).length;
  const restoredCount = JOBS.filter(j => j.is_restored).length;
  let statsText = `${f.length} מתוך ${JOBS.length}`;
  if (newCount) statsText += ` · ${newCount} חדשות 🆕`;
  if (restoredCount) statsText += ` · ${restoredCount} משוחזרות ♻️`;
  document.getElementById("jobs-stats").textContent = statsText;

  const list = document.getElementById("jobs-list");
  if (!JOBS.length) {
    list.innerHTML = `<div class="empty">אין משרות. לחץ "🔄 רענן משרות"</div>`;
    return;
  }
  if (!f.length) { list.innerHTML = `<div class="empty">אין תוצאות לסינון</div>`; return; }

  const hasProfile = !!ACTIVE_PROFILE;
  list.innerHTML = f.slice(0, 200).map(j => {
    const grade = j.grade || "—";
    const score = j.score ?? "";
    const reasons = (j.reasons || []).slice(0, 8).map(r => {
      const cls = /^[✓~★]/.test(r) ? "skill" : r.startsWith("↑") ? "kw" : "";
      return `<span class="tag ${cls}">${escapeHtml(r)}</span>`;
    }).join("");
    const src = sourceTag(j.ats);
    const tracked = TRACKED_IDS.has(j.id);
    const newBadge = j.is_new ? `<span class="new-badge">🆕 חדש</span>` : "";
    const restoredBadge = j.is_restored ? `<span class="restored-badge">♻️ משוחזר</span>` : "";
    const actions = hasProfile ? `
      <div class="job-actions">
        <button class="btn small ${tracked ? 'track-btn tracked' : 'track-btn'}" onclick="toggleTrack('${escapeAttr(j.id)}')">${tracked ? '⭐ במעקב' : '☆ עקוב'}</button>
        <label class="compare-check" title="בחר להשוואה"><input type="checkbox" class="compare-cb" data-id="${escapeAttr(j.id)}" onchange="updateCompareBar()" /> ⚖️</label>
        <button class="btn small" onclick="generate('cv','${escapeAttr(j.id)}','${escapeAttr(j.title)}','${escapeAttr(j.company)}')">📝 קו"ח</button>
        <button class="btn small" onclick="generateCvEN('${escapeAttr(j.id)}','${escapeAttr(j.title)}','${escapeAttr(j.company)}')">🌐 EN</button>
        <button class="btn small" onclick="generate('letter','${escapeAttr(j.id)}','${escapeAttr(j.title)}','${escapeAttr(j.company)}')">✉️ מכתב</button>
        <button class="btn small" onclick="generate('interview','${escapeAttr(j.id)}','${escapeAttr(j.title)}','${escapeAttr(j.company)}')">🎤 הכנה</button>
        <button class="btn small" onclick="openMockInterview('${escapeAttr(j.id)}','${escapeAttr(j.title)}','${escapeAttr(j.company)}')">💬 ראיון</button>
        <button class="btn small" onclick="generate('skill-gap','${escapeAttr(j.id)}','${escapeAttr(j.title)}','${escapeAttr(j.company)}')">🎯 פערים</button>
        <button class="btn small" onclick="generate('salary','${escapeAttr(j.id)}','${escapeAttr(j.title)}','${escapeAttr(j.company)}')">💰 שכר</button>
        <button class="btn small" onclick="generate('linkedin','${escapeAttr(j.id)}','${escapeAttr(j.title)}','${escapeAttr(j.company)}')">💼 LinkedIn</button>
      </div>` : "";

    return `
      <article class="job">
        <div class="job-main">
          <div class="badge ${grade}"><b>${grade}</b><span class="score-num">${score}</span></div>
          <div>
            <h3>
              ${newBadge}${restoredBadge}
              <a href="${escapeAttr(j.url)}" target="_blank" rel="noopener">${escapeHtml(j.title)}</a>
              <span class="src-badge ${src.class}" title="${src.label}">${src.icon}</span>
            </h3>
            <div class="job-meta">
              <span>🏢 ${escapeHtml(j.company)}</span>
              <span>📍 ${escapeHtml(j.location)}</span>
              <span>📂 ${escapeHtml(j.department)}</span>
            </div>
            <div class="reasons">${reasons}</div>
          </div>
        </div>
        ${actions}
      </article>`;
  }).join("");
}

// ═══════════════ Generation modal ═══════════════
const backdrop = document.getElementById("modal-backdrop");
const modalTitle = document.getElementById("modal-title");
const modalBody = document.getElementById("modal-body");
let currentContent = "";
let currentFilename = "output.md";

function renderMarkdown(md) {
  if (typeof marked !== "undefined" && marked.parse) {
    try { return marked.parse(md); } catch { /* fallback */ }
  }
  return escapeHtml(md).replace(/\n/g, "<br>");
}

function setModalContent(md, isLoading = false) {
  currentContent = md;
  if (isLoading) {
    modalBody.className = "modal-body loading";
    modalBody.innerHTML = `<div>${escapeHtml(md)} <span class="spinner"></span></div>`;
  } else {
    modalBody.className = "modal-body rendered";
    modalBody.innerHTML = renderMarkdown(md);
  }
}

function openModal(title, body, loading = false) {
  modalTitle.textContent = title;
  setModalContent(body, loading);
  backdrop.classList.add("open");
}
function closeModal() { backdrop.classList.remove("open"); }
document.getElementById("modal-close").addEventListener("click", closeModal);
backdrop.addEventListener("click", (e) => { if (e.target === backdrop) closeModal(); });

document.getElementById("modal-copy").addEventListener("click", async () => {
  await navigator.clipboard.writeText(currentContent);
  toast("📋 הועתק");
});
function downloadBlob(blob, filename) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 100);
}
document.getElementById("modal-md").addEventListener("click", () => {
  const blob = new Blob([currentContent], { type: "text/markdown;charset=utf-8" });
  downloadBlob(blob, currentFilename);
});
async function exportAs(format) {
  const ext = format === "pdf" ? "pdf" : "docx";
  const fname = currentFilename.replace(/\.md$/, "." + ext);
  const btn = document.getElementById("modal-" + format);
  const orig = btn.textContent;
  btn.disabled = true; btn.innerHTML = "מייצר... <span class='spinner'></span>";
  try {
    const r = await fetch(`/api/export/${format}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: currentContent, filename: fname }),
    });
    if (!r.ok) throw new Error((await r.json().catch(()=>({error:`HTTP ${r.status}`}))).error);
    downloadBlob(await r.blob(), fname);
    toast(`✅ הורד: ${fname}`);
  } catch (err) { toast("❌ " + err.message, true); }
  finally { btn.disabled = false; btn.textContent = orig; }
}
document.getElementById("modal-docx").addEventListener("click", () => exportAs("docx"));
document.getElementById("modal-pdf").addEventListener("click", () => exportAs("pdf"));

const GEN_LABELS = {
  cv: { name: "קו\"ח מותאמים", time: "10-20s" },
  letter: { name: "מכתב פתיחה", time: "10-15s" },
  interview: { name: "הכנה לראיון", time: "20-40s" },
  "skill-gap": { name: "ניתוח פערים", time: "15-25s" },
  salary: { name: "הכנה למו\"מ שכר", time: "15-25s" },
  linkedin: { name: "הודעות LinkedIn", time: "10-15s" },
  followup: { name: "Follow-Up", time: "10-15s" },
};

window.generate = async (type, jobId, jobTitle, company, opts = {}) => {
  if (!ACTIVE_PROFILE) { toast("❌ אין פרופיל פעיל", true); return; }
  // Cost confirmation for expensive ops
  const opMap = { "interview": "interview-prep", "skill-gap": "skill-gap", "salary": "salary" };
  if (opMap[type] && !confirmCost(opMap[type])) return;
  const meta = GEN_LABELS[type] || { name: type, time: "" };
  const suffix = opts.lang === "en" ? " · EN" : "";
  openModal(`${meta.name}${suffix}: ${jobTitle}`, `מייצר... (${meta.time})`, true);
  const prefix = type === "interview" ? "interview-prep" :
                 type === "skill-gap" ? "skill-gap" :
                 type === "salary" ? "salary-prep" : type;
  const langSuffix = opts.lang === "en" ? "-EN" : "";
  currentFilename = `${prefix}${langSuffix}-${company}-${jobTitle}.md`.replace(/[^\w.\u0590-\u05ff-]+/g, "_");
  try {
    const body = { jobId, ...(opts.lang ? { lang: opts.lang } : {}) };
    const r = await api(`/api/generate/${type}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    setModalContent(r.text);
  } catch (err) {
    setModalContent("❌ " + err.message);
    toast("❌ " + err.message, true);
  }
};

window.generateCvEN = (jobId, jobTitle, company) =>
  window.generate("cv", jobId, jobTitle, company, { lang: "en" });

// ═══════════════ Mock interview ═══════════════
const mockBackdrop = document.getElementById("mock-modal-backdrop");
let mockJob = null;
let mockHistory = [];

window.openMockInterview = async (jobId, jobTitle, company) => {
  if (!ACTIVE_PROFILE) { toast("❌ אין פרופיל פעיל", true); return; }
  mockJob = { id: jobId, title: jobTitle, company };
  mockHistory = [];
  document.getElementById("mock-title").textContent = `🎤 ${jobTitle} @ ${company}`;
  document.getElementById("mock-chat").innerHTML = "";
  mockBackdrop.classList.add("open");
  document.getElementById("mock-input-field").focus();
  await mockSend(true);
};

document.getElementById("mock-close").addEventListener("click", () => mockBackdrop.classList.remove("open"));
mockBackdrop.addEventListener("click", (e) => { if (e.target === mockBackdrop) mockBackdrop.classList.remove("open"); });

document.getElementById("mock-restart").addEventListener("click", async () => {
  if (!mockJob) return;
  mockHistory = [];
  document.getElementById("mock-chat").innerHTML = "";
  await mockSend(true);
});

async function mockSend(isFirstMessage) {
  const input = document.getElementById("mock-input-field");
  const chat = document.getElementById("mock-chat");
  const text = input.value.trim();

  if (!isFirstMessage) {
    if (!text) return;
    mockHistory.push({ role: "user", content: text });
    chat.insertAdjacentHTML("beforeend", `<div class="chat-msg user">${escapeHtml(text)}</div>`);
    input.value = "";
  }

  const thinkingEl = document.createElement("div");
  thinkingEl.className = "chat-msg thinking";
  thinkingEl.textContent = "המראיין חושב...";
  chat.appendChild(thinkingEl);
  chat.scrollTop = chat.scrollHeight;

  try {
    const r = await api("/api/mock-interview", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId: mockJob.id, history: mockHistory }),
    });
    thinkingEl.remove();
    mockHistory.push({ role: "assistant", content: r.text });
    chat.insertAdjacentHTML("beforeend", `<div class="chat-msg assistant">${escapeHtml(r.text).replace(/\n/g, "<br>")}</div>`);
    chat.scrollTop = chat.scrollHeight;
  } catch (err) {
    thinkingEl.remove();
    chat.insertAdjacentHTML("beforeend", `<div class="chat-msg assistant" style="border-color:var(--f);color:var(--f)">❌ ${escapeHtml(err.message)}</div>`);
  }
}

document.getElementById("mock-send").addEventListener("click", () => mockSend(false));
document.getElementById("mock-input-field").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); mockSend(false); }
});

// ═══════════════ Tracker ═══════════════
window.toggleTrack = async (jobId) => {
  const wasTracked = TRACKED_IDS.has(jobId);
  try {
    if (wasTracked) {
      await api("/api/tracker/remove", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: jobId }),
      });
      toast("☆ הוסר מהמעקב");
    } else {
      await api("/api/tracker/add", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId }),
      });
      toast("⭐ נוסף למעקב — עבור לטאב 'מעקב' לראות");
    }
    await loadTrackedIds();
    renderJobs();
  } catch (e) { toast("❌ " + e.message, true); }
};

async function loadTrackerPage() {
  await loadTrackedIds();
  document.getElementById("tracker-stats").textContent = `${TRACKED.length} משרות במעקב`;
  const cols = ["interested", "applied", "interview", "offer", "rejected"];
  for (const status of cols) {
    const items = TRACKED.filter(t => t.status === status);
    document.getElementById("cnt-" + status).textContent = items.length;
    document.getElementById("col-" + status).innerHTML = items.map(t => renderTrackedCard(t)).join("");
  }
  setupKanbanDnD();
}

function renderTrackedCard(t) {
  const grade = t.job.grade || "—";
  const daysSince = t.applied_at
    ? Math.floor((Date.now() - new Date(t.applied_at).getTime()) / 86400000)
    : null;
  const needsFollowup = t.status === "applied" && daysSince !== null && daysSince >= 5;
  const daysLabel = daysSince !== null ? ` · ⏱️ ${daysSince} ימים` : "";
  const followupAlert = needsFollowup
    ? `<div class="tc-followup" onclick="generateFollowup('${escapeAttr(t.id)}')">📧 שווה follow-up (${daysSince} ימים מאז הגשה)</div>`
    : "";
  return `
    <div class="tracked-card" draggable="true" data-id="${escapeAttr(t.id)}">
      <span class="tc-grade ${grade}">${grade}</span>
      <a href="${escapeAttr(t.job.url)}" target="_blank" class="tc-title">${escapeHtml(t.job.title)}</a>
      <div class="tc-meta">🏢 ${escapeHtml(t.job.company)} · 📍 ${escapeHtml(t.job.location)}${daysLabel}</div>
      ${t.notes ? `<div class="tc-note">📝 ${escapeHtml(t.notes)}</div>` : ""}
      ${followupAlert}
      <div class="tc-actions">
        <button onclick="editNote('${escapeAttr(t.id)}')">📝</button>
        <button onclick="generate('cv','${escapeAttr(t.id)}','${escapeAttr(t.job.title)}','${escapeAttr(t.job.company)}')">📝 קו"ח</button>
        <button onclick="generate('interview','${escapeAttr(t.id)}','${escapeAttr(t.job.title)}','${escapeAttr(t.job.company)}')">🎤 הכנה</button>
        <button onclick="generate('linkedin','${escapeAttr(t.id)}','${escapeAttr(t.job.title)}','${escapeAttr(t.job.company)}')">💼 LinkedIn</button>
        <button onclick="generateFollowup('${escapeAttr(t.id)}')">📧 Follow-up</button>
        <button onclick="companyDive('${escapeAttr(t.job.company)}')">🏢 חברה</button>
        <button onclick="removeTracked('${escapeAttr(t.id)}')" style="color:var(--f)">🗑️</button>
      </div>
    </div>`;
}

function setupKanbanDnD() {
  document.querySelectorAll(".tracked-card").forEach(card => {
    card.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData("text/plain", card.dataset.id);
      e.dataTransfer.effectAllowed = "move";
    });
  });
  document.querySelectorAll(".kanban-body").forEach(body => {
    body.addEventListener("dragover", (e) => {
      e.preventDefault();
      body.classList.add("dragover");
    });
    body.addEventListener("dragleave", () => body.classList.remove("dragover"));
    body.addEventListener("drop", async (e) => {
      e.preventDefault();
      body.classList.remove("dragover");
      const id = e.dataTransfer.getData("text/plain");
      const newStatus = body.parentElement.dataset.status;
      try {
        await api("/api/tracker/update", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id, status: newStatus }),
        });
        toast(`✅ הועבר ל-${newStatus}`);
        loadTrackerPage();
      } catch (err) { toast("❌ " + err.message, true); }
    });
  });
}

window.removeTracked = async (id) => {
  if (!confirm("להסיר מהמעקב?")) return;
  try {
    await api("/api/tracker/remove", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    toast("🗑️ הוסר");
    await loadTrackedIds();
    loadTrackerPage();
  } catch (e) { toast("❌ " + e.message, true); }
};

// Note modal
let editingNoteId = null;
window.editNote = (id) => {
  const t = TRACKED.find(x => x.id === id);
  if (!t) return;
  editingNoteId = id;
  document.getElementById("note-title").textContent = `הערה: ${t.job.title}`;
  document.getElementById("note-text").value = t.notes || "";
  document.getElementById("note-modal-backdrop").classList.add("open");
};
document.getElementById("note-close").addEventListener("click", () =>
  document.getElementById("note-modal-backdrop").classList.remove("open"));
document.getElementById("note-save").addEventListener("click", async () => {
  if (!editingNoteId) return;
  try {
    await api("/api/tracker/update", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: editingNoteId, notes: document.getElementById("note-text").value }),
    });
    toast("💾 נשמר");
    document.getElementById("note-modal-backdrop").classList.remove("open");
    loadTrackerPage();
  } catch (e) { toast("❌ " + e.message, true); }
});

// ═══════════════ Dashboard ═══════════════
document.getElementById("refresh-dashboard-btn").addEventListener("click", loadDashboardPage);

async function loadDashboardPage() {
  const wrap = document.getElementById("dashboard-content");
  wrap.innerHTML = `<div class="empty">טוען <span class="spinner"></span></div>`;
  try {
    const s = await api("/api/dashboard");
    wrap.innerHTML = renderDashboard(s);
  } catch (e) {
    wrap.innerHTML = `<div class="empty">❌ ${escapeHtml(e.message)}</div>`;
  }
}

function renderDashboard(s) {
  const statusLabels = {
    interested: "👀 מתעניין", applied: "📤 הגשתי", interview: "🎤 ראיון",
    offer: "🎉 הצעה", rejected: "❌ נדחה",
  };
  const totalTracked = Object.values(s.by_status).reduce((a,b) => a+b, 0) || 1;
  const totalGrades = Object.values(s.scoring.grade_distribution).reduce((a,b) => a+b, 0) || 1;
  const totalSources = Object.values(s.by_source).reduce((a,b) => a+b, 0) || 1;
  const maxCompany = Math.max(1, ...s.top_companies.map(c => c.count));

  return `
    <div class="stat-grid">
      <div class="stat-card">
        <div class="stat-label">משרות זמינות עכשיו</div>
        <div class="stat-value">${fmtNumber(s.totals.current_jobs)}</div>
        <div class="stat-sub">ציון ממוצע: ${s.scoring.avg_score}/100</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">סריקות בארכיון</div>
        <div class="stat-value">${fmtNumber(s.totals.scans)}</div>
        <div class="stat-sub">${s.totals.profiles} פרופילים שמורים</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">משרות במעקב</div>
        <div class="stat-value">${fmtNumber(s.totals.tracked_jobs)}</div>
        <div class="stat-sub">${s.by_status.applied + s.by_status.interview} פעילות</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">בראיונות עכשיו</div>
        <div class="stat-value">${fmtNumber(s.by_status.interview)}</div>
        <div class="stat-sub">${s.by_status.offer} הצעות בידך</div>
      </div>
    </div>

    <div class="stat-grid" style="grid-template-columns:repeat(auto-fit,minmax(380px,1fr))">
      <div class="card">
        <h3>📊 התפלגות ציונים נוכחית</h3>
        <div class="bar-chart">
          ${["A","B","C","D","F"].map(g => {
            const v = s.scoring.grade_distribution[g] || 0;
            const pct = (v / totalGrades) * 100;
            return `<div class="bar-row">
              <span class="bar-label">${g}</span>
              <div class="bar-track"><div class="bar-fill ${g}" style="width:${pct}%"></div></div>
              <span class="bar-value">${v}</span>
            </div>`;
          }).join("")}
        </div>
      </div>

      <div class="card">
        <h3>🎯 משרות במעקב לפי סטטוס</h3>
        <div class="bar-chart">
          ${Object.entries(statusLabels).map(([k, lbl]) => {
            const v = s.by_status[k] || 0;
            const pct = (v / totalTracked) * 100;
            return `<div class="bar-row">
              <span class="bar-label">${lbl}</span>
              <div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div>
              <span class="bar-value">${v}</span>
            </div>`;
          }).join("")}
        </div>
      </div>

      <div class="card">
        <h3>🏢 חברות מובילות</h3>
        <div class="bar-chart">
          ${s.top_companies.map(c => {
            const pct = (c.count / maxCompany) * 100;
            return `<div class="bar-row">
              <span class="bar-label">${escapeHtml(c.company)}</span>
              <div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div>
              <span class="bar-value">${c.count}</span>
            </div>`;
          }).join("") || `<div class="muted">אין נתונים</div>`}
        </div>
      </div>

      <div class="card">
        <h3>🌐 משרות לפי מקור</h3>
        <div class="bar-chart">
          ${Object.entries(s.by_source).sort((a,b) => b[1]-a[1]).map(([src, v]) => {
            const pct = (v / totalSources) * 100;
            const tag = sourceTag(src);
            return `<div class="bar-row">
              <span class="bar-label">${tag.icon} ${escapeHtml(src)}</span>
              <div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div>
              <span class="bar-value">${v}</span>
            </div>`;
          }).join("") || `<div class="muted">אין נתונים</div>`}
        </div>
      </div>
    </div>

    <div class="card" style="margin-top:16px">
      <h3>📅 5 סריקות אחרונות</h3>
      ${s.recent_scans.length ? s.recent_scans.map(rc => `
        <div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px dashed var(--border)">
          <span>${fmtDate(rc.scanned_at)}</span>
          <span class="muted">${fmtNumber(rc.total_jobs)} משרות</span>
        </div>`).join("") : `<div class="muted">אין סריקות בארכיון</div>`}
    </div>`;
}

// ═══════════════ Profile page ═══════════════
async function loadProfilePage() {
  await loadProfiles();
  const wrap = document.getElementById("profile-content");
  const subtitle = document.getElementById("profile-subtitle");

  if (!ACTIVE_PROFILE) {
    subtitle.textContent = "—";
    wrap.innerHTML = `<div class="empty">
      אין פרופיל פעיל.<br>
      <button class="btn primary" style="margin-top:14px" onclick="document.getElementById('cv-file-input').click()">📤 העלה CV</button>
    </div>`;
    return;
  }

  const p = ACTIVE_PROFILE.profile;
  const ins = ACTIVE_PROFILE.insights;
  const cvs = ACTIVE_PROFILE.cvs || [];
  const primaryIdx = ACTIVE_PROFILE.primary_cv_index || 0;
  subtitle.textContent = "";

  // Avatar + header card
  const avatarSrc = ACTIVE_PROFILE.avatar;
  const initials = (p.name || "?").slice(0, 2);
  const avatarHtml = avatarSrc
    ? `<img src="${avatarSrc}" class="avatar-large" onclick="document.getElementById('avatar-file-input').click()" title="לחץ להחלפה" />`
    : `<div class="avatar-placeholder" onclick="document.getElementById('avatar-file-input').click()" title="לחץ להוספת תמונה">${escapeHtml(initials)}</div>`;

  // CV list
  const cvsHtml = cvs.length ? cvs.map((cv, i) => `
    <div class="cv-item ${i === primaryIdx ? 'primary' : ''}">
      <span class="cv-icon">${i === primaryIdx ? '⭐' : '📄'}</span>
      <div class="cv-info">
        <b>${escapeHtml(cv.label || cv.filename)}</b>
        <span class="muted">${escapeHtml(cv.filename)} · ${cv.chars || '?'} תווים · ${fmtDate(cv.added_at)}</span>
      </div>
      <div class="cv-actions">
        ${i !== primaryIdx ? `<button class="btn small" onclick="setPrimaryCV('${escapeAttr(ACTIVE_PROFILE.id)}','${escapeAttr(cv.id)}')">⭐ ראשי</button>` : '<span class="muted" style="font-size:11px">ראשי</span>'}
        ${cvs.length > 1 ? `<button class="btn small danger" onclick="removeCV('${escapeAttr(ACTIVE_PROFILE.id)}','${escapeAttr(cv.id)}')">🗑️</button>` : ''}
      </div>
    </div>`).join("") : '<div class="muted">אין קבצי CV</div>';


  let insightsHtml = "";
  if (ins) {
    insightsHtml = `
      <div class="profile-grid">
        <div class="card" style="text-align:center">
          <h3>📊 ציון שוק</h3>
          <div class="score-circle" style="--p:${ins.market_score}">
            <b>${ins.market_score}</b>
            <span class="score-label">/ 100</span>
          </div>
          <div class="muted">דרגה: <b style="color:var(--accent)">${escapeHtml(ins.level)}</b></div>
        </div>
        <div class="card">
          <h3>💰 שווי שוק מוערך</h3>
          <div class="big-stat">₪${fmtNumber(ins.estimated_salary.monthly_min)}-${fmtNumber(ins.estimated_salary.monthly_max)}<span class="unit"> /חודש</span></div>
          <div class="muted" style="margin-top:8px">${escapeHtml(ins.estimated_salary.note)}</div>
        </div>
        <div class="card">
          <h3>🔥 תפקידים מומלצים</h3>
          ${ins.suggested_roles.map(r => `
            <div class="suggested-role">
              <span>${escapeHtml(r.title)}</span>
              <span class="role-salary">${escapeHtml(r.salary_range)}</span>
            </div>`).join("")}
        </div>
      </div>
      <div class="profile-grid">
        <div class="card">
          <h3>💪 חוזקות</h3>
          ${ins.strengths.map(s => `<div class="list-bullet">${escapeHtml(s)}</div>`).join("")}
        </div>
        <div class="card">
          <h3>⚠️ פערים מומלצים לטיפול</h3>
          ${ins.gaps.map(s => `<div class="list-bullet">${escapeHtml(s)}</div>`).join("")}
        </div>
        <div class="card">
          <h3>⭐ טכנולוגיות חמות בפרופיל שלך</h3>
          ${ins.hot_skills_in_profile.map(s => `<span class="skill-chip primary">${escapeHtml(s)}</span>`).join(" ")}
        </div>
      </div>
      <div class="card" style="margin-bottom:24px">
        <h3>📝 סיכום שוק</h3>
        <p style="line-height:1.7">${escapeHtml(ins.market_summary)}</p>
      </div>`;
  } else {
    insightsHtml = `
      <div class="card" style="text-align:center; margin-bottom:24px">
        <h3>📊 תובנות שוק</h3>
        <p class="muted" style="margin:12px 0 16px">לחץ "🧠 חשב תובנות שוק" למעלה לקבל ניתוח מקצועי.</p>
      </div>`;
  }

  wrap.innerHTML = `
    <div class="profile-header-card">
      ${avatarHtml}
      <div class="profile-header-info">
        <h2>${escapeHtml(p.name)}</h2>
        <div class="muted">${escapeHtml(p.title)} · ${p.experience_years} שנות ניסיון · נטען ${fmtDate(ACTIVE_PROFILE.created_at)}</div>
        <div style="margin-top:6px">
          <button class="btn small" onclick="document.getElementById('avatar-file-input').click()">📷 ${avatarSrc ? 'החלף' : 'הוסף'} תמונה</button>
        </div>
      </div>
    </div>

    <div class="cv-list-card">
      <h3>📎 קבצי CV (${cvs.length})</h3>
      ${cvsHtml}
      <button class="btn small" style="margin-top:10px" onclick="document.getElementById('add-cv-input').click()">📎 הוסף CV נוסף</button>
    </div>

    ${insightsHtml}
    <div class="profile-grid">
      <div class="card">
        <h3>🛠️ כישורים עיקריים</h3>
        ${p.skills.primary.map(s => `<span class="skill-chip primary">${escapeHtml(s)}</span>`).join(" ")}
      </div>
      <div class="card">
        <h3>🔧 כישורים משניים</h3>
        ${p.skills.secondary.map(s => `<span class="skill-chip secondary">${escapeHtml(s)}</span>`).join(" ")}
      </div>
      <div class="card">
        <h3>🎯 תחומי עניין</h3>
        ${p.skills.interested_in.map(s => `<span class="skill-chip interest">${escapeHtml(s)}</span>`).join(" ")}
      </div>
    </div>
    <div class="profile-grid">
      <div class="card">
        <h3>📋 פרטי פרופיל</h3>
        <div style="margin-bottom:6px"><span class="muted">שם:</span> <b>${escapeHtml(p.name)}</b></div>
        <div style="margin-bottom:6px"><span class="muted">תפקיד:</span> <b>${escapeHtml(p.title)}</b></div>
        <div style="margin-bottom:6px"><span class="muted">ניסיון:</span> <b>${p.experience_years} שנים</b></div>
        <div><span class="muted">מיקום:</span> <b>${(p.location.preferred || []).slice(0,3).join(", ")}</b> ${p.location.remote_ok ? "+ Remote" : ""}</div>
      </div>
      <div class="card">
        <h3>🚀 מילות מפתח רצויות</h3>
        ${p.keywords_boost.map(s => `<span class="skill-chip">${escapeHtml(s)}</span>`).join(" ")}
      </div>
      <div class="card">
        <h3>🚫 לסנן החוצה</h3>
        ${p.keywords_exclude.map(s => `<span class="skill-chip">${escapeHtml(s)}</span>`).join(" ")}
      </div>
    </div>`;
}

// ── Avatar upload ──
document.getElementById("avatar-file-input").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file || !ACTIVE_PROFILE) return;
  try {
    const fd = new FormData();
    fd.append("avatar", file);
    await api(`/api/profiles/avatar?id=${encodeURIComponent(ACTIVE_PROFILE.id)}`, { method: "POST", body: fd });
    toast("📷 תמונה עודכנה");
    await loadProfiles();
    loadProfilePage();
  } catch (err) { toast("❌ " + err.message, true); }
  finally { e.target.value = ""; }
});

// ── Add CV to profile ──
document.getElementById("add-cv-input").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file || !ACTIVE_PROFILE) return;
  toast(`📎 מעלה ${file.name}...`);
  try {
    const fd = new FormData();
    fd.append("cv", file);
    fd.append("id", ACTIVE_PROFILE.id);
    await api(`/api/profiles/cv/add?id=${encodeURIComponent(ACTIVE_PROFILE.id)}`, { method: "POST", body: fd });
    toast(`✅ CV נוסף: ${file.name}`);
    await loadProfiles();
    loadProfilePage();
  } catch (err) { toast("❌ " + err.message, true); }
  finally { e.target.value = ""; }
});

window.setPrimaryCV = async (profileId, cvId) => {
  try {
    toast("⭐ מחליף CV ראשי — מחלץ פרופיל + תובנות שוק...");
    const r = await api("/api/profiles/cv/primary", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profileId, cvId }),
    });
    const msg = r.insights_updated
      ? "✅ פרופיל + תובנות שוק + ציונים — הכל עודכן"
      : "✅ פרופיל + ציונים עודכנו (תובנות שוק לא היו — לחץ 🧠)";
    toast(msg);
    await loadProfiles();
    await loadJobs();
    loadProfilePage();
  } catch (e) { toast("❌ " + e.message, true); }
};

window.removeCV = async (profileId, cvId) => {
  if (!confirm("להסיר CV זה?")) return;
  try {
    await api("/api/profiles/cv/remove", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profileId, cvId }),
    });
    toast("🗑️ CV הוסר");
    await loadProfiles();
    loadProfilePage();
  } catch (e) { toast("❌ " + e.message, true); }
};

document.getElementById("analyze-profile-btn").addEventListener("click", async () => {
  if (!ACTIVE_PROFILE) { toast("❌ אין פרופיל פעיל", true); return; }
  if (!confirmCost("profile-insights")) return;
  const btn = document.getElementById("analyze-profile-btn");
  const orig = btn.textContent;
  btn.disabled = true; btn.innerHTML = "מנתח שוק... <span class='spinner'></span>";
  try {
    const r = await api("/api/profiles/insights", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: ACTIVE_PROFILE.id }),
    });
    ACTIVE_PROFILE.insights = r.insights;
    toast(`✅ ניתוח הושלם: ציון שוק ${r.insights.market_score}/100`);
    loadProfilePage();
  } catch (err) { toast("❌ " + err.message, true); }
  finally { btn.disabled = false; btn.textContent = orig; }
});

// ═══════════════ History page ═══════════════
async function loadHistoryPage() {
  const r = await api("/api/scans");
  SCANS = r.scans;
  document.getElementById("history-stats").textContent = `${SCANS.length} סריקות שמורות`;
  const list = document.getElementById("history-list");
  if (!SCANS.length) {
    list.innerHTML = `<div class="empty">עדיין לא נשמרו סריקות.</div>`;
    return;
  }
  list.innerHTML = SCANS.map(s => `
    <div class="scan-row">
      <span class="scan-icon">📋</span>
      <div class="scan-info">
        <b>${fmtDate(s.scanned_at)}</b>
        <div class="scan-meta">${fmtNumber(s.total_jobs)} משרות · ${s.companies_scanned} חברות${s.errors ? ` · ${s.errors} שגיאות` : ""}</div>
      </div>
      <div class="scan-actions">
        <button class="btn small" onclick="viewScan('${escapeAttr(s.id)}')">👁️ צפה</button>
        <button class="btn small danger" onclick="deleteScan('${escapeAttr(s.id)}')">🗑️</button>
      </div>
    </div>`).join("");
}

window.viewScan = async (id) => {
  try {
    const scan = await api(`/api/scans/get?id=${encodeURIComponent(id)}`);
    // Store for restore functionality
    window._viewingScan = scan;
    window._viewingScanId = id;
    // Switch to a dedicated scan-viewer mode in the history page
    renderScanViewer(scan);
  } catch (e) { toast("❌ " + e.message, true); }
};

function renderScanViewer(scan) {
  const list = document.getElementById("history-list");
  const hasProfile = !!ACTIVE_PROFILE;

  list.innerHTML = `
    <div style="margin-bottom:16px; display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px">
      <div>
        <h3 style="margin:0">📋 סריקה מ-${fmtDate(scan.scanned_at)}</h3>
        <span class="muted">${scan.jobs.length} משרות · ${scan.companies_scanned || "?"} חברות</span>
      </div>
      <div style="display:flex; gap:8px">
        <button class="btn" onclick="restoreAllFromScan()">♻️ שחזר את כל המשרות לתצוגה ראשית</button>
        <button class="btn" onclick="loadHistoryPage()">← חזרה לרשימה</button>
      </div>
    </div>
    <div class="filters" style="margin-bottom:12px">
      <input id="scan-q" placeholder="🔍 חיפוש בתוך הסריקה..." oninput="filterScanViewer()" />
    </div>
    <div id="scan-jobs-list">
      ${renderScanJobs(scan.jobs, hasProfile)}
    </div>`;
}

function renderScanJobs(jobs, hasProfile) {
  if (!jobs.length) return '<div class="empty">אין משרות</div>';
  return jobs.slice(0, 200).map(j => {
    const grade = j.grade || "—";
    const score = j.score ?? "";
    const src = sourceTag(j.ats || "greenhouse");
    const reasons = (j.reasons || []).slice(0, 6).map(r => {
      const cls = /^[✓~★]/.test(r) ? "skill" : r.startsWith("↑") ? "kw" : "";
      return `<span class="tag ${cls}">${escapeHtml(r)}</span>`;
    }).join("");
    const actions = `
      <div class="job-actions">
        <button class="btn small primary" onclick="restoreJob('${escapeAttr(j.id)}')">♻️ שחזר למשרות</button>
        ${hasProfile ? `
          <button class="btn small" onclick="toggleTrack('${escapeAttr(j.id)}')">☆ עקוב</button>
          <button class="btn small" onclick="generate('cv','${escapeAttr(j.id)}','${escapeAttr(j.title)}','${escapeAttr(j.company)}')">📝 קו"ח</button>
          <button class="btn small" onclick="generate('letter','${escapeAttr(j.id)}','${escapeAttr(j.title)}','${escapeAttr(j.company)}')">✉️ מכתב</button>
          <button class="btn small" onclick="generate('interview','${escapeAttr(j.id)}','${escapeAttr(j.title)}','${escapeAttr(j.company)}')">🎤 הכנה</button>
        ` : ""}
        <a href="${escapeAttr(j.url)}" target="_blank" class="btn small">🔗 פתח</a>
      </div>`;
    return `
      <article class="job">
        <div class="job-main">
          <div class="badge ${grade}"><b>${grade}</b><span class="score-num">${score}</span></div>
          <div>
            <h3>
              <a href="${escapeAttr(j.url)}" target="_blank" rel="noopener">${escapeHtml(j.title)}</a>
              <span class="src-badge" title="${src.label}">${src.icon}</span>
            </h3>
            <div class="job-meta">
              <span>🏢 ${escapeHtml(j.company)}</span>
              <span>📍 ${escapeHtml(j.location)}</span>
              <span>📂 ${escapeHtml(j.department || "—")}</span>
            </div>
            <div class="reasons">${reasons}</div>
          </div>
        </div>
        ${actions}
      </article>`;
  }).join("");
}

window.filterScanViewer = () => {
  if (!window._viewingScan) return;
  const q = (document.getElementById("scan-q")?.value || "").toLowerCase();
  let jobs = window._viewingScan.jobs;
  if (q) {
    jobs = jobs.filter(j => `${j.title} ${j.company} ${j.department} ${j.description}`.toLowerCase().includes(q));
  }
  document.getElementById("scan-jobs-list").innerHTML = renderScanJobs(jobs, !!ACTIVE_PROFILE);
};

// Restore a single job from viewed scan
window.restoreJob = async (jobId) => {
  if (!window._viewingScanId) return;
  try {
    const r = await api("/api/scans/restore", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: window._viewingScanId, jobIds: [jobId] }),
    });
    if (r.added > 0) {
      toast(`♻️ משרה שוחזרה! (${r.total} משרות כעת)`);
    } else {
      toast("ℹ️ משרה כבר קיימת בתצוגה הראשית");
    }
    await loadJobs(); // refresh main jobs
  } catch (e) { toast("❌ " + e.message, true); }
};

// Restore ALL jobs from viewed scan
window.restoreAllFromScan = async () => {
  if (!window._viewingScanId) return;
  if (!confirm(`לשחזר את כל המשרות מהסריקה הזו לתצוגה הראשית?`)) return;
  try {
    const r = await api("/api/scans/restore", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: window._viewingScanId }),
    });
    toast(`♻️ ${r.added} משרות שוחזרו! (${r.total} משרות כעת)`);
    await loadJobs();
  } catch (e) { toast("❌ " + e.message, true); }
};

window.deleteScan = async (id) => {
  if (!confirm("למחוק סריקה זו?")) return;
  try {
    await api("/api/scans/delete", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    toast("🗑️ נמחק"); loadHistoryPage();
  } catch (e) { toast("❌ " + e.message, true); }
};

// ═══════════════ Automation page ═══════════════
async function loadCostDashboard() {
  const wrap = document.getElementById("cost-dashboard");
  try {
    const c = await api("/api/costs");
    const typeLabels = {
      "cover-letter": "✉️ מכתב",
      "cv": "📝 קו\"ח",
      "interview-prep": "🎤 הכנה",
      "company-dive": "🏢 חברה",
      "skill-gap": "🎯 פערים",
      "salary": "💰 שכר",
      "linkedin": "💼 LinkedIn",
      "followup": "📧 Follow-up",
      "profile-insights": "🧠 פרופיל",
      "mock-interview": "💬 ראיון",
    };
    const byTypeHtml = Object.entries(c.by_type || {}).map(([k, v]) => {
      const label = typeLabels[k] || k;
      return `<span class="muted">${label}: ${v.calls}× ($${v.cost.toFixed(3)})</span>`;
    }).join(" · ");

    wrap.innerHTML = `
      <div class="stat-grid" style="grid-template-columns:repeat(auto-fit,minmax(160px,1fr));margin-bottom:12px">
        <div class="stat-card" style="padding:12px">
          <div class="stat-label">עלות כוללת</div>
          <div class="stat-value" style="font-size:24px;color:${c.total_cost > 1 ? 'var(--f)' : c.total_cost > 0.3 ? 'var(--c)' : 'var(--a)'}">$${c.total_cost.toFixed(3)}</div>
        </div>
        <div class="stat-card" style="padding:12px">
          <div class="stat-label">7 ימים אחרונים</div>
          <div class="stat-value" style="font-size:24px">$${c.last_7_days.toFixed(3)}</div>
        </div>
        <div class="stat-card" style="padding:12px">
          <div class="stat-label">קריאות AI</div>
          <div class="stat-value" style="font-size:24px">${c.total_calls}</div>
          <div class="stat-sub">${c.total_cached} מ-cache</div>
        </div>
        <div class="stat-card" style="padding:12px">
          <div class="stat-label">נחסך ע"י cache</div>
          <div class="stat-value" style="font-size:24px;color:var(--a)">$${c.saved_by_cache.toFixed(3)}</div>
          <div class="stat-sub">${c.cache.entries} רשומות (${c.cache.sizeKB}KB)</div>
        </div>
      </div>
      <div style="font-size:12px;margin-bottom:8px">${byTypeHtml || '<span class="muted">אין נתונים</span>'}</div>
      <div style="display:flex;gap:8px">
        <button class="btn small" onclick="clearAICache()">🗑️ נקה cache</button>
      </div>`;
  } catch (e) {
    wrap.innerHTML = `<div class="muted">❌ ${escapeHtml(e.message)}</div>`;
  }
}

window.clearAICache = async () => {
  if (!confirm("לנקות את ה-cache? קריאות AI הבאות ייצרו תוכן חדש (ויעלו כסף).")) return;
  try {
    const r = await api("/api/cache/clear", { method: "POST" });
    toast(`🗑️ נוקו ${r.removed} רשומות`);
    loadCostDashboard();
  } catch (e) { toast("❌ " + e.message, true); }
};

async function loadAutomationPage() {
  loadCostDashboard();
  try {
    const r = await api("/api/automation");
    const n = r.notifications, a = r.automation;
    document.getElementById("auto-enabled").checked = a.enabled;
    document.getElementById("auto-interval").value = String(a.interval_hours);
    const status = a.enabled ?
      `✅ פעיל · ריצה אחרונה: ${fmtDate(a.last_run)} · ריצה הבאה: ${fmtDate(a.next_run)}` :
      "⏸️ כבוי";
    document.getElementById("auto-status").textContent = status;

    document.getElementById("tg-token").value = n.telegram?.bot_token || "";
    document.getElementById("tg-chat").value = n.telegram?.chat_id || "";
    document.getElementById("tg-enabled").checked = !!n.telegram?.enabled;
    document.getElementById("tg-grade").value = n.min_grade_for_alert || "A";
  } catch (e) { toast("❌ " + e.message, true); }
}

document.getElementById("auto-save").addEventListener("click", async () => {
  try {
    await api("/api/automation/cron", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        enabled: document.getElementById("auto-enabled").checked,
        interval_hours: Number(document.getElementById("auto-interval").value),
      }),
    });
    toast("✅ הגדרות שמורות");
    loadAutomationPage();
  } catch (e) { toast("❌ " + e.message, true); }
});

document.getElementById("auto-run-now").addEventListener("click", async () => {
  const btn = document.getElementById("auto-run-now");
  const orig = btn.textContent;
  btn.disabled = true; btn.innerHTML = "סורק... <span class='spinner'></span>";
  try {
    const r = await api("/api/automation/run-now", { method: "POST" });
    toast(`✅ ${r.total} משרות · ${r.new_count} חדשות · ${r.alerted} התראות`);
    loadAutomationPage();
  } catch (e) { toast("❌ " + e.message, true); }
  finally { btn.disabled = false; btn.textContent = orig; }
});

document.getElementById("tg-save").addEventListener("click", async () => {
  try {
    await api("/api/automation/notifications", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        telegram: {
          bot_token: document.getElementById("tg-token").value.trim(),
          chat_id: document.getElementById("tg-chat").value.trim(),
          enabled: document.getElementById("tg-enabled").checked,
        },
        min_grade_for_alert: document.getElementById("tg-grade").value,
      }),
    });
    toast("✅ הגדרות טלגרם שמורות");
  } catch (e) { toast("❌ " + e.message, true); }
});

document.getElementById("tg-test").addEventListener("click", async () => {
  try {
    const r = await api("/api/automation/test-telegram", { method: "POST" });
    toast(r.ok ? "✅ הודעת בדיקה נשלחה!" : "❌ " + (r.error || "כשל"), !r.ok);
  } catch (e) { toast("❌ " + e.message, true); }
});

// ═══════════════ Job comparison ═══════════════
function updateCompareBar() {
  const checked = [...document.querySelectorAll(".compare-cb:checked")].map(cb => cb.dataset.id);
  let bar = document.getElementById("compare-bar");
  if (checked.length >= 2) {
    if (!bar) {
      bar = document.createElement("div");
      bar.id = "compare-bar";
      bar.className = "compare-bar";
      document.body.appendChild(bar);
    }
    bar.innerHTML = `
      <span>⚖️ נבחרו ${checked.length} משרות להשוואה</span>
      <button class="btn primary small" onclick="runCompare()">השווה עכשיו</button>
      <button class="btn small" onclick="clearCompare()">ביטול</button>`;
    bar.style.display = "flex";
  } else if (bar) {
    bar.style.display = "none";
  }
}
window.updateCompareBar = updateCompareBar;

window.runCompare = async () => {
  const ids = [...document.querySelectorAll(".compare-cb:checked")].map(cb => cb.dataset.id);
  if (ids.length < 2) { toast("בחר לפחות 2 משרות", true); return; }
  openModal(`⚖️ השוואת ${ids.length} משרות`, "מכין השוואה...", true);
  currentFilename = `comparison-${ids.length}-jobs.md`;
  try {
    const r = await api("/api/compare", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobIds: ids }),
    });
    setModalContent(r.text);
  } catch (e) {
    setModalContent("❌ " + e.message);
    toast("❌ " + e.message, true);
  }
};

window.clearCompare = () => {
  document.querySelectorAll(".compare-cb:checked").forEach(cb => cb.checked = false);
  const bar = document.getElementById("compare-bar");
  if (bar) bar.style.display = "none";
};

// ═══════════════ Company deep dive ═══════════════
window.companyDive = async (company) => {
  if (!confirmCost("company-dive")) return;
  openModal(`🏢 ${company} — סקירה מעמיקה`, "מנתח חברה... (15-25 שניות)", true);
  currentFilename = `company-dive-${company}.md`.replace(/[^\w.\u0590-\u05ff-]+/g, "_");
  try {
    const r = await api("/api/generate/company-dive", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ company }),
    });
    setModalContent(r.text);
  } catch (e) {
    setModalContent("❌ " + e.message);
    toast("❌ " + e.message, true);
  }
};

// ═══════════════ Follow-up ═══════════════
window.generateFollowup = async (id) => {
  if (!ACTIVE_PROFILE) { toast("❌ אין פרופיל פעיל", true); return; }
  const t = TRACKED.find(x => x.id === id);
  if (!t) return;
  openModal(`📧 Follow-Up: ${t.job.title}`, "מכין follow-up... (10-15 שניות)", true);
  currentFilename = `followup-${t.job.company}-${t.job.title}.md`.replace(/[^\w.\u0590-\u05ff-]+/g, "_");
  try {
    const r = await api("/api/generate/followup", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId: id }),
    });
    setModalContent(r.text);
  } catch (e) {
    setModalContent("❌ " + e.message);
    toast("❌ " + e.message, true);
  }
};

// ═══════════════ Companies page ═══════════════
let COMPANIES_DIR = [];

async function loadCompaniesPage() {
  const list = document.getElementById("companies-list");
  if (!COMPANIES_DIR.length) {
    list.innerHTML = `<div class="empty">טוען <span class="spinner"></span></div>`;
    try {
      const r = await api("/api/companies-directory");
      COMPANIES_DIR = r.companies;
    } catch (e) {
      list.innerHTML = `<div class="empty">❌ ${escapeHtml(e.message)}</div>`;
      return;
    }
  }
  renderCompanies();
}

["comp-q", "comp-tier"].forEach(id => {
  const el = document.getElementById(id);
  if (el) el.addEventListener("input", renderCompanies);
});

function tierBadge(tier) {
  const cls = tier === "FAANG" ? "FAANG"
    : tier === "Tier 1" ? "tier1"
    : tier === "Tier 1 IL" ? "tier1il"
    : tier === "Tier 2 IL" ? "tier2il"
    : tier === "Enterprise" ? "enterprise"
    : "startup";
  return `<span class="tier-badge ${cls}">${escapeHtml(tier)}</span>`;
}

function companyIcon(name) {
  if (/google|waze/i.test(name)) return "🔍";
  if (/microsoft/i.test(name)) return "🪟";
  if (/apple/i.test(name)) return "🍎";
  if (/amazon|aws/i.test(name)) return "📦";
  if (/meta|facebook/i.test(name)) return "👤";
  if (/nvidia/i.test(name)) return "🟢";
  if (/intel|mobileye/i.test(name)) return "🔵";
  if (/cyber|check.*point|sentinel/i.test(name)) return "🛡️";
  if (/fintech|pay|risk|forter|pagaya/i.test(name)) return "💳";
  if (/oracle|sap|cisco/i.test(name)) return "🏢";
  return "🏗️";
}

function renderCompanies() {
  const q = (document.getElementById("comp-q")?.value || "").toLowerCase();
  const tier = document.getElementById("comp-tier")?.value || "";
  let filtered = COMPANIES_DIR.filter(c => {
    if (q && !`${c.name} ${c.sector} ${c.hq}`.toLowerCase().includes(q)) return false;
    if (tier && c.tier !== tier) return false;
    return true;
  });

  const list = document.getElementById("companies-list");
  if (!filtered.length) {
    list.innerHTML = `<div class="empty">אין תוצאות</div>`;
    return;
  }

  list.innerHTML = filtered.map(c => `
    <div class="company-card">
      <div class="company-icon">${companyIcon(c.name)}</div>
      <div>
        <h3>${escapeHtml(c.name)} ${tierBadge(c.tier)}</h3>
        <div class="cc-meta">
          📍 ${escapeHtml(c.hq)} · 👥 ${escapeHtml(c.employees_il)} · ${escapeHtml(c.sector)}
        </div>
        <div class="cc-links">
          <a href="${escapeAttr(c.careers)}" target="_blank" class="btn small">🔗 דף קריירה</a>
          <a href="${escapeAttr(c.linkedin_search)}" target="_blank" class="btn small">💼 LinkedIn Recruiters</a>
          <button class="btn small" onclick="companyDive('${escapeAttr(c.name)}')">🔍 Deep Dive</button>
          <a href="/api/company-brief?name=${encodeURIComponent(c.name)}" class="btn small" download>📥 Brief</a>
          ${c.email_pattern && c.email_pattern !== "—"
            ? `<span class="btn small" title="מייל כללי">📧 ${escapeHtml(c.email_pattern)}</span>`
            : ""}
        </div>
        <div class="cc-tips">💡 ${escapeHtml(c.tips)}</div>
      </div>
    </div>`).join("");
}

// ═══════════════ Companies sub-tabs ═══════════════
document.querySelectorAll(".sub-tab").forEach(tab => {
  tab.addEventListener("click", () => {
    const target = tab.dataset.sub;
    if (!target) return;
    document.querySelectorAll(".sub-tab").forEach(t => t.classList.remove("active"));
    tab.classList.add("active");
    document.getElementById("companies-list-view").style.display = target === "companies-list-view" ? "block" : "none";
    document.getElementById("wlb-view").style.display = target === "wlb-view" ? "block" : "none";
    if (target === "wlb-view") loadWLBPage();
  });
});

// ═══════════════ WLB Directory ═══════════════
let WLB_DATA = [];

async function loadWLBPage() {
  if (!WLB_DATA.length) {
    try {
      const r = await api("/api/wlb-directory");
      WLB_DATA = r.companies;
    } catch (e) {
      document.getElementById("wlb-list").innerHTML = `<div class="empty">❌ ${escapeHtml(e.message)}</div>`;
      return;
    }
  }
  renderWLB();
}

["wlb-tier", "wlb-q"].forEach(id => {
  const el = document.getElementById(id);
  if (el) el.addEventListener("input", renderWLB);
});

function renderWLB() {
  const tier = document.getElementById("wlb-tier")?.value || "";
  const q = (document.getElementById("wlb-q")?.value || "").toLowerCase();

  let filtered = WLB_DATA.filter(c => {
    if (tier && c.tier !== tier) return false;
    if (q && !`${c.name} ${c.sector} ${c.hq}`.toLowerCase().includes(q)) return false;
    return true;
  });

  const list = document.getElementById("wlb-list");
  if (!filtered.length) { list.innerHTML = `<div class="empty">אין תוצאות</div>`; return; }

  list.innerHTML = filtered.map(c => `
    <div class="wlb-card">
      <div class="wlb-score-block">
        <div class="wlb-score ${c.tier}">${c.score}</div>
        <div class="wlb-rank">#${c.rank}</div>
      </div>
      <div>
        <h3>${escapeHtml(c.name)}</h3>
        <div class="wlb-meta">📍 ${escapeHtml(c.hq)} · 👥 ${escapeHtml(c.employees_il)} · ${escapeHtml(c.sector)}</div>

        <div class="wlb-details">
          <div class="wlb-detail"><div class="wlb-dl">Hybrid / Remote</div><div class="wlb-dv">${escapeHtml(c.hybrid)}</div></div>
          <div class="wlb-detail"><div class="wlb-dl">שעות</div><div class="wlb-dv">${escapeHtml(c.hours)}</div></div>
          <div class="wlb-detail"><div class="wlb-dl">חופשה</div><div class="wlb-dv">${c.vacation_days} ימים${c.unlimited_pto ? " (Unlimited)" : ""}</div></div>
          <div class="wlb-detail"><div class="wlb-dl">Crunch</div><div class="wlb-dv">${escapeHtml(c.crunch)}</div></div>
          ${c.glassdoor_wlb ? `<div class="wlb-detail"><div class="wlb-dl">Glassdoor WLB</div><div class="wlb-dv">${c.glassdoor_wlb}/5.0 ⭐</div></div>` : ""}
        </div>

        <div class="wlb-pros-cons">
          <ul class="wlb-pros" style="list-style:none;padding:0;margin:0">
            ${c.pros.map(p => `<li>✅ <span>${escapeHtml(p)}</span></li>`).join("")}
          </ul>
          <ul class="wlb-cons" style="list-style:none;padding:0;margin:0">
            ${c.cons.map(p => `<li>⚠️ <span>${escapeHtml(p)}</span></li>`).join("")}
          </ul>
        </div>

        ${c.quote ? `<div class="wlb-quote">"${escapeHtml(c.quote)}"</div>` : ""}
        ${c.notable ? `<div class="wlb-notable">✨ ${escapeHtml(c.notable)}</div>` : ""}
      </div>
    </div>`).join("");
}

// WLB deep report button
document.getElementById("wlb-deep-btn").addEventListener("click", async () => {
  if (!confirmCost("wlb-ranking")) return;
  const btn = document.getElementById("wlb-deep-btn");
  const orig = btn.textContent;
  btn.disabled = true;
  btn.innerHTML = "מחפש ברשת... <span class='spinner'></span>";
  try {
    const r = await api("/api/wlb-ranking");
    openModal("⚖️ דוח WLB מעמיק (AI + חיפוש)", "טוען...", true);
    setModalContent(r.text);
    currentFilename = `WLB-Deep-Report-${new Date().toISOString().slice(0,10)}.md`;
    toast("✅ דוח WLB מוכן");
  } catch (e) { toast("❌ " + e.message, true); }
  finally { btn.disabled = false; btn.textContent = orig; }
});

// ═══════════════ AI Opportunities page ═══════════════
let AI_CONTENT = null;

function showAIContent(text) {
  AI_CONTENT = text;
  const intro = document.getElementById("ai-content");
  const report = document.getElementById("ai-report");
  intro.style.display = "none";
  report.style.display = "block";
  report.innerHTML = `<div class="modal-body rendered" style="max-height:none;padding:28px 32px">${renderMarkdown(text)}</div>`;
  document.getElementById("ai-download-btn").style.display = "inline-flex";
}

async function loadAIPage() {
  if (AI_CONTENT) {
    showAIContent(AI_CONTENT);
    return;
  }
  // Try loading from server cache
  try {
    const r = await api("/api/ai-opportunities");
    if (r.ok && r.text) {
      showAIContent(r.text);
      if (r.cached) toast("📦 נטען מ-cache");
    }
  } catch {
    // No cache — show the intro screen (already in HTML)
  }
}

document.getElementById("ai-refresh-btn").addEventListener("click", async () => {
  if (!confirmCost("ai-opportunities")) return;
  const btn = document.getElementById("ai-refresh-btn");
  const intro = document.getElementById("ai-content");
  const report = document.getElementById("ai-report");
  const orig = btn.textContent;
  btn.disabled = true;
  btn.innerHTML = "מחפש ברשת... <span class='spinner'></span>";

  intro.style.display = "none";
  report.style.display = "block";
  report.innerHTML = `<div class="ai-loading"><span class="spinner"></span><p>Claude מחפש באינטרנט...</p><span class="muted">תפקידים, קורסים, כלים, שכר ומגמות AI</span></div>`;

  try {
    const r = await api("/api/ai-opportunities?force=1");
    showAIContent(r.text);
    toast("✅ דוח AI עודכן");
  } catch (e) {
    report.innerHTML = `<div class="ai-loading" style="color:var(--f)">❌ ${escapeHtml(e.message)}</div>`;
    toast("❌ " + e.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = orig;
  }
});

document.getElementById("ai-download-btn").addEventListener("click", () => {
  if (!AI_CONTENT) return;
  const blob = new Blob([AI_CONTENT], { type: "text/markdown;charset=utf-8" });
  downloadBlob(blob, `AI-Opportunities-${new Date().toISOString().slice(0,10)}.md`);
  toast("📄 הורד");
});

// ═══════════════ Portfolio page ═══════════════
let PF_DATA = null;

// Sub-tabs for portfolio page
document.querySelectorAll("[data-pfsub]").forEach(tab => {
  tab.addEventListener("click", () => {
    const target = tab.dataset.pfsub;
    document.querySelectorAll("[data-pfsub]").forEach(t => t.classList.remove("active"));
    tab.classList.add("active");
    ["overview", "ideas", "github"].forEach(id => {
      document.getElementById("pf-sub-" + id).style.display = id === target ? "block" : "none";
    });
    if (target === "ideas") loadPFIdeas();
  });
});

async function loadPortfolioPage() {
  renderPFOverview();
}

async function loadPFIdeas() {
  if (!PF_DATA) {
    try {
      PF_DATA = await api("/api/portfolio");
      const catSel = document.getElementById("pf-category");
      PF_DATA.categories.forEach(c => catSel.add(new Option(`${c.icon} ${c.name}`, c.id)));
    } catch (e) {
      document.getElementById("pf-list").innerHTML = `<div class="empty">❌ ${escapeHtml(e.message)}</div>`;
      return;
    }
  }
  renderPFTips();
  renderPFProjects();
}

function renderPFOverview() {
  document.getElementById("pf-overview-content").innerHTML = `
    <div class="card" style="border-right:3px solid var(--accent);margin-bottom:20px">
      <h3>📖 מה זה Portfolio ולמה זה קריטי?</h3>
      <p style="font-size:14px;line-height:1.8;color:var(--fg-soft)">
        <b>Portfolio של מפתח</b> הוא אוסף של פרויקטים שמראים למגייס מה אתה יודע לעשות — לא מה אתה אומר שאתה יודע, אלא מה בנית בפועל.
        בשנת 2026, כשמאות מועמדים מגישים לאותה משרה, portfolio חזק הוא ההבדל בין "נקרא לראיון" ל-"נזרק מהמשפך".
      </p>
    </div>

    <div class="profile-grid" style="margin-bottom:20px">
      <div class="card">
        <h3>🎯 למה Portfolio > קו"ח</h3>
        <div style="font-size:13px;line-height:1.7;color:var(--fg-soft)">
          <p>📄 <b>קורות חיים</b> אומרים "יש לי 5 שנות ניסיון ב-React"</p>
          <p>🚀 <b>Portfolio</b> מראה את ה-React app שבנית — עם קוד, deployment, ו-README</p>
          <p style="margin-top:8px">מגייסים מסתכלים על GitHub לפני שקוראים CV. <b>67% מהמגייסים</b> אומרים שפרויקטים אישיים משפיעים על ההחלטה.</p>
        </div>
      </div>
      <div class="card">
        <h3>📦 מה Portfolio כולל</h3>
        <div style="font-size:13px;line-height:1.7;color:var(--fg-soft)">
          <p>✅ <b>GitHub Profile</b> — ריפוזיטוריז ציבוריים מסודרים</p>
          <p>✅ <b>2-4 פרויקטים מרכזיים</b> — כל אחד פותר בעיה אמיתית</p>
          <p>✅ <b>README מפורט</b> — screenshots, הסבר, how to run</p>
          <p>✅ <b>Live demo</b> — לפחות פרויקט אחד deployed</p>
          <p>✅ <b>Clean code</b> — עם tests, CI, .gitignore</p>
          <p>⭐ <b>Bonus</b> — blog, npm package, open source PR</p>
        </div>
      </div>
      <div class="card">
        <h3>🏗️ איך בונים Portfolio ב-30 יום</h3>
        <div style="font-size:13px;line-height:1.7;color:var(--fg-soft)">
          <p><b>שבוע 1:</b> סדר GitHub profile — README, bio, pinned repos</p>
          <p><b>שבוע 2:</b> בנה פרויקט אחד חזק (AI/Fullstack) עם README מלא</p>
          <p><b>שבוע 3:</b> Deploy + הוסף tests + CI pipeline</p>
          <p><b>שבוע 4:</b> פרויקט שני + תרומת Open Source</p>
          <p style="margin-top:6px;color:var(--accent)"><b>תוצאה:</b> GitHub שמגייס רוצה לראות 🎯</p>
        </div>
      </div>
    </div>

    <div class="profile-grid" style="margin-bottom:20px">
      <div class="card">
        <h3>✅ Portfolio טוב — דוגמה</h3>
        <div style="font-size:12px;line-height:1.7;color:var(--fg-soft)">
          <p>📁 <b>my-saas-starter</b> ⭐23 — Next.js + Stripe + Auth</p>
          <p style="margin-right:16px">README עם screenshots, deployed on Vercel, 45 commits, CI/CD</p>
          <p>📁 <b>rag-chatbot</b> ⭐12 — LangChain + ChromaDB</p>
          <p style="margin-right:16px">Live demo, YouTube walkthrough, clean code</p>
          <p>📁 <b>contributed to langchain</b> — PR #4521 merged</p>
          <p style="margin-right:16px">Fixed bug in document loader, code review passed</p>
        </div>
      </div>
      <div class="card">
        <h3>❌ Portfolio גרוע — דוגמה</h3>
        <div style="font-size:12px;line-height:1.7;color:var(--fg-soft)">
          <p>📁 <b>todo-app</b> ⭐0 — JavaScript</p>
          <p style="margin-right:16px;color:var(--f)">No README, 1 commit, copied from tutorial</p>
          <p>📁 <b>calculator</b> ⭐0 — HTML</p>
          <p style="margin-right:16px;color:var(--f)">No .gitignore, node_modules committed</p>
          <p>📁 <b>test123</b> ⭐0 — No description</p>
          <p style="margin-right:16px;color:var(--f)">Empty repo, last updated 2 years ago</p>
        </div>
      </div>
    </div>

    <div class="card" style="text-align:center;padding:24px">
      <p style="font-size:15px;margin-bottom:12px">🐙 <b>יש לך GitHub? בוא נבדוק מה המצב.</b></p>
      <button class="btn ai-btn-glow" onclick="document.querySelector('[data-pfsub=github]').click()" style="font-size:14px !important">🔍 סרוק את ה-GitHub שלי</button>
      <p class="muted" style="margin-top:8px">Claude ינתח את הפרויקטים שלך וידרג אותם כ-portfolio</p>
    </div>`;
}

["pf-category", "pf-difficulty", "pf-q"].forEach(id => {
  const el = document.getElementById(id);
  if (el) el.addEventListener("input", renderPFProjects);
});

function renderPFTips() {
  const tips = PF_DATA.portfolio_tips;
  if (!tips) return;
  document.getElementById("pf-tips").innerHTML = `
    <div class="pf-tips-grid">
      <div class="pf-tips-card good">
        <h4>✅ חובה בכל Portfolio</h4>
        <ul>${tips.must_haves.map(t => `<li>${escapeHtml(t)}</li>`).join("")}</ul>
      </div>
      <div class="pf-tips-card nice">
        <h4>⭐ Nice to Have</h4>
        <ul>${tips.nice_to_haves.map(t => `<li>${escapeHtml(t)}</li>`).join("")}</ul>
      </div>
      <div class="pf-tips-card bad">
        <h4>❌ טעויות נפוצות</h4>
        <ul>${tips.common_mistakes.map(t => `<li>${escapeHtml(t)}</li>`).join("")}</ul>
      </div>
    </div>`;
}

function renderPFProjects() {
  const catId = document.getElementById("pf-category")?.value || "";
  const diff = document.getElementById("pf-difficulty")?.value || "";
  const q = (document.getElementById("pf-q")?.value || "").toLowerCase();
  const list = document.getElementById("pf-list");
  let html = "";

  for (const cat of PF_DATA.categories) {
    if (catId && cat.id !== catId) continue;
    let projects = cat.projects.filter(p => {
      if (diff && p.difficulty !== diff) return false;
      if (q && !`${p.title} ${p.description} ${p.stack.join(" ")}`.toLowerCase().includes(q)) return false;
      return true;
    });
    if (!projects.length) continue;

    html += `<div style="margin-bottom:24px">
      <div class="lc-category-header"><span class="cat-icon">${cat.icon}</span> ${escapeHtml(cat.name)}
        <span class="muted" style="font-size:12px;font-weight:400;margin-right:8px">${escapeHtml(cat.why)}</span>
      </div>
      ${projects.map(p => renderPFProject(p)).join("")}
    </div>`;
  }
  if (!html) html = `<div class="empty">אין תוצאות</div>`;
  list.innerHTML = html;
}

function renderPFProject(p) {
  const impactClass = p.impact >= 9 ? "high" : p.impact >= 7 ? "med" : "low";
  return `
    <div class="pf-project" id="pf-${p.id}">
      <div class="pf-project-head" onclick="document.getElementById('pf-${p.id}').classList.toggle('open')">
        <div class="pf-impact ${impactClass}"><b>${p.impact}</b><span>/10</span></div>
        <div style="flex:1">
          <h3>${escapeHtml(p.title)}</h3>
          <div class="pf-meta">
            <span class="pf-diff ${p.difficulty}">${p.difficulty === "easy" ? "🟢 קל" : p.difficulty === "medium" ? "🟡 בינוני" : "🔴 מאתגר"}</span>
            <span>⏱️ ${escapeHtml(p.time)}</span>
            <span>🛠️ ${p.stack.slice(0, 4).join(", ")}</span>
          </div>
        </div>
        <span class="pf-chevron">▶</span>
      </div>
      <div class="pf-body">
        <p>${escapeHtml(p.description)}</p>

        <div class="pf-section">
          <h4>🛠️ Stack מלא</h4>
          <div class="pf-feature-grid">
            ${p.stack.map(s => `<span class="skill-chip secondary">${escapeHtml(s)}</span>`).join("")}
          </div>
        </div>

        <div class="pf-section">
          <h4>✨ פיצ'רים מרכזיים</h4>
          <div class="pf-feature-grid">
            ${p.features.map(f => `<span class="skill-chip">${escapeHtml(f)}</span>`).join("")}
          </div>
        </div>

        <div class="pf-section">
          <h4>📚 מה תלמד</h4>
          <div class="pf-feature-grid">
            ${p.what_youll_learn.map(w => `<span class="skill-chip interest">${escapeHtml(w)}</span>`).join("")}
          </div>
        </div>

        <div class="pf-interview-value">
          💼 <b>ערך בראיון:</b> ${escapeHtml(p.interview_value)}
        </div>

        <div class="pf-section" style="margin-top:12px">
          <h4>🔗 משאבים ללמידה</h4>
          <div class="pf-feature-grid">
            ${p.resources.map(r => `<span class="skill-chip primary">${escapeHtml(r)}</span>`).join("")}
          </div>
        </div>
      </div>
    </div>`;
}

// ═══════════════ GitHub scan ═══════════════
document.getElementById("gh-scan-btn").addEventListener("click", async () => {
  const username = document.getElementById("gh-username").value.trim();
  if (!username) { toast("הזן username", true); return; }
  if (!confirmCost("github-analysis")) return;
  const btn = document.getElementById("gh-scan-btn");
  const results = document.getElementById("gh-results");
  const orig = btn.textContent;
  btn.disabled = true;
  btn.innerHTML = "סורק... <span class='spinner'></span>";
  results.innerHTML = `<div class="ai-loading"><span class="spinner"></span><p>סורק ${username} ב-GitHub...</p><span class="muted">מביא repos + Claude מנתח</span></div>`;

  try {
    const r = await api("/api/github/scan", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username }),
    });

    // Show repos grid + analysis
    const reposHtml = r.repos.length ? `
      <div class="card" style="margin-bottom:16px">
        <h3>📦 ${r.repos.length} ריפוזיטוריז ציבוריים (לא forks)</h3>
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:8px;margin-top:12px">
          ${r.repos.map(repo => `
            <div style="background:var(--bg);border-radius:8px;padding:12px;border:1px solid var(--border)">
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
                <a href="${escapeAttr(repo.url)}" target="_blank" style="font-weight:600;font-size:13px">${escapeHtml(repo.name)}</a>
                <span style="font-size:11px;color:var(--muted)">⭐${repo.stars}</span>
              </div>
              <div style="font-size:11px;color:var(--muted);margin-bottom:4px">${escapeHtml(repo.description || "—")}</div>
              <div style="display:flex;gap:4px;flex-wrap:wrap">
                ${repo.language ? `<span class="skill-chip secondary" style="font-size:10px;padding:1px 6px">${escapeHtml(repo.language)}</span>` : ""}
                ${(repo.topics || []).slice(0, 3).map(t => `<span class="skill-chip" style="font-size:10px;padding:1px 6px">${escapeHtml(t)}</span>`).join("")}
              </div>
            </div>`).join("")}
        </div>
      </div>` : "";

    const analysisHtml = r.analysis ? `
      <div class="card">
        <div class="modal-body rendered" style="padding:0;max-height:none">${renderMarkdown(r.analysis)}</div>
      </div>` : "";

    results.innerHTML = reposHtml + analysisHtml;
    toast(`✅ ${r.repos.length} repos נסרקו ודורגו`);
  } catch (e) {
    results.innerHTML = `<div class="empty" style="color:var(--f)">❌ ${escapeHtml(e.message)}</div>`;
    toast("❌ " + e.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = orig;
  }
});

// Enter key on username input
document.getElementById("gh-username").addEventListener("keydown", (e) => {
  if (e.key === "Enter") document.getElementById("gh-scan-btn").click();
});

// ═══════════════ LeetCode page ═══════════════
let LC_DATA = null;

async function loadLeetcodePage() {
  if (!LC_DATA) {
    try {
      LC_DATA = await api("/api/leetcode");
    } catch (e) {
      document.getElementById("lc-list").innerHTML = `<div class="empty">❌ ${escapeHtml(e.message)}</div>`;
      return;
    }
    // Populate category filter
    const catSel = document.getElementById("lc-category");
    LC_DATA.categories.forEach(c => catSel.add(new Option(`${c.icon} ${c.name}`, c.id)));
  }
  renderLCPlans();
  renderLCProblems();
}

["lc-level", "lc-category", "lc-q"].forEach(id => {
  const el = document.getElementById(id);
  if (el) el.addEventListener("input", renderLCProblems);
});

function renderLCPlans() {
  const plans = LC_DATA.study_plans;
  document.getElementById("lc-plans").innerHTML = `
    <div class="lc-plans-grid">
      ${Object.entries(plans).map(([key, p]) => `
        <div class="lc-plan" onclick="activateLCPlan('${key}')">
          <h4>${escapeHtml(p.name)}</h4>
          <div class="lc-plan-desc">${escapeHtml(p.description)}</div>
          <div class="lc-plan-count">${p.problems.length} <span class="muted" style="font-size:13px;font-weight:400">שאלות</span></div>
        </div>`).join("")}
    </div>`;
}

window.activateLCPlan = (key) => {
  const plan = LC_DATA.study_plans[key];
  if (!plan) return;
  // Build a filtered view showing only the plan's problems
  const nums = new Set(plan.problems);
  const list = document.getElementById("lc-list");
  let html = `<div style="margin-bottom:16px;display:flex;justify-content:space-between;align-items:center">
    <h3>📋 ${escapeHtml(plan.name)}</h3>
    <button class="btn small" onclick="renderLCProblems()">← כל השאלות</button>
  </div>`;

  let count = 0;
  for (const cat of LC_DATA.categories) {
    const problems = [];
    for (const level of ["easy", "medium", "hard"]) {
      for (const p of (cat.levels[level] || [])) {
        if (nums.has(p.num)) problems.push({ ...p, level });
      }
    }
    if (!problems.length) continue;
    html += `<div class="lc-category-section">
      <div class="lc-category-header"><span class="cat-icon">${cat.icon}</span> ${escapeHtml(cat.name)}</div>
      ${problems.map(p => renderLCProblem(p, p.level)).join("")}
    </div>`;
    count += problems.length;
  }
  html = html.replace("📋", `📋 ${count} שאלות ·`);
  list.innerHTML = html;
};

function renderLCProblems() {
  if (!LC_DATA) return;
  const level = document.getElementById("lc-level")?.value || "";
  const catId = document.getElementById("lc-category")?.value || "";
  const q = (document.getElementById("lc-q")?.value || "").toLowerCase();

  const list = document.getElementById("lc-list");
  let html = "";
  let total = 0;

  for (const cat of LC_DATA.categories) {
    if (catId && cat.id !== catId) continue;
    let catHtml = "";
    for (const lv of ["easy", "medium", "hard"]) {
      if (level && lv !== level) continue;
      const problems = (cat.levels[lv] || []).filter(p => {
        if (q && !`${p.title} ${p.pattern} ${p.tip}`.toLowerCase().includes(q)) return false;
        return true;
      });
      if (!problems.length) continue;
      catHtml += `<div class="lc-level-label ${lv}">${lv === "easy" ? "🟢 Easy" : lv === "medium" ? "🟡 Medium" : "🔴 Hard"}</div>`;
      catHtml += problems.map(p => renderLCProblem(p, lv)).join("");
      total += problems.length;
    }
    if (catHtml) {
      html += `<div class="lc-category-section">
        <div class="lc-category-header"><span class="cat-icon">${cat.icon}</span> ${escapeHtml(cat.name)}</div>
        ${catHtml}
      </div>`;
    }
  }
  if (!html) html = `<div class="empty">אין תוצאות</div>`;
  list.innerHTML = html;
}

function renderLCProblem(p, level) {
  return `
    <div class="lc-problem">
      <div class="lc-problem-head">
        <a href="${escapeAttr(p.url)}" target="_blank">#${p.num} ${escapeHtml(p.title)}</a>
        <span class="lc-pattern">${escapeHtml(p.pattern)}</span>
      </div>
      <div class="lc-tip">💡 ${escapeHtml(p.tip)}</div>
      <div class="lc-example">${escapeHtml(p.example)}</div>
    </div>`;
}

// ═══════════════ CV Editor ═══════════════
let CVE_STATE = { lang: "en", cvId: null, profileId: null, structured: null };

async function loadCVEditor() {
  if (!ACTIVE_PROFILE) {
    document.getElementById("cve-content").innerHTML = `<div class="empty">אין פרופיל פעיל. <br><button class="btn primary" style="margin-top:12px" onclick="document.querySelector('[data-tab=profile]').click()">👤 לדף פרופיל</button></div>`;
    return;
  }

  // Populate CV selector
  const sel = document.getElementById("cve-cv-select");
  sel.innerHTML = "";
  ACTIVE_PROFILE.cvs.forEach(c => sel.add(new Option(c.label || c.filename, c.id)));
  sel.value = CVE_STATE.cvId || ACTIVE_PROFILE.cvs[ACTIVE_PROFILE.primary_cv_index || 0].id;

  CVE_STATE.cvId = sel.value;
  CVE_STATE.profileId = ACTIVE_PROFILE.id;

  await fetchCVEData();
}

document.getElementById("cve-cv-select").addEventListener("change", async (e) => {
  CVE_STATE.cvId = e.target.value;
  await fetchCVEData();
});

document.querySelectorAll(".cve-lang-btn").forEach(btn => {
  btn.addEventListener("click", async () => {
    document.querySelectorAll(".cve-lang-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    CVE_STATE.lang = btn.dataset.lang;
    await fetchCVEData();
  });
});

async function fetchCVEData() {
  const wrap = document.getElementById("cve-content");
  wrap.innerHTML = `<div class="ai-loading"><span class="spinner"></span><p>טוען CV...</p><span class="muted">אם זו פעם ראשונה — Claude מחלץ את המבנה (~10-20 שניות)</span></div>`;
  try {
    const r = await api(`/api/cv-editor/get?profileId=${encodeURIComponent(CVE_STATE.profileId)}&cvId=${encodeURIComponent(CVE_STATE.cvId)}&lang=${CVE_STATE.lang}`);
    CVE_STATE.structured = r.structured;
    document.getElementById("cve-subtitle").textContent =
      `${r.language === "en" ? "🇬🇧 English" : "🇮🇱 עברית"} · ${r.structured.header.name}`;
    renderCVEditor();
    document.getElementById("cve-download-bar").style.display = "flex";
    document.getElementById("cve-ai-panel").style.display = "block";
    // Load revision count
    try {
      const rev = await api(`/api/cv-editor/revisions?profileId=${encodeURIComponent(CVE_STATE.profileId)}&cvId=${encodeURIComponent(CVE_STATE.cvId)}&language=${CVE_STATE.lang}`);
      updateRevCountBadge(rev.revisions.length);
    } catch {}
    refreshAnalysesCount();
  } catch (e) {
    wrap.innerHTML = `<div class="empty">❌ ${escapeHtml(e.message)}</div>`;
  }
}

document.getElementById("cve-translate-btn").addEventListener("click", async () => {
  const target = CVE_STATE.lang === "en" ? "he" : "en";
  if (!confirm(`לתרגם את ה-CV ל-${target === "en" ? "אנגלית" : "עברית"}?`)) return;
  const btn = document.getElementById("cve-translate-btn");
  const orig = btn.textContent;
  btn.disabled = true; btn.innerHTML = "מתרגם... <span class='spinner'></span>";
  try {
    const r = await api("/api/cv-editor/translate", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profileId: CVE_STATE.profileId, cvId: CVE_STATE.cvId, toLanguage: target }),
    });
    CVE_STATE.lang = target;
    CVE_STATE.structured = r.structured;
    document.querySelectorAll(".cve-lang-btn").forEach(b => b.classList.toggle("active", b.dataset.lang === target));
    renderCVEditor();
    toast("✅ תורגם");
  } catch (e) { toast("❌ " + e.message, true); }
  finally { btn.disabled = false; btn.textContent = orig; }
});

document.getElementById("cve-save-btn").addEventListener("click", async () => {
  const label = prompt("תווית לגרסה זו (אופציונלי, השאר ריק לדלג):");
  try {
    const r = await api("/api/cv-editor/save", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        profileId: CVE_STATE.profileId, cvId: CVE_STATE.cvId,
        language: CVE_STATE.lang, structured: CVE_STATE.structured,
        label: label || undefined,
      }),
    });
    toast(`💾 נשמר · ${r.revisions_count} גרסאות בהיסטוריה`);
    updateRevCountBadge(r.revisions_count);
  } catch (e) { toast("❌ " + e.message, true); }
});

function updateRevCountBadge(count) {
  const badge = document.getElementById("cve-rev-count");
  if (count > 0) {
    badge.textContent = count;
    badge.style.display = "inline-block";
  } else {
    badge.style.display = "none";
  }
}

// ── Revisions modal ──
document.getElementById("cve-revisions-btn").addEventListener("click", openRevisions);
document.getElementById("revisions-close").addEventListener("click", () =>
  document.getElementById("revisions-modal-backdrop").classList.remove("open"));
document.getElementById("revisions-modal-backdrop").addEventListener("click", (e) => {
  if (e.target.id === "revisions-modal-backdrop") e.target.classList.remove("open");
});

async function openRevisions() {
  const wrap = document.getElementById("revisions-list");
  wrap.innerHTML = `<div class="ai-loading"><span class="spinner"></span><p>טוען...</p></div>`;
  document.getElementById("revisions-modal-backdrop").classList.add("open");
  try {
    const r = await api(`/api/cv-editor/revisions?profileId=${encodeURIComponent(CVE_STATE.profileId)}&cvId=${encodeURIComponent(CVE_STATE.cvId)}&language=${CVE_STATE.lang}`);
    if (!r.revisions.length) {
      wrap.innerHTML = `<div class="empty" style="padding:30px"><p>📭 אין גרסאות שמורות עדיין.</p><p class="muted" style="margin-top:8px">כל פעם שתלחץ "💾 שמור שינויים" — הגרסה הקודמת תישמר כאן.</p></div>`;
      updateRevCountBadge(0);
      return;
    }
    updateRevCountBadge(r.revisions.length);
    wrap.innerHTML = `
      <div class="rev-item current">
        <div class="rev-item-head">
          <div class="rev-item-date">⭐ גרסה נוכחית (${CVE_STATE.lang === "en" ? "🇬🇧" : "🇮🇱"})</div>
        </div>
        <div class="rev-item-summary">זו הגרסה שמוצגת ונערכת כרגע</div>
      </div>
      ${r.revisions.map(rev => `
        <div class="rev-item">
          <div class="rev-item-head">
            <div class="rev-item-date">
              ${rev.label ? `<span class="rev-item-label">🏷️ ${escapeHtml(rev.label)}</span>` : ""}
              📅 ${fmtDate(rev.saved_at)}
            </div>
            <span class="rev-item-lang">${rev.language === "en" ? "🇬🇧 EN" : "🇮🇱 HE"}</span>
          </div>
          <div class="rev-item-summary">${escapeHtml(rev.changes_summary || "—")}</div>
          <div class="rev-item-actions">
            <button onclick="restoreRevision('${escapeAttr(rev.id)}')">↺ שחזר</button>
            <button onclick="labelRevision('${escapeAttr(rev.id)}','${escapeAttr(rev.label || "")}')">🏷️ ${rev.label ? "ערוך תווית" : "הוסף תווית"}</button>
            <button class="danger" onclick="deleteRevision('${escapeAttr(rev.id)}')">🗑️ מחק</button>
          </div>
        </div>
      `).join("")}`;
  } catch (e) {
    wrap.innerHTML = `<div class="empty" style="color:var(--f)">❌ ${escapeHtml(e.message)}</div>`;
  }
}

window.restoreRevision = async (revisionId) => {
  if (!confirm("לשחזר גרסה זו? הגרסה הנוכחית תישמר אוטומטית כגרסה חדשה.")) return;
  try {
    const r = await api("/api/cv-editor/restore", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profileId: CVE_STATE.profileId, cvId: CVE_STATE.cvId, revisionId }),
    });
    CVE_STATE.structured = r.structured;
    document.getElementById("revisions-modal-backdrop").classList.remove("open");
    renderCVEditor();
    toast("↺ גרסה שוחזרה");
  } catch (e) { toast("❌ " + e.message, true); }
};

window.deleteRevision = async (revisionId) => {
  if (!confirm("למחוק גרסה זו? לא ניתן לשחזר.")) return;
  try {
    await api("/api/cv-editor/delete-revision", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profileId: CVE_STATE.profileId, cvId: CVE_STATE.cvId, revisionId }),
    });
    toast("🗑️ נמחק");
    openRevisions();
  } catch (e) { toast("❌ " + e.message, true); }
};

window.labelRevision = async (revisionId, currentLabel) => {
  const label = prompt("תווית לגרסה:", currentLabel);
  if (label === null) return;
  try {
    await api("/api/cv-editor/label-revision", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profileId: CVE_STATE.profileId, cvId: CVE_STATE.cvId, revisionId, label: label.trim() }),
    });
    toast("🏷️ תווית עודכנה");
    openRevisions();
  } catch (e) { toast("❌ " + e.message, true); }
};

// ── AI Assistant: collapse toggle ──
document.getElementById("cve-ai-collapse").addEventListener("click", () => {
  const card = document.querySelector(".cve-ai-card");
  card.classList.toggle("collapsed");
  document.getElementById("cve-ai-collapse").textContent = card.classList.contains("collapsed") ? "▲" : "▼";
});

// ── Smart Add ──
document.getElementById("cve-smart-add-btn").addEventListener("click", async () => {
  const text = document.getElementById("cve-smart-text").value.trim();
  if (!text) { toast("הזן טקסט תחילה", true); return; }
  const btn = document.getElementById("cve-smart-add-btn");
  const orig = btn.textContent;
  btn.disabled = true;
  btn.innerHTML = "מנתח... <span class='spinner'></span>";
  try {
    const r = await api("/api/cv-editor/smart-add", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ structured: CVE_STATE.structured, text, language: CVE_STATE.lang }),
    });
    // Show preview modal
    window._smartAddPending = r.updated;
    document.getElementById("smart-add-preview").innerHTML = `
      <div class="smart-add-summary">✨ ${escapeHtml(r.summary || "שינויים יוחלו")}</div>
      <div class="muted" style="font-size:12px;margin-bottom:10px">השינויים יוחלו על ה-CV הנוכחי. הגרסה הקודמת תישמר בהיסטוריה אוטומטית.</div>
      <details>
        <summary style="cursor:pointer;color:var(--accent);font-size:13px">📋 ראה את ה-JSON המעודכן</summary>
        <pre style="background:var(--bg);padding:12px;border-radius:8px;font-size:11px;overflow-x:auto;margin-top:8px;max-height:300px">${escapeHtml(JSON.stringify(r.updated, null, 2))}</pre>
      </details>`;
    document.getElementById("smart-add-modal-backdrop").classList.add("open");
  } catch (e) { toast("❌ " + e.message, true); }
  finally { btn.disabled = false; btn.textContent = orig; }
});

document.getElementById("smart-add-close").addEventListener("click", () =>
  document.getElementById("smart-add-modal-backdrop").classList.remove("open"));
document.getElementById("smart-add-cancel").addEventListener("click", () =>
  document.getElementById("smart-add-modal-backdrop").classList.remove("open"));

document.getElementById("smart-add-apply").addEventListener("click", async () => {
  if (!window._smartAddPending) return;
  // Save current as revision first via the regular save endpoint (it auto-creates revision)
  CVE_STATE.structured = window._smartAddPending;
  try {
    const r = await api("/api/cv-editor/save", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        profileId: CVE_STATE.profileId, cvId: CVE_STATE.cvId,
        language: CVE_STATE.lang, structured: CVE_STATE.structured,
        label: "✨ Smart Add",
      }),
    });
    document.getElementById("smart-add-modal-backdrop").classList.remove("open");
    document.getElementById("cve-smart-text").value = "";
    renderCVEditor();
    updateRevCountBadge(r.revisions_count);
    toast("✅ השינויים הוחלו ונשמרו");
  } catch (e) { toast("❌ " + e.message, true); }
});

// ── Analyze CV (with auto-save + improve button) ──
let CVE_LAST_ANALYSIS = null;

document.getElementById("cve-analyze-btn").addEventListener("click", async () => {
  if (!confirmCost("analyze")) return;
  const btn = document.getElementById("cve-analyze-btn");
  const orig = btn.textContent;
  btn.disabled = true;
  btn.innerHTML = "מנתח... <span class='spinner'></span>";
  openModal("🔍 ניתוח קורות החיים שלך", "מנתח... זה יקח 15-25 שניות", true);
  currentFilename = `cv-analysis-${Date.now()}.md`;
  try {
    const r = await api("/api/cv-editor/analyze", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        structured: CVE_STATE.structured,
        language: CVE_STATE.lang,
        profileId: CVE_STATE.profileId,
        cvId: CVE_STATE.cvId,
      }),
    });
    CVE_LAST_ANALYSIS = { text: r.text, snapshot: CVE_STATE.structured };
    setModalContent(r.text);
    addImproveButtonToModal();
    refreshAnalysesCount();
    toast("✅ ניתוח נשמר בהיסטוריה");
  } catch (e) {
    setModalContent("❌ " + e.message);
    toast("❌ " + e.message, true);
  } finally { btn.disabled = false; btn.textContent = orig; }
});

function addImproveButtonToModal() {
  // Add an "improve" button to the modal foot if not exists
  const foot = document.querySelector("#modal-backdrop .modal-foot");
  if (!foot) return;
  if (foot.querySelector(".cve-improve-btn-modal")) return;
  const btn = document.createElement("button");
  btn.className = "btn primary cve-improve-btn-modal";
  btn.textContent = "✨ צור גרסה משופרת מהניתוח";
  btn.style.background = "linear-gradient(135deg, #a78bfa, #8b5cf6)";
  btn.style.border = "none";
  btn.style.marginRight = "auto";
  btn.onclick = improveFromAnalysis;
  foot.insertBefore(btn, foot.firstChild);
}

// Remove improve button from modal when modal opens for non-analysis content
const _origOpenModal = openModal;
function patchModal() {
  // Strip improve button when modal closes / opens fresh
  const close = document.getElementById("modal-close");
  if (close) close.addEventListener("click", () => {
    document.querySelectorAll(".cve-improve-btn-modal").forEach(b => b.remove());
  });
}
patchModal();

async function improveFromAnalysis() {
  if (!CVE_LAST_ANALYSIS) return;
  if (!confirmCost("improve")) return;
  const btn = document.querySelector(".cve-improve-btn-modal");
  if (btn) { btn.disabled = true; btn.innerHTML = "מייצר... <span class='spinner'></span>"; }
  try {
    const r = await api("/api/cv-editor/improve", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        structured: CVE_LAST_ANALYSIS.snapshot,
        analysisText: CVE_LAST_ANALYSIS.text,
        language: CVE_STATE.lang,
      }),
    });
    window._improvedCV = r.improved;
    document.getElementById("improve-preview").innerHTML = `
      <div class="smart-add-summary" style="background:rgba(168,85,247,0.08);border-color:rgba(168,85,247,0.3);color:#a78bfa;border-right-color:#a78bfa">
        ✨ ${escapeHtml(r.summary || "גרסה משופרת מוכנה")}
      </div>
      <div class="muted" style="font-size:12px;margin-bottom:14px">השיפורים יוחלו על ה-CV הנוכחי. הגרסה הקודמת תישמר בהיסטוריית הגרסאות אוטומטית.</div>
      <details>
        <summary style="cursor:pointer;color:var(--accent);font-size:13px">📋 ראה את ה-JSON המשופר</summary>
        <pre style="background:var(--bg);padding:12px;border-radius:8px;font-size:11px;overflow-x:auto;margin-top:8px;max-height:300px">${escapeHtml(JSON.stringify(r.improved, null, 2))}</pre>
      </details>`;
    closeModal();
    document.getElementById("improve-modal-backdrop").classList.add("open");
  } catch (e) {
    toast("❌ " + e.message, true);
    if (btn) { btn.disabled = false; btn.textContent = "✨ צור גרסה משופרת מהניתוח"; }
  }
}

document.getElementById("improve-close").addEventListener("click", () =>
  document.getElementById("improve-modal-backdrop").classList.remove("open"));
document.getElementById("improve-cancel").addEventListener("click", () =>
  document.getElementById("improve-modal-backdrop").classList.remove("open"));
document.getElementById("improve-apply").addEventListener("click", async () => {
  if (!window._improvedCV) return;
  CVE_STATE.structured = window._improvedCV;
  try {
    const r = await api("/api/cv-editor/save", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        profileId: CVE_STATE.profileId, cvId: CVE_STATE.cvId,
        language: CVE_STATE.lang, structured: CVE_STATE.structured,
        label: "✨ שיפור מניתוח",
      }),
    });
    document.getElementById("improve-modal-backdrop").classList.remove("open");
    renderCVEditor();
    updateRevCountBadge(r.revisions_count);
    toast("✅ השיפורים הוחלו ונשמרו");
  } catch (e) { toast("❌ " + e.message, true); }
});

// ── Past Analyses ──
async function refreshAnalysesCount() {
  if (!CVE_STATE.profileId) return;
  try {
    const r = await api(`/api/cv-editor/analyses?profileId=${encodeURIComponent(CVE_STATE.profileId)}&cvId=${encodeURIComponent(CVE_STATE.cvId)}&language=${CVE_STATE.lang}`);
    const badge = document.getElementById("cve-analyses-count");
    if (r.analyses.length > 0) {
      badge.textContent = r.analyses.length;
      badge.style.display = "inline-block";
    } else {
      badge.style.display = "none";
    }
  } catch {}
}

document.getElementById("cve-past-analyses-btn").addEventListener("click", openPastAnalyses);
document.getElementById("analyses-close").addEventListener("click", () =>
  document.getElementById("analyses-modal-backdrop").classList.remove("open"));
document.getElementById("analyses-modal-backdrop").addEventListener("click", (e) => {
  if (e.target.id === "analyses-modal-backdrop") e.target.classList.remove("open");
});

async function openPastAnalyses() {
  const wrap = document.getElementById("analyses-list");
  wrap.innerHTML = `<div class="ai-loading"><span class="spinner"></span><p>טוען...</p></div>`;
  document.getElementById("analyses-modal-backdrop").classList.add("open");
  try {
    const r = await api(`/api/cv-editor/analyses?profileId=${encodeURIComponent(CVE_STATE.profileId)}&cvId=${encodeURIComponent(CVE_STATE.cvId)}&language=${CVE_STATE.lang}`);
    if (!r.analyses.length) {
      wrap.innerHTML = `<div class="empty" style="padding:30px"><p>📭 אין ניתוחים שמורים עדיין.</p><p class="muted" style="margin-top:8px">לחץ "🔍 נתח את ה-CV" — כל ניתוח נשמר אוטומטית.</p></div>`;
      return;
    }
    wrap.innerHTML = r.analyses.map(a => `
      <div class="rev-item">
        <div class="rev-item-head">
          <div class="rev-item-date">📅 ${fmtDate(a.created_at)}</div>
          <span class="rev-item-lang">${a.language === "en" ? "🇬🇧 EN" : "🇮🇱 HE"}</span>
        </div>
        <div class="rev-item-actions">
          <button onclick="viewAnalysis('${escapeAttr(a.id)}')">👁️ צפה</button>
          <button class="danger" onclick="deleteAnalysis('${escapeAttr(a.id)}')">🗑️ מחק</button>
        </div>
      </div>`).join("");
  } catch (e) {
    wrap.innerHTML = `<div class="empty" style="color:var(--f)">❌ ${escapeHtml(e.message)}</div>`;
  }
}

window.viewAnalysis = async (analysisId) => {
  try {
    const r = await api(`/api/cv-editor/analysis?profileId=${encodeURIComponent(CVE_STATE.profileId)}&cvId=${encodeURIComponent(CVE_STATE.cvId)}&id=${encodeURIComponent(analysisId)}`);
    document.getElementById("analyses-modal-backdrop").classList.remove("open");
    CVE_LAST_ANALYSIS = { text: r.analysis.text, snapshot: r.analysis.cv_snapshot };
    openModal(`🔍 ניתוח מ-${fmtDate(r.analysis.created_at)}`, r.analysis.text);
    addImproveButtonToModal();
    currentFilename = `cv-analysis-${analysisId}.md`;
  } catch (e) { toast("❌ " + e.message, true); }
};

window.deleteAnalysis = async (analysisId) => {
  if (!confirm("למחוק ניתוח זה?")) return;
  try {
    await api("/api/cv-editor/analysis-delete", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profileId: CVE_STATE.profileId, cvId: CVE_STATE.cvId, analysisId }),
    });
    toast("🗑️ נמחק");
    openPastAnalyses();
    refreshAnalysesCount();
  } catch (e) { toast("❌ " + e.message, true); }
};

// ── Compact CV ──
document.getElementById("cve-compact-btn").addEventListener("click", async () => {
  if (!confirmCost("compact")) return;
  const btn = document.getElementById("cve-compact-btn");
  const orig = btn.textContent;
  btn.disabled = true;
  btn.innerHTML = "מצמצם... <span class='spinner'></span>";
  try {
    const r = await api("/api/cv-editor/compact", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ structured: CVE_STATE.structured, language: CVE_STATE.lang }),
    });
    window._compactCV = r.structured;
    // Show preview with stats
    const orig_size = JSON.stringify(CVE_STATE.structured).length;
    const new_size = JSON.stringify(r.structured).length;
    const reduction = Math.round((1 - new_size / orig_size) * 100);
    document.getElementById("compact-preview").innerHTML = `
      <div class="smart-add-summary" style="background:rgba(77,159,255,0.08);border-color:rgba(77,159,255,0.3);color:var(--accent);border-right-color:var(--accent)">
        🎯 הגרסה צומצמה ב-${reduction}% (${(orig_size/1024).toFixed(1)}KB → ${(new_size/1024).toFixed(1)}KB)
      </div>
      <div class="muted" style="font-size:12px;margin-bottom:14px">
        AI שמר על כל המידע הקריטי, צמצם תיאורים, השאיר את הbullets החשובים, וקיצר ניסיון ישן יותר.
        <br>הגרסה המקוצרת לא תוחל על ה-CV — היא רק להורדה.
      </div>
      <div style="background:var(--bg);padding:14px;border-radius:8px;font-size:13px;line-height:1.6">
        <b>${escapeHtml(r.structured.header?.name || "")}</b><br>
        <span class="muted">${escapeHtml(r.structured.header?.title || "")}</span><br><br>
        <b>📋 תקציר:</b> ${escapeHtml((r.structured.summary || "").slice(0, 200))}${(r.structured.summary || "").length > 200 ? "..." : ""}<br>
        <b>💼 משרות:</b> ${r.structured.experience?.length || 0}<br>
        <b>🎓 השכלה:</b> ${r.structured.education?.length || 0}<br>
        <b>🛠️ קטגוריות כישורים:</b> ${r.structured.skills?.length || 0}<br>
        <b>🚀 פרויקטים:</b> ${r.structured.projects?.length || 0}<br>
      </div>`;
    document.getElementById("compact-modal-backdrop").classList.add("open");
    toast("✅ גרסה מקוצרת מוכנה");
  } catch (e) { toast("❌ " + e.message, true); }
  finally { btn.disabled = false; btn.textContent = orig; }
});

document.getElementById("compact-close").addEventListener("click", () =>
  document.getElementById("compact-modal-backdrop").classList.remove("open"));

window.cveDownloadCompact = async (format) => {
  if (!window._compactCV) return;
  try {
    const r = await fetch("/api/cv-editor/generate", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ structured: window._compactCV, format }),
    });
    if (!r.ok) throw new Error((await r.json()).error);
    const blob = await r.blob();
    const name = window._compactCV.header?.name || "resume";
    downloadBlob(blob, `CV-${name}-COMPACT-${CVE_STATE.lang}.${format}`);
    toast(`✅ הורד מקוצר .${format}`);
  } catch (e) { toast("❌ " + e.message, true); }
};

window.cveDownload = async (format) => {
  try {
    const r = await fetch("/api/cv-editor/generate", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ structured: CVE_STATE.structured, format }),
    });
    if (!r.ok) throw new Error((await r.json()).error);
    const blob = await r.blob();
    const ext = format;
    const name = CVE_STATE.structured.header.name || "resume";
    downloadBlob(blob, `CV-${name}-${CVE_STATE.lang}.${ext}`);
    toast(`✅ הורד .${ext}`);
  } catch (e) { toast("❌ " + e.message, true); }
};

function renderCVEditor() {
  const s = CVE_STATE.structured;
  if (!s) return;
  const isHe = CVE_STATE.lang === "he";
  const t = isHe ? {
    summary: "תקציר", experience: "ניסיון תעסוקתי", education: "השכלה",
    skills: "כישורים", projects: "פרויקטים", certifications: "הסמכות", languages: "שפות",
    add: "הוסף", company: "חברה", title: "תפקיד", location: "מיקום",
    start: "התחלה", end: "סיום", description: "תיאור", achievements: "הישגים",
    technologies: "טכנולוגיות", category: "קטגוריה", skill: "כישור",
    institution: "מוסד", degree: "תואר", field: "תחום", gpa: "ממוצע", honors: "צל\"ש",
    project: "פרויקט", url: "קישור", date: "תאריך", cert: "הסמכה",
    issuer: "מנפיק", language: "שפה", level: "רמה",
    name: "שם מלא", email: "אימייל", phone: "טלפון",
  } : {
    summary: "Summary", experience: "Experience", education: "Education",
    skills: "Skills", projects: "Projects", certifications: "Certifications", languages: "Languages",
    add: "Add", company: "Company", title: "Title", location: "Location",
    start: "Start", end: "End", description: "Description", achievements: "Achievements",
    technologies: "Technologies", category: "Category", skill: "Skill",
    institution: "Institution", degree: "Degree", field: "Field", gpa: "GPA", honors: "Honors",
    project: "Project", url: "URL", date: "Date", cert: "Certification",
    issuer: "Issuer", language: "Language", level: "Level",
    name: "Full Name", email: "Email", phone: "Phone",
  };

  const sections = [
    { id: "header", icon: "👤", color: "blue", title: t.name, count: null },
    { id: "summary", icon: "📋", color: "cyan", title: t.summary, count: null },
    { id: "experience", icon: "💼", color: "green", title: t.experience, count: (s.experience || []).length },
    { id: "education", icon: "🎓", color: "purple", title: t.education, count: (s.education || []).length },
    { id: "skills", icon: "🛠️", color: "orange", title: t.skills, count: (s.skills || []).length },
    { id: "projects", icon: "🚀", color: "pink", title: t.projects, count: (s.projects || []).length },
    { id: "certifications", icon: "🏆", color: "gold", title: t.certifications, count: (s.certifications || []).length },
    { id: "languages", icon: "🌐", color: "teal", title: t.languages, count: (s.languages || []).length },
  ];

  const sidebarHtml = `<div class="cve-sidebar">
    ${sections.map(sec => `
      <div class="cve-nav-item" onclick="cveScrollTo('${sec.id}')" data-nav="${sec.id}">
        <span class="cve-nav-icon">${sec.icon}</span>
        <span>${escapeHtml(sec.title)}</span>
        ${sec.count !== null ? `<span class="cve-nav-count">${sec.count}</span>` : ""}
      </div>`).join("")}
  </div>`;

  function sectionHead(sec) {
    return `<div class="cve-section-head">
      <h3><span class="cve-icon-wrap">${sec.icon}</span> ${escapeHtml(sec.title)}</h3>
    </div>`;
  }

  document.getElementById("cve-content").innerHTML = `
    <div class="cve-layout">
      ${sidebarHtml}
      <div class="cve-main">
        <!-- Header -->
        <div class="cve-section" data-color="blue" id="cve-sec-header">
          ${sectionHead(sections[0])}
          <div class="cve-section-body">
            <div class="cve-field-row">
              <div class="cve-field"><label>${t.name}</label><input value="${escapeAttr(s.header.name || '')}" oninput="cveUpdateHeader('name', this.value)" /></div>
              <div class="cve-field"><label>${t.title}</label><input value="${escapeAttr(s.header.title || '')}" oninput="cveUpdateHeader('title', this.value)" /></div>
            </div>
            <div class="cve-field-row-3">
              <div class="cve-field"><label>${t.email}</label><input value="${escapeAttr(s.header.email || '')}" oninput="cveUpdateHeader('email', this.value)" /></div>
              <div class="cve-field"><label>${t.phone}</label><input value="${escapeAttr(s.header.phone || '')}" oninput="cveUpdateHeader('phone', this.value)" /></div>
              <div class="cve-field"><label>${t.location}</label><input value="${escapeAttr(s.header.location || '')}" oninput="cveUpdateHeader('location', this.value)" /></div>
            </div>
            <div class="cve-field-row-3">
              <div class="cve-field"><label>LinkedIn</label><input value="${escapeAttr(s.header.linkedin || '')}" oninput="cveUpdateHeader('linkedin', this.value)" /></div>
              <div class="cve-field"><label>GitHub</label><input value="${escapeAttr(s.header.github || '')}" oninput="cveUpdateHeader('github', this.value)" /></div>
              <div class="cve-field"><label>Website</label><input value="${escapeAttr(s.header.website || '')}" oninput="cveUpdateHeader('website', this.value)" /></div>
            </div>
          </div>
        </div>

        <!-- Summary -->
        <div class="cve-section" data-color="cyan" id="cve-sec-summary">
          ${sectionHead(sections[1])}
          <div class="cve-section-body">
            <textarea oninput="cveUpdate('summary', this.value)" rows="4" style="width:100%;background:var(--bg);color:var(--fg);border:1px solid var(--border);border-radius:8px;padding:12px 14px;font-family:inherit;font-size:13px;line-height:1.6">${escapeHtml(s.summary || '')}</textarea>
          </div>
        </div>

        <!-- Experience -->
        <div class="cve-section" data-color="green" id="cve-sec-experience">
          ${sectionHead(sections[2])}
          <div class="cve-section-body">
            ${(s.experience || []).map((e, i) => renderExperience(e, i, t)).join("")}
            <button class="cve-add-btn" onclick="cveAddExperience()">+ ${t.add} ${t.company}</button>
          </div>
        </div>

        <!-- Education -->
        <div class="cve-section" data-color="purple" id="cve-sec-education">
          ${sectionHead(sections[3])}
          <div class="cve-section-body">
            ${(s.education || []).map((e, i) => renderEducation(e, i, t)).join("")}
            <button class="cve-add-btn" onclick="cveAddEducation()">+ ${t.add} ${t.institution}</button>
          </div>
        </div>

        <!-- Skills -->
        <div class="cve-section" data-color="orange" id="cve-sec-skills">
          ${sectionHead(sections[4])}
          <div class="cve-section-body">
            ${(s.skills || []).map((c, i) => renderSkillCat(c, i, t)).join("")}
            <button class="cve-add-btn" onclick="cveAddSkillCat()">+ ${t.add} ${t.category}</button>
          </div>
        </div>

        <!-- Projects -->
        <div class="cve-section" data-color="pink" id="cve-sec-projects">
          ${sectionHead(sections[5])}
          <div class="cve-section-body">
            ${(s.projects || []).map((p, i) => renderProject(p, i, t)).join("")}
            <button class="cve-add-btn" onclick="cveAddProject()">+ ${t.add} ${t.project}</button>
          </div>
        </div>

        <!-- Certifications -->
        <div class="cve-section" data-color="gold" id="cve-sec-certifications">
          ${sectionHead(sections[6])}
          <div class="cve-section-body">
            ${(s.certifications || []).map((c, i) => renderCertification(c, i, t)).join("")}
            <button class="cve-add-btn" onclick="cveAddCert()">+ ${t.add} ${t.cert}</button>
          </div>
        </div>

        <!-- Languages -->
        <div class="cve-section" data-color="teal" id="cve-sec-languages">
          ${sectionHead(sections[7])}
          <div class="cve-section-body">
            ${(s.languages || []).map((l, i) => `
              <div class="cve-field-row" style="margin-bottom:8px">
                <div class="cve-field"><input value="${escapeAttr(l.name || '')}" oninput="cveUpdateNested('languages',${i},'name',this.value)" placeholder="${t.language}" /></div>
                <div class="cve-field" style="display:flex;align-items:center;gap:6px"><input value="${escapeAttr(l.level || '')}" oninput="cveUpdateNested('languages',${i},'level',this.value)" placeholder="${t.level}" style="flex:1" /><button onclick="cveRemoveItem('languages',${i})" style="background:transparent;border:none;color:var(--f);cursor:pointer;font-size:16px;padding:6px">✕</button></div>
              </div>`).join("")}
            <button class="cve-add-btn" onclick="cveAddLanguage()">+ ${t.add} ${t.language}</button>
          </div>
        </div>
      </div>
    </div>`;

  // Set first nav item active
  setTimeout(() => {
    const first = document.querySelector(".cve-nav-item");
    if (first) first.classList.add("active");
  }, 0);
}

window.cveScrollTo = (sectionId) => {
  const target = document.getElementById("cve-sec-" + sectionId);
  if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
  document.querySelectorAll(".cve-nav-item").forEach(n => n.classList.remove("active"));
  const navItem = document.querySelector(`.cve-nav-item[data-nav="${sectionId}"]`);
  if (navItem) navItem.classList.add("active");
};

function renderExperience(e, i, t) {
  const dateRange = (e.start_date || e.end_date)
    ? `${e.start_date || "?"} – ${e.end_date || "?"}`
    : "";
  return `
    <div class="cve-experience-item">
      <div class="cve-item-actions"><button onclick="cveRemoveItem('experience',${i})" title="מחק">✕ מחק</button></div>
      <div class="cve-item-title">${escapeHtml(e.title || "(תפקיד חדש)")}</div>
      <div class="cve-item-subtitle">${escapeHtml(e.company || "(חברה)")}${e.location ? ` · ${escapeHtml(e.location)}` : ""}</div>
      ${dateRange ? `<div class="cve-item-dates">📅 ${escapeHtml(dateRange)}</div>` : ""}
      <div class="cve-item-divider"></div>
      <div class="cve-field-row">
        <div class="cve-field"><label>${t.title}</label><input value="${escapeAttr(e.title || '')}" oninput="cveUpdateLive('experience',${i},'title',this.value,'cve-item-title')" /></div>
        <div class="cve-field"><label>${t.company}</label><input value="${escapeAttr(e.company || '')}" oninput="cveUpdateNested('experience',${i},'company',this.value)" /></div>
      </div>
      <div class="cve-field-row-3">
        <div class="cve-field"><label>${t.location}</label><input value="${escapeAttr(e.location || '')}" oninput="cveUpdateNested('experience',${i},'location',this.value)" /></div>
        <div class="cve-field"><label>${t.start}</label><input value="${escapeAttr(e.start_date || '')}" oninput="cveUpdateNested('experience',${i},'start_date',this.value)" /></div>
        <div class="cve-field"><label>${t.end}</label><input value="${escapeAttr(e.end_date || '')}" oninput="cveUpdateNested('experience',${i},'end_date',this.value)" /></div>
      </div>
      <div class="cve-field"><label>${t.description}</label><textarea oninput="cveUpdateNested('experience',${i},'description',this.value)" rows="2">${escapeHtml(e.description || '')}</textarea></div>
      <div class="cve-field">
        <label>${t.achievements}</label>
        <div class="cve-bullet-list">
          ${(e.achievements || []).map((a, j) => `
            <div class="cve-bullet-row">
              <input value="${escapeAttr(a)}" oninput="cveUpdateBullet('experience',${i},'achievements',${j},this.value)" />
              <button onclick="cveRemoveBullet('experience',${i},'achievements',${j})">✕</button>
            </div>`).join("")}
          <button class="cve-add-btn" style="font-size:12px;padding:8px" onclick="cveAddBullet('experience',${i},'achievements')">+ ${t.add}</button>
        </div>
      </div>
      <div class="cve-field"><label>${t.technologies}</label><input value="${escapeAttr((e.technologies || []).join(', '))}" oninput="cveUpdateCsv('experience',${i},'technologies',this.value)" placeholder="React, Node.js, AWS" /></div>
    </div>`;
}

function renderEducation(e, i, t) {
  const dateRange = (e.start_date || e.end_date) ? `${e.start_date || "?"} – ${e.end_date || "?"}` : "";
  const fullDegree = [e.degree, e.field].filter(Boolean).join(" · ");
  return `
    <div class="cve-edu-item">
      <div class="cve-item-actions"><button onclick="cveRemoveItem('education',${i})">✕ מחק</button></div>
      <div class="cve-item-title">${escapeHtml(fullDegree || "(תואר)")}</div>
      <div class="cve-item-subtitle">${escapeHtml(e.institution || "(מוסד)")}${e.location ? ` · ${escapeHtml(e.location)}` : ""}</div>
      ${dateRange ? `<div class="cve-item-dates">🎓 ${escapeHtml(dateRange)}</div>` : ""}
      <div class="cve-item-divider"></div>
      <div class="cve-field-row">
        <div class="cve-field"><label>${t.institution}</label><input value="${escapeAttr(e.institution || '')}" oninput="cveUpdateNested('education',${i},'institution',this.value)" /></div>
        <div class="cve-field"><label>${t.degree}</label><input value="${escapeAttr(e.degree || '')}" oninput="cveUpdateNested('education',${i},'degree',this.value)" /></div>
      </div>
      <div class="cve-field-row-3">
        <div class="cve-field"><label>${t.field}</label><input value="${escapeAttr(e.field || '')}" oninput="cveUpdateNested('education',${i},'field',this.value)" /></div>
        <div class="cve-field"><label>${t.start}</label><input value="${escapeAttr(e.start_date || '')}" oninput="cveUpdateNested('education',${i},'start_date',this.value)" /></div>
        <div class="cve-field"><label>${t.end}</label><input value="${escapeAttr(e.end_date || '')}" oninput="cveUpdateNested('education',${i},'end_date',this.value)" /></div>
      </div>
      <div class="cve-field-row">
        <div class="cve-field"><label>${t.gpa}</label><input value="${escapeAttr(e.gpa || '')}" oninput="cveUpdateNested('education',${i},'gpa',this.value)" /></div>
        <div class="cve-field"><label>${t.honors}</label><input value="${escapeAttr(e.honors || '')}" oninput="cveUpdateNested('education',${i},'honors',this.value)" /></div>
      </div>
    </div>`;
}

function renderSkillCat(c, i, t) {
  return `
    <div class="cve-skill-cat">
      <div class="cve-item-actions"><button onclick="cveRemoveItem('skills',${i})">✕</button></div>
      <input value="${escapeAttr(c.category || '')}" oninput="cveUpdateNested('skills',${i},'category',this.value)" placeholder="${t.category}" style="background:var(--bg);color:var(--fg);border:1px solid var(--border);border-radius:6px;padding:6px 10px;font-weight:600;font-size:13px;width:200px" />
      <div class="cve-skill-tags">
        ${(c.skills || []).map((s, j) => `
          <span class="cve-skill-tag">${escapeHtml(s)}<button onclick="cveRemoveBullet('skills',${i},'skills',${j})">✕</button></span>
        `).join("")}
      </div>
      <input placeholder="הוסף כישור + Enter" onkeydown="if(event.key==='Enter'){event.preventDefault();cveAddSkill(${i},this.value);this.value='';}" style="margin-top:8px;background:var(--bg);color:var(--fg);border:1px solid var(--border);border-radius:6px;padding:6px 10px;font-size:13px;width:100%" />
    </div>`;
}

function renderProject(p, i, t) {
  return `
    <div class="cve-project-item">
      <div class="cve-item-actions"><button onclick="cveRemoveItem('projects',${i})">✕ מחק</button></div>
      <div class="cve-item-title">${escapeHtml(p.name || "(פרויקט)")}</div>
      <div class="cve-item-subtitle">${escapeHtml(p.description ? p.description.slice(0, 80) + (p.description.length > 80 ? "..." : "") : "")}</div>
      ${p.date ? `<div class="cve-item-dates">🚀 ${escapeHtml(p.date)}</div>` : ""}
      <div class="cve-item-divider"></div>
      <div class="cve-field-row">
        <div class="cve-field"><label>${t.project}</label><input value="${escapeAttr(p.name || '')}" oninput="cveUpdateNested('projects',${i},'name',this.value)" /></div>
        <div class="cve-field"><label>${t.date}</label><input value="${escapeAttr(p.date || '')}" oninput="cveUpdateNested('projects',${i},'date',this.value)" /></div>
      </div>
      <div class="cve-field"><label>${t.description}</label><textarea oninput="cveUpdateNested('projects',${i},'description',this.value)" rows="2">${escapeHtml(p.description || '')}</textarea></div>
      <div class="cve-field-row">
        <div class="cve-field"><label>${t.url}</label><input value="${escapeAttr(p.url || '')}" oninput="cveUpdateNested('projects',${i},'url',this.value)" /></div>
        <div class="cve-field"><label>${t.technologies}</label><input value="${escapeAttr((p.technologies || []).join(', '))}" oninput="cveUpdateCsv('projects',${i},'technologies',this.value)" /></div>
      </div>
    </div>`;
}

function renderCertification(c, i, t) {
  return `
    <div class="cve-cert-item">
      <div class="cve-item-actions"><button onclick="cveRemoveItem('certifications',${i})">✕ מחק</button></div>
      <div class="cve-item-title">${escapeHtml(c.name || "(הסמכה)")}</div>
      <div class="cve-item-subtitle">${escapeHtml(c.issuer || "(מנפיק)")}</div>
      ${c.date ? `<div class="cve-item-dates">🏆 ${escapeHtml(c.date)}</div>` : ""}
      <div class="cve-item-divider"></div>
      <div class="cve-field-row-3">
        <div class="cve-field"><label>${t.cert}</label><input value="${escapeAttr(c.name || '')}" oninput="cveUpdateNested('certifications',${i},'name',this.value)" /></div>
        <div class="cve-field"><label>${t.issuer}</label><input value="${escapeAttr(c.issuer || '')}" oninput="cveUpdateNested('certifications',${i},'issuer',this.value)" /></div>
        <div class="cve-field"><label>${t.date}</label><input value="${escapeAttr(c.date || '')}" oninput="cveUpdateNested('certifications',${i},'date',this.value)" /></div>
      </div>
      <div class="cve-field"><label>${t.url}</label><input value="${escapeAttr(c.url || '')}" oninput="cveUpdateNested('certifications',${i},'url',this.value)" /></div>
    </div>`;
}

// ── State updaters ──
window.cveUpdateHeader = (key, value) => { CVE_STATE.structured.header[key] = value; };
window.cveUpdate = (key, value) => { CVE_STATE.structured[key] = value; };
window.cveUpdateNested = (section, idx, key, value) => {
  if (!CVE_STATE.structured[section][idx]) return;
  CVE_STATE.structured[section][idx][key] = value;
};
window.cveUpdateLive = (section, idx, key, value, liveClass) => {
  cveUpdateNested(section, idx, key, value);
  // Update the live header in the same item
  const item = document.querySelectorAll(`.cve-${section === "experience" ? "experience" : section === "education" ? "edu" : section === "projects" ? "project" : "cert"}-item`)[idx];
  if (item) {
    const liveEl = item.querySelector("." + liveClass);
    if (liveEl) liveEl.textContent = value || "(תפקיד חדש)";
  }
};
window.cveUpdateCsv = (section, idx, key, value) => {
  CVE_STATE.structured[section][idx][key] = value.split(",").map(s => s.trim()).filter(Boolean);
};
window.cveUpdateBullet = (section, idx, listKey, jdx, value) => {
  CVE_STATE.structured[section][idx][listKey][jdx] = value;
};
window.cveAddBullet = (section, idx, listKey) => {
  if (!CVE_STATE.structured[section][idx][listKey]) CVE_STATE.structured[section][idx][listKey] = [];
  CVE_STATE.structured[section][idx][listKey].push("");
  renderCVEditor();
};
window.cveRemoveBullet = (section, idx, listKey, jdx) => {
  CVE_STATE.structured[section][idx][listKey].splice(jdx, 1);
  renderCVEditor();
};
window.cveRemoveItem = (section, idx) => {
  CVE_STATE.structured[section].splice(idx, 1);
  renderCVEditor();
};
window.cveAddExperience = () => {
  if (!CVE_STATE.structured.experience) CVE_STATE.structured.experience = [];
  CVE_STATE.structured.experience.push({ company: "", title: "", start_date: "", end_date: "", achievements: [] });
  renderCVEditor();
};
window.cveAddEducation = () => {
  if (!CVE_STATE.structured.education) CVE_STATE.structured.education = [];
  CVE_STATE.structured.education.push({ institution: "", degree: "", start_date: "", end_date: "" });
  renderCVEditor();
};
window.cveAddSkillCat = () => {
  if (!CVE_STATE.structured.skills) CVE_STATE.structured.skills = [];
  CVE_STATE.structured.skills.push({ category: "", skills: [] });
  renderCVEditor();
};
window.cveAddSkill = (catIdx, value) => {
  const v = value.trim();
  if (!v) return;
  CVE_STATE.structured.skills[catIdx].skills.push(v);
  renderCVEditor();
};
window.cveAddProject = () => {
  if (!CVE_STATE.structured.projects) CVE_STATE.structured.projects = [];
  CVE_STATE.structured.projects.push({ name: "", description: "" });
  renderCVEditor();
};
window.cveAddCert = () => {
  if (!CVE_STATE.structured.certifications) CVE_STATE.structured.certifications = [];
  CVE_STATE.structured.certifications.push({ name: "", issuer: "", date: "" });
  renderCVEditor();
};
window.cveAddLanguage = () => {
  if (!CVE_STATE.structured.languages) CVE_STATE.structured.languages = [];
  CVE_STATE.structured.languages.push({ name: "", level: "" });
  renderCVEditor();
};

// ═══════════════ Mentor page ═══════════════
let MENTOR_STATE = null;

async function loadMentorPage() {
  try {
    MENTOR_STATE = await api("/api/mentor");
    renderMentorGoal();
    renderMentorChat();
    renderMentorStatus();
  } catch (e) { toast("❌ " + e.message, true); }
}

function renderMentorGoal() {
  const g = MENTOR_STATE?.goal;
  const wrap = document.getElementById("mentor-goal-display");
  if (!g) {
    wrap.innerHTML = `<div class="goal-empty">עדיין לא הוגדרה מטרה. <br><button class="btn small primary" onclick="document.getElementById('edit-goal-btn').click()" style="margin-top:8px">🎯 הגדר עכשיו</button></div>`;
    return;
  }
  wrap.innerHTML = `
    <div class="goal-card">
      <div class="goal-field"><b>תפקיד:</b> ${escapeHtml(g.target_role)}</div>
      ${g.target_salary_monthly ? `<div class="goal-field"><b>שכר:</b> ₪${fmtNumber(g.target_salary_monthly)}/חודש</div>` : ""}
      <div class="goal-field"><b>לוז:</b> ${g.target_timeline_months} חודשים</div>
      ${g.commitments_per_week ? `<div class="goal-field"><b>שבועי:</b> ${escapeHtml(g.commitments_per_week)}</div>` : ""}
      ${g.current_obstacles ? `<div class="goal-field"><b>מכשולים:</b> ${escapeHtml(g.current_obstacles)}</div>` : ""}
      ${g.why ? `<div class="goal-field" style="color:var(--c)"><b>למה:</b> ${escapeHtml(g.why)}</div>` : ""}
    </div>`;
}

function renderMentorStatus() {
  const wrap = document.getElementById("mentor-status");
  const t = TRACKED || [];
  const byStatus = {};
  for (const tr of t) byStatus[tr.status] = (byStatus[tr.status] || 0) + 1;
  const labels = { interested: "👀", applied: "📤", interview: "🎤", offer: "🎉", rejected: "❌" };
  wrap.innerHTML = Object.keys(labels).map(k =>
    `<div style="display:flex;justify-content:space-between;padding:4px 0;font-size:13px"><span>${labels[k]} ${k}</span><b>${byStatus[k] || 0}</b></div>`
  ).join("");
}

function renderMentorChat() {
  const chat = document.getElementById("mentor-chat");
  chat.innerHTML = (MENTOR_STATE?.conversations || []).map(m => `
    <div class="chat-msg ${m.role}">${m.role === "assistant" ? renderMarkdown(m.content) : escapeHtml(m.content).replace(/\n/g, "<br>")}</div>
  `).join("");
  chat.scrollTop = chat.scrollHeight;
}

window.mentorSend = async (predefinedMessage) => {
  const input = document.getElementById("mentor-input-field");
  const message = predefinedMessage || input.value.trim();
  if (!message) return;
  if (!predefinedMessage) input.value = "";

  const chat = document.getElementById("mentor-chat");
  chat.insertAdjacentHTML("beforeend", `<div class="chat-msg user">${escapeHtml(message).replace(/\n/g, "<br>")}</div>`);
  const thinking = document.createElement("div");
  thinking.className = "chat-msg thinking";
  thinking.textContent = "המנטור חושב...";
  chat.appendChild(thinking);
  chat.scrollTop = chat.scrollHeight;

  try {
    const r = await api("/api/mentor/chat", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
    });
    thinking.remove();
    chat.insertAdjacentHTML("beforeend", `<div class="chat-msg assistant">${renderMarkdown(r.reply)}</div>`);
    chat.scrollTop = chat.scrollHeight;
    // Reload state
    MENTOR_STATE = await api("/api/mentor");
  } catch (e) {
    thinking.remove();
    chat.insertAdjacentHTML("beforeend", `<div class="chat-msg assistant" style="border-color:var(--f);color:var(--f)">❌ ${escapeHtml(e.message)}</div>`);
    toast("❌ " + e.message, true);
  }
};

document.getElementById("mentor-send-btn").addEventListener("click", () => mentorSend());
document.getElementById("mentor-input-field").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); mentorSend(); }
});

document.getElementById("mentor-clear-btn").addEventListener("click", async () => {
  if (!confirm("לנקות את היסטוריית השיחה?")) return;
  await api("/api/mentor/clear", { method: "POST" });
  toast("🗑️ שיחה נוקתה");
  loadMentorPage();
});

// Goal modal
document.getElementById("edit-goal-btn").addEventListener("click", () => {
  const g = MENTOR_STATE?.goal;
  if (g) {
    document.getElementById("goal-role").value = g.target_role || "";
    document.getElementById("goal-salary").value = g.target_salary_monthly || "";
    document.getElementById("goal-timeline").value = String(g.target_timeline_months || 6);
    document.getElementById("goal-obstacles").value = g.current_obstacles || "";
    document.getElementById("goal-commitments").value = g.commitments_per_week || "";
    document.getElementById("goal-why").value = g.why || "";
  }
  document.getElementById("goal-modal-backdrop").classList.add("open");
});
document.getElementById("goal-close").addEventListener("click", () =>
  document.getElementById("goal-modal-backdrop").classList.remove("open"));
document.getElementById("goal-modal-backdrop").addEventListener("click", (e) => {
  if (e.target.id === "goal-modal-backdrop") e.target.classList.remove("open");
});
document.getElementById("goal-save").addEventListener("click", async () => {
  const goal = {
    target_role: document.getElementById("goal-role").value.trim(),
    target_salary_monthly: Number(document.getElementById("goal-salary").value) || undefined,
    target_timeline_months: Number(document.getElementById("goal-timeline").value),
    current_obstacles: document.getElementById("goal-obstacles").value.trim(),
    commitments_per_week: document.getElementById("goal-commitments").value.trim(),
    why: document.getElementById("goal-why").value.trim(),
  };
  if (!goal.target_role) { toast("חסר תפקיד יעד", true); return; }
  try {
    await api("/api/mentor/goal", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(goal),
    });
    toast("🎯 מטרה נשמרה");
    document.getElementById("goal-modal-backdrop").classList.remove("open");
    loadMentorPage();
  } catch (e) { toast("❌ " + e.message, true); }
});

// ═══════════════ Init ═══════════════
(async () => {
  await loadProfiles();
  await loadJobs();
  loadProfilePage();
})();

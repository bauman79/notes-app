import { useState, useRef, useCallback, useEffect } from "react";
impor * s XLSX from "xlsx";
import { GoogleOAuthProvider, useGoogleLogin } from "@react-oauth/google";

const GOOGLE_CLIENT_ID = "167666540402-ug48sj0qfst2g08lhcckkf69jvjhel21.apps.googleusercontent.com";
const DRIVE_FILE_NAME = "notes-app-data.json";

async function gdriveFind(token) {
  const q = encodeURIComponent("name='" + DRIVE_FILE_NAME + "' and trashed=false");
  const res = await fetch(
    "https://www.googleapis.com/drive/v3/files?q=" + q + "&spaces=drive&fields=files(id,name)",
    { headers: { Authorization: "Bearer " + token } }
  );
  const data = await res.json();
  return data.files?.[0]?.id || null;
}

async function gdriveRead(token, fileId) {
  const res = await fetch(
    "https://www.googleapis.com/drive/v3/files/" + fileId + "?alt=media",
    { headers: { Authorization: "Bearer " + token } }
  );
  if (!res.ok) return null;
  return res.json();
}

async function gdriveSave(token, data, existingFileId) {
  const metadata = { name: DRIVE_FILE_NAME, mimeType: "application/json" };
  const body = JSON.stringify(data);
  if (existingFileId) {
    await fetch(
      "https://www.googleapis.com/upload/drive/v3/files/" + existingFileId + "?uploadType=media",
      { method: "PATCH", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" }, body }
    );
  } else {
    const form = new FormData();
    form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
    form.append("file", new Blob([body], { type: "application/json" }));
    await fetch(
      "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart",
      { method: "POST", headers: { Authorization: "Bearer " + token }, body: form }
    );
  }
}

const T = { HEADER: "header", TODO: "todo", TEXT: "text" };
const NOTICE_ID = "__notice__";
const CALENDAR_ID = "__calendar__";
const TRASH_ID = "__trash__";
const WORKLOG_ID = "__worklog__";
const TRASH_DAYS = 30;

function makeDragState() {
  return { active: -1, insert: -1, startY: 0, ghostEl: null, ghostTop0: 0, containerEl: null, itemsSnapshot: [] };
}

function useSortable(containerRef, items, setItems) {
  const D = useRef(makeDragState());
  const itemsRef = useRef(items);
  useEffect(() => { itemsRef.current = items; });

  const beginDrag = useCallback((e, index) => {
    e.preventDefault();
    e.stopPropagation();
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    const container = containerRef.current;
    if (!container) return;
    const rows = Array.from(container.querySelectorAll("[data-sortidx]"));
    if (!rows[index]) return;
    const rect = rows[index].getBoundingClientRect();
    const ghost = rows[index].cloneNode(true);
    ghost.style.cssText = "position:fixed;pointer-events:none;z-index:9999;opacity:0.82;box-shadow:0 6px 24px rgba(15,32,68,.2);border-radius:10px;transform:scale(1.02);transition:none;left:" + rect.left + "px;top:" + rect.top + "px;width:" + rect.width + "px";
    document.body.appendChild(ghost);
    D.current.active = index;
    D.current.insert = index;
    D.current.startY = clientY;
    D.current.ghostEl = ghost;
    D.current.ghostTop0 = rect.top;
    D.current.containerEl = container;
    rows[index].style.opacity = "0.25";
    let line = document.getElementById("__sortline__");
    if (!line) {
      line = document.createElement("div");
      line.id = "__sortline__";
      line.style.cssText = "position:fixed;left:0;right:0;height:2px;background:#2563eb;z-index:9998;pointer-events:none;border-radius:2px;display:none;box-shadow:0 0 6px rgba(37,99,235,.5)";
      document.body.appendChild(line);
    }
    const onMove = (ev) => {
      const cy = ev.touches ? ev.touches[0].clientY : ev.clientY;
      const dy = cy - D.current.startY;
      if (D.current.ghostEl) D.current.ghostEl.style.top = (D.current.ghostTop0 + dy) + "px";
      const rs = Array.from(D.current.containerEl.querySelectorAll("[data-sortidx]"));
      let insertAt = rs.length;
      for (let i = 0; i < rs.length; i++) {
        const r = rs[i].getBoundingClientRect();
        if (cy < r.top + r.heigh * .5) { insertAt = i; break; }
      }
      D.current.insert = insertAt;
      const lineRef = document.getElementById("__sortline__");
      if (lineRef) {
        const target = rs[insertAt] || rs[rs.length - 1];
        if (target) {
          const tr = target.getBoundingClientRect();
          const lineY = insertAt < rs.length ? tr.top - 1 : tr.bottom + 1;
          lineRef.style.top = lineY + "px";
          lineRef.style.left = (tr.left + 4) + "px";
          lineRef.style.width = (tr.width - 8) + "px";
          lineRef.style.display = "block";
        }
      }
    };
    const onUp = () => {
      if (D.current.ghostEl) { try { document.body.removeChild(D.current.ghostEl); } catch(e) {} D.current.ghostEl = null; }
      const lineRef = document.getElementById("__sortline__");
      if (lineRef) lineRef.style.display = "none";
      const rs = Array.from(D.current.containerEl?.querySelectorAll("[data-sortidx]") || []);
      if (rs[D.current.active]) rs[D.current.active].style.opacity = "";
      const from = D.current.active;
      let to = D.current.insert;
      if (to > from) to = to - 1;
      if (from !== to && to >= 0) {
        const arr = [...itemsRef.current];
        const [moved] = arr.splice(from, 1);
        arr.splice(to, 0, moved);
        setItems(arr);
      }
      D.current = makeDragState();
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.removeEventListener("touchmove", onMove);
      document.removeEventListener("touchend", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    document.addEventListener("touchmove", onMove, { passive: false });
    document.addEventListener("touchend", onUp);
  }, [setItems, containerRef]);
  return { beginDrag };
}

const mkDate = () => {
  const d = new Date();
  return d.getFullYear() + "." + String(d.getMonth() + 1).padStart(2, "0") + "." + String(d.getDate()).padStart(2, "0");
};
const mkTs = () => Date.now();
const daysAgo = (ts) => Math.floor((Date.now() - ts) / 86400000);

let nextId = 400;

const initSidebar = [
  { id: "f1", type: "folder", name: "PROJECT" },
  { id: "f2", type: "folder", name: "AREA" },
  { id: "div1", type: "divider" },
  { id: "f3", type: "folder", name: "RESOURCE" },
  { id: "f4", type: "folder", name: "ARCHIVE" },
];

const initItems = [
  { id: "i1", type: T.HEADER, title: "Q2 Product Launch", folder: "f1", starred: false, createdAt: "2026.03.19" },
  { id: "i2", type: T.TODO, title: "Landing page copy finalized", folder: "f1", done: false, starred: false, createdAt: "2026.03.19" },
  { id: "i3", type: T.TODO, title: "Stakeholder deck reviewed", folder: "f1", done: true, starred: true, createdAt: "2026.03.18" },
  { id: "i4", type: T.TEXT, title: "Launch strategy overview", folder: "f1", starred: true, createdAt: "2026.03.17", body: "Core objective: drive 20% adoption in the first 60 days.", hiddenSections: [{ id: "h1", label: "Risk factors", content: "Delayed QA sign-off may push launch by one week.", open: false }], links: [] },
  { id: "i5", type: T.TEXT, title: "Competitor pricing notes", folder: "f1", starred: false, createdAt: "2026.03.19", body: "Three main competitors revised pricing in Q1.", hiddenSections: [], links: [] },
  { id: "i6", type: T.HEADER, title: "Team Operations", folder: "f2", starred: false, createdAt: "2026.03.15" },
  { id: "i7", type: T.TODO, title: "Weekly sync agenda prepared", folder: "f2", done: false, starred: true, createdAt: "2026.03.16" },
  { id: "i8", type: T.TEXT, title: "Onboarding checklist", folder: "f2", starred: false, createdAt: "2026.03.14", body: "New member onboarding: tool access, intro meetings.", hiddenSections: [], links: [] },
  { id: "i9", type: T.HEADER, title: "Learning & Development", folder: "f3", starred: false, createdAt: "2026.03.10" },
  { id: "i10", type: T.TODO, title: "Book summary: Thinking Fast and Slow", folder: "f3", done: false, starred: false, createdAt: "2026.03.12" },
  { id: "i11", type: T.TEXT, title: "Useful frameworks", folder: "f3", starred: true, createdAt: "2026.03.08", body: "MECE, First Principles, JTBD, Eisenhower Matrix.", hiddenSections: [], links: [] },
  { id: "i12", type: T.TODO, title: "Archive 2025 project files", folder: "f4", done: false, starred: false, createdAt: "2026.03.01" },
];

const initWorklogs = [
  { id: "wl1", date: "2026.03.19", project: "Q2 Product Launch", keyPoint: "Landing page review", details: "Reviewed three copy variants.", notes: "Final decision by Friday", createdAt: mkTs() },
  { id: "wl2", date: "2026.03.19", project: "Team Operations", keyPoint: "Weekly sync", details: "Discussed sprint velocity drop.", notes: "", createdAt: mkTs() },
  { id: "wl3", date: "2026.03.18", project: "Q2 Product Launch", keyPoint: "Competitor analysis", details: "Mapped pricing tiers.", notes: "Share with leadership", createdAt: mkTs() },
  { id: "wl4", date: "2026.02.25", project: "Learning & Development", keyPoint: "Framework study", details: "MECE and First Principles.", notes: "", createdAt: mkTs() },
];

function useIsMobile() {
  const [v, setV] = useState(() => window.innerWidth < 768);
  useEffect(() => {
    const h = () => setV(window.innerWidth < 768);
    window.addEventListener("resize", h);
    return () => window.removeEventListener("resize", h);
  }, []);
  return v;
}

function RichText({ html, onChange, placeholder, style }) {
  const ref = useRef(null);
  const containerRef = useRef(null);
  const { tb, checkSel, exec: execBase, tbRef, hide } = useFloatingToolbar(containerRef);
  useEffect(() => {
    if (ref.current && ref.current.innerHTML !== (html || "")) ref.current.innerHTML = html || "";
  }, []);
  const exec = (cmd, val) => { execBase(cmd, val); onChange?.(ref.current?.innerHTML || ""); };
  return (
    <div ref={containerRef} style={{ position: "relative" }} data-rc="1">
      <FloatingToolbar tb={tb} exec={exec} tbRef={tbRef} />
      <div ref={ref} contentEditable suppressContentEditableWarning
        onInput={() => onChange?.(ref.current.innerHTML)}
        onMouseUp={checkSel} onKeyUp={checkSel} onBlur={hide}
        data-placeholder={placeholder}
        style={{ outline: "none", minHeight: 36, lineHeight: 1.75, wordBreak: "break-word", color: "#1e3a6e", ...style }} />
      <style>{`[data-rc] [contenteditable]:empty:before { content: attr(data-placeholder); color:#b0c8e0; pointer-events:none; }`}</style>
    </div>
  );
}

const rtBtn = { background: "none", border: "none", color: "#e2eaf8", fontSize: 13, fontWeight: 700, cursor: "pointer", padding: "3px 5px", borderRadius: 5, fontFamily: "inherit", minWidth: 22 };
const rtDiv = { width: 1, height: 16, background: "rgba(255,255,255,.15)", margin: "0 3px", flexShrink: 0 };

function useFloatingToolbar(containerRef) {
  const [tb, setTb] = useState(null);
  const tbRef = useRef(null);
  const checkSel = useCallback(() => {
    setTimeout(() => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.toString().trim()) { setTb(null); return; }
      const container = containerRef?.current;
      if (container && !container.contains(sel.anchorNode)) { setTb(null); return; }
      const r = sel.getRangeAt(0).getBoundingClientRect();
      const cr = (container || sel.anchorNode?.parentElement)?.closest("[data-rc]")?.getBoundingClientRect() || r;
      setTb({ x: r.left - cr.left + r.width / 2, y: r.top - cr.top - 8 });
    }, 10);
  }, [containerRef]);
  const exec = useCallback((cmd, val) => { document.execCommand(cmd, false, val || null); setTb(null); }, []);
  const hide = useCallback(() => { setTimeout(() => { if (!tbRef.current?.contains(document.activeElement)) setTb(null); }, 150); }, []);
  return { tb, checkSel, exec, tbRef, hide };
}

function FloatingToolbar({ tb, exec, tbRef }) {
  if (!tb) return null;
  return (
    <div ref={tbRef} style={{ position: "absolute", left: tb.x, top: tb.y, transform: "translate(-50%,-100%)", zIndex: 500, filter: "drop-shadow(0 4px 16px rgba(15,32,68,.25))" }} onMouseDown={(e) => e.preventDefault()}>
      <div style={{ display: "flex", alignItems: "center", gap: 2, background: "#1a2d54", borderRadius: 10, padding: "6px 8px" }}>
        <button onMouseDown={(e) => { e.preventDefault(); exec("bold"); }} style={rtBtn}><b>B</b></button>
        <button onMouseDown={(e) => { e.preventDefault(); exec("italic"); }} style={rtBtn}><i>I</i></button>
        <button onMouseDown={(e) => { e.preventDefault(); exec("underline"); }} style={rtBtn}><u>U</u></button>
        <button onMouseDown={(e) => { e.preventDefault(); exec("strikeThrough"); }} style={rtBtn}><s>S</s></button>
        <div style={rtDiv} />
        {["#1e3a6e", "#e53e3e", "#2563eb", "#059669", "#d97706"].map((c) => (
          <div key={c} style={{ width: 13, height: 13, borderRadius: "50%", background: c, cursor: "pointer" }} onMouseDown={(e) => { e.preventDefault(); exec("foreColor", c); }} />
        ))}
        <div style={rtDiv} />
        {[["#fef08a", "노랑"], ["#bbf7d0", "초록"], ["#bfdbfe", "파랑"], ["transparent", "제거"]].map(([c, t]) => (
          <div key={c} title={t} style={{ width: 13, height: 13, borderRadius: 3, background: c === "transparent" ? "#fff" : c, border: c === "transparent" ? "2px dashed #94a3b8" : "2px solid rgba(0,0,0,.07)", cursor: "pointer" }} onMouseDown={(e) => { e.preventDefault(); exec("hiliteColor", c); }} />
        ))}
        <div style={rtDiv} />
        <button onMouseDown={(e) => { e.preventDefault(); exec("removeFormat"); }} style={{ ...rtBtn, color: "#fca5a5", fontSize: 11 }}>✕</button>
      </div>
      <div style={{ width: 0, height: 0, borderLeft: "6px solid transparent", borderRight: "6px solid transparent", borderTop: "7px solid #1a2d54", margin: "0 auto" }} />
    </div>
  );
}

function DatePicker({ value, onChange, onClose }) {
  const parse = (d) => d ? { y: parseInt(d.split(".")[0]), m: parseInt(d.split(".")[1]) - 1 } : { y: new Date().getFullYear(), m: new Date().getMonth() };
  const [cur, setCur] = useState(() => parse(value));
  const dim = (y, m) => new Date(y, m + 1, 0).getDate();
  const fd = (y, m) => new Date(y, m, 1).getDay();
  const pad = (n) => String(n).padStart(2, "0");
  const cells = [...Array(fd(cur.y, cur.m)).fill(null), ...Array(dim(cur.y, cur.m)).fill(0).map((_, i) => i + 1)];
  const isSel = (d) => value === cur.y + "." + pad(cur.m + 1) + "." + pad(d);
  const PB = { background: "none", border: "none", fontSize: 18, cursor: "pointer", color: "#6b8bb5", padding: "2px 8px", borderRadius: 6, fontFamily: "inherit" };
  return (
    <div style={{ position: "absolute", zIndex: 600, background: "#fff", borderRadius: 14, boxShadow: "0 8px 32px rgba(15,32,68,.18)", padding: 16, width: 240, top: "100%", left: 0, marginTop: 4, border: "1px solid #e0eaf8" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
        <button onClick={() => setCur((p) => p.m === 0 ? { y: p.y - 1, m: 11 } : { ...p, m: p.m - 1 })} style={PB}>‹</button>
        <span style={{ fontSize: 13.5, fontWeight: 700, color: "#1e3a6e" }}>{cur.y}년 {cur.m + 1}월</span>
        <button onClick={() => setCur((p) => p.m === 11 ? { y: p.y + 1, m: 0 } : { ...p, m: p.m + 1 })} style={PB}>›</button>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7,1fr)", gap: 2 }}>
        {["일", "월", "화", "수", "목", "금", "토"].map((d) => (
          <div key={d} style={{ textAlign: "center", fontSize: 10, color: "#94a3b8", fontWeight: 600, padding: "2px 0" }}>{d}</div>
        ))}
        {cells.map((d, i) => (
          <div key={i} onClick={() => { if (d) { onChange(cur.y + "." + pad(cur.m + 1) + "." + pad(d)); onClose(); } }}
            style={{ textAlign: "center", fontSize: 12, padding: "5px 0", borderRadius: 6, cursor: d ? "pointer" : "default",
              background: isSel(d) ? "#2563eb" : "transparent", color: isSel(d) ? "#fff" : d ? "#1e3a6e" : "transparent", fontWeight: isSel(d) ? 700 : 400 }}>
            {d || ""}
          </div>
        ))}
      </div>
    </div>
  );
}

function MonthPicker({ value, onChange, onClose, label }) {
  const initY = value ? parseInt(value.split(".")[0]) : new Date().getFullYear();
  const [y, setY] = useState(initY);
  const MN = ["1월", "2월", "3월", "4월", "5월", "6월", "7월", "8월", "9월", "10월", "11월", "12월"];
  const PB = { background: "none", border: "none", fontSize: 18, cursor: "pointer", color: "#6b8bb5", padding: "2px 8px", borderRadius: 6, fontFamily: "inherit" };
  return (
    <div style={{ position: "absolute", zIndex: 700, background: "#fff", borderRadius: 14, boxShadow: "0 8px 32px rgba(15,32,68,.2)", padding: 16, width: 210, top: "100%", right: 0, marginTop: 4, border: "1px solid #e0eaf8" }}>
      {label && <div style={{ fontSize: 11, fontWeight: 700, color: "#2563eb", letterSpacing: "1px", marginBottom: 10 }}>{label}</div>}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
        <button onClick={() => setY(y - 1)} style={PB}>‹</button>
        <span style={{ fontSize: 13.5, fontWeight: 700, color: "#1e3a6e" }}>{y}년</span>
        <button onClick={() => setY(y + 1)} style={PB}>›</button>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 4 }}>
        {MN.map((m, i) => {
          const key = y + "." + String(i + 1).padStart(2, "0");
          const sel = value === key;
          return (
            <div key={i} onClick={() => { onChange(key); onClose(); }}
              style={{ textAlign: "center", padding: "7px 2px", borderRadius: 7, cursor: "pointer", fontSize: 12,
                fontWeight: sel ? 700 : 400, background: sel ? "#2563eb" : "#f5f8ff", color: sel ? "#fff" : "#1e3a6e" }}>
              {m}
            </div>
          );
        })}
      </div>
    </div>
  );
}

const wBtn = { background: "#fff", border: "1px solid #e0eaf8", borderRadius: 9, padding: "7px 11px", fontSize: 12.5, cursor: "pointer", fontFamily: "inherit", fontWeight: 600, color: "#4b6fa8", display: "flex", alignItems: "center", gap: 4, whiteSpace: "nowrap" };
const wCB = { width: 16, height: 16, borderRadius: 4, border: "1.5px solid #c2d0e8", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, color: "#fff", fontWeight: 700, cursor: "pointer", flexShrink: 0 };
const wCBOn = { background: "#2563eb", borderColor: "#2563eb" };
const wDatePill = { fontSize: 12, color: "#2563eb", background: "#eff6ff", borderRadius: 7, padding: "5px 8px", cursor: "pointer", fontWeight: 600, border: "1px solid #bfdbfe", whiteSpace: "nowrap", userSelect: "none" };
const wCell = { border: "none", borderBottom: "1px solid transparent", background: "transparent", outline: "none", fontFamily: "inherit", fontSize: 13, color: "#1e3a6e", lineHeight: 1.4, padding: "3px 4px", width: "100%" };
const wRowBtn = { background: "none", border: "1px solid #e8eef8", borderRadius: 5, width: 20, height: 20, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", color: "#6b8bb5", fontSize: 12, fontWeight: 700, padding: 0, fontFamily: "inherit" };

function WorklogView({ worklogs, setWorklogs, folders, isMobile }) {
  const now = new Date();
  const todayYM = now.getFullYear() + "." + String(now.getMonth() + 1).padStart(2, "0");
  const [search, setSearch] = useState("");
  const [navYM, setNavYM] = useState(null);
  const [showNav, setShowNav] = useState(false);
  const [showDl, setShowDl] = useState(false);
  const [selected, setSelected] = useState(new Set());
  const [filterFolders, setFilterFolders] = useState(new Set());
  const [showFilter, setShowFilter] = useState(false);
  const listRef = useRef(null);
  const folderNames = folders.map((f) => f.name);
  const allSelected = filterFolders.size === 0;
  const toggleFilterFolder = (name) => {
    setFilterFolders((prev) => { const n = new Set(prev); n.has(name) ? n.delete(name) : n.add(name); return n; });
  };
  const filterLabel = allSelected ? "전체" : filterFolders.size === 1 ? [...filterFolders][0] : filterFolders.size + "개 선택";
  const q = search.trim().toLowerCase();
  const filtered = worklogs.filter((w) => {
    const matchSearch = !q || [w.date, w.project, w.keyPoint, w.details, w.notes].join(" ").toLowerCase().includes(q);
    const matchFolder = allSelected || filterFolders.has(w.project);
    return matchSearch && matchFolder;
  });
  const grouped = {};
  filtered.forEach((w) => { const ym = w.date?.slice(0, 7) || "?"; if (!grouped[ym]) grouped[ym] = []; grouped[ym].push(w); });
  const sortedYMs = Object.keys(grouped).sort((a, b) => b.localeCompare(a));
  const addEntry = (date) => {
    const id = "wl" + nextId++;
    const defaultProject = filterFolders.size === 1 ? [...filterFolders][0] : "";
    setWorklogs((prev) => [{ id, date: date || mkDate(), project: defaultProject, keyPoint: "", details: "", notes: "", createdAt: mkTs() }, ...prev]);
  };
  const updEntry = (id, patch) => setWorklogs((prev) => prev.map((w) => w.id === id ? { ...w, ...patch } : w));
  const delEntry = (id) => setWorklogs((prev) => prev.filter((w) => w.id !== id));
  const delSel = () => { setWorklogs((prev) => prev.filter((w) => !selected.has(w.id))); setSelected(new Set()); };
  const toggleSel = (id) => setSelected((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const navigateTo = (ym) => {
    setNavYM(ym); setShowNav(false);
    setTimeout(() => { listRef.current?.querySelector('[data-ym="' + ym + '"]')?.scrollIntoView({ behavior: "smooth", block: "start" }); }, 100);
  };
  const colGrid = isMobile ? "20px 80px 1fr 100px 28px" : "20px 90px 1fr 120px 1fr 80px 28px";

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }} onClick={() => setShowFilter(false)}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", paddingBottom: 10, borderBottom: "1px solid #eef3ff", marginBottom: 8 }}>
        <div style={{ flex: 1, minWidth: 120, position: "relative" }}>
          <span style={{ position: "absolute", left: 9, top: "50%", transform: "translateY(-50%)", color: "#a0b4cc", fontSize: 13 }}>🔍</span>
          <input style={{ width: "100%", padding: "7px 10px 7px 28px", borderRadius: 9, border: "1.5px solid #e0eaf8", fontSize: 12.5, color: "#1e3a6e", outline: "none", fontFamily: "inherit", background: "#fff", boxSizing: "border-box" }}
            placeholder="검색..." value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <div style={{ position: "relative" }} onClick={(e) => e.stopPropagation()}>
          <button style={{ ...wBtn, ...(allSelected ? {} : { background: "#eef3ff", color: "#2563eb", borderColor: "#bfdbfe" }) }}
            onClick={() => setShowFilter((v) => !v)}>⊞ {filterLabel}</button>
          {showFilter && (
            <div style={{ position: "absolute", top: "100%", left: 0, marginTop: 4, background: "#fff", borderRadius: 12, boxShadow: "0 6px 24px rgba(15,32,68,.16)", border: "1px solid #e0eaf8", zIndex: 400, minWidth: 170, overflow: "hidden" }}>
              <div style={{ padding: "6px 12px 4px", fontSize: 10, fontWeight: 700, color: "#94a3b8", letterSpacing: "1px", textTransform: "uppercase" }}>폴더 필터</div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 14px", cursor: "pointer", borderBottom: "1px solid #f0f4fa", background: allSelected ? "#eff6ff" : "transparent" }}
                onClick={() => setFilterFolders(new Set())}>
                <div style={{ width: 15, height: 15, borderRadius: 4, border: "1.5px solid", borderColor: allSelected ? "#2563eb" : "#c2d0e8", background: allSelected ? "#2563eb" : "transparent", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                  {allSelected && <span style={{ color: "#fff", fontSize: 10, fontWeight: 700 }}>✓</span>}
                </div>
                <span style={{ fontSize: 13, fontWeight: 600, color: allSelected ? "#2563eb" : "#1e3a6e" }}>전체</span>
              </div>
              {folderNames.map((name) => {
                const on = filterFolders.has(name);
                return (
                  <div key={name} style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 14px", cursor: "pointer", background: on ? "#eff6ff" : "transparent" }}
                    onClick={() => toggleFilterFolder(name)}>
                    <div style={{ width: 15, height: 15, borderRadius: 4, border: "1.5px solid", borderColor: on ? "#2563eb" : "#c2d0e8", background: on ? "#2563eb" : "transparent", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                      {on && <span style={{ color: "#fff", fontSize: 10, fontWeight: 700 }}>✓</span>}
                    </div>
                    <span style={{ fontSize: 13, fontWeight: 500, color: on ? "#2563eb" : "#1e3a6e" }}>{name}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
        <div style={{ position: "relative" }}>
          <button style={wBtn} onClick={() => setShowNav((v) => !v)}>📅 {navYM || todayYM}</button>
          {showNav && <MonthPicker value={navYM || todayYM} onChange={navigateTo} onClose={() => setShowNav(false)} label="년월로 이동" />}
        </div>
        <button style={{ ...wBtn, background: "#2563eb", color: "#fff", border: "none", boxShadow: "0 2px 8px rgba(37,99,235,.3)" }} onClick={() => setShowDl(true)}>↓ 엑셀</button>
        {selected.size > 0 && <button style={{ ...wBtn, color: "#e53e3e", borderColor: "#fecaca" }} onClick={delSel}>삭제({selected.size})</button>}
        <button style={{ ...wBtn, color: "#2563eb", borderColor: "#bfdbfe", fontWeight: 700 }} onClick={() => addEntry(mkDate())}>＋ 추가</button>
      </div>
      <div ref={listRef} style={{ flex: 1, overflowY: "auto", paddingBottom: 40 }}>
        {sortedYMs.length === 0 && (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "60px 0", color: "#b0c4de" }}>
            <div style={{ fontSize: 32, marginBottom: 10 }}>📋</div>
            <div style={{ fontSize: 13 }}>{search || !allSelected ? "결과 없음" : "업무일지를 작성해보세요."}</div>
          </div>
        )}
        {sortedYMs.map((ym) => {
          const [yy, mm] = ym.split(".");
          const dayG = {};
          grouped[ym].forEach((w) => { dayG[w.date] = (dayG[w.date] || []).concat(w); });
          const sortedDays = Object.keys(dayG).sort((a, b) => b.localeCompare(a));
          return (
            <div key={ym} data-ym={ym} style={{ marginBottom: 28 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8, marginTop: 4 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: "#1e3a6e", background: "#eef3ff", borderRadius: 20, padding: "4px 14px", flexShrink: 0 }}>{yy}년 {parseInt(mm)}월</div>
                <div style={{ flex: 1, height: 1, background: "rgba(37,99,235,.1)" }} />
                <span style={{ fontSize: 11, color: "#94a3b8", flexShrink: 0 }}>{grouped[ym].length}건</span>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: colGrid, gap: 4, padding: "2px 8px", fontSize: 10, fontWeight: 700, color: "#94a3b8", textTransform: "uppercase", marginBottom: 2 }}>
                <div /><div>날짜</div><div>핵심사항</div><div>폴더</div>
                {!isMobile && <><div>세부내용</div><div>비고</div></>}
                <div />
              </div>
              {sortedDays.map((date) => (
                <div key={date}>
                  {dayG[date].map((w, wi) => (
                    <WRow key={w.id} entry={w} wi={wi} isMobile={isMobile} colGrid={colGrid}
                      folders={folders} isSel={selected.has(w.id)}
                      onToggleSel={() => toggleSel(w.id)}
                      onUpdate={(p) => updEntry(w.id, p)}
                      onDelete={() => delEntry(w.id)}
                      onAddBelow={() => addEntry(date)} />
                  ))}
                </div>
              ))}
            </div>
          );
        })}
      </div>
      {showDl && <DownloadModal worklogs={worklogs} onClose={() => setShowDl(false)} />}
    </div>
  );
}

function WRow({ entry, wi, isMobile, colGrid, folders, isSel, onToggleSel, onUpdate, onDelete, onAddBelow }) {
  const [showDP, setShowDP] = useState(false);
  const [showFP, setShowFP] = useState(false);
  const selFolder = folders.find((f) => f.name === entry.project);
  return (
    <div style={{ display: "grid", gridTemplateColumns: colGrid, gap: 4, alignItems: "center",
      background: isSel ? "#eff6ff" : "#fff", borderRadius: 10, padding: "7px 8px", marginBottom: 3,
      boxShadow: isSel ? "0 0 0 1.5px #93c5fd" : "0 1px 3px rgba(15,32,68,.05)" }}>
      <div style={{ ...wCB, ...(isSel ? wCBOn : {}) }} onClick={onToggleSel}>{isSel && "✓"}</div>
      <div style={{ position: "relative" }}>
        {wi === 0
          ? <div style={wDatePill} onClick={() => setShowDP((v) => !v)}>{entry.date || "날짜"}</div>
          : <div style={{ ...wDatePill, opacity: 0.2, pointerEvents: "none", fontSize: 11 }}>{entry.date}</div>}
        {showDP && <DatePicker value={entry.date} onChange={(d) => { onUpdate({ date: d }); setShowDP(false); }} onClose={() => setShowDP(false)} />}
      </div>
      <input style={wCell} value={entry.keyPoint} placeholder="핵심사항..." onChange={(e) => onUpdate({ keyPoint: e.target.value })} />
      <div style={{ position: "relative" }}>
        <div style={{ ...wDatePill, color: selFolder ? "#1650b8" : "#94a3b8", borderColor: selFolder ? "#bfdbfe" : "#e8eef8", background: selFolder ? "#eff6ff" : "#f8faff", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
          onClick={() => setShowFP((v) => !v)}>
          {selFolder ? entry.project : "폴더"}
        </div>
        {showFP && (
          <div style={{ position: "absolute", zIndex: 500, background: "#fff", borderRadius: 12, boxShadow: "0 6px 24px rgba(15,32,68,.16)", border: "1px solid #e0eaf8", top: "100%", left: 0, marginTop: 4, minWidth: 150, overflow: "hidden" }}>
            <div style={{ padding: "6px 12px 4px", fontSize: 10, fontWeight: 700, color: "#94a3b8", letterSpacing: "1px", textTransform: "uppercase" }}>폴더 선택</div>
            {entry.project && (
              <div style={{ padding: "8px 14px", fontSize: 12, color: "#e53e3e", cursor: "pointer", fontWeight: 500, borderBottom: "1px solid #f0f4fa" }}
                onMouseDown={() => { onUpdate({ project: "" }); setShowFP(false); }}>* 선택 해제</div>
            )}
            {folders.map((f) => (
              <div key={f.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 14px", fontSize: 13, cursor: "pointer", fontWeight: 500,
                color: entry.project === f.name ? "#2563eb" : "#1e3a6e", background: entry.project === f.name ? "#eff6ff" : "transparent" }}
                onMouseDown={() => { onUpdate({ project: f.name }); setShowFP(false); }}>
                {entry.project === f.name && <span style={{ fontSize: 11 }}>✓ </span>}{f.name}
              </div>
            ))}
          </div>
        )}
      </div>
      {!isMobile && <input style={wCell} value={entry.details} placeholder="세부내용..." onChange={(e) => onUpdate({ details: e.target.value })} />}
      {!isMobile && <input style={{ ...wCell, fontSize: 12 }} value={entry.notes} placeholder="비고..." onChange={(e) => onUpdate({ notes: e.target.value })} />}
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        <button style={wRowBtn} onClick={onAddBelow} title="행 추가">＋</button>
        <button style={{ ...wRowBtn, color: "#fca5a5" }} onClick={onDelete} title="삭제">*</button>
      </div>
    </div>
  );
}

function DownloadModal({ worklogs, onClose }) {
  const now = new Date();
  const thisYM = now.getFullYear() + "." + String(now.getMonth() + 1).padStart(2, "0");
  const [from, setFrom] = useState(thisYM);
  const [to, setTo] = useState(thisYM);
  const [showF, setShowF] = useState(false);
  const [showT, setShowT] = useState(false);
  const doDownload = () => {
    const rows = worklogs
      .filter((w) => { const ym = w.date?.slice(0, 7) || ""; return ym >= from && ym <= to; })
      .sort((a, b) => a.date?.localeCompare(b.date))
      .map((w) => ({ "날짜": w.date || "", "프로젝트": w.project || "", "핵심사항": w.keyPoint || "", "세부내용": w.details || "", "비고": w.notes || "" }));
    if (!rows.length) { alert("해당 기간에 데이터가 없습니다."); return; }
    const ws = XLSX.utils.json_to_sheet(rows);
    ws["!cols"] = [{ wch: 12 }, { wch: 22 }, { wch: 30 }, { wch: 40 }, { wch: 20 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "업무일지");
    XLSX.writeFile(wb, "업무일지_" + from + "_" + to + ".xlsx");
    onClose();
  };
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(15,32,68,.4)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 800 }} onClick={onClose}>
      <div style={{ background: "#fff", borderRadius: 18, padding: "26px 24px 20px", width: 300, boxShadow: "0 16px 48px rgba(15,32,68,.22)" }} onClick={(e) => e.stopPropagation()}>
        <div style={{ fontSize: 15, fontWeight: 700, color: "#0f2044", marginBottom: 4 }}>📥 엑셀 다운로드</div>
        <div style={{ fontSize: 12, color: "#8aa0c0", marginBottom: 18, lineHeight: 1.6 }}>기간을 선택하여 xlsx 파일로 저장합니다.</div>
        <div style={{ display: "flex", gap: 10, marginBottom: 18 }}>
          {[["시작", from, setFrom, showF, setShowF], ["종료", to, setTo, showT, setShowT]].map(([lbl, val, set, show, setShow]) => (
            <div key={lbl} style={{ flex: 1 }}>
              <div style={{ fontSize: 11, color: "#6b8bb5", fontWeight: 700, marginBottom: 4 }}>{lbl}</div>
              <div style={{ position: "relative" }}>
                <button style={{ ...wBtn, width: "100%", justifyContent: "center", fontSize: 12 }} onClick={() => setShow((v) => !v)}>{val}</button>
                {show && <MonthPicker value={val} onChange={(v) => { set(v); setShow(false); }} onClose={() => setShow(false)} />}
              </div>
            </div>
          ))}
        </div>
        <button style={{ width: "100%", padding: "12px", borderRadius: 10, border: "none", background: "#2563eb", color: "#fff", fontSize: 14, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", boxShadow: "0 4px 10px rgba(37,99,235,.3)" }} onClick={doDownload}>다운로드</button>
        <button style={{ width: "100%", padding: "9px", borderRadius: 10, border: "none", background: "transparent", color: "#9ca3af", fontSize: 13, cursor: "pointer", fontFamily: "inherit", marginTop: 8 }} onClick={onClose}>취소</button>
      </div>
    </div>
  );
}

function CalendarView({ items, folders }) {
  const now = new Date();
  const todayYM = now.getFullYear() + "." + String(now.getMonth() + 1).padStart(2, "0");
  const [search, setSearch] = useState("");
  const [navYM, setNavYM] = useState(null);
  const [showNav, setShowNav] = useState(false);
  const [filterFolders, setFilterFolders] = useState(new Set());
  const [showFilter, setShowFilter] = useState(false);
  const listRef = useRef(null);
  const allSelected = filterFolders.size === 0;
  const toggleFF = (name) => setFilterFolders((prev) => { const n = new Set(prev); n.has(name) ? n.delete(name) : n.add(name); return n; });
  const filterLabel = allSelected ? "전체" : filterFolders.size === 1 ? [...filterFolders][0] : filterFolders.size + "개 선택";
  const getFN = (id) => folders.find((f) => f.id === id)?.name || "—";
  const tIcon = (t) => t === T.HEADER ? "▬" : t === T.TODO ? "☐" : "T";
  const tColor = (t) => t === T.HEADER ? "#2563eb" : t === T.TODO ? "#059669" : "#8b5cf6";
  const q = search.trim().toLowerCase();
  const filtered = [...items].filter((i) => !i.deletedAt).filter((i) => !q || (i.title || "").toLowerCase().includes(q)).filter((i) => allSelected || filterFolders.has(getFN(i.folder))).sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
  const grouped = {};
  filtered.forEach((item) => { const d = item.createdAt || "날짜 없음"; if (!grouped[d]) grouped[d] = []; grouped[d].push(item); });
  const ymGroups = {};
  Object.entries(grouped).forEach(([date, dayItems]) => { const ym = date.slice(0, 7); if (!ymGroups[ym]) ymGroups[ym] = {}; ymGroups[ym][date] = dayItems; });
  const sortedYMs = Object.keys(ymGroups).sort((a, b) => b.localeCompare(a));
  const navigateTo = (ym) => {
    setNavYM(ym); setShowNav(false);
    setTimeout(() => { listRef.current?.querySelector('[data-calym="' + ym + '"]')?.scrollIntoView({ behavior: "smooth", block: "start" }); }, 100);
  };
  const doDownload = () => {
    const rows = filtered.map((item) => ({ "날짜": item.createdAt || "", "폴더": getFN(item.folder), "유형": item.type === T.HEADER ? "헤더" : item.type === T.TODO ? "할일" : "텍스트", "제목": item.title || "", "완료": item.type === T.TODO ? (item.done ? "완료" : "진행") : "", "별표": item.starred ? "★" : "" }));
    if (!rows.length) { alert("데이터가 없습니다."); return; }
    const ws = XLSX.utils.json_to_sheet(rows);
    ws["!cols"] = [{ wch: 12 }, { wch: 14 }, { wch: 8 }, { wch: 40 }, { wch: 6 }, { wch: 4 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "캘린더");
    XLSX.writeFile(wb, "calendar_" + (navYM || todayYM) + ".xlsx");
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }} onClick={() => setShowFilter(false)}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", paddingBottom: 10, borderBottom: "1px solid #eef3ff", marginBottom: 8 }}>
        <div style={{ flex: 1, minWidth: 120, position: "relative" }}>
          <span style={{ position: "absolute", left: 9, top: "50%", transform: "translateY(-50%)", color: "#a0b4cc", fontSize: 13 }}>🔍</span>
          <input style={{ width: "100%", padding: "7px 10px 7px 28px", borderRadius: 9, border: "1.5px solid #e0eaf8", fontSize: 12.5, color: "#1e3a6e", outline: "none", fontFamily: "inherit", background: "#fff", boxSizing: "border-box" }}
            placeholder="검색..." value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <div style={{ position: "relative" }} onClick={(e) => e.stopPropagation()}>
          <button style={{ ...wBtn, ...(allSelected ? {} : { background: "#eef3ff", color: "#2563eb", borderColor: "#bfdbfe" }) }}
            onClick={() => setShowFilter((v) => !v)}>⊞ {filterLabel}</button>
          {showFilter && (
            <div style={{ position: "absolute", top: "100%", left: 0, marginTop: 4, background: "#fff", borderRadius: 12, boxShadow: "0 6px 24px rgba(15,32,68,.16)", border: "1px solid #e0eaf8", zIndex: 400, minWidth: 170, overflow: "hidden" }}>
              <div style={{ padding: "6px 12px 4px", fontSize: 10, fontWeight: 700, color: "#94a3b8", letterSpacing: "1px", textTransform: "uppercase" }}>폴더 필터</div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 14px", cursor: "pointer", borderBottom: "1px solid #f0f4fa", background: allSelected ? "#eff6ff" : "transparent" }}
                onClick={() => setFilterFolders(new Set())}>
                <div style={{ width: 15, height: 15, borderRadius: 4, border: "1.5px solid", borderColor: allSelected ? "#2563eb" : "#c2d0e8", background: allSelected ? "#2563eb" : "transparent", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                  {allSelected && <span style={{ color: "#fff", fontSize: 10, fontWeight: 700 }}>✓</span>}
                </div>
                <span style={{ fontSize: 13, fontWeight: 600, color: allSelected ? "#2563eb" : "#1e3a6e" }}>전체</span>
              </div>
              {folders.map((f) => {
                const on = filterFolders.has(f.name);
                return (
                  <div key={f.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 14px", cursor: "pointer", background: on ? "#eff6ff" : "transparent" }}
                    onClick={() => toggleFF(f.name)}>
                    <div style={{ width: 15, height: 15, borderRadius: 4, border: "1.5px solid", borderColor: on ? "#2563eb" : "#c2d0e8", background: on ? "#2563eb" : "transparent", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                      {on && <span style={{ color: "#fff", fontSize: 10, fontWeight: 700 }}>✓</span>}
                    </div>
                    <span style={{ fontSize: 13, fontWeight: 500, color: on ? "#2563eb" : "#1e3a6e" }}>{f.name}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
        <div style={{ position: "relative" }}>
          <button style={wBtn} onClick={() => setShowNav((v) => !v)}>📅 {navYM || todayYM}</button>
          {showNav && <MonthPicker value={navYM || todayYM} onChange={navigateTo} onClose={() => setShowNav(false)} label="년월로 이동" />}
        </div>
        <button style={{ ...wBtn, background: "#2563eb", color: "#fff", border: "none", boxShadow: "0 2px 8px rgba(37,99,235,.3)" }} onClick={doDownload}>↓ 엑셀</button>
      </div>
      <div ref={listRef} style={{ flex: 1, overflowY: "auto", paddingBottom: 40 }}>
        {sortedYMs.length === 0 && (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "60px 0", color: "#b0c4de" }}>
            <div style={{ fontSize: 32, marginBottom: 10 }}>◷</div>
            <div style={{ fontSize: 13 }}>{search || !allSelected ? "결과 없음" : "항목이 없습니다."}</div>
          </div>
        )}
        {sortedYMs.map((ym) => {
          const [yy, mm] = ym.split(".");
          const dayEntries = Object.entries(ymGroups[ym]).sort((a, b) => b[0].localeCompare(a[0]));
          const total = dayEntries.reduce((s, [, v]) => s + v.length, 0);
          return (
            <div key={ym} data-calym={ym} style={{ marginBottom: 28 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8, marginTop: 4 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: "#1e3a6e", background: "#eef3ff", borderRadius: 20, padding: "4px 14px", flexShrink: 0 }}>{yy}년 {parseInt(mm)}월</div>
                <div style={{ flex: 1, height: 1, background: "rgba(37,99,235,.1)" }} />
                <span style={{ fontSize: 11, color: "#94a3b8", flexShrink: 0 }}>{total}건</span>
              </div>
              {dayEntries.map(([date, dayItems]) => (
                <div key={date} style={{ marginBottom: 12 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
                    <div style={{ flex: 1, height: 1, background: "rgba(37,99,235,.08)" }} />
                    <div style={{ fontSize: 11, fontWeight: 700, color: "#2563eb", padding: "2px 8px", background: "#eef3ff", borderRadius: 10, whiteSpace: "nowrap" }}>{date}</div>
                    <div style={{ flex: 1, height: 1, background: "rgba(37,99,235,.08)" }} />
                  </div>
                  {dayItems.map((item) => (
                    <div key={item.id} style={{ display: "flex", alignItems: "center", gap: 10, background: "#fff", borderRadius: 9, padding: "10px 14px", boxShadow: "0 1px 3px rgba(15,32,68,.05)", marginBottom: 3 }}>
                      <span style={{ fontSize: 12, fontWeight: 700, width: 16, flexShrink: 0, textAlign: "center", color: tColor(item.type) }}>{tIcon(item.type)}</span>
                      <span style={{ flex: 1, fontSize: 13.5, color: "#1e3a6e", fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.title || "(제목 없음)"}</span>
                      {item.starred && <span style={{ color: "#f59e0b", fontSize: 12 }}>★</span>}
                      <span style={{ fontSize: 10, color: "#6b8bb5", background: "#f0f5fc", borderRadius: 8, padding: "2px 7px", flexShrink: 0 }}>{getFN(item.folder)}</span>
                      {item.type === T.TODO && (
                        <span style={{ fontSize: 10, borderRadius: 8, padding: "2px 7px", flexShrink: 0, ...(item.done ? { color: "#065f46", background: "#d1fae5" } : { color: "#b45309", background: "#fef3c7" }) }}>
                          {item.done ? "완료" : "진행"}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function TrashView({ items, onRestore, onPermDel, onEmpty }) {
  const [sel, setSel] = useState(new Set());
  const trash = items.filter((i) => i.deletedAt);
  const togSel = (id) => setSel((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const allSel = trash.length > 0 && sel.size === trash.length;
  const left = (ts) => Math.max(0, TRASH_DAYS - daysAgo(ts));
  return (
    <div>
      {trash.length > 0 && (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12, flexWrap: "wrap", gap: 8 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}
            onClick={() => setSel(allSel ? new Set() : new Set(trash.map((i) => i.id)))}>
            <div style={{ width: 17, height: 17, borderRadius: 4, border: "1.5px solid #c2d0e8", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, color: "#fff", fontWeight: 700, ...(allSel ? { background: "#2563eb", borderColor: "#2563eb" } : {}) }}>
              {allSel && "✓"}
            </div>
            <span style={{ fontSize: 12, color: "#6b8bb5" }}>전체 선택</span>
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            {sel.size > 0 && (
              <>
                <button style={{ background: "none", border: "1px solid #bfdbfe", borderRadius: 7, padding: "5px 11px", fontSize: 12, cursor: "pointer", fontFamily: "inherit", fontWeight: 600, color: "#2563eb" }}
                  onClick={() => { sel.forEach((id) => onRestore(id)); setSel(new Set()); }}>복원({sel.size})</button>
                <button style={{ background: "none", border: "1px solid #fecaca", borderRadius: 7, padding: "5px 11px", fontSize: 12, cursor: "pointer", fontFamily: "inherit", fontWeight: 600, color: "#e53e3e" }}
                  onClick={() => { sel.forEach((id) => onPermDel(id)); setSel(new Set()); }}>삭제({sel.size})</button>
              </>
            )}
            <button style={{ background: "none", border: "1px solid #e5e7eb", borderRadius: 7, padding: "5px 11px", fontSize: 12, cursor: "pointer", fontFamily: "inherit", fontWeight: 600, color: "#9ca3af" }}
              onClick={() => { onEmpty(); setSel(new Set()); }}>전체 비우기</button>
          </div>
        </div>
      )}
      {trash.length === 0 && (
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "80px 0", color: "#b0c4de" }}>
          <div style={{ fontSize: 32, marginBottom: 10 }}>🗑</div>
          <div style={{ fontSize: 13 }}>휴지통이 비어있습니다.</div>
        </div>
      )}
      {trash.map((item) => {
        const isSel = sel.has(item.id);
        const l = left(item.deletedAt);
        return (
          <div key={item.id} style={{ display: "flex", alignItems: "center", gap: 10, background: isSel ? "#eff6ff" : "#fff", borderRadius: 10, padding: "12px 14px", marginBottom: 5, boxShadow: isSel ? "0 0 0 1.5px #93c5fd" : "0 1px 3px rgba(15,32,68,.05)" }}>
            <div style={{ width: 17, height: 17, borderRadius: 4, border: "1.5px solid #c2d0e8", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, color: "#fff", fontWeight: 700, cursor: "pointer", flexShrink: 0, ...(isSel ? { background: "#2563eb", borderColor: "#2563eb" } : {}) }}
              onClick={() => togSel(item.id)}>{isSel && "✓"}</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13.5, color: "#4b5563", fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", textDecoration: "line-through" }}>{item.title || "(제목 없음)"}</div>
              <div style={{ fontSize: 10, color: l <= 3 ? "#e53e3e" : "#9ca3af", marginTop: 2 }}>
                {l === 0 ? "오늘 영구 삭제" : l + "일 후 자동 삭제"} · {item.originalFolderName || "알 수 없는 폴더"}
              </div>
            </div>
            <button style={{ background: "none", border: "1px solid #bfdbfe", borderRadius: 7, color: "#2563eb", fontSize: 11.5, padding: "4px 10px", cursor: "pointer", fontFamily: "inherit", fontWeight: 600, flexShrink: 0 }}
              onClick={() => onRestore(item.id)}>복원</button>
            <button style={{ background: "none", border: "none", color: "#d0ddef", fontSize: 18, cursor: "pointer", padding: "0 2px", flexShrink: 0 }}
              onClick={() => onPermDel(item.id)}>*</button>
          </div>
        );
      })}
      <div style={{ fontSize: 11, color: "#c0c8d8", textAlign: "center", marginTop: 16, lineHeight: 1.6 }}>{TRASH_DAYS}일 후 자동 영구 삭제됩니다.</div>
    </div>
  );
}

function SidebarInner({ sidebarItems, setSidebarItems, activeFolder, onSelect, onAddItem, user, onLogin, onLogout, trashCount, syncStatus }) {
  const [showAdd, setShowAdd] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const containerRef = useRef(null);
  const { beginDrag } = useSortable(containerRef, sidebarItems, setSidebarItems);
  const NI = { display: "flex", alignItems: "center", gap: 8, padding: "9px 12px", borderRadius: 8, cursor: "pointer", fontWeight: 500, marginBottom: 1, userSelect: "none" };

  const deleteFolder = (item) => { setSidebarItems((prev) => prev.filter((i) => i.id !== item.id)); setConfirmDelete(null); };

  return (
    <>
      <div style={{ padding: "44px 22px 20px", borderBottom: "1px solid rgba(255,255,255,.12)", flexShrink: 0 }}>
        <div style={{ lineHeight: 1 }}>
          <span style={{ color: "rgba(255,255,255,.65)", fontSize: 13, fontWeight: 300, letterSpacing: "0.5px", fontStyle: "italic", display: "block", marginBottom: 2 }}>the</span>
          <span style={{ color: "#ffffff", fontSize: 26, fontWeight: 900, letterSpacing: "3px", fontFamily: "'Arial Black','Helvetica Neue',sans-serif", textTransform: "uppercase", display: "block" }}>NOTES</span>
        </div>
      </div>
      <nav ref={containerRef} style={{ padding: "10px 10px", flex: 1, overflowY: "auto" }}>
        {sidebarItems.map((item, index) => {
          const handle = (
            <span data-handle="1" style={{ color: "rgba(255,255,255,.25)", fontSize: 16, cursor: "grab", padding: "0 4px", flexShrink: 0, touchAction: "none", userSelect: "none", lineHeight: 1 }}
              onMouseDown={(e) => beginDrag(e, index)}
              onTouchStart={(e) => { const t = e.touches[0]; beginDrag({ clientY: t.clientY, touches: e.touches, preventDefault: () => e.preventDefault(), stopPropagation: () => e.stopPropagation() }, index); }}>
              ⠿
            </span>
          );
          if (item.type === "sheader") return (
            <div key={item.id} data-sortidx={index} style={{ display: "flex", alignItems: "center", fontSize: 9.5, fontWeight: 700, color: "rgba(255,255,255,.3)", letterSpacing: "1.8px", textTransform: "uppercase", padding: "10px 12px 4px", userSelect: "none" }}>
              <span style={{ flex: 1 }}>{item.label}</span>{handle}
            </div>
          );
          if (item.type === "divider") return (
            <div key={item.id} data-sortidx={index} style={{ padding: "6px 12px", userSelect: "none", display: "flex", alignItems: "center", gap: 4 }}>
              <div style={{ flex: 1, height: 1, background: "rgba(255,255,255,.12)", borderRadius: 1 }} />
              <span style={{ color: "rgba(255,120,120,.45)", fontSize: 14, lineHeight: 1, cursor: "pointer", padding: "0 2px", flexShrink: 0 }}
                onMouseDown={(e) => { e.stopPropagation(); setSidebarItems((prev) => prev.filter((i) => i.id !== item.id)); }}>*</span>
              {handle}
            </div>
          );
          if (item.type === "folder") return (
            <div key={item.id} data-sortidx={index}
              style={{ ...NI, color: "rgba(255,255,255,.6)", ...(activeFolder === item.id ? { background: "rgba(255,255,255,.12)", color: "#fff" } : {}) }}
              onClick={() => onSelect(item.id)}>
              <span style={{ fontSize: 11, width: 16, color: "rgba(255,255,255,.4)", flexShrink: 0 }}>○</span>
              <span style={{ flex: 1, fontSize: 13.5 }}>{item.name}</span>
              <span style={{ color: "rgba(255,120,120,.5)", fontSize: 16, lineHeight: 1, cursor: "pointer", padding: "0 3px", flexShrink: 0 }} title="폴더 삭제"
                onMouseDown={(e) => { e.stopPropagation(); setConfirmDelete(item); }}>*</span>
              {handle}
            </div>
          );
          return null;
        })}
        <div style={{ marginTop: 8, paddingTop: 8, borderTop: "1px solid rgba(255,255,255,.08)" }}>
          {[
            { id: NOTICE_ID, label: "Notice", icon: "★", ac: "#fde68a", ic: "rgba(255,220,80,.65)" },
            { id: CALENDAR_ID, label: "Calendar", icon: "◷", ac: "#a5f3fc", ic: "rgba(125,211,252,.65)" },
            { id: WORKLOG_ID, label: "Worklog", icon: "📋", ac: "#c4b5fd", ic: "rgba(167,139,250,.7)" },
            { id: TRASH_ID, label: "Trash", icon: "🗑", ac: "#fca5a5", ic: "rgba(252,165,165,.7)", badge: trashCount },
          ].map((f) => (
            <div key={f.id} style={{ ...NI, ...(activeFolder === f.id ? { background: "rgba(255,255,255,.12)", color: f.ac } : { color: f.ic }) }}
              onClick={() => onSelect(f.id)}>
              <span style={{ fontSize: 11, width: 16 }}>{f.icon}</span>
              <span style={{ flex: 1, fontSize: 13.5 }}>{f.label}</span>
              {f.badge > 0 && <span style={{ background: "rgba(252,165,165,.25)", color: "rgba(252,165,165,.9)", borderRadius: 10, padding: "1px 6px", fontSize: 10, fontWeight: 700 }}>{f.badge}</span>}
            </div>
          ))}
        </div>
      </nav>
      {confirmDelete && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(10,20,50,.55)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 900 }}
          onClick={() => setConfirmDelete(null)}>
          <div style={{ background: "#fff", borderRadius: 18, padding: "28px 24px 22px", width: 280, boxShadow: "0 16px 48px rgba(15,32,68,.28)", textAlign: "center" }}
            onClick={(e) => e.stopPropagation()}>
            <div style={{ fontSize: 36, marginBottom: 8 }}>🗑</div>
            <div style={{ fontSize: 15, fontWeight: 700, color: "#0f2044", marginBottom: 8 }}>폴더 삭제</div>
            <div style={{ fontSize: 13, color: "#6b8bb5", marginBottom: 22, lineHeight: 1.6 }}>
              <span style={{ fontWeight: 700, color: "#1e3a6e" }}>"{confirmDelete.name}"</span> 폴더를 삭제하시겠습니까?<br />폴더 안의 노트는 삭제되지 않습니다.
            </div>
            <div style={{ display: "flex", gap: 10 }}>
              <button style={{ flex: 1, padding: "11px", borderRadius: 10, border: "1.5px solid #e0eaf8", background: "transparent", color: "#6b8bb5", fontSize: 14, cursor: "pointer", fontFamily: "inherit", fontWeight: 600 }}
                onClick={() => setConfirmDelete(null)}>취소</button>
              <button style={{ flex: 1, padding: "11px", borderRadius: 10, border: "none", background: "#e53e3e", color: "#fff", fontSize: 14, cursor: "pointer", fontFamily: "inherit", fontWeight: 700, boxShadow: "0 4px 12px rgba(229,62,62,.3)" }}
                onClick={() => deleteFolder(confirmDelete)}>삭제</button>
            </div>
          </div>
        </div>
      )}
      <div style={{ padding: "12px 12px 8px", borderTop: "1px solid rgba(255,255,255,.08)", flexShrink: 0 }}>
        <div style={{ position: "relative" }}>
          <div style={{ display: "flex", alignItems: "center", color: "rgba(255,255,255,.5)", fontSize: 12.5, cursor: "pointer", padding: "7px 10px", borderRadius: 7, userSelect: "none" }}
            onClick={() => setShowAdd((v) => !v)}>
            <span style={{ fontSize: 15, marginRight: 6 }}>+</span> 추가
          </div>
          {showAdd && (
            <div style={{ position: "absolute", bottom: "100%", left: 0, background: "#1650b8", border: "1px solid rgba(255,255,255,.15)", borderRadius: 10, overflow: "hidden", zIndex: 200, minWidth: 110, boxShadow: "0 4px 16px rgba(0,0,0,.25)", marginBottom: 4 }}>
              {[["폴더", "folder"], ["헤더", "sheader"], ["구분선", "divider"]].map(([l, t]) => (
                <div key={t} style={{ padding: "10px 16px", color: "rgba(255,255,255,.75)", fontSize: 13, cursor: "pointer", fontWeight: 500 }}
                  onClick={() => { onAddItem(t); setShowAdd(false); }}>{l}</div>
              ))}
            </div>
          )}
        </div>
      </div>
      <div style={{ padding: "12px 12px 28px", borderTop: "1px solid rgba(255,255,255,.08)", flexShrink: 0 }}>
        {user ? (
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            {user.picture
              ? <img src={user.picture} alt="" style={{ width: 32, height: 32, borderRadius: "50%", flexShrink: 0 }} referrerPolicy="no-referrer" />
              : <div style={{ width: 32, height: 32, borderRadius: "50%", background: "linear-gradient(135deg,#4285F4,#34A853)", display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontSize: 14, fontWeight: 700, flexShrink: 0 }}>
                  {user.name?.[0]?.toUpperCase() || "G"}
                </div>}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ color: "#fff", fontSize: 12.5, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{user.name}</div>
              <div style={{ color: "rgba(255,255,255,.4)", fontSize: 10, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{user.email}</div>
            </div>
            <button style={{ background: "none", border: "1px solid rgba(255,255,255,.2)", borderRadius: 7, color: "rgba(255,255,255,.5)", fontSize: 11, padding: "4px 8px", cursor: "pointer", fontFamily: "inherit", flexShrink: 0 }}
              onClick={onLogout}>로그아웃</button>
          </div>
        ) : (
          <button style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", background: "rgba(255,255,255,.95)", border: "none", borderRadius: 10, padding: "10px 14px", cursor: "pointer", fontSize: 12.5, fontWeight: 600, color: "#1650b8", boxShadow: "0 2px 8px rgba(0,0,0,.15)" }}
            onClick={onLogin}>
            <svg width="16" height="16" viewBox="0 0 24 24" style={{ flexShrink: 0 }}>
              <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
              <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
              <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
              <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
            </svg>
            <span>Google로 로그인</span>
          </button>
        )}
      </div>
    </>
  );
}

function getYouTubeId(url) {
  if (!url) return null;
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/watch\?.*v=([a-zA-Z0-9_-]{11})/,
  ];
  for (const p of patterns) { const m = url.match(p); if (m) return m[1]; }
  return null;
}

function LinkItem({ lk, onDelete }) {
  const ytId = getYouTubeId(lk.url);
  const isYT = !!ytId;
  return (
    <div style={{ display: "inline-flex", alignItems: "center", gap: 6, borderRadius: 20, padding: "4px 12px", fontSize: 12,
      background: isYT ? "#fff0f0" : "#eff6ff", border: isYT ? "1px solid #fecaca" : "1px solid #bfdbfe" }}
      onClick={(e) => e.stopPropagation()}>
      <span style={{ fontSize: 12 }}>{isYT ? "▶" : "🔗"}</span>
      <span style={{ color: isYT ? "#c53030" : "#2563eb", fontWeight: 600, cursor: "pointer" }}
        onClick={() => window.open(lk.url, "_blank", "noopener,noreferrer")}>{lk.label}</span>
      <span style={{ color: "#c0cfe8", cursor: "pointer", fontSize: 14, lineHeight: 1 }} onClick={onDelete}>*</span>
    </div>
  );
}

function HiddenSection({ section, isMobile, onUpdate, onDelete }) {
  return (
    <div style={{ margin: "0 14px 6px 21px", border: "1px solid #e0eaf8", borderRadius: 9, overflow: "hidden", background: "#fafcff" }}
      onClick={(e) => e.stopPropagation()}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 10px", background: "#f0f5fc" }}>
        <button style={{ background: "none", border: "none", cursor: "pointer", color: "#4b6fa8", padding: "2px 4px", borderRadius: 4, display: "flex", alignItems: "center", flexShrink: 0 }}
          onClick={() => onUpdate({ open: !section.open })}>
          <span style={{ display: "inline-block", transition: "transform .2s", transform: section.open ? "rotate(0deg)" : "rotate(-90deg)", fontSize: 13 }}>▾</span>
        </button>
        <input style={{ color: "#2a5ba8", border: "none", background: "transparent", outline: "none", fontFamily: "inherit", fontSize: 12.5, fontWeight: 600, flex: 1 }}
          value={section.label} onChange={(e) => onUpdate({ label: e.target.value })} placeholder="섹션 제목..."
          onClick={(e) => e.stopPropagation()} />
        <span style={{ color: "#c0cfe8", fontSize: 15, cursor: "pointer", padding: "0 2px" }} onClick={onDelete}>*</span>
      </div>
      {section.open && (
        <div style={{ padding: "10px 12px", borderTop: "1px solid #e8eef8" }}>
          <RichText html={section.content} onChange={(v) => onUpdate({ content: v })} placeholder="내용을 입력하세요..." style={{ fontSize: 13 }} />
        </div>
      )}
    </div>
  );
}

function NoteItem({ item, isMobile, onUpdate, onDelete, onMoveToTrash, folders }) {
  const [expanded, setExpanded] = useState(false);
  const [showLinkForm, setShowLinkForm] = useState(false);
  const [linkUrl, setLinkUrl] = useState("");
  const [linkLabel, setLinkLabel] = useState("");
  const [showMovePicker, setShowMovePicker] = useState(false);

  const addLink = () => {
    if (!linkUrl.trim()) return;
    const label = linkLabel.trim() || linkUrl.trim();
    onUpdate({ links: [...(item.links || []), { id: "lk" + nextId++, url: linkUrl.trim(), label }] });
    setLinkUrl(""); setLinkLabel(""); setShowLinkForm(false);
  };
  const delLink = (id) => onUpdate({ links: (item.links || []).filter((l) => l.id !== id) });
  const addHidden = () => onUpdate({ hiddenSections: [...(item.hiddenSections || []), { id: "hs" + nextId++, label: "", content: "", open: true }] });
  const updHidden = (id, patch) => onUpdate({ hiddenSections: (item.hiddenSections || []).map((s) => s.id === id ? { ...s, ...patch } : s) });
  const delHidden = (id) => onUpdate({ hiddenSections: (item.hiddenSections || []).filter((s) => s.id !== id) });

  const currentFolderName = folders.find((f) => f.id === item.folder)?.name || "—";

  if (item.type === T.HEADER) {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 14px", borderRadius: 10, background: "#e8f0fe", margin: "10px 0 4px" }}>
        <span style={{ color: "#2563eb", fontSize: 13, fontWeight: 800, flexShrink: 0 }}>▬</span>
        <input style={{ flex: 1, background: "none", border: "none", outline: "none", fontFamily: "inherit", fontSize: 14, fontWeight: 700, color: "#1e3a6e" }}
          value={item.title} onChange={(e) => onUpdate({ title: e.target.value })} placeholder="Header..." />
        <span style={{ color: "#b0c8e0", cursor: "pointer", fontSize: 16, padding: "0 2px" }} onClick={onMoveToTrash}>*</span>
      </div>
    );
  }

  if (item.type === T.TODO) {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", borderRadius: 10, background: "#fff", boxShadow: "0 1px 3px rgba(15,32,68,.06)", marginBottom: 3 }}>
        <div style={{ width: 18, height: 18, borderRadius: 5, border: "1.5px solid", borderColor: item.done ? "#2563eb" : "#c2d0e8", background: item.done ? "#2563eb" : "transparent", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", flexShrink: 0 }}
          onClick={() => onUpdate({ done: !item.done })}>
          {item.done && <span style={{ color: "#fff", fontSize: 11, fontWeight: 700 }}>✓</span>}
        </div>
        <input style={{ flex: 1, background: "none", border: "none", outline: "none", fontFamily: "inherit", fontSize: 13.5, color: item.done ? "#94a3b8" : "#1e3a6e", textDecoration: item.done ? "line-through" : "none" }}
          value={item.title} onChange={(e) => onUpdate({ title: e.target.value })} placeholder="To-do..." />
        <span style={{ fontSize: 13, cursor: "pointer", color: item.starred ? "#f59e0b" : "#d0ddef" }}
          onClick={() => onUpdate({ starred: !item.starred })}>{item.starred ? "★" : "☆"}</span>
        <span style={{ color: "#d0ddef", cursor: "pointer", fontSize: 16, padding: "0 2px" }} onClick={onMoveToTrash}>*</span>
      </div>
    );
  }

  // TEXT
  return (
    <div style={{ borderRadius: 12, background: "#fff", boxShadow: "0 1px 4px rgba(15,32,68,.06)", marginBottom: 4, overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 14px", cursor: "pointer" }}
        onClick={() => setExpanded((v) => !v)}>
        <span style={{ color: "#8b5cf6", fontSize: 12, fontWeight: 700, flexShrink: 0 }}>T</span>
        <span style={{ flex: 1, fontSize: 13.5, fontWeight: 600, color: "#1e3a6e", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {item.title || "(제목 없음)"}
        </span>
        {(item.links || []).length > 0 && <span style={{ fontSize: 10, color: "#6b8bb5" }}>🔗{item.links.length}</span>}
        <span style={{ fontSize: 13, cursor: "pointer", color: item.starred ? "#f59e0b" : "#d0ddef" }}
          onClick={(e) => { e.stopPropagation(); onUpdate({ starred: !item.starred }); }}>{item.starred ? "★" : "☆"}</span>
        <span style={{ color: "#d0ddef", cursor: "pointer", fontSize: 16, padding: "0 2px" }}
          onClick={(e) => { e.stopPropagation(); onMoveToTrash(); }}>*</span>
        <span style={{ color: "#b0c8e0", fontSize: 13, transition: "transform .2s", transform: expanded ? "rotate(0deg)" : "rotate(-90deg)" }}>▾</span>
      </div>
      {expanded && (
        <div style={{ padding: "0 14px 14px" }}>
          <input style={{ width: "100%", border: "none", borderBottom: "1px solid #eef3ff", outline: "none", fontFamily: "inherit", fontSize: 14, fontWeight: 700, color: "#1e3a6e", padding: "6px 0", marginBottom: 8, boxSizing: "border-box" }}
            value={item.title} onChange={(e) => onUpdate({ title: e.target.value })} placeholder="제목..." />

          {/* Folder move */}
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8, position: "relative" }}>
            <span style={{ fontSize: 11, color: "#94a3b8" }}>폴더:</span>
            <div style={{ fontSize: 12, color: "#2563eb", background: "#eff6ff", borderRadius: 6, padding: "3px 8px", cursor: "pointer", fontWeight: 600, border: "1px solid #bfdbfe" }}
              onClick={() => setShowMovePicker((v) => !v)}>{currentFolderName}</div>
            {showMovePicker && (
              <div style={{ position: "absolute", zIndex: 500, background: "#fff", borderRadius: 12, boxShadow: "0 6px 24px rgba(15,32,68,.16)", border: "1px solid #e0eaf8", top: "100%", left: 0, marginTop: 4, minWidth: 150, overflow: "hidden" }}>
                {folders.map((f) => (
                  <div key={f.id} style={{ padding: "9px 14px", fontSize: 13, cursor: "pointer", fontWeight: 500,
                    color: item.folder === f.id ? "#2563eb" : "#1e3a6e", background: item.folder === f.id ? "#eff6ff" : "transparent" }}
                    onClick={() => { onUpdate({ folder: f.id }); setShowMovePicker(false); }}>
                    {item.folder === f.id && "✓ "}{f.name}
                  </div>
                ))}
              </div>
            )}
          </div>

          <RichText html={item.body} onChange={(v) => onUpdate({ body: v })} placeholder="본문을 입력하세요..." style={{ fontSize: 13.5, marginBottom: 10 }} />

          {/* Links */}
          {(item.links || []).length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
              {item.links.map((lk) => <LinkItem key={lk.id} lk={lk} onDelete={() => delLink(lk.id)} />)}
            </div>
          )}

          {/* Hidden sections */}
          {(item.hiddenSections || []).map((s) => (
            <HiddenSection key={s.id} section={s} isMobile={isMobile} onUpdate={(p) => updHidden(s.id, p)} onDelete={() => delHidden(s.id)} />
          ))}

          {/* Action buttons */}
          <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
            <button style={{ background: "#f5f8ff", border: "1px solid #e0eaf8", borderRadius: 7, padding: "5px 10px", fontSize: 11.5, cursor: "pointer", fontFamily: "inherit", color: "#4b6fa8", fontWeight: 600 }}
              onClick={() => setShowLinkForm((v) => !v)}>🔗 링크</button>
            <button style={{ background: "#f5f8ff", border: "1px solid #e0eaf8", borderRadius: 7, padding: "5px 10px", fontSize: 11.5, cursor: "pointer", fontFamily: "inherit", color: "#4b6fa8", fontWeight: 600 }}
              onClick={addHidden}>▾ 숨김 섹션</button>
          </div>

          {showLinkForm && (
            <div style={{ display: "flex", gap: 6, marginTop: 8, alignItems: "center" }} onClick={(e) => e.stopPropagation()}>
              <input style={{ flex: 2, padding: "6px 8px", borderRadius: 7, border: "1px solid #e0eaf8", fontSize: 12, outline: "none", fontFamily: "inherit" }}
                value={linkUrl} onChange={(e) => setLinkUrl(e.target.value)} placeholder="URL" />
              <input style={{ flex: 1, padding: "6px 8px", borderRadius: 7, border: "1px solid #e0eaf8", fontSize: 12, outline: "none", fontFamily: "inherit" }}
                value={linkLabel} onChange={(e) => setLinkLabel(e.target.value)} placeholder="표시 이름" />
              <button style={{ background: "#2563eb", color: "#fff", border: "none", borderRadius: 7, padding: "6px 12px", fontSize: 12, cursor: "pointer", fontFamily: "inherit", fontWeight: 600 }}
                onClick={addLink}>추가</button>
            </div>
          )}

          <div style={{ fontSize: 10, color: "#b0c8e0", marginTop: 10 }}>{item.createdAt}</div>
        </div>
      )}
    </div>
  );
}

function NoticeView({ items, folders, onUpdate, onMoveToTrash, isMobile }) {
  const starred = items.filter((i) => i.starred && !i.deletedAt);
  if (starred.length === 0) {
    return (
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "80px 0", color: "#b0c4de" }}>
        <div style={{ fontSize: 32, marginBottom: 10 }}>★</div>
        <div style={{ fontSize: 13 }}>별표 항목이 없습니다.</div>
      </div>
    );
  }
  return (
    <div>
      {starred.map((item) => (
        <NoteItem key={item.id} item={item} isMobile={isMobile} onUpdate={(p) => onUpdate(item.id, p)} onMoveToTrash={() => onMoveToTrash(item.id)} folders={folders} />
      ))}
    </div>
  );
}

function MainContent({ items, setItems, folders, activeFolder, isMobile, worklogs, setWorklogs }) {
  const containerRef = useRef(null);
  const folderItems = items.filter((i) => i.folder === activeFolder && !i.deletedAt);
  const { beginDrag } = useSortable(containerRef, folderItems, (newFolderItems) => {
    const otherItems = items.filter((i) => i.folder !== activeFolder || i.deletedAt);
    setItems([...otherItems, ...newFolderItems]);
  });

  const onUpdate = (id, patch) => setItems((prev) => prev.map((i) => i.id === id ? { ...i, ...patch } : i));
  const onMoveToTrash = (id) => {
    const item = items.find((i) => i.id === id);
    const folderName = folders.find((f) => f.id === item?.folder)?.name || "알 수 없음";
    setItems((prev) => prev.map((i) => i.id === id ? { ...i, deletedAt: mkTs(), originalFolderName: folderName } : i));
  };
  const onRestore = (id) => setItems((prev) => prev.map((i) => i.id === id ? { ...i, deletedAt: undefined, originalFolderName: undefined } : i));
  const onPermDel = (id) => setItems((prev) => prev.filter((i) => i.id !== id));
  const onEmpty = () => setItems((prev) => prev.filter((i) => !i.deletedAt));

  const addItem = (type) => {
    const id = "i" + nextId++;
    const base = { id, folder: activeFolder, starred: false, createdAt: mkDate() };
    if (type === T.HEADER) setItems((prev) => [...prev, { ...base, type: T.HEADER, title: "" }]);
    else if (type === T.TODO) setItems((prev) => [...prev, { ...base, type: T.TODO, title: "", done: false }]);
    else setItems((prev) => [...prev, { ...base, type: T.TEXT, title: "", body: "", hiddenSections: [], links: [] }]);
  };

  const folderName = folders.find((f) => f.id === activeFolder)?.name || "";

  if (activeFolder === NOTICE_ID) {
    return (
      <div style={{ padding: isMobile ? 16 : 32, height: "100%", overflowY: "auto" }}>
        <div style={{ fontSize: 20, fontWeight: 800, color: "#1e3a6e", marginBottom: 16 }}>★ Notice</div>
        <NoticeView items={items} folders={folders} onUpdate={onUpdate} onMoveToTrash={onMoveToTrash} isMobile={isMobile} />
      </div>
    );
  }
  if (activeFolder === CALENDAR_ID) {
    return (
      <div style={{ padding: isMobile ? 16 : 32, height: "100%", overflowY: "auto" }}>
        <div style={{ fontSize: 20, fontWeight: 800, color: "#1e3a6e", marginBottom: 16 }}>◷ Calendar</div>
        <CalendarView items={items} folders={folders} />
      </div>
    );
  }
  if (activeFolder === WORKLOG_ID) {
    return (
      <div style={{ padding: isMobile ? 16 : 32, height: "100%", overflow: "hidden", display: "flex", flexDirection: "column" }}>
        <div style={{ fontSize: 20, fontWeight: 800, color: "#1e3a6e", marginBottom: 16, flexShrink: 0 }}>📋 Worklog</div>
        <div style={{ flex: 1, overflow: "hidden" }}>
          <WorklogView worklogs={worklogs} setWorklogs={setWorklogs} folders={folders} isMobile={isMobile} />
        </div>
      </div>
    );
  }
  if (activeFolder === TRASH_ID) {
    return (
      <div style={{ padding: isMobile ? 16 : 32, height: "100%", overflowY: "auto" }}>
        <div style={{ fontSize: 20, fontWeight: 800, color: "#1e3a6e", marginBottom: 16 }}>🗑 Trash</div>
        <TrashView items={items} onRestore={onRestore} onPermDel={onPermDel} onEmpty={onEmpty} />
      </div>
    );
  }

  return (
    <div style={{ padding: isMobile ? 16 : 32, height: "100%", overflowY: "auto" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16, gap: 8 }}>
        <div style={{ fontSize: 20, fontWeight: 800, color: "#1e3a6e" }}>{folderName}</div>
        <div style={{ display: "flex", gap: 6 }}>
          {[["▬ 헤더", T.HEADER], ["☐ 할일", T.TODO], ["T 텍스트", T.TEXT]].map(([l, t]) => (
            <button key={t} style={{ background: "#f5f8ff", border: "1px solid #e0eaf8", borderRadius: 8, padding: "6px 12px", fontSize: 12, cursor: "pointer", fontFamily: "inherit", color: "#4b6fa8", fontWeight: 600 }}
              onClick={() => addItem(t)}>{l}</button>
          ))}
        </div>
      </div>
      <div ref={containerRef}>
        {folderItems.length === 0 && (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "80px 0", color: "#b0c4de" }}>
            <div style={{ fontSize: 32, marginBottom: 10 }}>📝</div>
            <div style={{ fontSize: 13 }}>아직 항목이 없습니다. 위 버튼으로 추가하세요.</div>
          </div>
        )}
        {folderItems.map((item, idx) => (
          <div key={item.id} data-sortidx={idx} style={{ display: "flex", alignItems: "flex-start", gap: 4 }}>
            <span style={{ color: "#c8d6e5", fontSize: 14, cursor: "grab", padding: "12px 2px 0 0", flexShrink: 0, touchAction: "none", userSelect: "none" }}
              onMouseDown={(e) => beginDrag(e, idx)}
              onTouchStart={(e) => { const t = e.touches[0]; beginDrag({ clientY: t.clientY, touches: e.touches, preventDefault: () => e.preventDefault(), stopPropagation: () => e.stopPropagation() }, idx); }}>
              ⠿
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <NoteItem item={item} isMobile={isMobile} onUpdate={(p) => onUpdate(item.id, p)} onMoveToTrash={() => onMoveToTrash(item.id)} folders={folders} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function AppInner() {
  const isMobile = useIsMobile();
  const [sidebarItems, setSidebarItems] = useState(initSidebar);
  const [items, setItems] = useState(initItems);
  const [worklogs, setWorklogs] = useState(initWorklogs);
  const [activeFolder, setActiveFolder] = useState("f1");
  const [sidebarOpen, setSidebarOpen] = useState(!isMobile);
  const [user, setUser] = useState(null);
  const [gToken, setGToken] = useState(null);
  const [driveFileId, setDriveFileId] = useState(null);
  const [syncStatus, setSyncStatus] = useState("");

  // Auto-purge trash
  useEffect(() => {
    setItems((prev) => prev.filter((i) => !i.deletedAt || daysAgo(i.deletedAt) < TRASH_DAYS));
  }, []);

  // Google login
  const doLogin = useGoogleLogin({
    onSuccess: async (tokenResponse) => {
      const token = tokenResponse.access_token;
      setGToken(token);
      try {
        const res = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", { headers: { Authorization: "Bearer " + token } });
        const info = await res.json();
        setUser({ name: info.name, email: info.email, picture: info.picture });
      } catch(e) {}
      // Load from Drive
      try {
        setSyncStatus("loading");
        const fid = await gdriveFind(token);
        if (fid) {
          setDriveFileId(fid);
          const data = await gdriveRead(token, fid);
          if (data) {
            if (data.sidebarItems) setSidebarItems(data.sidebarItems);
            if (data.items) setItems(data.items);
            if (data.worklogs) setWorklogs(data.worklogs);
          }
        }
        setSyncStatus("loaded");
      } catch(e) { setSyncStatus("error"); }
    },
    onError: () => {},
    scope: "https://www.googleapis.com/auth/drive.file",
  });

  const doLogout = () => { setUser(null); setGToken(null); setDriveFileId(null); };

  // Auto-save to Drive
  const saveTimer = useRef(null);
  useEffect(() => {
    if (!gToken) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      try {
        setSyncStatus("saving");
        const data = { sidebarItems, items, worklogs };
        await gdriveSave(gToken, data, driveFileId);
        if (!driveFileId) {
          const fid = await gdriveFind(gToken);
          if (fid) setDriveFileId(fid);
        }
        setSyncStatus("saved");
      } catch(e) { setSyncStatus("error"); }
    }, 2000);
    return () => { if (saveTimer.current) clearTimeout(saveTimer.current); };
  }, [sidebarItems, items, worklogs, gToken, driveFileId]);

  const folders = sidebarItems.filter((i) => i.type === "folder");
  const trashCount = items.filter((i) => i.deletedAt).length;

  const addSidebarItem = (type) => {
    const id = "sb" + nextId++;
    if (type === "folder") setSidebarItems((prev) => [...prev, { id, type: "folder", name: "NEW FOLDER" }]);
    else if (type === "sheader") setSidebarItems((prev) => [...prev, { id, type: "sheader", label: "SECTION" }]);
    else setSidebarItems((prev) => [...prev, { id, type: "divider" }]);
  };

  return (
    <div style={{ display: "flex", height: "100vh", fontFamily: "'Pretendard','Inter','Segoe UI',sans-serif", background: "#f0f4fa" }}>
      {/* Mobile overlay */}
      {isMobile && sidebarOpen && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(10,20,50,.4)", zIndex: 49 }}
          onClick={() => setSidebarOpen(false)} />
      )}
      {/* Sidebar */}
      <div style={{
        width: 240, background: "linear-gradient(180deg,#0f2044 0%,#1a3570 100%)", display: "flex", flexDirection: "column",
        position: isMobile ? "fixed" : "relative", left: isMobile ? (sidebarOpen ? 0 : -260) : 0,
        top: 0, bottom: 0, zIndex: 50, transition: "left .3s ease", flexShrink: 0
      }}>
        <SidebarInner sidebarItems={sidebarItems} setSidebarItems={setSidebarItems}
          activeFolder={activeFolder} onSelect={(id) => { setActiveFolder(id); if (isMobile) setSidebarOpen(false); }}
          onAddItem={addSidebarItem} user={user} onLogin={doLogin} onLogout={doLogout}
          trashCount={trashCount} syncStatus={syncStatus} />
      </div>
      {/* Main */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
        {isMobile && (
          <div style={{ display: "flex", alignItems: "center", padding: "10px 14px", background: "#fff", borderBottom: "1px solid #eef3ff", flexShrink: 0 }}>
            <button style={{ background: "none", border: "none", fontSize: 22, cursor: "pointer", color: "#1e3a6e", padding: "2px 8px" }}
              onClick={() => setSidebarOpen(true)}>☰</button>
            <span style={{ fontSize: 14, fontWeight: 700, color: "#1e3a6e", marginLeft: 6 }}>
              {activeFolder === NOTICE_ID ? "Notice" : activeFolder === CALENDAR_ID ? "Calendar" : activeFolder === WORKLOG_ID ? "Worklog" : activeFolder === TRASH_ID ? "Trash" : folders.find((f) => f.id === activeFolder)?.name || ""}
            </span>
            {syncStatus === "saving" && <span style={{ marginLeft: "auto", fontSize: 10, color: "#94a3b8" }}>저장 중...</span>}
            {syncStatus === "saved" && <span style={{ marginLeft: "auto", fontSize: 10, color: "#059669" }}>✓ 저장됨</span>}
          </div>
        )}
        <div style={{ flex: 1, overflow: "hidden" }}>
          <MainContent items={items} setItems={setItems} folders={folders} activeFolder={activeFolder}
            isMobile={isMobile} worklogs={worklogs} setWorklogs={setWorklogs} />
        </div>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <GoogleOAuthProvider clientId={GOOGLE_CLIENT_ID}>
      <AppInner />
    </GoogleOAuthProvider>
  );
}
ENDOFFILE

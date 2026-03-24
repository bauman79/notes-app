import { useState, useRef, useCallback, useEffect } from "react";
import { createPortal } from "react-dom";
import * as XLSX from "xlsx";
import { initializeApp } from "firebase/app";
import { getAuth, signInWithPopup, signInWithRedirect, getRedirectResult, GoogleAuthProvider, onAuthStateChanged, signOut } from "firebase/auth";

// ─── Firebase config ──────────────────────────────────────
const firebaseConfig = {
  apiKey: "AIzaSyBVwig-ugqZuiQwp584F475-1BgNNKr7A8",
  authDomain: "the-notes-e1f26.firebaseapp.com",
  projectId: "the-notes-e1f26",
  storageBucket: "the-notes-e1f26.firebasestorage.app",
  messagingSenderId: "295958524830",
  appId: "1:295958524830:web:cd9e86793d62f31faa5c8f"
};
const firebaseApp  = initializeApp(firebaseConfig);
const firebaseAuth = getAuth(firebaseApp);
const googleProvider = new GoogleAuthProvider();
googleProvider.addScope("https://www.googleapis.com/auth/drive.file");
googleProvider.addScope("https://www.googleapis.com/auth/calendar");
googleProvider.setCustomParameters({ prompt: "select_account" });
const DRIVE_FILE_NAME  = "notes-app-data.json";

// ─── Google Drive helpers ─────────────────────────────────
async function gdriveFind(token) {
  const q = encodeURIComponent(`name='${DRIVE_FILE_NAME}' and trashed=false`);
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${q}&spaces=drive&fields=files(id,name)`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (res.status === 401) throw new Error("TOKEN_EXPIRED");
  const data = await res.json();
  return data.files?.[0]?.id || null;
}

async function gdriveRead(token, fileId) {
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (res.status === 401) throw new Error("TOKEN_EXPIRED");
  if (!res.ok) return null;
  return res.json();
}

async function gdriveSave(token, data, existingFileId) {
  const body = JSON.stringify(data);
  if (existingFileId) {
    const res = await fetch(
      `https://www.googleapis.com/upload/drive/v3/files/${existingFileId}?uploadType=media`,
      {
        method: "PATCH",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body,
      }
    );
    if (res.status === 401) throw new Error("TOKEN_EXPIRED");
    if (!res.ok) throw new Error("Save failed: " + res.status);
    return existingFileId;
  } else {
    const form = new FormData();
    form.append("metadata", new Blob([JSON.stringify({ name: DRIVE_FILE_NAME, mimeType: "application/json" })], { type: "application/json" }));
    form.append("file", new Blob([body], { type: "application/json" }));
    const res = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });
    if (res.status === 401) throw new Error("TOKEN_EXPIRED");
    if (!res.ok) throw new Error("Create failed: " + res.status);
    const created = await res.json();
    return created.id; // 새로 생성된 파일 ID 반환
  }
}

// ─── Constants ────────────────────────────────────────────
async function gdriveUploadFile(token, file) {
  const metadata = { name: file.name, mimeType: file.type };
  const form = new FormData();
  form.append("metadata", new Blob([JSON.stringify(metadata)], { type:"application/json" }));
  form.append("file", file);
  const res = await fetch(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,mimeType",
    { method:"POST", headers:{ Authorization:`Bearer ${token}` }, body:form }
  );
  if (res.status === 401) throw new Error("TOKEN_EXPIRED");
  if (!res.ok) throw new Error("Upload failed");
  return res.json(); // { id, name, mimeType }
}

// Create thumbnail dataURL from image file (max 240px)
function createThumbnail(file) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const MAX = 240;
        const scale = Math.min(MAX / img.width, MAX / img.height, 1);
        const canvas = document.createElement("canvas");
        canvas.width  = img.width  * scale;
        canvas.height = img.height * scale;
        canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/jpeg", 0.75));
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
}


const T = { HEADER: "header", TODO: "todo", TEXT: "text" };

// ─── Google Calendar API helpers ─────────────────────────
const GCAL_BASE = "https://www.googleapis.com/calendar/v3/calendars/primary";

async function gcalFetch(token, timeMin, timeMax) {
  const params = new URLSearchParams({
    timeMin: timeMin || new Date(Date.now() - 30*24*60*60*1000).toISOString(),
    timeMax: timeMax || new Date(Date.now() + 60*24*60*60*1000).toISOString(),
    maxResults: 250,
    singleEvents: true,
    orderBy: "startTime",
  });
  const r = await fetch(`${GCAL_BASE}/events?${params}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (r.status === 401) throw new Error("TOKEN_EXPIRED");
  if (!r.ok) throw new Error(`gcal fetch ${r.status}`);
  const data = await r.json();
  return data.items || [];
}

async function gcalCreateEvent(token, { title, date, description="" }) {
  const body = {
    summary: title,
    description,
    start: { date }, // "YYYY-MM-DD" 형식
    end:   { date },
  };
  const r = await fetch(`${GCAL_BASE}/events`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (r.status === 401) throw new Error("TOKEN_EXPIRED");
  if (!r.ok) throw new Error(`gcal create ${r.status}`);
  return await r.json();
}

async function gcalUpdateEvent(token, eventId, patch) {
  const r = await fetch(`${GCAL_BASE}/events/${eventId}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (r.status === 401) throw new Error("TOKEN_EXPIRED");
  if (!r.ok) throw new Error(`gcal update ${r.status}`);
  return await r.json();
}

async function gcalDeleteEvent(token, eventId) {
  const r = await fetch(`${GCAL_BASE}/events/${eventId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (r.status === 401) throw new Error("TOKEN_EXPIRED");
  if (!r.ok && r.status !== 204) throw new Error(`gcal delete ${r.status}`);
}

const NOTICE_ID   = "__notice__";
const CALENDAR_ID = "__calendar__";
const TRASH_ID    = "__trash__";
const WORKLOG_ID  = "__worklog__";
const MANUAL_ID   = "__manual__";
const UPCOMING_ID = "__upcoming__";
const TRASH_DAYS = 30;

// ─── Drag-to-reorder: data-attr + container scan ──────────
// No per-item refs. Scans container children via data-sortidx attribute.
// Pure ref drag state — never causes extra renders during drag.
function makeDragState() {
  return {
    active: -1, insert: -1,
    startY: 0, ghostEl: null, ghostTop0: 0,
    containerEl: null, itemsSnapshot: [],
  };
}

function useSortable(containerRef, items, setItems) {
  const D = useRef(makeDragState());
  // Always have latest items without creating new handler functions
  const itemsRef = useRef(items);
  useEffect(() => { itemsRef.current = items; });

  const beginDrag = useCallback((e, index) => {
    e.preventDefault();
    e.stopPropagation();
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    const container = containerRef.current;
    if (!container) return;

    // Find the specific row by data-sortidx VALUE (not array position)
    // This handles cases where some rows are hidden/not rendered
    const rows = Array.from(container.querySelectorAll('[data-sortidx]'));
    const targetRow = rows.find(r => parseInt(r.getAttribute('data-sortidx')) === index);
    if (!targetRow) return;
    const rect = targetRow.getBoundingClientRect();
    // Build a visible-rows-only index map for drag positioning
    const visibleRows = rows; // all currently rendered rows

    // Ghost
    const ghost = targetRow.cloneNode(true);
    ghost.style.cssText = [
      'position:fixed', 'pointer-events:none', 'z-index:9999',
      'opacity:0.82', 'box-shadow:0 6px 24px rgba(15,32,68,.2)',
      'border-radius:10px', 'transform:scale(1.02)', 'transition:none',
      `left:${rect.left}px`, `top:${rect.top}px`, `width:${rect.width}px`,
    ].join(';');
    document.body.appendChild(ghost);

    D.current.active = index;
    D.current.insert = index;
    D.current.startY = clientY;
    D.current.ghostEl = ghost;
    D.current.ghostTop0 = rect.top;
    D.current.containerEl = container;

    // Dim the source row directly via DOM
    targetRow.style.opacity = '0.25';

    // Drop-line indicator
    let line = document.getElementById('__sortline__');
    if (!line) {
      line = document.createElement('div');
      line.id = '__sortline__';
      line.style.cssText = 'position:fixed;left:0;right:0;height:2px;background:#2563eb;z-index:9998;pointer-events:none;border-radius:2px;display:none;box-shadow:0 0 6px rgba(37,99,235,.5)';
      document.body.appendChild(line);
    }

    const onMove = (ev) => {
      const cy = ev.touches ? ev.touches[0].clientY : ev.clientY;
      const dy = cy - D.current.startY;
      if (D.current.ghostEl) {
        D.current.ghostEl.style.top = (D.current.ghostTop0 + dy) + 'px';
      }

      // Re-scan positions every move (handles scroll/reflow)
      const rs = Array.from(D.current.containerEl.querySelectorAll('[data-sortidx]'));
      let insertAt = rs.length;
      for (let i = 0; i < rs.length; i++) {
        const r = rs[i].getBoundingClientRect();
        if (cy < r.top + r.height * 0.5) { insertAt = i; break; }
      }
      D.current.insert = insertAt;

      // Show drop line
      const lineRef = document.getElementById('__sortline__');
      if (lineRef) {
        const target = rs[insertAt] || rs[rs.length - 1];
        if (target) {
          const tr = target.getBoundingClientRect();
          const lineY = insertAt < rs.length ? tr.top - 1 : tr.bottom + 1;
          lineRef.style.top = lineY + 'px';
          lineRef.style.left = (tr.left + 4) + 'px';
          lineRef.style.width = (tr.width - 8) + 'px';
          lineRef.style.display = 'block';
        }
      }
    };

    const onUp = () => {
      // Remove ghost & line
      if (D.current.ghostEl) {
        try { document.body.removeChild(D.current.ghostEl); } catch(_) {}
        D.current.ghostEl = null;
      }
      const lineRef = document.getElementById('__sortline__');
      if (lineRef) lineRef.style.display = 'none';

      // Restore source row opacity
      const rs = Array.from(D.current.containerEl?.querySelectorAll('[data-sortidx]') || []);
      const activeRow = rs.find(r => parseInt(r.getAttribute('data-sortidx')) === D.current.active);
      if (activeRow) activeRow.style.opacity = '';

      const from = D.current.active;
      // D.current.insert is a visible-row array index — convert to data-sortidx value
      const insertRow = rs[D.current.insert];
      const insertSortIdx = insertRow ? parseInt(insertRow.getAttribute('data-sortidx')) : -1;

      if (from !== -1 && insertSortIdx !== -1 && from !== insertSortIdx) {
        const arr = [...itemsRef.current];
        const fromPos = arr.findIndex((_, i) => i === from);
        const toPos   = arr.findIndex((_, i) => i === insertSortIdx);
        if (fromPos !== -1 && toPos !== -1) {
          const [moved] = arr.splice(fromPos, 1);
          const adjustedTo = fromPos < toPos ? toPos - 1 : toPos;
          arr.splice(adjustedTo, 0, moved);
          setItems(arr);
        }
      }

      D.current = makeDragState();

      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup',   onUp);
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('touchend',  onUp);
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup',   onUp);
    document.addEventListener('touchmove', onMove, { passive: false });
    document.addEventListener('touchend',  onUp);
  }, [setItems, containerRef]);

  return { beginDrag };
}
const mkDate = () => {
  const d = new Date();
  return `${d.getFullYear()}.${String(d.getMonth()+1).padStart(2,"0")}.${String(d.getDate()).padStart(2,"0")}`;
};
const mkTs = () => Date.now();
const daysAgo = ts => Math.floor((Date.now() - ts) / 86400000);

// nextId: start above the max existing ID to prevent collisions after reload
function getNextId() {
  try {
    const all = [
      ...JSON.parse(localStorage.getItem("notes_sidebar") || "[]"),
      ...JSON.parse(localStorage.getItem("notes_items") || "[]"),
      ...JSON.parse(localStorage.getItem("notes_worklogs") || "[]"),
    ];
    const nums = all
      .map(i => parseInt((i.id || "").replace(/[^0-9]/g, ""), 10))
      .filter(n => !isNaN(n));
    return nums.length > 0 ? Math.max(...nums) + 1 : 400;
  } catch { return 400; }
}
let nextId = getNextId();

const initSidebar = [
  // ── PROJECT ──
  { id:"sh1", type:"sheader", label:"PROJECT" },
  { id:"f1",  type:"folder",  name:"Work" },
  { id:"f2",  type:"folder",  name:"Personal" },
  { id:"f3",  type:"folder",  name:"Side Project" },
  { id:"f4",  type:"folder",  name:"Client" },
  // ── AREA ──
  { id:"sh2", type:"sheader", label:"AREA" },
  { id:"f5",  type:"folder",  name:"Health" },
  { id:"f6",  type:"folder",  name:"Finance" },
  { id:"f7",  type:"folder",  name:"Learning" },
  { id:"f8",  type:"folder",  name:"Relationships" },
  // ── RESOURCE ──
  { id:"sh3", type:"sheader", label:"RESOURCE" },
  { id:"f9",  type:"folder",  name:"References" },
  { id:"f10", type:"folder",  name:"Templates" },
  { id:"f11", type:"folder",  name:"Ideas" },
  { id:"f12", type:"folder",  name:"Reading List" },
  // ── ARCHIVE ──
  { id:"sh4", type:"sheader", label:"ARCHIVE" },
  { id:"f13", type:"folder",  name:"2025" },
  { id:"f14", type:"folder",  name:"2024" },
  { id:"f15", type:"folder",  name:"Completed" },
  { id:"f16", type:"folder",  name:"Inactive" },
];

const initItems = [
  { id:"i1", type:T.HEADER, title:"Getting Started", folder:"f1", starred:false, createdAt:"2026.03.21" },
  { id:"i2", type:T.TODO, title:"Explore folders and headers", folder:"f1", done:false, starred:false, createdAt:"2026.03.21" },
  { id:"i3", type:T.TODO, title:"Add your first note", folder:"f1", done:false, starred:false, createdAt:"2026.03.21" },
  { id:"i4", type:T.TEXT, title:"Welcome to the NOTES", folder:"f1", starred:true, createdAt:"2026.03.21",
    body:"Organize your work with folders, headers, to-dos, and rich text. Sign in with Google to sync everything to your Drive.",
    hiddenSections:[], links:[] },
];

const initWorklogs = [
  { id:"wl1", date:"2026.03.19", project:"Q2 Product Launch", keyPoint:"Landing page review", details:"Reviewed three copy variants with the marketing team. Variant B had the highest clarity score.", notes:"Final decision by EOD Friday", createdAt:mkTs() },
  { id:"wl2", date:"2026.03.19", project:"Team Operations", keyPoint:"Weekly sync", details:"Discussed sprint velocity drop. Root cause: unclear acceptance criteria. Action: update definition of done.", notes:"", createdAt:mkTs() },
  { id:"wl3", date:"2026.03.18", project:"Q2 Product Launch", keyPoint:"Competitor analysis", details:"Mapped pricing tiers of three key competitors. Identified a gap in the mid-market segment.", notes:"Share with leadership", createdAt:mkTs() },
  { id:"wl4", date:"2026.02.25", project:"Learning & Development", keyPoint:"Framework study session", details:"Went through MECE and First Principles with case examples. Applied to current product positioning problem.", notes:"", createdAt:mkTs() },
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

// ─── RichText ─────────────────────────────────────────────
function RichText({ html, onChange, placeholder, style }) {
  const ref = useRef(null);
  const containerRef = useRef(null);
  const composingRef = useRef(false); // 한국어/한자 조합 입력 중 플래그
  const { tb, checkSel, exec: execBase, tbRef, hide } = useFloatingToolbar(containerRef);

  // html prop이 바뀔 때마다 DOM 업데이트 (Drive 동기화 등)
  // 포커스 중이거나 조합 중이면 절대 건드리지 않음
  useEffect(() => {
    if (!ref.current) return;
    if (composingRef.current) return; // 한국어 조합 중 보호
    if (ref.current.contains(document.activeElement)) return; // 타이핑 중 보호
    const current = ref.current.innerHTML;
    const next = html || "";
    if (current !== next) {
      ref.current.innerHTML = next;
    }
  }, [html]);

  const exec = (cmd, val) => {
    execBase(cmd, val);
    onChange?.(ref.current?.innerHTML || "");
  };

  return (
    <div ref={containerRef} style={{ position:"relative" }} data-rc="1">
      <FloatingToolbar tb={tb} exec={exec} tbRef={tbRef} />
      <div
        ref={ref}
        contentEditable
        suppressContentEditableWarning
        onCompositionStart={() => { composingRef.current = true; }}
        onCompositionEnd={e => {
          composingRef.current = false;
          onChange?.(ref.current.innerHTML);
        }}
        onInput={() => { if (!composingRef.current) onChange?.(ref.current.innerHTML); }}
        onMouseUp={checkSel}
        onKeyUp={checkSel}
        onBlur={hide}
        data-placeholder={placeholder}
        style={{ outline:"none", minHeight:36, lineHeight:1.75, wordBreak:"break-word", color:"#1e3a6e", ...style }}
      />
      <style>{`[data-rc] [contenteditable]:empty:before { content: attr(data-placeholder); color:#b0c8e0; pointer-events:none; }`}</style>
    </div>
  );
}
const rtBtn = { background:"none", border:"none", color:"#e2eaf8", fontSize:13, fontWeight:700, cursor:"pointer", padding:"3px 5px", borderRadius:5, fontFamily:"inherit", minWidth:22 };
const rtDiv = { width:1, height:16, background:"rgba(255,255,255,.15)", margin:"0 3px", flexShrink:0 };
// ─── Shared FloatingToolbar ───────────────────────────────
// Renders a floating formatting bar at given {x, y} relative to a container.
// Call useFloatingToolbar(containerRef) to get { tb, checkSel, exec, tbRef }.
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

  const exec = useCallback((cmd, val) => {
    document.execCommand(cmd, false, val || null);
    setTb(null);
  }, []);

  const hide = useCallback(() => {
    setTimeout(() => {
      if (!tbRef.current?.contains(document.activeElement)) setTb(null);
    }, 150);
  }, []);

  return { tb, checkSel, exec, tbRef, hide };
}

function FloatingToolbar({ tb, exec, tbRef }) {
  if (!tb) return null;
  return (
    <div
      ref={tbRef}
      style={{ position:"absolute", left:tb.x, top:tb.y, transform:"translate(-50%,-100%)", zIndex:500, filter:"drop-shadow(0 4px 16px rgba(15,32,68,.25))" }}
      onMouseDown={e => e.preventDefault()}>
      <div style={{ display:"flex", alignItems:"center", gap:2, background:"#1a2d54", borderRadius:10, padding:"6px 8px" }}>
        <button onMouseDown={e=>{e.preventDefault();exec("bold");}} style={rtBtn}><b>B</b></button>
        <button onMouseDown={e=>{e.preventDefault();exec("italic");}} style={rtBtn}><i>I</i></button>
        <button onMouseDown={e=>{e.preventDefault();exec("underline");}} style={rtBtn}><u>U</u></button>
        <button onMouseDown={e=>{e.preventDefault();exec("strikeThrough");}} style={rtBtn}><s>S</s></button>
        <div style={rtDiv}/>
        {["#1e3a6e","#e53e3e","#2563eb","#059669","#d97706"].map(c=>(
          <div key={c} style={{width:13,height:13,borderRadius:"50%",background:c,cursor:"pointer"}}
            onMouseDown={e=>{e.preventDefault();exec("foreColor",c);}}/>
        ))}
        <div style={rtDiv}/>
        {[["#fef08a","Yellow"],["#bbf7d0","Green"],["#bfdbfe","Blue"],["transparent","Clear"]].map(([c,t])=>(
          <div key={c} title={t} style={{width:13,height:13,borderRadius:3,background:c==="transparent"?"#fff":c,border:c==="transparent"?"2px dashed #94a3b8":"2px solid rgba(0,0,0,.07)",cursor:"pointer"}}
            onMouseDown={e=>{e.preventDefault();exec("hiliteColor",c);}}/>
        ))}
        <div style={rtDiv}/>
        <button onMouseDown={e=>{e.preventDefault();exec("removeFormat");}} style={{...rtBtn,color:"#fca5a5",fontSize:11}}>✕</button>
      </div>
      <div style={{width:0,height:0,borderLeft:"6px solid transparent",borderRight:"6px solid transparent",borderTop:"7px solid #1a2d54",margin:"0 auto"}}/>
    </div>
  );
}

// ─── TodoDatePicker ─ 인라인 달력 (To-do 마감기한용) ──────
function TodoDatePicker({ value, onChange, onClear }) {
  const parse = d => d ? { y:parseInt(d.split(".")[0]), m:parseInt(d.split(".")[1])-1 } : { y:new Date().getFullYear(), m:new Date().getMonth() };
  const [cur, setCur] = useState(() => parse(value));
  const dim = (y,m) => new Date(y,m+1,0).getDate();
  const fd  = (y,m) => new Date(y,m,1).getDay();
  const pad = n => String(n).padStart(2,"0");
  const cells = [...Array(fd(cur.y,cur.m)).fill(null), ...Array(dim(cur.y,cur.m)).fill(0).map((_,i)=>i+1)];
  const isSel = d => value === `${cur.y}.${pad(cur.m+1)}.${pad(d)}`;
  const today = new Date();
  const isToday = d => today.getFullYear()===cur.y && today.getMonth()===cur.m && today.getDate()===d;
  const PB = { background:"none", border:"none", fontSize:16, cursor:"pointer", color:"#6b8bb5", padding:"2px 6px", borderRadius:6, fontFamily:"inherit" };
  return (
    <div style={{ background:"#f8faff", borderRadius:10, padding:"10px 10px 8px", border:"1px solid #e0eaf8" }}>
      {/* 선택된 날짜 & 삭제 */}
      {value && (
        <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:6 }}>
          <span style={{ fontSize:12, fontWeight:700, color:"#ef4444" }}>📅 {value}</span>
          <span style={{ fontSize:13, color:"#fca5a5", cursor:"pointer", fontWeight:700 }} onClick={onClear} title="삭제">×</span>
        </div>
      )}
      {/* 월 네비 */}
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:6 }}>
        <button onClick={e=>{e.preventDefault();setCur(p=>p.m===0?{y:p.y-1,m:11}:{...p,m:p.m-1});}} style={PB}>‹</button>
        <span style={{ fontSize:12, fontWeight:700, color:"#1e3a6e" }}>{cur.y} / {cur.m+1}</span>
        <button onClick={e=>{e.preventDefault();setCur(p=>p.m===11?{y:p.y+1,m:0}:{...p,m:p.m+1});}} style={PB}>›</button>
      </div>
      {/* 요일 헤더 */}
      <div style={{ display:"grid", gridTemplateColumns:"repeat(7,1fr)", gap:1, marginBottom:2 }}>
        {["S","M","T","W","T","F","S"].map((d,i) => (
          <div key={i} style={{ textAlign:"center", fontSize:10, color: i===0?"#ef4444":i===6?"#6b8bb5":"#94a3b8", fontWeight:600 }}>{d}</div>
        ))}
      </div>
      {/* 날짜 그리드 */}
      <div style={{ display:"grid", gridTemplateColumns:"repeat(7,1fr)", gap:1 }}>
        {cells.map((d,i) => (
          <div key={i}
            onClick={() => d && onChange(`${cur.y}.${pad(cur.m+1)}.${pad(d)}`)}
            style={{ textAlign:"center", fontSize:11.5, padding:"4px 0", borderRadius:5,
              cursor:d?"pointer":"default",
              background: isSel(d)?"#2563eb": isToday(d)?"#eff6ff":"transparent",
              color: isSel(d)?"#fff": isToday(d)?"#2563eb": d?(i%7===0?"#ef4444":"#1e3a6e"):"transparent",
              fontWeight: isSel(d)||isToday(d)?700:400 }}>
            {d||""}
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── DatePicker ───────────────────────────────────────────
function DatePicker({ value, onChange, onClose }) {
  const parse = d => d ? { y:parseInt(d.split(".")[0]), m:parseInt(d.split(".")[1])-1 } : { y:new Date().getFullYear(), m:new Date().getMonth() };
  const [cur, setCur] = useState(() => parse(value));
  const dim = (y,m) => new Date(y,m+1,0).getDate();
  const fd  = (y,m) => new Date(y,m,1).getDay();
  const pad = n => String(n).padStart(2,"0");
  const cells = [...Array(fd(cur.y,cur.m)).fill(null), ...Array(dim(cur.y,cur.m)).fill(0).map((_,i)=>i+1)];
  const isSel = d => value === `${cur.y}.${pad(cur.m+1)}.${pad(d)}`;
  const PB = { background:"none", border:"none", fontSize:18, cursor:"pointer", color:"#6b8bb5", padding:"2px 8px", borderRadius:6, fontFamily:"inherit" };
  return (
    <div style={{ position:"absolute", zIndex:600, background:"#fff", borderRadius:14, boxShadow:"0 8px 32px rgba(15,32,68,.18)", padding:16, width:240, top:"100%", left:0, marginTop:4, border:"1px solid #e0eaf8" }}>
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:12 }}>
        <button onClick={() => setCur(p => p.m===0 ? {y:p.y-1,m:11} : {...p,m:p.m-1})} style={PB}>‹</button>
        <span style={{ fontSize:13.5, fontWeight:700, color:"#1e3a6e" }}>{cur.y} / {cur.m+1}</span>
        <button onClick={() => setCur(p => p.m===11 ? {y:p.y+1,m:0} : {...p,m:p.m+1})} style={PB}>›</button>
      </div>
      <div style={{ display:"grid", gridTemplateColumns:"repeat(7,1fr)", gap:2 }}>
        {["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].map(d => (
          <div key={d} style={{ textAlign:"center", fontSize:10, color:"#94a3b8", fontWeight:600, padding:"2px 0" }}>{d}</div>
        ))}
        {cells.map((d, i) => (
          <div key={i}
            onClick={() => d && onChange(`${cur.y}.${pad(cur.m+1)}.${pad(d)}`) && onClose()}
            style={{ textAlign:"center", fontSize:12, padding:"5px 0", borderRadius:6, cursor:d?"pointer":"default",
              background:isSel(d)?"#2563eb":"transparent", color:isSel(d)?"#fff":d?"#1e3a6e":"transparent", fontWeight:isSel(d)?700:400 }}>
            {d || ""}
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── MonthPicker ──────────────────────────────────────────
function MonthPicker({ value, onChange, onClose, label }) {
  const initY = value ? parseInt(value.split(".")[0]) : new Date().getFullYear();
  const [y, setY] = useState(initY);
  const MN = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const PB = { background:"none", border:"none", fontSize:18, cursor:"pointer", color:"#6b8bb5", padding:"2px 8px", borderRadius:6, fontFamily:"inherit" };
  return (
    <div style={{ position:"absolute", zIndex:700, background:"#fff", borderRadius:14, boxShadow:"0 8px 32px rgba(15,32,68,.2)", padding:16, width:210, top:"100%", right:0, marginTop:4, border:"1px solid #e0eaf8" }}>
      {label && <div style={{ fontSize:11, fontWeight:700, color:"#2563eb", letterSpacing:"1px", marginBottom:10 }}>{label}</div>}
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:10 }}>
        <button onClick={() => setY(y-1)} style={PB}>‹</button>
        <span style={{ fontSize:13.5, fontWeight:700, color:"#1e3a6e" }}>{y}</span>
        <button onClick={() => setY(y+1)} style={PB}>›</button>
      </div>
      <div style={{ display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:4 }}>
        {MN.map((m, i) => {
          const key = `${y}.${String(i+1).padStart(2,"0")}`;
          const sel = value === key;
          return (
            <div key={i} onClick={() => { onChange(key); onClose(); }}
              style={{ textAlign:"center", padding:"7px 2px", borderRadius:7, cursor:"pointer", fontSize:12,
                fontWeight:sel?700:400, background:sel?"#2563eb":"#f5f8ff", color:sel?"#fff":"#1e3a6e" }}>
              {m}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── WorklogView ──────────────────────────────────────────
// ─── WorklogChart: 주간/월간 프로젝트별 요약 ────────────
function WorklogChart({ worklogs, folders }) {
  const [period, setPeriod] = useState("month"); // "week" | "month" | "3month"
  const now = new Date();

  const getCutoff = () => {
    const d = new Date();
    if (period==="week")   { d.setDate(d.getDate()-7); }
    if (period==="month")  { d.setMonth(d.getMonth()-1); }
    if (period==="3month") { d.setMonth(d.getMonth()-3); }
    return `${d.getFullYear()}.${String(d.getMonth()+1).padStart(2,"0")}.${String(d.getDate()).padStart(2,"0")}`;
  };

  const cutoff = getCutoff();
  const filtered = worklogs.filter(w => (w.date||"") >= cutoff);

  // 프로젝트별 항목 수 집계
  const byProject = {};
  filtered.forEach(w => {
    const k = w.project || "(미지정)";
    byProject[k] = (byProject[k]||0) + 1;
  });
  const sorted = Object.entries(byProject).sort((a,b)=>b[1]-a[1]);
  const maxVal = sorted[0]?.[1] || 1;

  // 날짜별 일지 수 (최근 14일)
  const byDate = {};
  const today = `${now.getFullYear()}.${String(now.getMonth()+1).padStart(2,"0")}.${String(now.getDate()).padStart(2,"0")}`;
  for (let i=13;i>=0;i--) {
    const d = new Date(); d.setDate(d.getDate()-i);
    const k = `${d.getFullYear()}.${String(d.getMonth()+1).padStart(2,"0")}.${String(d.getDate()).padStart(2,"0")}`;
    byDate[k] = 0;
  }
  worklogs.forEach(w => { if (byDate[w.date]!==undefined) byDate[w.date]++; });
  const dateEntries = Object.entries(byDate);
  const maxDate = Math.max(...dateEntries.map(([,v])=>v), 1);

  const COLORS = ["#2563eb","#059669","#f59e0b","#ef4444","#8b5cf6","#06b6d4","#ec4899","#84cc16","#f97316","#94a3b8"];

  return (
    <div style={{background:"#fff",borderRadius:12,border:"1px solid #e0eaf8",padding:"16px 20px",marginBottom:12,flexShrink:0}}>
      <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:14}}>
        <span style={{fontSize:13,fontWeight:700,color:"#1e3a6e"}}>📊 업무 요약</span>
        <div style={{flex:1}}/>
        {[["week","1주"],["month","1개월"],["3month","3개월"]].map(([v,l])=>(
          <button key={v} style={{...tbBtn,
            background:period===v?"#eff6ff":"#f5f8ff",
            color:period===v?"#2563eb":"#4b6fa8",
            borderColor:period===v?"#bfdbfe":"#dce8fb",
            fontSize:11}}
            onClick={()=>setPeriod(v)}>{l}</button>
        ))}
        <span style={{fontSize:11,color:"#94a3b8"}}>{filtered.length}개 항목</span>
      </div>

      <div style={{display:"flex",gap:20,flexWrap:"wrap"}}>
        {/* 프로젝트별 막대 */}
        <div style={{flex:"1 1 240px",minWidth:200}}>
          <div style={{fontSize:11,fontWeight:700,color:"#94a3b8",textTransform:"uppercase",letterSpacing:"1px",marginBottom:8}}>프로젝트별</div>
          {sorted.length===0
            ? <div style={{fontSize:12,color:"#b0c4de",padding:"8px 0"}}>해당 기간 데이터 없음</div>
            : sorted.map(([proj,cnt],i)=>(
              <div key={proj} style={{marginBottom:6}}>
                <div style={{display:"flex",justifyContent:"space-between",marginBottom:2}}>
                  <span style={{fontSize:11.5,color:"#1e3a6e",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",maxWidth:"70%"}}>{proj}</span>
                  <span style={{fontSize:11,color:"#6b8bb5",fontWeight:600,flexShrink:0}}>{cnt}회</span>
                </div>
                <div style={{height:8,background:"#f0f4fa",borderRadius:4,overflow:"hidden"}}>
                  <div style={{height:"100%",width:`${(cnt/maxVal)*100}%`,background:COLORS[i%COLORS.length],borderRadius:4,transition:"width .3s"}}/>
                </div>
              </div>
          ))}
        </div>

        {/* 최근 14일 활동 히트맵 */}
        <div style={{flex:"1 1 280px",minWidth:240}}>
          <div style={{fontSize:11,fontWeight:700,color:"#94a3b8",textTransform:"uppercase",letterSpacing:"1px",marginBottom:8}}>최근 14일 활동</div>
          <div style={{display:"flex",gap:3,alignItems:"flex-end"}}>
            {dateEntries.map(([date,cnt])=>{
              const isToday = date===today;
              const h = Math.max(8, (cnt/maxDate)*60);
              return (
                <div key={date} style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",gap:2}}>
                  <div title={`${date}: ${cnt}개`}
                    style={{width:"100%",height:h,borderRadius:3,
                      background:cnt===0?"#f0f4fa":COLORS[0],
                      opacity:cnt===0?1:0.3+0.7*(cnt/maxDate),
                      border:isToday?"2px solid #f59e0b":"none",
                      transition:"height .2s",cursor:cnt>0?"pointer":"default"}}/>
                  <span style={{fontSize:8,color:"#94a3b8",transform:"rotate(-45deg)",transformOrigin:"top left",whiteSpace:"nowrap",marginLeft:4}}>
                    {date.slice(5)}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

function WorklogView({ worklogs, setWorklogs, folders, isMobile }) {
  const [showChart, setShowChart] = useState(false);
  const now = new Date();
  const todayYM = `${now.getFullYear()}.${String(now.getMonth()+1).padStart(2,"0")}`;
  const [search,        setSearch]        = useState("");
  const [navYM,         setNavYM]         = useState(null);
  const [showNav,       setShowNav]       = useState(false);
  const [showDl,        setShowDl]        = useState(false);
  // Close popups on window click
  useEffect(() => {
    const close = () => { setShowNav(false); setShowFilter(false); };
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, []);
  const [selected,      setSelected]      = useState(new Set());
  // Multi-select folder filter: empty Set = show all
  const [filterFolders, setFilterFolders] = useState(new Set());
  const [showFilter,    setShowFilter]    = useState(false);
  const listRef = useRef(null);
  const folderNames = folders.map(f => f.name);

  const allSelected = filterFolders.size === 0;
  const toggleFilterFolder = name => {
    setFilterFolders(prev => {
      const n = new Set(prev);
      n.has(name) ? n.delete(name) : n.add(name);
      return n;
    });
  };
  const filterLabel = allSelected
    ? "All"
    : filterFolders.size === 1
      ? [...filterFolders][0]
      : `${filterFolders.size} selected`;

  const q = search.trim().toLowerCase();
  const filtered = worklogs.filter(w => {
    const matchSearch = !q || [w.date,w.project,w.keyPoint,w.details,w.notes].join(" ").toLowerCase().includes(q);
    const matchFolder = allSelected || filterFolders.has(w.project);
    return matchSearch && matchFolder;
  });

  const grouped = {};
  filtered.forEach(w => {
    const ym = w.date?.slice(0,7) || "?";
    if (!grouped[ym]) grouped[ym] = [];
    grouped[ym].push(w);
  });
  const sortedYMs = Object.keys(grouped).sort((a,b) => b.localeCompare(a));

  const addEntry = date => {
    const id = `wl${nextId++}`;
    const defaultProject = filterFolders.size===1 ? [...filterFolders][0] : "";
    setWorklogs(prev => [{ id, date:date||mkDate(), project:defaultProject, keyPoint:"", details:"", notes:"", createdAt:mkTs() }, ...prev]);
  };
  const updEntry = (id, patch) => setWorklogs(prev => prev.map(w => w.id===id ? {...w,...patch} : w));
  const delEntry = id => setWorklogs(prev => prev.filter(w => w.id!==id));
  const delSel   = () => { setWorklogs(prev => prev.filter(w => !selected.has(w.id))); setSelected(new Set()); };
  const toggleSel = id => setSelected(prev => { const n=new Set(prev); n.has(id)?n.delete(id):n.add(id); return n; });
  const navigateTo = ym => {
    setNavYM(ym); setShowNav(false);
    setTimeout(() => { listRef.current?.querySelector(`[data-ym="${ym}"]`)?.scrollIntoView({behavior:"smooth",block:"start"}); }, 100);
  };

  // colGrid: cb | date | folder | keyPoint | details | notes | actions
  const colGrid = isMobile
    ? null  // 모바일은 커스텀 flex 레이아웃 사용
    : "20px 95px 115px 1fr 0.9fr 1.6fr 28px";

  return (
    <div style={{display:"flex",flexDirection:"column",height:"100%"}} onClick={()=>{ setShowFilter(false); setShowNav(false); }}>

      {/* ── Worklog 설명 배너 ── */}
      <div style={{background:"linear-gradient(90deg,#eff6ff,#f5f3ff)",border:"1px solid #dbeafe",borderRadius:10,padding:"8px 14px",marginBottom:10,display:"flex",alignItems:"center",gap:8}}>
        <span style={{fontSize:16,flexShrink:0}}>📋</span>
        <span style={{fontSize:12,color:"#3b4e8c",lineHeight:1.6}}>
          <b>Worklog</b>는 업무일지 전용 공간입니다. 폴더 노트와 별도로 날짜·프로젝트·핵심 내용을 기록하고, Excel로 내보내거나 불러올 수 있습니다.
        </span>
      </div>

      {/* ── Top controls ── */}
      <div style={{display:"flex",alignItems:"center",gap:6,flexWrap:"wrap",paddingBottom:10,borderBottom:"1px solid #eef3ff",marginBottom:8}}>
        <div style={{flex:1,minWidth:120,position:"relative"}}>
          <span style={{position:"absolute",left:9,top:"50%",transform:"translateY(-50%)",color:"#a0b4cc",fontSize:13}}>🔍</span>
          <input style={{width:"100%",padding:"7px 10px 7px 28px",borderRadius:9,border:"1.5px solid #e0eaf8",fontSize:12.5,color:"#1e3a6e",outline:"none",fontFamily:"inherit",background:"#fff",boxSizing:"border-box"}}
            placeholder="Search..." value={search} onChange={e=>setSearch(e.target.value)} />
        </div>

        {/* Folder filter button */}
        <div style={{position:"relative"}} onClick={e=>e.stopPropagation()}>
          <button style={{...wBtn, ...(allSelected?{}:{background:"#eef3ff",color:"#2563eb",borderColor:"#bfdbfe"})}}
            onClick={e=>{e.stopPropagation();setShowFilter(v=>!v);}}>
            ⊞ {filterLabel}
          </button>
          {showFilter && (
            <div style={{position:"absolute",top:"100%",left:0,marginTop:4,background:"#fff",borderRadius:12,boxShadow:"0 6px 24px rgba(15,32,68,.16)",border:"1px solid #e0eaf8",zIndex:400,minWidth:170,overflow:"hidden"}} onClick={e=>e.stopPropagation()}>
              <div style={{padding:"6px 12px 4px",fontSize:10,fontWeight:700,color:"#94a3b8",letterSpacing:"1px",textTransform:"uppercase"}}>Folder Filter</div>
              <div style={{display:"flex",alignItems:"center",gap:8,padding:"9px 14px",cursor:"pointer",borderBottom:"1px solid #f0f4fa",background:allSelected?"#eff6ff":"transparent"}}
                onClick={()=>setFilterFolders(new Set())}>
                <div style={{width:15,height:15,borderRadius:4,border:"1.5px solid",borderColor:allSelected?"#2563eb":"#c2d0e8",background:allSelected?"#2563eb":"transparent",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
                  {allSelected && <span style={{color:"#fff",fontSize:10,fontWeight:700}}>✓</span>}
                </div>
                <span style={{fontSize:13,fontWeight:600,color:allSelected?"#2563eb":"#1e3a6e"}}>All</span>
              </div>
              {folderNames.map(name => {
                const on = filterFolders.has(name);
                return (
                  <div key={name} style={{display:"flex",alignItems:"center",gap:8,padding:"9px 14px",cursor:"pointer",background:on?"#eff6ff":"transparent"}}
                    onClick={()=>toggleFilterFolder(name)}>
                    <div style={{width:15,height:15,borderRadius:4,border:"1.5px solid",borderColor:on?"#2563eb":"#c2d0e8",background:on?"#2563eb":"transparent",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
                      {on && <span style={{color:"#fff",fontSize:10,fontWeight:700}}>✓</span>}
                    </div>
                    <span style={{fontSize:13,fontWeight:500,color:on?"#2563eb":"#1e3a6e"}}>{name}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div style={{position:"relative"}} onClick={e=>e.stopPropagation()}>
          <button style={wBtn} onClick={e=>{e.stopPropagation();setShowNav(v=>!v);}}>📅 {navYM||todayYM}</button>
          {showNav && <div onClick={e=>e.stopPropagation()}><MonthPicker value={navYM||todayYM} onChange={navigateTo} onClose={()=>setShowNav(false)} label="Go to month"/></div>}
        </div>
        <button style={{...wBtn,background:"#2563eb",color:"#fff",border:"none",boxShadow:"0 2px 8px rgba(37,99,235,.3)"}} onClick={()=>setShowDl(true)}>↓ Excel</button>
        {/* Worklog Excel Import */}
        <label style={{...wBtn,cursor:"pointer",color:"#059669",borderColor:"#6ee7b7",background:"#f0fdf4"}} title="Excel 파일로 Worklog 가져오기">
          ↑ Import
          <input type="file" accept=".xlsx,.xls" style={{display:"none"}} onChange={e=>{
            const file = e.target.files?.[0];
            if (!file) return;
            e.target.value = "";
            const reader = new FileReader();
            reader.onload = ev => {
              try {
                const wb = XLSX.read(ev.target.result, {type:"array"});
                const ws = wb.Sheets[wb.SheetNames[0]];
                const rows = XLSX.utils.sheet_to_json(ws, {defval:""});
                const newEntries = rows.map(r => ({
                  id: `wl${Date.now()}_${Math.random().toString(36).slice(2,7)}`,
                  date:     String(r["Date"]     || r["date"]     || "").trim(),
                  project:  String(r["Project"]  || r["project"]  || r["Folder"] || r["folder"] || "").trim(),
                  keyPoint: String(r["Key Point"] || r["keyPoint"] || r["key_point"] || "").trim(),
                  details:  String(r["Details"]  || r["details"]  || "").trim(),
                  notes:    String(r["Notes"]    || r["notes"]    || "").trim(),
                  createdAt: Date.now(),
                })).filter(r => r.date || r.keyPoint || r.details);
                if (!newEntries.length) { alert("가져올 데이터가 없습니다.\n열 이름: Date, Project, Key Point, Details, Notes"); return; }
                setWorklogs(prev => [...prev, ...newEntries]);
                alert(`${newEntries.length}개 항목을 가져왔습니다.`);
              } catch(err) {
                alert("파일을 읽을 수 없습니다: " + err.message);
              }
            };
            reader.readAsArrayBuffer(file);
          }}/>
        </label>
        {selected.size>0 && <button style={{...wBtn,color:"#e53e3e",borderColor:"#fecaca"}} onClick={delSel}>Delete ({selected.size})</button>}
        <button style={{...wBtn,color:"#2563eb",borderColor:"#bfdbfe",fontWeight:700}} onClick={()=>addEntry(mkDate())}>＋ Add</button>
        <button style={{...wBtn, background:showChart?"#eff6ff":"#f5f8ff", color:showChart?"#2563eb":"#4b6fa8", borderColor:showChart?"#bfdbfe":"#dce8fb"}}
          onClick={()=>setShowChart(v=>!v)}>📊 Chart</button>
      </div>

      {/* ── Chart View ── */}
      {showChart && <WorklogChart worklogs={worklogs} folders={folders} />}
      <div ref={listRef} style={{flex:1,overflowY:"auto",paddingBottom:40}}>
        {sortedYMs.length===0 && (
          <div style={{display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:"60px 0",color:"#b0c4de"}}>
            <div style={{fontSize:32,marginBottom:10}}>📋</div>
            <div style={{fontSize:13}}>{search||!allSelected?"No results":"Start writing your worklog."}</div>
          </div>
        )}
        {sortedYMs.map(ym => {
          const [yy,mm] = ym.split(".");
          const dayG = {};
          grouped[ym].forEach(w=>{ dayG[w.date]=(dayG[w.date]||[]).concat(w); });
          const sortedDays = Object.keys(dayG).sort((a,b)=>b.localeCompare(a));
          return (
            <div key={ym} data-ym={ym} style={{marginBottom:28}}>
              <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:8,marginTop:4}}>
                <div style={{fontSize:13,fontWeight:700,color:"#1e3a6e",background:"#eef3ff",borderRadius:20,padding:"4px 14px",flexShrink:0}}>{yy} / {parseInt(mm)}</div>
                <div style={{flex:1,height:1,background:"rgba(37,99,235,.1)"}}/>
                <span style={{fontSize:11,color:"#94a3b8",flexShrink:0}}>{grouped[ym].length}</span>
              </div>
              {/* Column headers — PC only */}
              {!isMobile && (
                <div style={{display:"grid",gridTemplateColumns:colGrid,gap:4,padding:"2px 8px",fontSize:10,fontWeight:700,color:"#94a3b8",textTransform:"uppercase",marginBottom:2}}>
                  <div/><div>Date</div><div>Folder</div><div>Key Point</div>
                  <div>Details</div><div>Notes</div>
                  <div/>
                </div>
              )}
              {sortedDays.map(date=>(
                <div key={date}>
                  {dayG[date].map((w,wi)=>(
                    <WRow key={w.id} entry={w} wi={wi} isMobile={isMobile} colGrid={colGrid}
                      folders={folders} isSel={selected.has(w.id)}
                      onToggleSel={()=>toggleSel(w.id)}
                      onUpdate={p=>updEntry(w.id,p)}
                      onDelete={()=>delEntry(w.id)}
                      onAddBelow={()=>addEntry(date)}/>
                  ))}
                </div>
              ))}
            </div>
          );
        })}
      </div>
      {showDl && <DownloadModal worklogs={worklogs} onClose={()=>setShowDl(false)}/>}
    </div>
  );
}

// ─── WRow ─────────────────────────────────────────────────
// ─── WRowTextarea: auto-resize textarea for Worklog cells ─
function WRowTextarea({ value, placeholder, onChange }) {
  const ref = useRef(null);
  // 매 렌더마다 높이 자동 조절 (선택 없이도 전체 내용 표시)
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 120) + "px";
  });
  return (
    <textarea
      ref={ref}
      rows={1}
      style={{ ...wCell, fontSize:13, resize:"none", overflowY:"hidden",
        lineHeight:1.5, padding:"2px 4px", boxSizing:"border-box",
        minHeight:28, maxHeight:120, display:"block" }}
      value={value}
      placeholder={placeholder}
      onChange={e => onChange(e.target.value)}
    />
  );
}

function WRow({ entry, wi, isMobile, colGrid, folders, isSel, onToggleSel, onUpdate, onDelete, onAddBelow }) {
  const [showDP,   setShowDP]   = useState(false);
  const [showFP,   setShowFP]   = useState(false);
  const [popupType, setPopupType] = useState(null); // 'D' | 'N' | null
  const [popupPos,  setPopupPos]  = useState({ top:0, left:0 });
  const dBtnRef = useRef(null);
  const nBtnRef = useRef(null);
  const selFolder = folders.find(f => f.name===entry.project);

  // D/N 팝업 열기
  const openPopup = (type, ref) => {
    if (!ref.current) return;
    const r = ref.current.getBoundingClientRect();
    setPopupPos({ top: r.bottom + 4, left: Math.max(8, r.right - 260) });
    setPopupType(v => v === type ? null : type);
  };

  // 외부 클릭 시 팝업 닫기
  useEffect(() => {
    if (!popupType) return;
    const close = e => {
      if (dBtnRef.current?.contains(e.target)) return;
      if (nBtnRef.current?.contains(e.target)) return;
      setPopupType(null);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("touchstart", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("touchstart", close);
    };
  }, [popupType]);

  const datePill = (
    <div style={{position:"relative"}}>
      {wi===0
        ? <div style={wDatePill} onClick={()=>setShowDP(v=>!v)}>{entry.date||"Date"}</div>
        : <div style={{...wDatePill,opacity:.2,pointerEvents:"none",fontSize:11}}>{entry.date}</div>
      }
      {showDP && <>
        <div style={{position:"fixed",inset:0,zIndex:399}} onClick={()=>setShowDP(false)} />
        <DatePicker value={entry.date} onChange={d=>{onUpdate({date:d});setShowDP(false);}} onClose={()=>setShowDP(false)}/>
      </>}
    </div>
  );

  const folderPill = (
    <div style={{position:"relative"}}>
      <div style={{...wDatePill,
        color: selFolder?"#1650b8":"#94a3b8",
        borderColor: selFolder?"#bfdbfe":"#e8eef8",
        background: selFolder?"#eff6ff":"#f8faff",
        overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",
        maxWidth: isMobile ? 100 : "100%"}}
        onClick={()=>setShowFP(v=>!v)}>
        {selFolder ? entry.project : "Folder"}
      </div>
      {showFP && (<>
        <div style={{position:"fixed",inset:0,zIndex:499}} onClick={()=>setShowFP(false)} />
        <div style={{position:"absolute",zIndex:500,background:"#fff",borderRadius:12,
          boxShadow:"0 6px 24px rgba(15,32,68,.16)",border:"1px solid #e0eaf8",
          top:"100%",left:0,marginTop:4,minWidth:150,overflow:"hidden"}}>
          <div style={{padding:"6px 12px 4px",fontSize:10,fontWeight:700,color:"#94a3b8",letterSpacing:"1px",textTransform:"uppercase"}}>Select folder</div>
          {entry.project && (
            <div style={{padding:"8px 14px",fontSize:12,color:"#e53e3e",cursor:"pointer",fontWeight:500,borderBottom:"1px solid #f0f4fa"}}
              onMouseDown={()=>{onUpdate({project:""});setShowFP(false);}}>× Clear</div>
          )}
          {folders.map(f=>(
            <div key={f.id}
              style={{display:"flex",alignItems:"center",gap:8,padding:"9px 14px",fontSize:13,cursor:"pointer",fontWeight:500,
                color:entry.project===f.name?"#2563eb":"#1e3a6e",
                background:entry.project===f.name?"#eff6ff":"transparent"}}
              onMouseDown={()=>{onUpdate({project:f.name});setShowFP(false);}}>
              {entry.project===f.name && <span style={{fontSize:11}}>✓ </span>}{f.name}
            </div>
          ))}
        </div>
      </>)}
    </div>
  );

  // D/N 팝업 (portal)
  const popup = popupType && createPortal(
    <div
      style={{ position:"fixed", top:popupPos.top, left:popupPos.left,
        background:"#fff", borderRadius:12, boxShadow:"0 8px 28px rgba(15,32,68,.18)",
        border:"1px solid #e0eaf8", zIndex:9999, width:260, overflow:"hidden",
        fontFamily:"'SF Pro Display',-apple-system,'Helvetica Neue',sans-serif" }}
      onMouseDown={e=>e.stopPropagation()}
      onTouchStart={e=>e.stopPropagation()}>
      <div style={{padding:"10px 14px 6px",fontSize:10,fontWeight:700,color:"#94a3b8",letterSpacing:"1px",textTransform:"uppercase",borderBottom:"1px solid #f0f4fa"}}>
        {popupType === 'D' ? 'Details' : 'Notes'}
      </div>
      <textarea
        style={{width:"100%",minHeight:100,maxHeight:200,border:"none",outline:"none",
          fontFamily:"inherit",fontSize:13,color:"#1e3a6e",lineHeight:1.6,
          padding:"10px 14px",resize:"vertical",boxSizing:"border-box",background:"transparent"}}
        placeholder={popupType === 'D' ? "Details..." : "Notes..."}
        value={popupType === 'D' ? (entry.details||"") : (entry.notes||"")}
        onChange={e => onUpdate(popupType==='D' ? {details:e.target.value} : {notes:e.target.value})}
        autoFocus
      />
    </div>,
    document.body
  );

  // ── 모바일 레이아웃 ──────────────────────────────────────
  if (isMobile) {
    const hasD = !!(entry.details && entry.details.trim());
    const hasN = !!(entry.notes && entry.notes.trim());
    return (
      <div style={{background:isSel?"#eff6ff":"#fff",borderRadius:10,padding:"8px 8px 6px",
        marginBottom:4, boxShadow:isSel?"0 0 0 1.5px #93c5fd":"0 1px 3px rgba(15,32,68,.05)"}}>
        {/* 윗줄: cb + date + folder + D/N/+/× 버튼 */}
        <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:4}}>
          <div style={{...wCB,...(isSel?wCBOn:{}),flexShrink:0}} onClick={onToggleSel}>{isSel&&"✓"}</div>
          {datePill}
          {folderPill}
          <div style={{flex:1}}/>
          {/* D 버튼 */}
          <button ref={dBtnRef}
            style={{...wRowBtn,
              background: hasD ? (popupType==='D'?"#2563eb":"#eff6ff") : "#f8faff",
              color: hasD ? (popupType==='D'?"#fff":"#2563eb") : "#c2d0e8",
              border: hasD?"1px solid #bfdbfe":"1px solid #e8eef8",
              fontWeight:700, fontSize:11}}
            onClick={()=>openPopup('D',dBtnRef)}
            title="Details">D</button>
          {/* N 버튼 */}
          <button ref={nBtnRef}
            style={{...wRowBtn,
              background: hasN ? (popupType==='N'?"#2563eb":"#eff6ff") : "#f8faff",
              color: hasN ? (popupType==='N'?"#fff":"#2563eb") : "#c2d0e8",
              border: hasN?"1px solid #bfdbfe":"1px solid #e8eef8",
              fontWeight:700, fontSize:11}}
            onClick={()=>openPopup('N',nBtnRef)}
            title="Notes">N</button>
          <button style={wRowBtn} onClick={onAddBelow} title="Add row">＋</button>
          <button style={{...wRowBtn,color:"#fca5a5"}} onClick={onDelete} title="Delete">×</button>
        </div>
        {/* 아랫줄: keypoint (자동 줄바꿈) */}
        <div style={{paddingLeft:26}}>
          <input style={{...wCell,fontSize:13,width:"100%"}}
            value={entry.keyPoint} placeholder="Key point..."
            onChange={e=>onUpdate({keyPoint:e.target.value})}/>
        </div>
        {popup}
      </div>
    );
  }

  // ── PC 레이아웃 ────────────────────────────────────────
  return (
    <div style={{display:"grid",gridTemplateColumns:colGrid,gap:4,alignItems:"center",
      background:isSel?"#eff6ff":"#fff",borderRadius:10,padding:"6px 8px",marginBottom:3,
      boxShadow:isSel?"0 0 0 1.5px #93c5fd":"0 1px 3px rgba(15,32,68,.05)"}}>
      <div style={{...wCB,...(isSel?wCBOn:{})}} onClick={onToggleSel}>{isSel&&"✓"}</div>
      {datePill}
      {folderPill}
      {/* Key point — textarea: 자동 줄바꿈 */}
      <WRowTextarea value={entry.keyPoint} placeholder="Key point..." onChange={v=>onUpdate({keyPoint:v})} />
      <WRowTextarea value={entry.details}  placeholder="Details..."   onChange={v=>onUpdate({details:v})} />
      <WRowTextarea value={entry.notes}    placeholder="Notes..."     onChange={v=>onUpdate({notes:v})} />
      <div style={{display:"flex",flexDirection:"column",gap:2,alignSelf:"center"}}>
        <button style={wRowBtn} onClick={onAddBelow} title="Add row">＋</button>
        <button style={{...wRowBtn,color:"#fca5a5"}} onClick={onDelete} title="Delete">×</button>
      </div>
    </div>
  );
}
function DownloadModal({ worklogs, onClose }) {
  const now = new Date();
  const thisYM = `${now.getFullYear()}.${String(now.getMonth()+1).padStart(2,"0")}`;
  const [from, setFrom] = useState(thisYM);
  const [to,   setTo]   = useState(thisYM);
  const [showF, setShowF] = useState(false);
  const [showT, setShowT] = useState(false);

  const doDownload = () => {
    const rows = worklogs
      .filter(w => { const ym = w.date?.slice(0,7)||""; return ym>=from && ym<=to; })
      .sort((a,b) => a.date?.localeCompare(b.date))
      .map(w => ({ Date:w.date||"", Project:w.project||"", "Key Point":w.keyPoint||"", Details:w.details||"", Notes:w.notes||"" }));
    if (!rows.length) { alert("No data for selected period."); return; }
    const ws = XLSX.utils.json_to_sheet(rows);
    ws["!cols"] = [{wch:12},{wch:22},{wch:30},{wch:40},{wch:20}];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Worklog");
    XLSX.writeFile(wb, `worklog_${from}_${to}.xlsx`);
    onClose();
  };

  return (
    <div style={{ position:"fixed", inset:0, background:"rgba(15,32,68,.4)", display:"flex", alignItems:"center", justifyContent:"center", zIndex:800 }}
      onClick={onClose}>
      <div style={{ background:"#fff", borderRadius:18, padding:"26px 24px 20px", width:300, boxShadow:"0 16px 48px rgba(15,32,68,.22)" }}
        onClick={e => e.stopPropagation()}>
        <div style={{ fontSize:15, fontWeight:700, color:"#0f2044", marginBottom:4 }}>📥 Export to Excel</div>
        <div style={{ fontSize:12, color:"#8aa0c0", marginBottom:18, lineHeight:1.6 }}>Select a date range to export as xlsx.</div>
        <div style={{ display:"flex", gap:10, marginBottom:18 }}>
          {[["From", from, setFrom, showF, setShowF], ["To", to, setTo, showT, setShowT]].map(([lbl, val, set, show, setShow]) => (
            <div key={lbl} style={{ flex:1 }}>
              <div style={{ fontSize:11, color:"#6b8bb5", fontWeight:700, marginBottom:4 }}>{lbl}</div>
              <div style={{ position:"relative" }}>
                <button style={{ ...wBtn, width:"100%", justifyContent:"center", fontSize:12 }} onClick={() => setShow(v => !v)}>{val}</button>
                {show && <MonthPicker value={val} onChange={v => { set(v); setShow(false); }} onClose={() => setShow(false)} />}
              </div>
            </div>
          ))}
        </div>
        <button style={{ width:"100%", padding:"12px", borderRadius:10, border:"none", background:"#2563eb", color:"#fff", fontSize:14, fontWeight:700, cursor:"pointer", fontFamily:"inherit", boxShadow:"0 4px 10px rgba(37,99,235,.3)" }}
          onClick={doDownload}>Download</button>
        <button style={{ width:"100%", padding:"9px", borderRadius:10, border:"none", background:"transparent", color:"#9ca3af", fontSize:13, cursor:"pointer", fontFamily:"inherit", marginTop:8 }}
          onClick={onClose}>Cancel</button>
      </div>
    </div>
  );
}

const wBtn = { background:"#fff", border:"1px solid #e0eaf8", borderRadius:9, padding:"7px 11px", fontSize:12.5, cursor:"pointer", fontFamily:"inherit", fontWeight:600, color:"#4b6fa8", display:"flex", alignItems:"center", gap:4, whiteSpace:"nowrap" };
const wCB  = { width:16, height:16, borderRadius:4, border:"1.5px solid #c2d0e8", display:"flex", alignItems:"center", justifyContent:"center", fontSize:10, color:"#fff", fontWeight:700, cursor:"pointer", flexShrink:0 };
const wCBOn = { background:"#2563eb", borderColor:"#2563eb" };
const wDatePill = { fontSize:12, color:"#2563eb", background:"#eff6ff", borderRadius:7, padding:"5px 8px", cursor:"pointer", fontWeight:600, border:"1px solid #bfdbfe", whiteSpace:"nowrap", userSelect:"none" };
const wCell = { border:"none", borderBottom:"1px solid transparent", background:"transparent", outline:"none", fontFamily:"inherit", fontSize:13, color:"#1e3a6e", lineHeight:1.4, padding:"3px 4px", width:"100%" };
const wRowBtn = { background:"none", border:"1px solid #e8eef8", borderRadius:5, width:20, height:20, display:"flex", alignItems:"center", justifyContent:"center", cursor:"pointer", color:"#6b8bb5", fontSize:12, fontWeight:700, padding:0, fontFamily:"inherit" };

// ─── CalendarView ─────────────────────────────────────────
// ─── CalendarView (Google Calendar 통합 + 월간 그리드) ────
function CalendarView({ items, folders, accessToken, onUpdate }) {
  const now = new Date();
  const pad2 = n => String(n).padStart(2,"0");
  const [curYear,  setCurYear]  = useState(now.getFullYear());
  const [curMonth, setCurMonth] = useState(now.getMonth()); // 0-based
  const [gcalEvents, setGcalEvents] = useState([]);
  const [gcalLoading, setGcalLoading] = useState(false);
  const [gcalError, setGcalError] = useState("");
  const [selectedDay, setSelectedDay] = useState(null); // "YYYY.MM.DD"
  const [showNewEvent, setShowNewEvent] = useState(false);
  const [newEventTitle, setNewEventTitle] = useState("");
  const [editingEvent, setEditingEvent] = useState(null); // {id, summary, description}
  const [viewMode, setViewMode] = useState("month"); // "month" | "list"

  // 달 이동
  const prevMonth = () => { if (curMonth === 0) { setCurYear(y=>y-1); setCurMonth(11); } else setCurMonth(m=>m-1); };
  const nextMonth = () => { if (curMonth === 11) { setCurYear(y=>y+1); setCurMonth(0); } else setCurMonth(m=>m+1); };

  // 날짜 유틸
  const ymStr = `${curYear}.${pad2(curMonth+1)}`;
  const todayStr = `${now.getFullYear()}.${pad2(now.getMonth()+1)}.${pad2(now.getDate())}`;
  const daysInMonth = new Date(curYear, curMonth+1, 0).getDate();
  const firstDow = new Date(curYear, curMonth, 1).getDay(); // 0=Sun
  const allDays = [...Array(firstDow).fill(null), ...Array(daysInMonth).fill(0).map((_,i)=>i+1)];

  // Google Calendar 로드
  const loadGCal = async () => {
    if (!accessToken) return;
    setGcalLoading(true); setGcalError("");
    try {
      const tMin = new Date(curYear, curMonth, 1).toISOString();
      const tMax = new Date(curYear, curMonth+1, 0, 23, 59, 59).toISOString();
      const evts = await gcalFetch(accessToken, tMin, tMax);
      setGcalEvents(evts);
    } catch(e) {
      if (e.message === "TOKEN_EXPIRED") setGcalError("토큰 만료 — 재로그인 필요");
      else setGcalError("Google Calendar 연동 오류");
    } finally { setGcalLoading(false); }
  };

  useEffect(() => { loadGCal(); }, [curYear, curMonth, accessToken]);

  // 날짜별 이벤트 맵: "YYYY.MM.DD" → [{...}]
  const gcalByDay = {};
  gcalEvents.forEach(ev => {
    const d = ev.start?.date || ev.start?.dateTime?.slice(0,10);
    if (!d) return;
    const [y,m,day] = d.split("-");
    const key = `${y}.${m}.${day}`;
    if (!gcalByDay[key]) gcalByDay[key] = [];
    gcalByDay[key].push(ev);
  });

  // 이 달 theNOTES 아이템 (createdAt 기준)
  const notesByDay = {};
  items.filter(i => !i.deletedAt && (i.createdAt||"").startsWith(ymStr)).forEach(i => {
    const key = i.createdAt;
    if (!notesByDay[key]) notesByDay[key] = [];
    notesByDay[key].push(i);
  });
  // dueDate 기준 To-do
  items.filter(i => !i.deletedAt && i.type===T.TODO && (i.dueDate||"").startsWith(ymStr)).forEach(i => {
    const key = i.dueDate;
    if (!notesByDay[key]) notesByDay[key] = [];
    if (!notesByDay[key].find(x=>x.id===i.id+"_due")) notesByDay[key].push({...i, _isDue:true});
  });

  // Google Calendar 이벤트 생성
  const createGCalEvent = async () => {
    if (!newEventTitle.trim() || !selectedDay || !accessToken) return;
    const [y,m,d] = selectedDay.split(".");
    try {
      const ev = await gcalCreateEvent(accessToken, { title:newEventTitle.trim(), date:`${y}-${m}-${d}` });
      setGcalEvents(prev=>[...prev, ev]);
      setNewEventTitle(""); setShowNewEvent(false);
    } catch(e) { alert("Google Calendar 이벤트 생성 실패: " + e.message); }
  };

  // Google Calendar 이벤트 수정
  const updateGCalEvent = async () => {
    if (!editingEvent || !accessToken) return;
    try {
      const updated = await gcalUpdateEvent(accessToken, editingEvent.id, { summary: editingEvent.summary, description: editingEvent.description||"" });
      setGcalEvents(prev => prev.map(e=>e.id===updated.id?updated:e));
      setEditingEvent(null);
    } catch(e) { alert("수정 실패: " + e.message); }
  };

  // Google Calendar 이벤트 삭제
  const deleteGCalEvent = async (eventId) => {
    if (!accessToken) return;
    if (!window.confirm("이 Google Calendar 이벤트를 삭제하시겠습니까?")) return;
    try {
      await gcalDeleteEvent(accessToken, eventId);
      setGcalEvents(prev => prev.filter(e=>e.id!==eventId));
    } catch(e) { alert("삭제 실패: " + e.message); }
  };

  const dayCell = (day) => {
    if (!day) return <td key={`e-${Math.random()}`} style={{border:"1px solid #e0eaf8",background:"#f8faff",minWidth:90,height:80}}/>;
    const key = `${curYear}.${pad2(curMonth+1)}.${pad2(day)}`;
    const isToday = key === todayStr;
    const isSelected = key === selectedDay;
    const gcalEvts = gcalByDay[key] || [];
    const noteEvts = notesByDay[key] || [];
    const hasDue = noteEvts.some(i=>i._isDue);

    return (
      <td key={key}
        onClick={() => setSelectedDay(isSelected ? null : key)}
        style={{
          border:"1px solid #e0eaf8", verticalAlign:"top", padding:"4px 5px",
          minWidth:90, height:80, cursor:"pointer", position:"relative",
          background: isSelected?"#eff6ff": isToday?"#fefce8":"#fff",
          transition:"background .1s"
        }}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:2}}>
          <span style={{
            fontSize:12, fontWeight:isToday?800:500,
            color:isToday?"#2563eb":"#374151",
            background:isToday?"#dbeafe":"transparent",
            borderRadius:"50%", width:22, height:22,
            display:"flex",alignItems:"center",justifyContent:"center"
          }}>{day}</span>
          {(gcalEvts.length>0||hasDue) && (
            <span style={{fontSize:9,color:"#6b7280"}}>
              {gcalEvts.length>0&&`G${gcalEvts.length}`}
              {hasDue&&" 📅"}
            </span>
          )}
        </div>
        {/* Google Calendar 이벤트 */}
        {gcalEvts.slice(0,2).map(ev=>(
          <div key={ev.id} style={{
            fontSize:10,lineHeight:1.3,background:"#dbeafe",color:"#1d4ed8",
            borderRadius:3,padding:"1px 4px",marginBottom:1,
            overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",
            cursor:"pointer"
          }}
          onClick={e=>{e.stopPropagation();setEditingEvent({id:ev.id,summary:ev.summary||"",description:ev.description||""});}}>
            📅 {ev.summary}
          </div>
        ))}
        {gcalEvts.length>2 && <div style={{fontSize:9,color:"#6b7280"}}>+{gcalEvts.length-2}개</div>}
        {/* theNOTES 항목 (due date) */}
        {noteEvts.filter(i=>i._isDue).slice(0,1).map(i=>(
          <div key={i.id+"d"} style={{
            fontSize:10,lineHeight:1.3,background:"#fef2f2",color:"#dc2626",
            borderRadius:3,padding:"1px 4px",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"
          }}>⏰ {i.title}</div>
        ))}
      </td>
    );
  };

  // 선택된 날 상세
  const selDayGcal  = selectedDay ? (gcalByDay[selectedDay]||[]) : [];
  const selDayNotes = selectedDay ? (notesByDay[selectedDay]||[]).filter(i=>!i._isDue) : [];
  const selDayDue   = selectedDay ? (notesByDay[selectedDay]||[]).filter(i=>i._isDue) : [];

  return (
    <div style={{display:"flex",flexDirection:"column",height:"100%",overflow:"hidden"}}>
      {/* 헤더 */}
      <div style={{display:"flex",alignItems:"center",gap:8,padding:"10px 20px 8px",borderBottom:"1px solid #e0eaf8",flexShrink:0,flexWrap:"wrap"}}>
        <button style={{...tbBtn}} onClick={prevMonth}>‹</button>
        <span style={{fontSize:16,fontWeight:700,color:"#1e3a6e",minWidth:120,textAlign:"center"}}>
          {curYear}년 {curMonth+1}월
        </span>
        <button style={{...tbBtn}} onClick={nextMonth}>›</button>
        <button style={{...tbBtn,background: now.getFullYear()===curYear&&now.getMonth()===curMonth?"#eff6ff":"#f5f8ff"}}
          onClick={()=>{setCurYear(now.getFullYear());setCurMonth(now.getMonth());}}>Today</button>
        <div style={{flex:1}}/>
        {gcalLoading && <span style={{fontSize:11,color:"#6b8bb5"}}>📅 로딩 중...</span>}
        {gcalError  && <span style={{fontSize:11,color:"#ef4444"}}>{gcalError}</span>}
        {!accessToken && <span style={{fontSize:11,color:"#94a3b8"}}>Google 로그인 시 일정 연동됩니다</span>}
        {accessToken && !gcalLoading && !gcalError && (
          <span style={{fontSize:11,color:"#059669"}}>✅ Google Calendar 연동됨 ({gcalEvents.length}개)</span>
        )}
        <button style={{...tbBtn}} onClick={()=>setViewMode(v=>v==="month"?"list":"month")}>
          {viewMode==="month"?"📋 목록":"📅 월간"}
        </button>
      </div>

      <div style={{flex:1,display:"flex",overflow:"hidden"}}>
        {/* 월간 그리드 */}
        {viewMode==="month" && (
          <div style={{flex:1,overflowY:"auto",padding:"8px 12px"}}>
            <table style={{width:"100%",borderCollapse:"collapse",tableLayout:"fixed"}}>
              <thead>
                <tr>
                  {["일","월","화","수","목","금","토"].map((d,i)=>(
                    <th key={d} style={{
                      padding:"6px 0",fontSize:11,fontWeight:700,textAlign:"center",
                      color:i===0?"#ef4444":i===6?"#6b7280":"#374151",
                      borderBottom:"2px solid #e0eaf8"
                    }}>{d}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {Array.from({length:Math.ceil(allDays.length/7)},(_,ri)=>(
                  <tr key={ri}>
                    {allDays.slice(ri*7,ri*7+7).map((d,ci)=>dayCell(d))}
                    {allDays.slice(ri*7,ri*7+7).length<7 && [...Array(7-allDays.slice(ri*7,ri*7+7).length)].map((_,i)=>(
                      <td key={"e"+i} style={{border:"1px solid #e0eaf8",background:"#f8faff"}}/>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* 목록 뷰 */}
        {viewMode==="list" && (
          <div style={{flex:1,overflowY:"auto",padding:"12px 20px"}}>
            {Object.keys({...gcalByDay,...notesByDay}).sort().map(day => {
              if (!day.startsWith(ymStr)) return null;
              const g = gcalByDay[day]||[];
              const n = notesByDay[day]||[];
              if (!g.length && !n.length) return null;
              return (
                <div key={day} style={{marginBottom:16}}>
                  <div style={{fontSize:12,fontWeight:700,color:"#2563eb",background:"#eff6ff",borderRadius:8,padding:"3px 10px",marginBottom:6,display:"inline-block"}}>
                    {day}
                  </div>
                  {g.map(ev=>(
                    <div key={ev.id} style={{display:"flex",alignItems:"center",gap:8,background:"#fff",borderRadius:8,padding:"7px 12px",marginBottom:3,boxShadow:"0 1px 3px rgba(15,32,68,.05)",borderLeft:"3px solid #2563eb"}}>
                      <span style={{fontSize:12}}>📅</span>
                      <span style={{flex:1,fontSize:13,color:"#1e3a6e",fontWeight:500}}>{ev.summary||"(제목 없음)"}</span>
                      <span style={{fontSize:11,color:"#94a3b8"}}>Google Calendar</span>
                      <button style={{background:"none",border:"1px solid #e0eaf8",borderRadius:5,padding:"2px 7px",fontSize:11,cursor:"pointer",color:"#4b6fa8"}}
                        onClick={()=>setEditingEvent({id:ev.id,summary:ev.summary||"",description:ev.description||""})}>편집</button>
                      <button style={{background:"none",border:"1px solid #fecaca",borderRadius:5,padding:"2px 7px",fontSize:11,cursor:"pointer",color:"#ef4444"}}
                        onClick={()=>deleteGCalEvent(ev.id)}>삭제</button>
                    </div>
                  ))}
                  {n.filter(i=>!i._isDue).map(i=>(
                    <div key={i.id} style={{display:"flex",alignItems:"center",gap:8,background:"#fff",borderRadius:8,padding:"7px 12px",marginBottom:3,boxShadow:"0 1px 3px rgba(15,32,68,.05)",borderLeft:`3px solid ${i.type===T.TODO?"#059669":i.type===T.HEADER?"#2563eb":"#8b5cf6"}`}}>
                      <span style={{fontSize:11,color:i.type===T.TODO?"#059669":i.type===T.HEADER?"#2563eb":"#8b5cf6",fontWeight:700}}>
                        {i.type===T.TODO?"☐":i.type===T.HEADER?"▬":"T"}
                      </span>
                      <span style={{flex:1,fontSize:13,color:"#1e3a6e"}}>{i.title||"(untitled)"}</span>
                      <span style={{fontSize:11,color:"#94a3b8"}}>{folders.find(f=>f.id===i.folder)?.name||""}</span>
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        )}

        {/* 선택된 날 사이드패널 */}
        {selectedDay && viewMode==="month" && (
          <div style={{width:260,borderLeft:"1px solid #e0eaf8",display:"flex",flexDirection:"column",background:"#f8faff",overflowY:"auto",flexShrink:0}}>
            <div style={{padding:"10px 14px 6px",display:"flex",alignItems:"center",justifyContent:"space-between",borderBottom:"1px solid #e0eaf8"}}>
              <span style={{fontSize:13,fontWeight:700,color:"#1e3a6e"}}>{selectedDay}</span>
              {accessToken && (
                <button style={{...tbBtn,fontSize:11}}
                  onClick={()=>setShowNewEvent(true)}>+ 일정 추가</button>
              )}
            </div>
            <div style={{flex:1,overflowY:"auto",padding:"8px 12px"}}>
              {/* 새 이벤트 입력 */}
              {showNewEvent && (
                <div style={{background:"#fff",borderRadius:8,padding:"8px 10px",marginBottom:8,boxShadow:"0 1px 4px rgba(15,32,68,.08)"}}>
                  <input
                    value={newEventTitle} onChange={e=>setNewEventTitle(e.target.value)}
                    placeholder="이벤트 제목..."
                    autoFocus
                    style={{width:"100%",border:"none",borderBottom:"1px solid #e0eaf8",outline:"none",fontSize:12.5,color:"#1e3a6e",background:"transparent",marginBottom:6,padding:"2px 0",boxSizing:"border-box"}}
                    onKeyDown={e=>{if(e.key==="Enter")createGCalEvent();if(e.key==="Escape")setShowNewEvent(false);}}
                  />
                  <div style={{display:"flex",gap:4}}>
                    <button style={{...tbBtn,background:"#2563eb",color:"#fff",border:"none",fontSize:11}} onClick={createGCalEvent}>저장</button>
                    <button style={{...tbBtn,fontSize:11}} onClick={()=>{setShowNewEvent(false);setNewEventTitle("");}}>취소</button>
                  </div>
                </div>
              )}
              {/* Google Calendar 이벤트 */}
              {selDayGcal.length>0 && <div style={{fontSize:10,fontWeight:700,color:"#94a3b8",textTransform:"uppercase",letterSpacing:"1px",marginBottom:4}}>Google Calendar</div>}
              {selDayGcal.map(ev=>(
                <div key={ev.id} style={{background:"#fff",borderRadius:8,padding:"7px 10px",marginBottom:4,borderLeft:"3px solid #2563eb",boxShadow:"0 1px 3px rgba(15,32,68,.05)"}}>
                  <div style={{fontSize:12.5,color:"#1e3a6e",fontWeight:600,marginBottom:2}}>{ev.summary||"(제목 없음)"}</div>
                  {ev.description && <div style={{fontSize:11,color:"#6b8bb5",lineHeight:1.5}}>{ev.description}</div>}
                  <div style={{display:"flex",gap:4,marginTop:5}}>
                    <button style={{...tbBtn,fontSize:10}} onClick={()=>setEditingEvent({id:ev.id,summary:ev.summary||"",description:ev.description||""})}>편집</button>
                    <button style={{...tbBtn,fontSize:10,color:"#ef4444",borderColor:"#fecaca"}} onClick={()=>deleteGCalEvent(ev.id)}>삭제</button>
                  </div>
                </div>
              ))}
              {/* theNOTES 노트 */}
              {selDayNotes.length>0 && <div style={{fontSize:10,fontWeight:700,color:"#94a3b8",textTransform:"uppercase",letterSpacing:"1px",marginBottom:4,marginTop:8}}>Notes</div>}
              {selDayNotes.map(i=>(
                <div key={i.id} style={{background:"#fff",borderRadius:8,padding:"6px 10px",marginBottom:3,boxShadow:"0 1px 3px rgba(15,32,68,.05)",borderLeft:`3px solid ${i.type===T.TODO?"#059669":i.type===T.HEADER?"#2563eb":"#8b5cf6"}`}}>
                  <div style={{fontSize:12,color:"#1e3a6e"}}>{i.title||"(untitled)"}</div>
                  <div style={{fontSize:10,color:"#94a3b8",marginTop:1}}>{folders.find(f=>f.id===i.folder)?.name||""}</div>
                </div>
              ))}
              {/* 마감기한 */}
              {selDayDue.length>0 && <div style={{fontSize:10,fontWeight:700,color:"#94a3b8",textTransform:"uppercase",letterSpacing:"1px",marginBottom:4,marginTop:8}}>⏰ 마감기한</div>}
              {selDayDue.map(i=>(
                <div key={i.id+"_due"} style={{background:"#fef2f2",borderRadius:8,padding:"6px 10px",marginBottom:3,borderLeft:"3px solid #ef4444"}}>
                  <div style={{fontSize:12,color:"#dc2626",fontWeight:600}}>{i.title||"(untitled)"}</div>
                  <div style={{fontSize:10,color:"#94a3b8",marginTop:1}}>{folders.find(f=>f.id===i.folder)?.name||""}</div>
                </div>
              ))}
              {!selDayGcal.length && !selDayNotes.length && !selDayDue.length && (
                <div style={{fontSize:12,color:"#94a3b8",textAlign:"center",paddingTop:20}}>이 날 항목 없음</div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Google Calendar 이벤트 편집 모달 */}
      {editingEvent && (
        <div style={{position:"fixed",inset:0,background:"rgba(15,32,68,.4)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:9999}}
          onClick={()=>setEditingEvent(null)}>
          <div style={{background:"#fff",borderRadius:14,padding:"20px 22px",width:340,boxShadow:"0 12px 40px rgba(15,32,68,.25)"}}
            onClick={e=>e.stopPropagation()}>
            <div style={{fontSize:14,fontWeight:700,color:"#1e3a6e",marginBottom:14}}>📅 Google Calendar 이벤트 편집</div>
            <div style={{marginBottom:10}}>
              <div style={{fontSize:11,color:"#94a3b8",marginBottom:4}}>제목</div>
              <input value={editingEvent.summary}
                onChange={e=>setEditingEvent(p=>({...p,summary:e.target.value}))}
                style={{width:"100%",padding:"7px 10px",borderRadius:8,border:"1.5px solid #e0eaf8",fontSize:13,color:"#1e3a6e",outline:"none",boxSizing:"border-box",fontFamily:"inherit"}}/>
            </div>
            <div style={{marginBottom:14}}>
              <div style={{fontSize:11,color:"#94a3b8",marginBottom:4}}>설명 (메모)</div>
              <textarea value={editingEvent.description}
                onChange={e=>setEditingEvent(p=>({...p,description:e.target.value}))}
                rows={3}
                style={{width:"100%",padding:"7px 10px",borderRadius:8,border:"1.5px solid #e0eaf8",fontSize:13,color:"#1e3a6e",outline:"none",resize:"vertical",boxSizing:"border-box",fontFamily:"inherit"}}/>
            </div>
            <div style={{display:"flex",gap:8}}>
              <button style={{flex:1,padding:"9px",borderRadius:9,border:"none",background:"#2563eb",color:"#fff",fontSize:13,fontWeight:600,cursor:"pointer",fontFamily:"inherit"}}
                onClick={updateGCalEvent}>저장</button>
              <button style={{flex:1,padding:"9px",borderRadius:9,border:"1px solid #e0eaf8",background:"#fff",color:"#6b7280",fontSize:13,cursor:"pointer",fontFamily:"inherit"}}
                onClick={()=>setEditingEvent(null)}>취소</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}


// ─── TrashView ────────────────────────────────────────────
// ─── ManualView ───────────────────────────────────────────
const MANUAL_CONTENT = {
  ko: {
    lang: "한국어",
    title: "theNOTES 사용 가이드",
    subtitle: "",
    sections: [
      {
        icon: "🗂️", title: "기본 구조",
        desc: "왼쪽 사이드바에서 폴더를 선택하면 오른쪽에 해당 폴더의 노트 목록이 표시됩니다.",
        tips: [
          "PROJECT / AREA / RESOURCE / ARCHIVE 섹션으로 폴더를 분류할 수 있습니다.",
          "섹션 이름을 클릭하면 직접 수정할 수 있습니다.",
          "⠿ 핸들을 드래그하면 폴더·노트 순서를 바꿀 수 있습니다.",
          "사이드바 하단 + Add 버튼으로 새 폴더·섹션·구분선을 추가합니다.",
          "Notice(★), Calendar(◷), Worklog(📋), Trash(🗑), Manual(📖) 은 하단 고정 메뉴입니다.",
        ],
        ui: {
          label: "사이드바 구조",
          items: ["▾ PROJECT", "  ○ Work  ●", "  ○ Personal", "▾ AREA", "  ○ Health", "★ Notice  ◷ Calendar  📋 Worklog  🗑 Trash  📖 Manual"],
        }
      },
      {
        icon: "➕", title: "노트 추가하기",
        desc: "폴더에 들어간 후 오른쪽 상단 + 버튼을 눌러 세 가지 유형의 항목을 추가합니다.",
        tips: [
          "▬ Header — 항목들을 묶는 제목 구분선. 클릭해서 접고 펼 수 있습니다.",
          "☐ To-do — 체크박스가 있는 할 일. Enter 키로 다음 항목을 바로 추가합니다.",
          "T Text — 서식 있는 텍스트 노트. 표·숨김 섹션·링크·파일첨부 가능.",
          "항목을 선택(포커스)한 상태에서 + 버튼을 누르면 그 아래에 삽입됩니다.",
          "폴더 상단 ↓ Excel 로 현재 폴더를 엑셀로 내보내고, ↑ Import 로 불러올 수 있습니다.",
        ],
        ui: {
          label: "+ 추가 메뉴 / 상단 툴바",
          items: ["▬ Header", "☐ To-do", "T  Text", "──────────────", "🔍  Select  ↓ Excel  ↑ Import  [+]"],
        }
      },
      {
        icon: "☐", title: "To-do 기능 — ⋯ 메뉴",
        desc: "To-do 항목 오른쪽 ⋯ 버튼을 누르면 Due Date(마감기한)와 Move to(이동/복사) 메뉴가 열립니다.",
        tips: [
          "📅 Due Date — 달력에서 마감기한 선택. 선택 후 제목 아래에 빨간색으로 표시됩니다.",
          "마감기한 옆 × 버튼 또는 달력에서 × 버튼으로 삭제합니다.",
          "📂 Move to — 폴더 목록 선택 후 ✂️ 이동(원본 삭제) 또는 📋 복사(원본 유지) 선택.",
          "Enter 키를 누르면 바로 아래에 새 To-do가 추가됩니다.",
        ],
        ui: {
          label: "⋯ 메뉴 구조",
          items: ["📅 Due Date  ›", "📂 Move to  ›", "  → 폴더 선택 후: ✂️ 이동 / 📋 복사"],
        }
      },
      {
        icon: "✅", title: "To-do 완료 & Completed",
        desc: "To-do 항목의 왼쪽 체크박스를 클릭하면 완료 처리됩니다.",
        tips: [
          "완료된 항목은 하단 Completed 섹션으로 자동 이동됩니다.",
          "Completed ▾ 를 클릭해 펼치면 완료 목록을 볼 수 있습니다.",
          "✓ 버튼을 다시 클릭하면 미완료로 되돌릴 수 있습니다.",
          "Completed의 × 버튼을 클릭하면 휴지통으로 이동합니다.",
        ],
        ui: {
          label: "Completed 섹션",
          items: ["▾ Completed  3          Latest: 2026.03.23", "  ✓ 완료된 할 일  2026.03.23  ×", "  ✓ 다른 완료 항목  2026.03.22  ×"],
        }
      },
      {
        icon: "★", title: "별표(Star) & Notice & PDF 내보내기",
        desc: "항목 오른쪽의 ★ 버튼을 클릭하면 별표가 표시됩니다. Select 모드에서 ↓ PDF로 내보낼 수 있습니다.",
        tips: [
          "별표가 된 항목은 제목 앞에 금색 ★이 표시됩니다.",
          "Notice(★)를 클릭하면 모든 폴더의 별표 항목만 모아 볼 수 있습니다.",
          "Select 버튼 → 항목 선택 → ↓ PDF 버튼을 누르면 선택 항목을 PDF로 저장합니다.",
          "PDF는 화면에 보이는 순서대로, 제목·내용·체크박스·마감기한 포함 출력됩니다.",
          "Delete 버튼으로 선택 항목을 일괄 삭제합니다.",
        ],
        ui: {
          label: "Select 모드 툴바",
          items: ["□ All  ↓ PDF  Delete  Cancel"],
        }
      },
      {
        icon: "☁️", title: "Google Drive 동기화",
        desc: "Google 계정으로 로그인하면 모든 노트가 내 Google Drive에 자동 저장됩니다.",
        tips: [
          "왼쪽 하단 'Sign in with Google' 버튼으로 로그인합니다.",
          "로그인 후 ✅ Synced 표시가 나타나면 동기화 완료입니다.",
          "어느 기기 어느 브라우저에서도 동일한 데이터를 볼 수 있습니다.",
          "❌ 표시가 나타나면 클릭해서 재로그인하세요. 로컬 데이터는 유지됩니다.",
        ],
        ui: {
          label: "로그인 상태",
          items: ["b  bauman", "   duholee79@gmail...", "   ✅ Synced"],
        }
      },
      {
        icon: "📱", title: "앱 설치 (PWA)",
        desc: "theNOTES는 브라우저에서 PC·스마트폰 홈 화면에 앱처럼 설치해 사용할 수 있습니다.",
        tips: [
          "Android Chrome: 주소창 오른쪽 설치(⊕) 아이콘 또는 메뉴 → '홈 화면에 추가'.",
          "iPhone Safari: 하단 공유 버튼(□↑) → '홈 화면에 추가' → 추가.",
          "PC Chrome/Edge: 주소창 오른쪽 설치 아이콘(⊕) 클릭 → 설치.",
          "설치 후에는 브라우저 없이 별도 앱처럼 실행되며, 오프라인에서도 기본 동작합니다.",
          "데이터는 Google Drive에 저장되므로 설치 여부와 무관하게 동기화됩니다.",
        ],
        ui: {
          label: "설치 방법",
          items: ["Android Chrome: ⋮ 메뉴 → 홈 화면에 추가", "iPhone Safari: □↑ → 홈 화면에 추가", "PC Chrome/Edge: 주소창 우측 ⊕ → 설치"],
        }
      },
      {
        icon: "📋", title: "Worklog (업무일지)",
        desc: "사이드바 Worklog를 클릭하면 날짜·폴더·핵심내용·상세내용·메모를 기록할 수 있는 업무일지 화면이 열립니다.",
        tips: [
          "+ Add 버튼으로 오늘 날짜의 새 항목을 추가합니다.",
          "날짜 버튼 클릭 → 날짜 선택기. 폴더 버튼 클릭 → 프로젝트 폴더 연결.",
          "↓ Excel로 기간을 선택해 엑셀 내보내기. ↑ Import로 같은 양식 파일 가져오기.",
          "스마트폰에서는 날짜+폴더+[D][N][+][×] 한 줄, 아래에 Key Point 표시.",
          "[D] 버튼으로 Details, [N] 버튼으로 Notes를 팝업으로 보기/편집 가능.",
        ],
        ui: {
          label: "PC 컬럼 구조",
          items: ["DATE  FOLDER  KEY POINT  DETAILS  NOTES", "2026.03.23  [프로젝트]  현황 분석  상세 내용...  메모..."],
        }
      },
      {
        icon: "📥", title: "Excel 내보내기 / 가져오기",
        desc: "각 폴더의 노트를 Excel로 내보내거나, 같은 양식의 Excel 파일을 불러올 수 있습니다.",
        tips: [
          "폴더 상단 ↓ Excel → 현재 폴더 전체를 xlsx로 저장합니다.",
          "↑ Import → xlsx 파일 선택 → 현재 폴더에 추가됩니다 (기존 데이터 유지).",
          "Import 양식 컬럼: Type(Header/Todo/Text), Title, Body, Done, Starred, Date",
          "설정(⚙) → Backup → ↓ 전체 백업으로 모든 폴더를 한 번에 백업합니다.",
        ],
        ui: {
          label: "상단 툴바",
          items: ["🔍  Select  ↓ Excel  ↑ Import  [+]"],
        }
      },
      {
        icon: "🗑️", title: "휴지통 & 복원",
        desc: "× 버튼으로 삭제한 항목은 30일간 휴지통에 보관됩니다.",
        tips: [
          "사이드바 Trash를 클릭하면 삭제된 항목 목록이 표시됩니다.",
          "Restore 버튼으로 원래 폴더로 복원할 수 있습니다.",
          "Delete 버튼으로 영구 삭제합니다.",
          "Empty all 버튼으로 휴지통을 비웁니다.",
        ],
        ui: {
          label: "휴지통 화면",
          items: ["□ 전체 선택  Restore(2)  Delete(2)  Empty all", "□ 삭제된 항목  원본폴더  12일 남음  Restore  Delete"],
        }
      },
      {
        icon: "⚙️", title: "설정",
        desc: "사이드바 하단 ⚙ 버튼을 클릭하면 설정 창이 열립니다.",
        tips: [
          "Account — 로그인 계정과 동기화 상태를 확인합니다.",
          "Backup — ↓ 전체 백업 (Excel) 버튼으로 모든 폴더+Worklog를 한 번에 백업합니다.",
          "Sign Out — 로그아웃합니다 (로그아웃 전 자동 저장).",
          "문의/오류 신고: duholee79@gmail.com",
        ],
        ui: {
          label: "설정 창",
          items: ["⚙ Settings", "ACCOUNT  bauman / duholee79@gmail.com  ✅ Synced", "BACKUP  ↓ 전체 백업 (Excel)", "DANGER ZONE  Sign Out  Delete Account"],
        }
      },
    ]
  },
  en: {
    lang: "English",
    title: "theNOTES User Guide",
    subtitle: "",
    sections: [
      {
        icon: "🗂️", title: "Basic Structure",
        desc: "Select a folder in the left sidebar to see its notes in the main area.",
        tips: [
          "Folders are organized under PROJECT / AREA / RESOURCE / ARCHIVE sections.",
          "Click a section name to rename it directly.",
          "Drag the ⠿ handle to reorder folders and notes.",
          "Use the + Add button at the bottom of the sidebar to add folders, sections, or dividers.",
          "Notice(★), Calendar(◷), Worklog(📋), Trash(🗑), Manual(📖) are fixed bottom menu items.",
        ],
        ui: { label: "Sidebar Structure", items: ["▾ PROJECT","  ○ Work  ●","  ○ Personal","▾ AREA","  ○ Health","★ Notice  ◷ Calendar  📋 Worklog  🗑 Trash  📖 Manual"] }
      },
      {
        icon: "➕", title: "Adding Notes",
        desc: "Click the + button (top right) to add one of three item types.",
        tips: [
          "▬ Header — A title divider that groups items. Click to collapse/expand.",
          "☐ To-do — A checkbox task. Press Enter to add the next task immediately.",
          "T Text — Rich text with tables, hidden sections, links, and attachments.",
          "If an item is focused, the + button inserts directly below it.",
          "Use ↓ Excel to export the current folder, and ↑ Import to load from xlsx.",
        ],
        ui: { label: "+ Menu / Top Toolbar", items: ["▬ Header","☐ To-do","T  Text","──────────────","🔍  Select  ↓ Excel  ↑ Import  [+]"] }
      },
      {
        icon: "☐", title: "To-do — ⋯ Menu",
        desc: "Click the ⋯ button on a To-do to access Due Date and Move to options.",
        tips: [
          "📅 Due Date — pick a date from the calendar. Shown in red below the title.",
          "Click × next to the due date (or inside the calendar) to remove it.",
          "📂 Move to — select a folder, then choose ✂️ Move (removes original) or 📋 Copy (keeps original).",
          "Press Enter to add a new To-do directly below.",
        ],
        ui: { label: "⋯ Menu Structure", items: ["📅 Due Date  ›","📂 Move to  ›","  → Select folder: ✂️ Move / 📋 Copy"] }
      },
      {
        icon: "✅", title: "To-do & Completed",
        desc: "Click the checkbox on a To-do to mark it complete.",
        tips: [
          "Completed items move to the Completed section at the bottom.",
          "Click ▾ Completed to expand and view them.",
          "Click ✓ again to restore an item to active.",
          "Click × in Completed to send the item to the Trash.",
        ],
        ui: { label: "Completed Section", items: ["▾ Completed  3       Latest: 2026.03.23","  ✓ Finished task  2026.03.23  ×","  ✓ Another task   2026.03.22  ×"] }
      },
      {
        icon: "★", title: "Stars & Notice & PDF Export",
        desc: "Click ★ to star any item. Use Select mode to export selected items as PDF.",
        tips: [
          "Starred items show a gold ★ before their title.",
          "Click Notice in the sidebar to see all starred items across all folders.",
          "Select button → select items → ↓ PDF button to export as a PDF file.",
          "PDF preserves display order and includes full content (title, body, checkbox, due date).",
          "Use Delete to bulk-delete selected items.",
        ],
        ui: { label: "Select Mode Toolbar", items: ["□ All  ↓ PDF  Delete  Cancel"] }
      },
      {
        icon: "☁️", title: "Google Drive Sync",
        desc: "Sign in with Google to auto-save all notes to your personal Google Drive.",
        tips: [
          "Click 'Sign in with Google' at the bottom of the sidebar.",
          "Once signed in, ✅ Synced indicates successful synchronization.",
          "Access the same data from any device or browser.",
          "If ❌ appears, click it to re-login. Your local data is preserved.",
        ],
        ui: { label: "Login Status", items: ["b  bauman","   duholee79@gmail...","   ✅ Synced"] }
      },
      {
        icon: "📱", title: "Install as App (PWA)",
        desc: "theNOTES can be installed on your PC or smartphone homescreen and used like a native app.",
        tips: [
          "Android Chrome: tap the install (⊕) icon in the address bar or menu → 'Add to Home Screen'.",
          "iPhone Safari: tap the Share button (□↑) → 'Add to Home Screen' → Add.",
          "PC Chrome/Edge: click the install icon (⊕) in the address bar → Install.",
          "Once installed, it runs without a browser UI and works offline for basic use.",
          "Data stays synced via Google Drive regardless of how you open the app.",
        ],
        ui: { label: "Installation", items: ["Android Chrome: ⋮ menu → Add to Home Screen","iPhone Safari: □↑ → Add to Home Screen","PC Chrome/Edge: address bar ⊕ → Install"] }
      },
      {
        icon: "📋", title: "Worklog",
        desc: "Click Worklog in the sidebar to open the daily work journal.",
        tips: [
          "Click + Add to create a new entry for today.",
          "Click the date pill to open the date picker. Click the folder pill to link to a project.",
          "↓ Excel exports entries for a date range. ↑ Import loads from a matching xlsx.",
          "On mobile: date + folder + [D][N][+][×] on top, Key Point below.",
          "[D] shows Details popup, [N] shows Notes popup — tap elsewhere to close.",
        ],
        ui: { label: "PC Columns", items: ["DATE  FOLDER  KEY POINT  DETAILS  NOTES","2026.03.23  [Project]  Status review  Details...  Notes..."] }
      },
      {
        icon: "📥", title: "Excel Export / Import",
        desc: "Export folder notes to Excel or import from a matching Excel file.",
        tips: [
          "↓ Excel (top bar) — exports the current folder as xlsx.",
          "↑ Import (top bar) — select xlsx to add to current folder (existing data kept).",
          "Import columns: Type(Header/Todo/Text), Title, Body, Done, Starred, Date",
          "Settings (⚙) → Backup → ↓ Full Backup exports all folders + Worklog at once.",
        ],
        ui: { label: "Top Toolbar", items: ["🔍  Select  ↓ Excel  ↑ Import  [+]"] }
      },
      {
        icon: "🗑️", title: "Trash & Restore",
        desc: "Items deleted with × are kept in Trash for 30 days.",
        tips: [
          "Click Trash in the sidebar to view deleted items.",
          "Click Restore to return an item to its original folder.",
          "Click Delete to permanently remove an item.",
          "Click Empty all to clear the entire Trash.",
        ],
        ui: { label: "Trash View", items: ["□ Select all  Restore(2)  Delete(2)  Empty all","□ Deleted item  From: Work  12 days left  Restore  Delete"] }
      },
      {
        icon: "⚙️", title: "Settings",
        desc: "Click the ⚙ button at the bottom of the sidebar to open Settings.",
        tips: [
          "Account — view your login and sync status.",
          "Backup — ↓ Full Backup (Excel) saves all folders + Worklog in one file.",
          "Sign Out — signs you out (auto-saves before logout).",
          "Support: duholee79@gmail.com",
        ],
        ui: { label: "Settings Panel", items: ["⚙ Settings","ACCOUNT  bauman / duholee79@gmail.com  ✅ Synced","BACKUP  ↓ Full Backup (Excel)","DANGER ZONE  Sign Out  Delete Account"] }
      },
    ]
  },
  ja: {
    lang: "日本語",
    title: "theNOTES 使い方ガイド",
    subtitle: "",
    sections: [
      {
        icon: "🗂️", title: "基本構造",
        desc: "左サイドバーでフォルダを選択すると、右のメイン画面にノート一覧が表示されます。",
        tips: [
          "PROJECT / AREA / RESOURCE / ARCHIVE セクションでフォルダを整理できます。",
          "セクション名をクリックすると直接編集できます。",
          "⠿ ハンドルをドラッグしてフォルダやノートの順序を変更できます。",
          "サイドバー下部の + Add ボタンで新しいフォルダ・セクション・区切り線を追加します。",
          "Notice(★), Calendar(◷), Worklog(📋), Trash(🗑), Manual(📖) は固定メニューです。",
        ],
        ui: { label: "サイドバー構造", items: ["▾ PROJECT","  ○ Work  ●","  ○ Personal","▾ AREA","  ○ Health","★ Notice  ◷ Calendar  📋 Worklog  🗑 Trash  📖 Manual"] }
      },
      {
        icon: "➕", title: "ノートの追加",
        desc: "フォルダに入った後、右上の + ボタンで3種類の項目を追加できます。",
        tips: [
          "▬ Header — 項目をまとめる見出し。クリックで折りたたみ・展開できます。",
          "☐ To-do — チェックボックス付きのタスク。Enterキーで次の項目を追加します。",
          "T Text — 表・隠しセクション・リンク・ファイル添付が可能なリッチテキスト。",
          "項目にフォーカスした状態で + ボタンを押すと、その直下に挿入されます。",
          "↓ Excel で現在のフォルダをExcel保存、↑ Import でxlsxを読み込めます。",
        ],
        ui: { label: "+ メニュー / 上部ツールバー", items: ["▬ Header","☐ To-do","T  Text","──────────────","🔍  Select  ↓ Excel  ↑ Import  [+]"] }
      },
      {
        icon: "☐", title: "To-do — ⋯ メニュー",
        desc: "To-doの ⋯ ボタンを押すと Due Date（期限）と Move to（移動/コピー）メニューが開きます。",
        tips: [
          "📅 Due Date — カレンダーから期限を選択。選択後はタイトル下に赤字で表示されます。",
          "期限横の × ボタン（またはカレンダー内の ×）で削除できます。",
          "📂 Move to — フォルダを選択後、✂️ 移動（元データ削除）または 📋 コピー（元データ保持）を選べます。",
          "Enter キーを押すと直下に新しい To-do が追加されます。",
        ],
        ui: { label: "⋯ メニュー構造", items: ["📅 Due Date  ›","📂 Move to  ›","  → フォルダ選択後: ✂️ 移動 / 📋 コピー"] }
      },
      {
        icon: "✅", title: "To-do完了 & Completed",
        desc: "To-doのチェックボックスをクリックすると完了になります。",
        tips: [
          "完了した項目は下部のCompletedセクションに移動します。",
          "▾ Completedをクリックして展開すると一覧が表示されます。",
          "✓ をもう一度クリックすると未完了に戻せます。",
          "Completed の × ボタンでゴミ箱に移動します。",
        ],
        ui: { label: "Completedセクション", items: ["▾ Completed  3       Latest: 2026.03.23","  ✓ 完了したタスク  2026.03.23  ×","  ✓ 別のタスク      2026.03.22  ×"] }
      },
      {
        icon: "★", title: "スター & Notice & PDFエクスポート",
        desc: "★ ボタンでスターを付けられます。Selectモードで選択項目をPDFに書き出せます。",
        tips: [
          "スター付き項目はタイトルの前に金色の★が表示されます。",
          "サイドバーのNoticeをクリックすると全フォルダのスター項目だけを一覧できます。",
          "Select → 項目を選択 → ↓ PDF ボタンでPDFとして保存できます。",
          "PDFは画面の表示順どおりに出力され、タイトル・本文・チェック・期限を含みます。",
          "Deleteボタンで選択項目を一括削除します。",
        ],
        ui: { label: "Selectモード ツールバー", items: ["□ All  ↓ PDF  Delete  Cancel"] }
      },
      {
        icon: "☁️", title: "Google Drive同期",
        desc: "Googleアカウントでログインすると全ノートが自動保存されます。",
        tips: [
          "サイドバー下部の「Sign in with Google」ボタンでログインします。",
          "✅ Synced 表示が出たら同期完了です。",
          "どのデバイス・ブラウザからも同じデータを参照できます。",
          "❌ が表示されたらクリックして再ログインしてください。ローカルデータは保持されます。",
        ],
        ui: { label: "ログイン状態", items: ["b  bauman","   duholee79@gmail...","   ✅ Synced"] }
      },
      {
        icon: "📱", title: "アプリとしてインストール (PWA)",
        desc: "theNOTES はPC・スマートフォンのホーム画面にアプリとしてインストールして使えます。",
        tips: [
          "Android Chrome: アドレスバーのインストール(⊕)アイコン、またはメニュー → 「ホーム画面に追加」。",
          "iPhone Safari: 共有ボタン(□↑) → 「ホーム画面に追加」 → 追加。",
          "PC Chrome/Edge: アドレスバー右のインストールアイコン(⊕) → インストール。",
          "インストール後はブラウザUIなしで独立したアプリとして起動し、オフラインでも基本動作します。",
          "データはGoogle Driveに保存されるため、インストール有無に関係なく同期されます。",
        ],
        ui: { label: "インストール方法", items: ["Android Chrome: ⋮ メニュー → ホーム画面に追加","iPhone Safari: □↑ → ホーム画面に追加","PC Chrome/Edge: アドレスバー右 ⊕ → インストール"] }
      },
      {
        icon: "📋", title: "Worklog（業務日誌）",
        desc: "サイドバーのWorklogをクリックすると業務日誌画面が開きます。",
        tips: [
          "+ Add ボタンで今日の日付の新しい項目を追加します。",
          "日付ボタンでカレンダー、フォルダボタンでプロジェクトフォルダと紐付けられます。",
          "↓ Excel で期間指定してExcel書き出し。↑ Import で同じ形式のxlsxを読み込み。",
          "スマートフォンでは日付+フォルダ+[D][N][+][×]が上段、Key Pointが下段に表示されます。",
          "[D]でDetails、[N]でNotesのポップアップが開き、他の場所をタップすると閉じます。",
        ],
        ui: { label: "PCカラム構成", items: ["DATE  FOLDER  KEY POINT  DETAILS  NOTES","2026.03.23  [プロジェクト]  状況整理  詳細...  メモ..."] }
      },
      {
        icon: "📥", title: "Excel書き出し / 読み込み",
        desc: "フォルダのノートをExcelに書き出したり、同じ形式のファイルを読み込めます。",
        tips: [
          "↓ Excel（上部バー）→ 現在のフォルダをxlsxに保存します。",
          "↑ Import（上部バー）→ xlsxを選択 → 現在のフォルダに追加されます（既存データは保持）。",
          "Importの列: Type(Header/Todo/Text), Title, Body, Done, Starred, Date",
          "設定(⚙) → Backup → ↓ 全データバックアップで全フォルダ+Worklogを一括保存できます。",
        ],
        ui: { label: "上部ツールバー", items: ["🔍  Select  ↓ Excel  ↑ Import  [+]"] }
      },
      {
        icon: "🗑️", title: "ゴミ箱 & 復元",
        desc: "× で削除した項目は30日間ゴミ箱に保管されます。",
        tips: [
          "サイドバーのTrashをクリックすると削除済み一覧が表示されます。",
          "Restoreで元のフォルダに復元できます。",
          "Deleteで完全削除します。",
          "Empty allでゴミ箱を空にします。",
        ],
        ui: { label: "ゴミ箱画面", items: ["□ 全選択  Restore(2)  Delete(2)  Empty all","□ 削除済み項目  元:Work  残り12日  Restore  Delete"] }
      },
      {
        icon: "⚙️", title: "設定",
        desc: "サイドバー下部の ⚙ ボタンをクリックすると設定が開きます。",
        tips: [
          "Account — ログインアカウントと同期状態を確認できます。",
          "Backup — ↓ 全データバックアップ（Excel）で全フォルダ+Worklogをまとめて保存します。",
          "Sign Out — ログアウトします（ログアウト前に自動保存されます）。",
          "お問い合わせ・不具合報告: duholee79@gmail.com",
        ],
        ui: { label: "設定パネル", items: ["⚙ Settings","ACCOUNT  bauman / duholee79@gmail.com  ✅ Synced","BACKUP  ↓ 全データバックアップ（Excel）","DANGER ZONE  Sign Out  Delete Account"] }
      },
    ]
  }
};

function ManualView({ isMobile }) {
  const [lang, setLang] = useState("ko");
  const C = MANUAL_CONTENT[lang];

  // PDF 생성 (html2canvas 없이 CSS print 방식)
  const handlePdfDownload = () => {
    const printContent = document.getElementById("manual-print-area");
    if (!printContent) return;
    const w = window.open("", "_blank", "width=900,height=1200");
    w.document.write(`
      <!DOCTYPE html><html><head>
      <meta charset="UTF-8">
      <title>theNOTES Manual (${C.lang})</title>
      <style>
        body { font-family: 'Segoe UI', 'Helvetica Neue', Arial, sans-serif; margin: 40px; color: #1e3a6e; line-height: 1.7; }
        h1 { font-size: 26px; color: #2563eb; margin-bottom: 6px; }
        .sub { font-size: 14px; color: #6b8bb5; margin-bottom: 36px; }
        .section { margin-bottom: 32px; page-break-inside: avoid; }
        .section-title { font-size: 17px; font-weight: 700; color: #1e3a6e; margin-bottom: 8px; display: flex; align-items: center; gap: 8px; }
        .desc { font-size: 13.5px; color: #4b6fa8; margin-bottom: 10px; }
        .tips li { font-size: 13px; color: #374151; margin-bottom: 5px; }
        .ui-box { background: #f0f5ff; border-radius: 8px; padding: 12px 16px; margin-top: 10px; font-family: monospace; font-size: 12px; color: #374151; }
        .ui-label { font-size: 11px; font-weight: 700; color: #6b8bb5; letter-spacing: 1px; text-transform: uppercase; margin-bottom: 6px; }
        .ui-item { padding: 3px 0; border-bottom: 1px solid #e0eaf8; }
        .ui-item:last-child { border-bottom: none; }
        hr { border: none; border-top: 1px solid #e0eaf8; margin: 28px 0; }
        @media print { body { margin: 20px; } }
      </style></head><body>
      <h1>📖 ${C.title}</h1>
      <div class="sub">${C.subtitle}</div>
      ${C.sections.map((s, i) => `
        ${i > 0 ? "<hr>" : ""}
        <div class="section">
          <div class="section-title">${s.icon} ${s.title}</div>
          <div class="desc">${s.desc}</div>
          <ul class="tips">${s.tips.map(t => `<li>${t}</li>`).join("")}</ul>
          <div class="ui-box">
            <div class="ui-label">${s.ui.label}</div>
            ${s.ui.items.map(item => `<div class="ui-item">${item}</div>`).join("")}
          </div>
        </div>
      `).join("")}
      <hr>
      <div style="font-size:11px;color:#94a3b8;text-align:center;margin-top:16px">theNOTES · BAUMAN · duholee79@gmail.com</div>
      </body></html>
    `);
    w.document.close();
    setTimeout(() => { w.print(); }, 400);
  };

  return (
    <div style={{ display:"flex", flexDirection:"column", height:"100%", background:"#f8faff" }}>
      {/* 헤더 */}
      <div style={{ background:"linear-gradient(135deg,#2563eb,#1650b8)", padding: isMobile?"20px 18px 16px":"24px 40px 20px", flexShrink:0 }}>
        <div style={{ display:"flex", alignItems:"flex-start", justifyContent:"space-between", gap:12, flexWrap:"wrap" }}>
          <div style={{ flex:1, minWidth:0 }}>
            <div style={{ fontSize: isMobile?20:24, fontWeight:800, color:"#fff", marginBottom:4 }}>📖 {C.title}</div>
            {C.subtitle && <div style={{ fontSize:12.5, color:"rgba(255,255,255,.7)", lineHeight:1.6 }}>{C.subtitle}</div>}
          </div>
          <div style={{ display:"flex", alignItems:"center", gap:8, flexShrink:0, flexWrap:"wrap" }}>
            {/* 언어 선택 */}
            <div style={{ display:"flex", gap:4 }}>
              {[["ko","KO"],["en","EN"],["ja","JA"]].map(([l,label]) => (
                <button key={l}
                  style={{ padding:"6px 12px", borderRadius:8, border:"none", cursor:"pointer", fontFamily:"inherit", fontSize:12, fontWeight:700,
                    background: lang===l ? "#fff" : "rgba(255,255,255,.15)",
                    color: lang===l ? "#2563eb" : "rgba(255,255,255,.8)",
                    boxShadow: lang===l ? "0 2px 8px rgba(0,0,0,.15)" : "none",
                    transition:"all .15s" }}
                  onClick={() => setLang(l)}>{label}</button>
              ))}
            </div>
            {/* PDF 다운로드 */}
            <button
              style={{ display:"flex", alignItems:"center", gap:6, padding:"7px 14px", borderRadius:8, border:"none", cursor:"pointer", fontFamily:"inherit", fontSize:12, fontWeight:700, background:"rgba(255,255,255,.95)", color:"#2563eb", boxShadow:"0 2px 8px rgba(0,0,0,.2)" }}
              onClick={handlePdfDownload}>
              <span>↓</span> PDF
            </button>
          </div>
        </div>
      </div>

      {/* 섹션 목차 (번호 네비) */}
      <div style={{ background:"#fff", borderBottom:"1px solid #e0eaf8", padding: isMobile?"8px 10px":"10px 40px", display:"flex", gap:isMobile?2:6, flexWrap:"wrap", flexShrink:0, overflowX:"auto" }}>
        {C.sections.map((s, i) => (
          <a key={i} href={`#ms-${i}`}
            title={s.title}
            style={{ fontSize:isMobile?16:11.5, color:"#4b6fa8", background:"#eff6ff", borderRadius:20,
              padding: isMobile?"6px 8px":"3px 10px",
              textDecoration:"none", fontWeight:600, whiteSpace:"nowrap", lineHeight:1 }}>
            {/* 모바일: 아이콘만, PC: 아이콘 + 텍스트 */}
            {isMobile ? s.icon : `${s.icon} ${s.title}`}
          </a>
        ))}
      </div>

      {/* 본문 */}
      <div id="manual-print-area" style={{ flex:1, overflowY:"auto", padding: isMobile?"16px":"32px 40px 60px" }}>
        {C.sections.map((s, i) => (
          <div key={i} id={`ms-${i}`} style={{ marginBottom:36, background:"#fff", borderRadius:14, boxShadow:"0 2px 12px rgba(15,32,68,.06)", overflow:"hidden" }}>
            {/* 섹션 헤더 */}
            <div style={{ background:"linear-gradient(90deg,rgba(37,99,235,.07),rgba(37,99,235,.02))", borderLeft:"4px solid #2563eb", padding:"16px 20px 12px" }}>
              <div style={{ display:"flex", alignItems:"center", gap:10 }}>
                <span style={{ fontSize:22 }}>{s.icon}</span>
                <div>
                  <div style={{ fontSize:16, fontWeight:700, color:"#1e3a6e" }}>{i+1}. {s.title}</div>
                  <div style={{ fontSize:12.5, color:"#6b8bb5", marginTop:2, lineHeight:1.5 }}>{s.desc}</div>
                </div>
              </div>
            </div>
            {/* 본문 */}
            <div style={{ padding:"14px 20px 16px", display:"flex", gap:20, flexWrap:"wrap" }}>
              {/* Tips */}
              <div style={{ flex:"1 1 280px", minWidth:0 }}>
                <div style={{ fontSize:11, fontWeight:700, color:"#94a3b8", letterSpacing:"1px", textTransform:"uppercase", marginBottom:8 }}>Tips</div>
                {s.tips.map((tip, ti) => (
                  <div key={ti} style={{ display:"flex", gap:8, marginBottom:7, fontSize:13, color:"#374151", lineHeight:1.6 }}>
                    <span style={{ color:"#2563eb", fontWeight:700, flexShrink:0, marginTop:1 }}>•</span>
                    <span>{tip}</span>
                  </div>
                ))}
              </div>
              {/* UI 미리보기 */}
              <div style={{ flex:"0 0 auto", minWidth: isMobile?"100%":260 }}>
                <div style={{ fontSize:11, fontWeight:700, color:"#94a3b8", letterSpacing:"1px", textTransform:"uppercase", marginBottom:8 }}>{s.ui.label}</div>
                <div style={{ background:"#f0f5ff", borderRadius:10, border:"1px solid #dbeafe", overflow:"hidden" }}>
                  <div style={{ background:"linear-gradient(90deg,#2563eb,#1a5fd4)", padding:"6px 12px" }}>
                    <div style={{ display:"flex", gap:5 }}>
                      {[0,1,2].map(k => <div key={k} style={{ width:8,height:8,borderRadius:"50%",background:"rgba(255,255,255,.4)" }}/>)}
                    </div>
                  </div>
                  <div style={{ padding:"10px 12px" }}>
                    {s.ui.items.map((item, ii) => (
                      <div key={ii} style={{ fontFamily:"'SF Mono','Courier New',monospace", fontSize:11.5, color:"#1e3a6e", padding:"4px 6px", marginBottom:2, background: ii%2===0?"#e8f0fe":"transparent", borderRadius:5, lineHeight:1.5, wordBreak:"break-all" }}>
                        {item}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </div>
        ))}
        {/* 푸터 */}
        <div style={{ textAlign:"center", padding:"20px 0 10px", fontSize:11, color:"#94a3b8" }}>
          theNOTES · BAUMAN · duholee79@gmail.com
        </div>
      </div>
    </div>
  );
}

// ─── UpcomingView ─────────────────────────────────────────
function UpcomingView({ items, folders, onSelectFolder }) {
  const today = mkDate();
  const todayD = new Date(); todayD.setHours(0,0,0,0);
  const tomorrow = new Date(todayD); tomorrow.setDate(tomorrow.getDate()+1);
  const weekEnd  = new Date(todayD); weekEnd.setDate(weekEnd.getDate()+7);

  const parseDate = d => {
    if (!d) return null;
    const [y,m,day] = d.split(".").map(Number);
    const dt = new Date(y, m-1, day); dt.setHours(0,0,0,0);
    return dt;
  };

  const dueTodos = items
    .filter(i => !i.deletedAt && i.type === T.TODO && i.dueDate)
    .sort((a,b) => a.dueDate.localeCompare(b.dueDate));

  const groups = [
    { key:"overdue", label:"⚠️ 기한 초과", color:"#ef4444", bg:"#fff1f2", items: dueTodos.filter(i => { const d=parseDate(i.dueDate); return d && d < todayD; }) },
    { key:"today",   label:"📅 오늘",      color:"#f59e0b", bg:"#fffbeb", items: dueTodos.filter(i => { const d=parseDate(i.dueDate); return d && d.getTime()===todayD.getTime(); }) },
    { key:"tmrow",   label:"🌅 내일",      color:"#2563eb", bg:"#eff6ff", items: dueTodos.filter(i => { const d=parseDate(i.dueDate); return d && d.getTime()===tomorrow.getTime(); }) },
    { key:"week",    label:"📆 이번 주",   color:"#059669", bg:"#f0fdf4", items: dueTodos.filter(i => { const d=parseDate(i.dueDate); return d && d > tomorrow && d <= weekEnd; }) },
    { key:"later",   label:"🗓 이후",      color:"#6b7280", bg:"#f9fafb", items: dueTodos.filter(i => { const d=parseDate(i.dueDate); return d && d > weekEnd; }) },
  ].filter(g => g.items.length > 0);

  if (dueTodos.length === 0) return (
    <div style={{ display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", height:"60%", color:"#b0c4de" }}>
      <div style={{ fontSize:36, marginBottom:10 }}>📅</div>
      <div style={{ fontSize:13 }}>마감기한이 설정된 항목이 없습니다.</div>
      <div style={{ fontSize:11, marginTop:6, color:"#c0d0e4" }}>To-do의 ⋯ 버튼 → Due Date로 마감기한을 설정하세요.</div>
    </div>
  );

  return (
    <div style={{ padding:"16px 36px 40px", overflowY:"auto", height:"100%" }}>
      <div style={{ fontSize:13, color:"#6b8bb5", marginBottom:20 }}>
        마감기한이 설정된 To-do {dueTodos.length}개
      </div>
      {groups.map(g => (
        <div key={g.key} style={{ marginBottom:28 }}>
          <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:8 }}>
            <span style={{ fontSize:13, fontWeight:700, color:g.color }}>{g.label}</span>
            <span style={{ fontSize:11, color:g.color, background:g.bg, borderRadius:20, padding:"1px 8px", fontWeight:700 }}>{g.items.length}</span>
          </div>
          {g.items.map(item => {
            const folder = folders.find(f => f.id===item.folder);
            return (
              <div key={item.id}
                style={{ display:"flex", alignItems:"center", gap:10, background:"#fff",
                  borderRadius:10, padding:"10px 14px", marginBottom:4,
                  boxShadow:"0 1px 4px rgba(15,32,68,.06)",
                  borderLeft:`3px solid ${g.color}`, cursor:"pointer" }}
                onClick={() => onSelectFolder(item.folder)}>
                <div style={{ width:16, height:16, borderRadius:4, border:`1.5px solid ${item.done?"#2563eb":"#c2d0e8"}`,
                  background: item.done?"#2563eb":"transparent", flexShrink:0, display:"flex", alignItems:"center", justifyContent:"center" }}>
                  {item.done && <span style={{ color:"#fff", fontSize:10, fontWeight:700 }}>✓</span>}
                </div>
                {item.starred && <span style={{ color:"#f59e0b", fontSize:11, flexShrink:0 }}>★</span>}
                <span style={{ flex:1, fontSize:13.5, color: item.done?"#96acc8":"#1e3a6e",
                  textDecoration: item.done?"line-through":"none",
                  overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                  {item.title || "(제목 없음)"}
                </span>
                <span style={{ fontSize:11, color:g.color, fontWeight:700, flexShrink:0 }}>📅 {item.dueDate}</span>
                {folder && <span style={{ fontSize:11, color:"#94a3b8", flexShrink:0, maxWidth:80, overflow:"hidden", textOverflow:"ellipsis" }}>{folder.name}</span>}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

function TrashView({ items, onRestore, onPermDel, onEmpty }) {
  const [sel, setSel] = useState(new Set());
  const trash = items.filter(i => i.deletedAt);
  const togSel = id => setSel(prev => { const n=new Set(prev); n.has(id)?n.delete(id):n.add(id); return n; });
  const allSel = trash.length > 0 && sel.size === trash.length;
  const left = ts => Math.max(0, TRASH_DAYS - daysAgo(ts));
  return (
    <div>
      {trash.length > 0 && (
        <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:12, flexWrap:"wrap", gap:8 }}>
          <div style={{ display:"flex", alignItems:"center", gap:8, cursor:"pointer" }}
            onClick={() => setSel(allSel ? new Set() : new Set(trash.map(i=>i.id)))}>
            <div style={{ width:17, height:17, borderRadius:4, border:"1.5px solid #c2d0e8", display:"flex", alignItems:"center", justifyContent:"center", fontSize:11, color:"#fff", fontWeight:700, ...(allSel?{background:"#2563eb",borderColor:"#2563eb"}:{}) }}>
              {allSel && "✓"}
            </div>
            <span style={{ fontSize:12, color:"#6b8bb5" }}>Select all</span>
          </div>
          <div style={{ display:"flex", gap:6 }}>
            {sel.size > 0 && (
              <>
                <button style={{ background:"none", border:"1px solid #bfdbfe", borderRadius:7, padding:"5px 11px", fontSize:12, cursor:"pointer", fontFamily:"inherit", fontWeight:600, color:"#2563eb" }}
                  onClick={() => { sel.forEach(id => onRestore(id)); setSel(new Set()); }}>Restore ({sel.size})</button>
                <button style={{ background:"none", border:"1px solid #fecaca", borderRadius:7, padding:"5px 11px", fontSize:12, cursor:"pointer", fontFamily:"inherit", fontWeight:600, color:"#e53e3e" }}
                  onClick={() => { sel.forEach(id => onPermDel(id)); setSel(new Set()); }}>Delete ({sel.size})</button>
              </>
            )}
            <button style={{ background:"none", border:"1px solid #e5e7eb", borderRadius:7, padding:"5px 11px", fontSize:12, cursor:"pointer", fontFamily:"inherit", fontWeight:600, color:"#9ca3af" }}
              onClick={() => { onEmpty(); setSel(new Set()); }}>Empty all</button>
          </div>
        </div>
      )}
      {trash.length === 0 && (
        <div style={{ display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", padding:"80px 0", color:"#b0c4de" }}>
          <div style={{ fontSize:32, marginBottom:10 }}>🗑</div>
          <div style={{ fontSize:13 }}>Trash is empty.</div>
        </div>
      )}
      {trash.map(item => {
        const isSel = sel.has(item.id);
        const l = left(item.deletedAt);
        return (
          <div key={item.id} style={{ display:"flex", alignItems:"center", gap:10, background:isSel?"#eff6ff":"#fff", borderRadius:10, padding:"12px 14px", marginBottom:5, boxShadow:isSel?"0 0 0 1.5px #93c5fd":"0 1px 3px rgba(15,32,68,.05)" }}>
            <div style={{ width:17, height:17, borderRadius:4, border:"1.5px solid #c2d0e8", display:"flex", alignItems:"center", justifyContent:"center", fontSize:11, color:"#fff", fontWeight:700, cursor:"pointer", flexShrink:0, ...(isSel?{background:"#2563eb",borderColor:"#2563eb"}:{}) }}
              onClick={() => togSel(item.id)}>{isSel && "✓"}</div>
            <div style={{ flex:1, minWidth:0 }}>
              <div style={{ fontSize:13.5, color:"#4b5563", fontWeight:500, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", textDecoration:"line-through" }}>{item.title||"(no title)"}</div>
              <div style={{ fontSize:10, color:l<=3?"#e53e3e":"#9ca3af", marginTop:2 }}>
                {l===0?"Deleted today":`Auto-delete in ${l} days`} · {item.originalFolderName||"Unknown folder"}
              </div>
            </div>
            <button style={{ background:"none", border:"1px solid #bfdbfe", borderRadius:7, color:"#2563eb", fontSize:11.5, padding:"4px 10px", cursor:"pointer", fontFamily:"inherit", fontWeight:600, flexShrink:0 }}
              onClick={() => onRestore(item.id)}>Restore</button>
            <button style={{ background:"none", border:"none", color:"#d0ddef", fontSize:18, cursor:"pointer", padding:"0 2px", flexShrink:0 }}
              onClick={() => onPermDel(item.id)}>×</button>
          </div>
        );
      })}
      <div style={{ fontSize:11, color:"#c0c8d8", textAlign:"center", marginTop:16, lineHeight:1.6 }}>Items are permanently deleted after {TRASH_DAYS} days.</div>
    </div>
  );
}

// ─── SwipeFolder: single folder row with swipe-to-delete ──
// ─── Sidebar ──────────────────────────────────────────────
// ─── FolderRow: hover-to-edit hint ───────────────────────
function FolderRow({ item, index, NI, isActive, handle, onSelect, onDelete, focusNewId, setSidebarItems }) {
  const [hovered, setHovered] = useState(false);
  const [showPicker, setShowPicker] = useState(false);
  const pickerRef = useRef(null);

  // 색상 팔레트
  const COLORS = ["#94a3b8","#f87171","#fb923c","#facc15","#4ade80","#38bdf8","#818cf8","#f472b6","#a78bfa","#34d399"];
  // 이모지 프리셋
  const EMOJIS = ["","📁","💼","🏠","📚","🎯","⚡","🔧","🌟","💡","📝","🎨","🚀","💰","📊"];

  const curColor = item.color || "#94a3b8";
  const curEmoji = item.emoji || "";

  useEffect(() => {
    if (!showPicker) return;
    const close = e => {
      if (!pickerRef.current?.contains(e.target)) setShowPicker(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [showPicker]);

  return (
    <div key={item.id} data-sortidx={index}
      style={{ ...NI, color: isActive?"#fff":"rgba(255,255,255,.6)",
        background: isActive?"rgba(255,255,255,.12)":"transparent",
        position:"relative" }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={() => onSelect(item.id)}>
      {/* 폴더 아이콘 — 클릭해서 color/emoji 변경 */}
      <span
        title="색상·아이콘 변경"
        style={{ fontSize: curEmoji ? 13 : 11, width:16, flexShrink:0,
          color: curEmoji ? "inherit" : (isActive ? "rgba(255,255,255,.9)" : curColor),
          cursor:"pointer", lineHeight:1 }}
        onMouseDown={e => { e.stopPropagation(); setShowPicker(v=>!v); }}>
        {curEmoji || "●"}
      </span>

      {/* 색상/이모지 피커 팝업 */}
      {showPicker && (
        <div ref={pickerRef}
          style={{ position:"absolute", left:20, top:"100%", zIndex:9999,
            background:"#1a2d54", borderRadius:12, padding:"10px 12px",
            boxShadow:"0 8px 28px rgba(0,0,0,.4)", width:200, marginTop:2 }}
          onMouseDown={e => e.stopPropagation()}>
          {/* 색상 */}
          <div style={{ fontSize:10, color:"rgba(255,255,255,.5)", marginBottom:6, letterSpacing:"1px", textTransform:"uppercase" }}>Color</div>
          <div style={{ display:"flex", flexWrap:"wrap", gap:4, marginBottom:10 }}>
            {COLORS.map(c => (
              <div key={c}
                style={{ width:20, height:20, borderRadius:"50%", background:c, cursor:"pointer",
                  border: curColor===c ? "2px solid #fff" : "2px solid transparent" }}
                onMouseDown={() => setSidebarItems(prev => prev.map(i => i.id===item.id ? {...i,color:c} : i))}/>
            ))}
          </div>
          {/* 이모지 */}
          <div style={{ fontSize:10, color:"rgba(255,255,255,.5)", marginBottom:6, letterSpacing:"1px", textTransform:"uppercase" }}>Icon</div>
          <div style={{ display:"flex", flexWrap:"wrap", gap:4 }}>
            {EMOJIS.map((em,idx) => (
              <div key={idx}
                style={{ width:24, height:24, borderRadius:5, display:"flex", alignItems:"center", justifyContent:"center",
                  fontSize: em ? 14 : 11, cursor:"pointer",
                  background: curEmoji===em ? "rgba(255,255,255,.2)" : "transparent",
                  color:"rgba(255,255,255,.8)" }}
                onMouseDown={() => { setSidebarItems(prev => prev.map(i => i.id===item.id ? {...i,emoji:em} : i)); }}>
                {em || "—"}
              </div>
            ))}
          </div>
        </div>
      )}

      {focusNewId === item.id
        ? <input data-focusid={item.id}
            value={item.name}
            onChange={e => setSidebarItems(prev => prev.map(i => i.id===item.id?{...i,name:e.target.value}:i))}
            onClick={e => e.stopPropagation()}
            style={{ flex:1, fontSize:13.5, background:"transparent", border:"none", borderBottom:"1px solid rgba(255,255,255,.3)", outline:"none", color:"inherit", fontFamily:"inherit", fontWeight:500, minWidth:0 }} />
        : <span style={{ flex:1, fontSize:13.5, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{item.name}</span>
      }
      {hovered && !isActive && (
        <span style={{ fontSize:10, color:"rgba(255,255,255,.3)", flexShrink:0, marginRight:2 }}>✎</span>
      )}
      <span
        style={{ color:"rgba(255,120,120,.45)", fontSize:15, lineHeight:1, cursor:"pointer",
          padding:"0 3px", flexShrink:0,
          opacity: hovered ? 1 : 0, transition:"opacity .15s" }}
        title="Delete folder"
        onMouseDown={e => { e.stopPropagation(); onDelete(); }}>×</span>
      {handle}
    </div>
  );
}

function SidebarInner({ sidebarItems, setSidebarItems, activeFolder, onSelect, onAddItem, user, onLogin, onLogout, trashCount, syncStatus, activeSidebarId, focusNewId, onFocusDone, allItems, allWorklogs }) {
  const [showAdd,      setShowAdd]      = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(null);
  // Auto-focus new item
  useEffect(() => {
    if (!focusNewId) return;
    setTimeout(() => {
      const el = document.querySelector(`[data-focusid="${focusNewId}"]`);
      if (el) { el.focus(); el.select?.(); onFocusDone?.(); }
    }, 80);
  }, [focusNewId]);
  const [collapsedSB, setCollapsedSB] = useState(() => {
    try {
      const saved = localStorage.getItem("notes_collapsedSB");
      return saved ? new Set(JSON.parse(saved)) : new Set();
    } catch { return new Set(); }
  });
  const toggleSB = id => setCollapsedSB(prev => {
    const n = new Set(prev);
    n.has(id) ? n.delete(id) : n.add(id);
    try { localStorage.setItem("notes_collapsedSB", JSON.stringify([...n])); } catch {}
    return n;
  });
  const containerRef = useRef(null);
  const { beginDrag } = useSortable(containerRef, sidebarItems, setSidebarItems);
  const NI = { display:"flex", alignItems:"center", gap:8, padding:"9px 12px", borderRadius:8, cursor:"pointer", fontWeight:500, marginBottom:1, userSelect:"none" };

  const deleteFolder = (item) => {
    setSidebarItems(prev => prev.filter(i => i.id !== item.id));
    setConfirmDelete(null);
  };

  return (
    <>
      <div style={{ padding:"44px 22px 20px", borderBottom:"1px solid rgba(255,255,255,.12)", flexShrink:0 }}>
        <div style={{ lineHeight:1 }}>
          <span style={{ color:"rgba(255,255,255,.65)", fontSize:13, fontWeight:300, letterSpacing:"0.5px", fontStyle:"italic", display:"block", marginBottom:2 }}>the</span>
          <span style={{ color:"#ffffff", fontSize:26, fontWeight:900, letterSpacing:"3px", fontFamily:"'Arial Black','Helvetica Neue',sans-serif", textTransform:"uppercase", display:"block" }}>NOTES</span>
        </div>
      </div>

      <nav ref={containerRef} style={{ padding:"10px 10px", flex:1, overflowY:"auto" }}
        onClick={() => setShowAdd(false)}>
        {(() => {
          // Determine which items are hidden under a collapsed sheader
          let currentSH = null;
          const visMap = sidebarItems.map((item, index) => {
            if (item.type === "sheader") { currentSH = item; return { item, index, visible: true }; }
            const hidden = currentSH && collapsedSB.has(currentSH.id) && item.type !== "sheader";
            return { item, index, visible: !hidden };
          });
          return visMap.map(({ item, index, visible }) => {
          if (!visible) return null;
          const handle = (
            <span
              data-handle="1"
              style={{ color:"rgba(255,255,255,.25)", fontSize:16, cursor:"grab", padding:"0 4px", flexShrink:0, touchAction:"none", userSelect:"none", lineHeight:1 }}
              onMouseDown={e => beginDrag(e, index)}
              onTouchStart={e => { const t=e.touches[0]; beginDrag({clientY:t.clientY,touches:e.touches,preventDefault:()=>e.preventDefault(),stopPropagation:()=>e.stopPropagation()}, index); }}>
              ⠿
            </span>
          );

          if (item.type === "sheader") return (
            <div key={item.id} data-sortidx={index} style={{ display:"flex", alignItems:"center", gap:4, padding:"10px 12px 4px", userSelect:"none" }}>
              <button
                style={{ background:"none", border:"none", color:"rgba(255,255,255,.6)", fontSize:22, cursor:"pointer", flexShrink:0, transition:"transform .2s", transform:collapsedSB.has(item.id)?"rotate(-90deg)":"rotate(0deg)", width:36, height:36, display:"flex", alignItems:"center", justifyContent:"center", padding:0, borderRadius:6, touchAction:"manipulation" }}
                onMouseDown={e => { e.stopPropagation(); toggleSB(item.id); }}
                onTouchEnd={e => { e.preventDefault(); e.stopPropagation(); toggleSB(item.id); }}>▾</button>
              <input
                data-focusid={item.id}
                value={item.label}
                onChange={e => setSidebarItems(prev => prev.map(i => i.id===item.id ? {...i, label:e.target.value} : i))}
                onClick={e => e.stopPropagation()}
                style={{ flex:1, background:"transparent", border:"none", outline:"none", fontFamily:"inherit", fontSize:12, fontWeight:700, color:"rgba(255,255,255,.45)", letterSpacing:"1.5px", textTransform:"uppercase", cursor:"text", minWidth:0 }}
                placeholder="SECTION" />
              <span style={{ color:"rgba(255,120,120,.4)", fontSize:14, cursor:"pointer", lineHeight:1, padding:"0 2px", flexShrink:0 }}
                onMouseDown={e => { e.stopPropagation(); setSidebarItems(prev => prev.filter(i => i.id !== item.id)); }}>×</span>
              {handle}
            </div>
          );
          if (item.type === "divider") return (
            <div key={item.id} data-sortidx={index} style={{ padding:"6px 12px", userSelect:"none", display:"flex", alignItems:"center", gap:4 }}>
              <div style={{ flex:1, height:1, background:"rgba(255,255,255,.12)", borderRadius:1 }} />
              <span
                style={{ color:"rgba(255,120,120,.45)", fontSize:14, lineHeight:1, cursor:"pointer", padding:"0 2px", flexShrink:0 }}
                onMouseDown={e => { e.stopPropagation(); setSidebarItems(prev => prev.filter(i => i.id !== item.id)); }}>×</span>
              {handle}
            </div>
          );
          if (item.type === "folder") return (
            <FolderRow key={item.id} item={item} index={index} NI={NI}
              isActive={activeFolder===item.id}
              handle={handle}
              onSelect={onSelect}
              onDelete={() => setConfirmDelete(item)}
              focusNewId={focusNewId}
              setSidebarItems={setSidebarItems} />
          );
          return null;
        });
        })()}

        <div style={{ marginTop:8, paddingTop:8, borderTop:"1px solid rgba(255,255,255,.08)" }}>
          {[
            { id:NOTICE_ID,   label:"Notice",   icon:"★",  ac:"#fde68a",  ic:"rgba(255,220,80,.65)" },
            { id:UPCOMING_ID, label:"Upcoming",  icon:"📅", ac:"#fecdd3",  ic:"rgba(251,113,133,.65)" },
            { id:CALENDAR_ID, label:"Calendar", icon:"◷",  ac:"#a5f3fc",  ic:"rgba(125,211,252,.65)" },
            { id:WORKLOG_ID,  label:"Worklog",  icon:"📋", ac:"#c4b5fd",  ic:"rgba(167,139,250,.7)" },
            { id:TRASH_ID,    label:"Trash",    icon:"🗑", ac:"#fca5a5",  ic:"rgba(252,165,165,.7)", badge:trashCount },
            { id:MANUAL_ID,   label:"Manual",   icon:"📖", ac:"#bbf7d0",  ic:"rgba(134,239,172,.7)" },
          ].map(f => (
            <div key={f.id}
              style={{ ...NI, ...(activeFolder===f.id ? {background:"rgba(255,255,255,.12)",color:f.ac} : {color:f.ic}) }}
              onClick={() => onSelect(f.id)}>
              <span style={{ fontSize:11, width:16 }}>{f.icon}</span>
              <span style={{ flex:1, fontSize:13.5 }}>{f.label}</span>
              {f.badge > 0 && <span style={{ background:"rgba(252,165,165,.25)", color:"rgba(252,165,165,.9)", borderRadius:10, padding:"1px 6px", fontSize:10, fontWeight:700 }}>{f.badge}</span>}
            </div>
          ))}
        </div>
      </nav>

      {/* Folder delete confirmation modal */}
      {confirmDelete && (
        <div style={{ position:"fixed", inset:0, background:"rgba(10,20,50,.55)", display:"flex", alignItems:"center", justifyContent:"center", zIndex:900 }}
          onClick={() => setConfirmDelete(null)}>
          <div style={{ background:"#fff", borderRadius:18, padding:"28px 24px 22px", width:280, boxShadow:"0 16px 48px rgba(15,32,68,.28)", textAlign:"center" }}
            onClick={e => e.stopPropagation()}>
            <div style={{ fontSize:36, marginBottom:8 }}>🗑</div>
            <div style={{ fontSize:15, fontWeight:700, color:"#0f2044", marginBottom:8 }}>Delete Folder</div>
            <div style={{ fontSize:13, color:"#6b8bb5", marginBottom:22, lineHeight:1.6 }}>
              <span style={{ fontWeight:700, color:"#1e3a6e" }}>"{confirmDelete.name}"</span> Are you sure you want to delete this folder?<br/>
              Notes inside will not be deleted.
            </div>
            <div style={{ display:"flex", gap:10 }}>
              <button style={{ flex:1, padding:"11px", borderRadius:10, border:"1.5px solid #e0eaf8", background:"transparent", color:"#6b8bb5", fontSize:14, cursor:"pointer", fontFamily:"inherit", fontWeight:600 }}
                onClick={() => setConfirmDelete(null)}>Cancel</button>
              <button style={{ flex:1, padding:"11px", borderRadius:10, border:"none", background:"#e53e3e", color:"#fff", fontSize:14, cursor:"pointer", fontFamily:"inherit", fontWeight:700, boxShadow:"0 4px 12px rgba(229,62,62,.3)" }}
                onClick={() => deleteFolder(confirmDelete)}>Delete</button>
            </div>
          </div>
        </div>
      )}

      {/* close showAdd when clicking outside */}
      {showAdd && <div style={{ position:"fixed", inset:0, zIndex:150 }} onClick={() => setShowAdd(false)} />}

      {/* ── Settings Panel ── */}
      {showSettings && (
        <div style={{ position:"fixed", inset:0, background:"rgba(10,20,50,.6)", zIndex:800, display:"flex", alignItems:"flex-end", justifyContent:"flex-start" }}
          onClick={() => setShowSettings(false)}>
          <div style={{ width:320, maxWidth:"100vw", background:"#fff", borderRadius:"0 18px 0 0", padding:"28px 24px 36px", boxShadow:"4px 0 40px rgba(15,32,68,.25)", maxHeight:"90vh", overflowY:"auto" }}
            onClick={e => e.stopPropagation()}>
            <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:24 }}>
              <div style={{ fontSize:18, fontWeight:700, color:"#0f2044" }}>⚙ Settings</div>
              <span style={{ fontSize:22, cursor:"pointer", color:"#94a3b8", lineHeight:1 }} onClick={() => setShowSettings(false)}>×</span>
            </div>

            <div style={{ fontSize:11, fontWeight:700, color:"#94a3b8", letterSpacing:"1px", textTransform:"uppercase", marginBottom:8 }}>Account</div>
            <div style={{ background:"#f8faff", borderRadius:12, padding:"14px 16px", marginBottom:20 }}>
              <div style={{ fontSize:13, color:"#1e3a6e", fontWeight:600, marginBottom:4 }}>{user?.name || "Not signed in"}</div>
              <div style={{ fontSize:12, color:"#6b8bb5", marginBottom:4 }}>{user?.email || "Sign in to syncnc your notes"}</div>
              {syncStatus==="saved" && <div style={{ fontSize:11, color:"#16a34a" }}>✅ Google Drive synced</div>}
              {syncStatus==="saving" && <div style={{ fontSize:11, color:"#ca8a04" }}>⏳ Saving...</div>}
              {syncStatus==="error" && <div style={{ fontSize:11, color:"#dc2626", cursor:"pointer" }} onClick={onLogin}>❌ Token expired — tap to re-login</div>}
            </div>

            <div style={{ fontSize:11, fontWeight:700, color:"#94a3b8", letterSpacing:"1px", textTransform:"uppercase", marginBottom:8 }}>App Features</div>
            <div style={{ background:"#f8faff", borderRadius:12, padding:"14px 16px", marginBottom:20, lineHeight:1.9 }}>
              {[
                ["🔐", "Google Login", "Sign in with your Google account — no separate password needed."],
                ["☁️", "Auto Cloud Save", "All notes are automatically saved to your personal Google Drive in real time."],
                ["📁", "Private Storage", "Your data is stored only in your own Drive. No one else can access it."],
                ["📱", "Any Device", "Access from any browser — desktop, tablet, or mobile."],
                ["📋", "Worklog", "Track daily work and link entries to your project folders."],
                ["📅", "Calendar View", "See all notes and tasks organized by date."],
                ["⭐", "Offline Resilient", "Works seamlessly; syncs back to Drive when connected."],
              ].map(([icon, title, desc]) => (
                <div key={title} style={{ display:"flex", gap:12, paddingBottom:12, marginBottom:12, borderBottom:"1px solid #eef3ff" }}>
                  <span style={{ fontSize:18, flexShrink:0, marginTop:1 }}>{icon}</span>
                  <div>
                    <div style={{ fontSize:12.5, fontWeight:700, color:"#1e3a6e", marginBottom:2 }}>{title}</div>
                    <div style={{ fontSize:12, color:"#6b8bb5", lineHeight:1.6 }}>{desc}</div>
                  </div>
                </div>
              ))}
            </div>

            <div style={{ fontSize:11, fontWeight:700, color:"#94a3b8", letterSpacing:"1px", textTransform:"uppercase", marginBottom:8 }}>How to Use</div>
            <div style={{ background:"#f8faff", borderRadius:12, padding:"14px 16px", marginBottom:20, fontSize:12.5, color:"#4b6fa8", lineHeight:1.9 }}>
              <div>• <b>Folders</b> — organize notes by project</div>
              <div>• <b>Header</b> — group items inside a folder</div>
              <div>• <b>To-do</b> — press Enter to add next task</div>
              <div>• <b>Text</b> — rich notes with sections, tables, links</div>
              <div>• <b>Worklog</b> — daily log linked to folders</div>
              <div>• <b>Calendar</b> — view all items by date</div>
              <div>• <b>⠿</b> — drag to reorder</div>
              <div>• <b>★</b> — star items to see in Notice</div>
            </div>

            <div style={{ fontSize:11, fontWeight:700, color:"#94a3b8", letterSpacing:"1px", textTransform:"uppercase", marginBottom:8 }}>About</div>
            <div style={{ background:"#f8faff", borderRadius:12, padding:"14px 16px", marginBottom:20, fontSize:12.5, color:"#4b6fa8", lineHeight:1.8 }}>
              <div>the NOTES is a personal productivity app. Your notes are securely stored in your own Google Drive.</div>
              <div style={{ marginTop:8, fontSize:11, color:"#94a3b8" }}>Made by BAUMAN</div>
              <div style={{ marginTop:6, fontSize:11, color:"#6b8bb5" }}>
                문의/오류 신고: <a href="mailto:duholee79@gmail.com" style={{ color:"#2563eb", fontWeight:600, textDecoration:"none" }}>duholee79@gmail.com</a>
              </div>
            </div>

            {/* PWA 설치 안내 */}
            <div style={{ fontSize:11, fontWeight:700, color:"#94a3b8", letterSpacing:"1px", textTransform:"uppercase", marginBottom:8 }}>앱으로 설치</div>
            <div style={{ background:"#f0fdf4", border:"1px solid #bbf7d0", borderRadius:12, padding:"14px 16px", marginBottom:20 }}>
              <div style={{ fontSize:12.5, color:"#166534", fontWeight:600, marginBottom:10 }}>📱 홈 화면에 앱처럼 설치할 수 있습니다</div>
              <div style={{ display:"flex", flexDirection:"column", gap:7 }}>
                {[
                  ["Android Chrome", "주소창 우측 설치(⊕) 아이콘 → 설치"],
                  ["iPhone Safari", "하단 공유(□↑) → 홈 화면에 추가"],
                  ["PC Chrome/Edge", "주소창 우측 설치(⊕) 아이콘 → 설치"],
                ].map(([device, desc]) => (
                  <div key={device} style={{ display:"flex", alignItems:"flex-start", gap:8, fontSize:12 }}>
                    <span style={{ background:"#dcfce7", color:"#166534", borderRadius:6, padding:"2px 7px", fontWeight:700, fontSize:11, flexShrink:0, whiteSpace:"nowrap" }}>{device}</span>
                    <span style={{ color:"#4b6fa8", lineHeight:1.5 }}>{desc}</span>
                  </div>
                ))}
              </div>
              <div style={{ marginTop:10, fontSize:11, color:"#6b8bb5", lineHeight:1.6, borderTop:"1px solid #bbf7d0", paddingTop:8 }}>
                설치 후에는 브라우저 없이 독립 앱으로 실행됩니다. 데이터는 Google Drive에 저장되므로 기기가 달라도 동기화됩니다.
              </div>
            </div>

            <div style={{ fontSize:11, fontWeight:700, color:"#94a3b8", letterSpacing:"1px", textTransform:"uppercase", marginBottom:8 }}>Backup</div>
            <div style={{ background:"#f8faff", borderRadius:12, padding:"14px 16px", marginBottom:20 }}>
              <div style={{ fontSize:12, color:"#6b8bb5", marginBottom:12, lineHeight:1.6 }}>
                모든 폴더의 노트를 Excel 파일로 백업합니다. 각 폴더가 별도 시트로 저장됩니다.
              </div>
              <button style={{ width:"100%", padding:"11px", borderRadius:10, border:"1.5px solid #bfdbfe", background:"#eff6ff", color:"#2563eb", fontSize:13, fontWeight:700, cursor:"pointer", fontFamily:"inherit" }}
                onClick={() => {
                  try {
                    const wb = XLSX.utils.book_new();
                    // 폴더별 시트 생성
                    const allFolders = sidebarItems.filter(i => i.type === "folder");
                    allFolders.forEach(folder => {
                      const folderItems = (allItems||[]).filter(i => !i.deletedAt && i.folder === folder.id);
                      if (folderItems.length === 0) return;
                      const rows = folderItems.map(i => ({
                        Type: i.type === "header" ? "Header" : i.type === "todo" ? "Todo" : "Text",
                        Title: i.title || "",
                        Body: i.body || "",
                        Done: i.type === "todo" ? (i.done ? "Yes" : "No") : "",
                        Starred: i.starred ? "★" : "",
                        Date: i.createdAt || "",
                      }));
                      const ws = XLSX.utils.json_to_sheet(rows);
                      ws["!cols"] = [{wch:8},{wch:35},{wch:50},{wch:6},{wch:6},{wch:12}];
                      const sheetName = folder.name.slice(0, 31).replace(/[\\/:*?[\]]/g, "_");
                      XLSX.utils.book_append_sheet(wb, ws, sheetName);
                    });
                    // Worklog 시트
                    if ((allWorklogs||[]).length > 0) {
                      const wRows = (allWorklogs||[]).map(w => ({ Date:w.date||"", Project:w.project||"", "Key Point":w.keyPoint||"", Details:w.details||"", Notes:w.notes||"" }));
                      const wws = XLSX.utils.json_to_sheet(wRows);
                      wws["!cols"] = [{wch:12},{wch:22},{wch:30},{wch:40},{wch:25}];
                      XLSX.utils.book_append_sheet(wb, wws, "Worklog");
                    }
                    if (wb.SheetNames.length === 0) { alert("백업할 데이터가 없습니다."); return; }
                    const now = new Date();
                    const ts = `${now.getFullYear()}${String(now.getMonth()+1).padStart(2,"0")}${String(now.getDate()).padStart(2,"0")}`;
                    XLSX.writeFile(wb, `theNOTES_backup_${ts}.xlsx`);
                  } catch(e) { alert("백업 실패: " + e.message); }
                }}>
                ↓ 전체 백업 (Excel)
              </button>
            </div>

            <div style={{ fontSize:11, fontWeight:700, color:"#fca5a5", letterSpacing:"1px", textTransform:"uppercase", marginBottom:8 }}>Danger Zone</div>
            <button style={{ width:"100%", padding:"11px", borderRadius:10, border:"1.5px solid #fecaca", background:"#fff5f5", color:"#e53e3e", fontSize:13, fontWeight:700, cursor:"pointer", fontFamily:"inherit", marginBottom:8 }}
              onClick={() => { if (window.confirm("Sign out?")) { setShowSettings(false); onLogout(); } }}>
              Sign Out
            </button>
            <button style={{ width:"100%", padding:"11px", borderRadius:10, border:"1.5px solid #fecaca", background:"transparent", color:"#e53e3e", fontSize:13, cursor:"pointer", fontFamily:"inherit" }}
              onClick={() => { if (window.confirm("Delete account? Your Google Drive data will remain.")) setShowSettings(false); }}>
              Delete Account
            </button>
            <div style={{ fontSize:11, color:"#c0cfe8", textAlign:"center", marginTop:20 }}>the NOTES · BAUMAN · v1.0</div>
          </div>
        </div>
      )}

      {/* ── Add + Settings bar ── */}
      <div style={{ padding:"8px 12px 6px", borderTop:"1px solid rgba(255,255,255,.08)", flexShrink:0 }}>
        <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between" }}>
          <div style={{ position:"relative" }}>
            <div style={{ display:"flex", alignItems:"center", color:"rgba(255,255,255,.5)", fontSize:12.5, cursor:"pointer", padding:"7px 10px", borderRadius:7, userSelect:"none" }}
              onClick={() => setShowAdd(v => !v)}>
              <span style={{ fontSize:15, marginRight:6 }}>+</span> Add
            </div>
            {showAdd && (
              <div style={{ position:"absolute", bottom:"100%", left:0, background:"#1650b8", border:"1px solid rgba(255,255,255,.15)", borderRadius:10, overflow:"hidden", zIndex:200, minWidth:120, boxShadow:"0 4px 16px rgba(0,0,0,.25)", marginBottom:4 }}>
                {[["Header","sheader"],["Folder","folder"],["Divider","divider"]].map(([l,t]) => (
                  <div key={t} style={{ padding:"10px 16px", color:"rgba(255,255,255,.75)", fontSize:13, cursor:"pointer", fontWeight:500 }}
                    onClick={() => { onAddItem(t, activeSidebarId); setShowAdd(false); }}>{l}</div>
                ))}
              </div>
            )}
          </div>
          <button
            style={{ background:"none", border:"none", cursor:"pointer", color:"rgba(255,255,255,.4)", fontSize:20, padding:"6px 10px", borderRadius:7, lineHeight:1 }}
            title="Settings"
            onClick={() => setShowSettings(true)}>⚙</button>
        </div>
      </div>

      <div style={{ padding:"12px 12px 28px", borderTop:"1px solid rgba(255,255,255,.08)", flexShrink:0 }}>
        {user ? (
          <div style={{ display:"flex", alignItems:"center", gap:10 }}>
            {user.picture
              ? <img src={user.picture} alt="" style={{ width:32, height:32, borderRadius:"50%", flexShrink:0, objectFit:"cover" }} referrerPolicy="no-referrer" />
              : <div style={{ width:32, height:32, borderRadius:"50%", background:"linear-gradient(135deg,#4285F4,#34A853)", display:"flex", alignItems:"center", justifyContent:"center", color:"#fff", fontSize:14, fontWeight:700, flexShrink:0 }}>
                  {user.name?.[0]?.toUpperCase() || "G"}
                </div>
            }
            <div style={{ flex:1, minWidth:0 }}>
              <div style={{ color:"#fff", fontSize:12.5, fontWeight:600, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{user.name}</div>
              <div style={{ color:"rgba(255,255,255,.4)", fontSize:10, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{user.email}</div>
              <div style={{ fontSize:9, marginTop:1, color: syncStatus==="saving"?"#fde68a":syncStatus==="saved"?"#86efac":syncStatus==="error"?"#fca5a5":"transparent", cursor: syncStatus==="error"?"pointer":"default" }}
                onClick={syncStatus==="error" ? onLogin : undefined}>
                {syncStatus==="saving"?"⏳ Saving...":syncStatus==="saved"?"✅ Synced":syncStatus==="error"?"❌ Re-login needed":"·"}
              </div>
            </div>
            <button style={{ background:"none", border:"1px solid rgba(255,255,255,.2)", borderRadius:7, color:"rgba(255,255,255,.5)", fontSize:11, padding:"4px 8px", cursor:"pointer", fontFamily:"inherit", flexShrink:0 }}
              onClick={onLogout}>Log out</button>
          </div>
        ) : (
          <button style={{ display:"flex", alignItems:"center", gap:8, width:"100%", background:"rgba(255,255,255,.95)", border:"none", borderRadius:10, padding:"10px 14px", cursor:"pointer", fontSize:12.5, fontWeight:600, color:"#1650b8", boxShadow:"0 2px 8px rgba(0,0,0,.15)" }}
            onClick={onLogin}>
            <svg width="16" height="16" viewBox="0 0 24 24" style={{ flexShrink:0 }}>
              <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
              <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
              <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
              <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
            </svg>
            <span>Sign in with Google</span>
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
  for (const p of patterns) {
    const m = url.match(p);
    if (m) return m[1];
  }
  return null;
}

function LinkItem({ lk, onDelete }) {
  const ytId = getYouTubeId(lk.url);
  const isYT = !!ytId;

  return (
    <div style={{ display:"inline-flex", alignItems:"center", gap:6, borderRadius:20, padding:"4px 12px", fontSize:12,
      background: isYT ? "#fff0f0" : "#eff6ff",
      border: isYT ? "1px solid #fecaca" : "1px solid #bfdbfe" }}
      onClick={e => e.stopPropagation()}>
      <span style={{ fontSize:12 }}>{isYT ? "▶" : "🔗"}</span>
      <span style={{ color: isYT ? "#c53030" : "#2563eb", fontWeight:600, cursor:"pointer" }}
        onClick={() => { const u = /^https?:\/\//i.test(lk.url) ? lk.url : "https://" + lk.url; window.open(u, "_blank", "noopener,noreferrer"); }}>
        {lk.label}
      </span>
      <span style={{ color:"#c0cfe8", cursor:"pointer", fontSize:14, lineHeight:1 }} onClick={onDelete}>×</span>
    </div>
  );
}
// ─── Note Item Components ─────────────────────────────────
function HiddenSection({ section, isMobile, onUpdate, onDelete }) {
  return (
    <div style={{ margin:"0 14px 6px 21px", border:"1px solid #e0eaf8", borderRadius:9, overflow:"hidden", background:"#fafcff" }}
      onClick={e => e.stopPropagation()}>
      <div style={{ display:"flex", alignItems:"center", gap:6, padding:"8px 10px", background:"#f0f5fc" }}>
        <button style={{ background:"none", border:"none", cursor:"pointer", color:"#4b6fa8", padding:"2px 4px", borderRadius:4, display:"flex", alignItems:"center", flexShrink:0 }}
          onClick={() => onUpdate({ open:!section.open })}>
          <span style={{ display:"inline-block", transition:"transform .2s", transform:section.open?"rotate(0deg)":"rotate(-90deg)", fontSize:13 }}>▾</span>
        </button>
        <input style={{ color:"#2a5ba8", border:"none", background:"transparent", outline:"none", fontFamily:"inherit", fontSize:12.5, fontWeight:600, flex:1 }}
          value={section.label} onChange={e => onUpdate({ label:e.target.value })} placeholder="Section title..."
          onClick={e => e.stopPropagation()} />
        <span style={{ color:"#c0cfe8", fontSize:15, cursor:"pointer", padding:"0 2px" }} onClick={onDelete}>×</span>
      </div>
      {section.open && (
        <div style={{ padding:"10px 12px", borderTop:"1px solid #e8eef8" }}>
          <RichText html={section.content||""} onChange={v => onUpdate({ content:v })}
            placeholder="Write content here..." style={{ fontSize:isMobile?13.5:13, minHeight:36 }} />
        </div>
      )}
    </div>
  );
}

function LinkModal({ onConfirm, onClose }) {
  const [label,    setLabel]    = useState("");
  const [url,      setUrl]      = useState("");
  const [fetching, setFetching] = useState(false);
  const [ytDetected, setYtDetected] = useState(false);

  // Auto-fetch YouTube title when URL is pasted/typed
  const handleUrlChange = async (val) => {
    setUrl(val);
    const ytId = getYouTubeId(val.trim());
    if (ytId) {
      setYtDetected(true);
      if (!label) {
        setFetching(true);
        try {
          const res = await fetch(
            `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${ytId}&format=json`
          );
          if (res.ok) {
            const data = await res.json();
            if (data.title) setLabel(data.title);
          }
        } catch (_) {
          // fetch may be blocked in sandbox — leave label empty
        } finally {
          setFetching(false);
        }
      }
    } else {
      setYtDetected(false);
    }
  };

  const submit = () => {
    if (!url) return;
    const rawUrl = url.trim();
    const normalizedUrl = /^https?:\/\//i.test(rawUrl) ? rawUrl : "https://" + rawUrl;
    onConfirm({ label: label.trim() || rawUrl, url: normalizedUrl });
  };

  return (
    <div style={{ position:"fixed", inset:0, background:"rgba(15,32,68,.4)", display:"flex", alignItems:"center", justifyContent:"center", zIndex:600 }}
      onClick={onClose}>
      <div style={{ background:"#fff", borderRadius:18, padding:"28px 24px 22px", width:310, boxShadow:"0 16px 48px rgba(15,32,68,.22)" }}
        onClick={e => e.stopPropagation()}>
        <div style={{ fontSize:16, fontWeight:700, color:"#0f2044", marginBottom:16 }}>
          {ytDetected ? "▶ YouTube Link" : "🔗 Add Link"}
        </div>

        {/* URL first */}
        <div style={{ marginBottom:12 }}>
          <div style={{ fontSize:11, fontWeight:700, color:"#6b8bb5", marginBottom:5, letterSpacing:"0.5px" }}>URL</div>
          <input
            autoFocus
            style={{ ...mInput, marginBottom:0, borderColor: ytDetected ? "#fca5a5" : "#d0dcef" }}
            placeholder="https://..."
            value={url}
            onChange={e => handleUrlChange(e.target.value)}
            onKeyDown={e => e.key==="Enter" && submit()}
          />
          {ytDetected && (
            <div style={{ fontSize:11, color:"#e53e3e", marginTop:4, fontWeight:500 }}>▶ YouTube video detected</div>
          )}
        </div>

        {/* Label */}
        <div style={{ marginBottom:20 }}>
          <div style={{ fontSize:11, fontWeight:700, color:"#6b8bb5", marginBottom:5, letterSpacing:"0.5px", display:"flex", alignItems:"center", gap:6 }}>
            Title
            {fetching && <span style={{ fontSize:10, color:"#94a3b8", fontWeight:400 }}>Loading...</span>}
          </div>
          <input
            style={{ ...mInput, marginBottom:0 }}
            placeholder={ytDetected ? "Video title (auto-filled)" : "Label (optional)"}
            value={label}
            onChange={e => setLabel(e.target.value)}
            onKeyDown={e => e.key==="Enter" && submit()}
          />
        </div>

        <div style={{ display:"flex", gap:10, justifyContent:"flex-end" }}>
          <button style={mBtnC} onClick={onClose}>Cancel</button>
          <button style={{ ...mBtnP, background: ytDetected ? "#e53e3e" : "#2563eb", boxShadow: ytDetected ? "0 4px 10px rgba(229,62,62,.3)" : "0 4px 10px rgba(37,99,235,.3)" }}
            onClick={submit}>Add</button>
        </div>
      </div>
    </div>
  );
}
const mInput = { width:"100%", padding:"12px 14px", borderRadius:10, border:"1.5px solid #d0dcef", fontSize:15, color:"#1e3a6e", outline:"none", fontFamily:"inherit", boxSizing:"border-box", marginBottom:18, display:"block" };
const mBtnC  = { padding:"10px 20px", borderRadius:10, border:"1.5px solid #d0dcef", background:"transparent", color:"#6b8bb5", fontSize:14, cursor:"pointer", fontFamily:"inherit" };
const mBtnP  = { padding:"10px 20px", borderRadius:10, border:"none", background:"#2563eb", color:"#fff", fontSize:14, fontWeight:600, cursor:"pointer", fontFamily:"inherit", boxShadow:"0 4px 10px rgba(37,99,235,.3)" };


// ─── Table helpers ────────────────────────────────────────
const mkCell  = (content="",colspan=1,rowspan=1,bg=null) => ({ id:`tc${Math.random().toString(36).slice(2,7)}`, content, colspan, rowspan, bg });
const mkTable = (rows=2,cols=3) => ({
  id: `tbl${nextId++}`,
  colWidths: Array(cols).fill(Math.floor(100/cols)),
  rows: Array(rows).fill(0).map(()=>Array(cols).fill(0).map(()=>mkCell()))
});

// ─── TableBlock ───────────────────────────────────────────
// ─── RichTableCell: contentEditable cell with floating toolbar ──
function RichTableCell({ content, onChange, disabled }) {
  const ref = useRef(null);
  // Toolbar state — all managed locally, no shared containerRef needed
  const tbRef  = useRef(null);
  const [tb, setTb] = useState(null);

  // content prop이 바뀔 때마다 DOM 업데이트 (Drive 동기화 등)
  // 포커스 중(타이핑 중)이면 건드리지 않음
  useEffect(() => {
    if (!ref.current) return;
    if (ref.current.contains(document.activeElement)) return;
    if (ref.current.innerHTML !== content) {
      ref.current.innerHTML = content;
    }
  }, [content]);

  const checkSel = useCallback(() => {
    setTimeout(() => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.toString().trim()) { setTb(null); return; }
      if (!ref.current?.contains(sel.anchorNode)) { setTb(null); return; }
      // Position relative to viewport — use fixed positioning for toolbar
      const r = sel.getRangeAt(0).getBoundingClientRect();
      setTb({ x: r.left + r.width / 2, y: r.top - 8, fixed: true });
    }, 10);
  }, []);

  // exec: do NOT call focus() — e.preventDefault() on toolbar mousedown keeps selection intact
  const exec = useCallback((cmd, val) => {
    document.execCommand(cmd, false, val || null);
    onChange?.(ref.current?.innerHTML || "");
    setTb(null);
  }, [onChange]);

  const hide = useCallback(() => {
    setTimeout(() => {
      if (!tbRef.current?.contains(document.activeElement)) setTb(null);
    }, 150);
  }, []);

  return (
    <div style={{ position:"relative" }}>
      {/* Toolbar uses fixed positioning to escape table stacking context */}
      {tb && (
        <div
          ref={tbRef}
          style={{ position:"fixed", left:tb.x, top:tb.y, transform:"translate(-50%,-100%)", zIndex:9999,
            filter:"drop-shadow(0 4px 16px rgba(15,32,68,.25))" }}
          onMouseDown={e => e.preventDefault()}>
          <div style={{ display:"flex", alignItems:"center", gap:2, background:"#1a2d54", borderRadius:10, padding:"6px 8px" }}>
            <button onMouseDown={e=>{e.preventDefault();exec("bold");}} style={rtBtn}><b>B</b></button>
            <button onMouseDown={e=>{e.preventDefault();exec("italic");}} style={rtBtn}><i>I</i></button>
            <button onMouseDown={e=>{e.preventDefault();exec("underline");}} style={rtBtn}><u>U</u></button>
            <button onMouseDown={e=>{e.preventDefault();exec("strikeThrough");}} style={rtBtn}><s>S</s></button>
            <div style={rtDiv}/>
            {["#1e3a6e","#e53e3e","#2563eb","#059669","#d97706"].map(c=>(
              <div key={c} style={{width:13,height:13,borderRadius:"50%",background:c,cursor:"pointer"}}
                onMouseDown={e=>{e.preventDefault();exec("foreColor",c);}}/>
            ))}
            <div style={rtDiv}/>
            {[["#fef08a","Yellow"],["#bbf7d0","Green"],["#bfdbfe","Blue"],["transparent","Clear"]].map(([c,t])=>(
              <div key={c} title={t} style={{width:13,height:13,borderRadius:3,background:c==="transparent"?"#fff":c,border:c==="transparent"?"2px dashed #94a3b8":"2px solid rgba(0,0,0,.07)",cursor:"pointer"}}
                onMouseDown={e=>{e.preventDefault();exec("hiliteColor",c);}}/>
            ))}
            <div style={rtDiv}/>
            <button onMouseDown={e=>{e.preventDefault();exec("removeFormat");}} style={{...rtBtn,color:"#fca5a5",fontSize:11}}>✕</button>
          </div>
          <div style={{width:0,height:0,borderLeft:"6px solid transparent",borderRight:"6px solid transparent",borderTop:"7px solid #1a2d54",margin:"0 auto"}}/>
        </div>
      )}
      <div
        ref={ref}
        contentEditable={!disabled}
        suppressContentEditableWarning
        onInput={e => !disabled && onChange?.(e.currentTarget.innerHTML)}
        onMouseUp={!disabled ? checkSel : undefined}
        onKeyUp={!disabled ? checkSel : undefined}
        onBlur={hide}
        onClick={e => { if (!disabled) e.stopPropagation(); }}
        style={{ outline:"none", minHeight:20, lineHeight:1.5, color:"#1e3a6e", wordBreak:"break-word",
          pointerEvents: disabled ? "none" : "auto" }}
      />
    </div>
  );
}

function TableBlock({ table, onUpdate, onDelete }) {
  const [mode,        setMode]       = useState(null); // null | "merge" | "split" | "color"
  const [selCells,    setSelCells]   = useState(new Set());
  const [pendingBg,   setPendingBg]  = useState(null);
  const [showWidthUI, setShowWidthUI]= useState(false);
  const [draftWidths, setDraftWidths]= useState(null);
  const tableRef = useRef(null);

  const rows    = table.rows;
  const numCols = rows[0]?.length || 0;
  const key     = (r,c) => `${r},${c}`;
  const colWidths = table.colWidths || Array(numCols).fill(Math.floor(100/numCols));

  // ── 폭 UI ────────────────────────────────────────────────
  const openWidthUI = () => {
    setDraftWidths(colWidths.map(w => String(Math.round(w))));
    setShowWidthUI(true);
    setMode(null);
  };

  const handleWidthChange = (ci, val) => {
    const next = [...draftWidths];
    next[ci] = val;
    setDraftWidths(next);
  };

  const applyWidths = () => {
    const parsed = draftWidths.slice(0, numCols - 1).map(v => {
      const n = parseFloat(v);
      return isNaN(n) ? 5 : Math.max(5, Math.min(90, n));
    });
    const usedSum = parsed.reduce((a, b) => a + b, 0);
    const last = Math.max(5, Math.round(100 - usedSum));
    onUpdate({ colWidths: [...parsed, last] });
    setShowWidthUI(false);
    setDraftWidths(null);
  };

  const usedPct = draftWidths
    ? draftWidths.slice(0, numCols - 1).reduce((a, v) => {
        const n = parseFloat(v); return a + (isNaN(n) ? 0 : n);
      }, 0)
    : 0;
  const remainPct = Math.max(0, Math.round(100 - usedPct));

  // ── 셀 병합/분리 ──────────────────────────────────────────
  const isMerged = cell => (cell.colspan||1) > 1 || (cell.rowspan||1) > 1;
  const mergedKeys = new Set();
  rows.forEach((row, ri) => row.forEach((cell, ci) => {
    if (!cell.hidden && isMerged(cell)) mergedKeys.add(key(ri, ci));
  }));

  const enterMode = m => {
    if (mode === m) { setMode(null); setSelCells(new Set()); return; }
    setMode(m); setSelCells(new Set()); setShowWidthUI(false);
  };

  const handleCellClick = (r, c, e) => {
    e.stopPropagation();
    const k = key(r, c);
    if (mode === "merge") {
      setSelCells(prev => { const n = new Set(prev); n.has(k) ? n.delete(k) : n.add(k); return n; });
    } else if (mode === "split") {
      if (!isMerged(rows[r][c])) return;
      setSelCells(new Set([k]));
    } else if (mode === "color") {
      setSelCells(prev => { const n = new Set(prev); n.has(k) ? n.delete(k) : n.add(k); return n; });
    } else {
      setSelCells(prev => {
        const n = new Set(prev);
        if (e.shiftKey || e.metaKey || e.ctrlKey) { n.has(k) ? n.delete(k) : n.add(k); }
        else { n.clear(); n.add(k); }
        return n;
      });
    }
  };

  const confirmMode = () => {
    if (mode === "merge") doMerge();
    else if (mode === "split") doSplit();
    else if (mode === "color") applyBg();
  };

  const doMerge = () => {
    if (selCells.size < 2) return;
    const coords = [...selCells].map(k => k.split(",").map(Number));
    const minR = Math.min(...coords.map(([r]) => r)), maxR = Math.max(...coords.map(([r]) => r));
    const minC = Math.min(...coords.map(([, c]) => c)), maxC = Math.max(...coords.map(([, c]) => c));
    onUpdate({ rows: rows.map((row, ri) => row.map((cell, ci) => {
      if (ri === minR && ci === minC) return { ...cell, rowspan: maxR-minR+1, colspan: maxC-minC+1 };
      if (ri >= minR && ri <= maxR && ci >= minC && ci <= maxC) return { ...cell, hidden: true };
      return cell;
    }))});
    setMode(null); setSelCells(new Set());
  };

  const doSplit = () => {
    if (selCells.size !== 1) return;
    const [r, c] = [...selCells][0].split(",").map(Number);
    const cell = rows[r][c];
    if (!isMerged(cell)) return;
    onUpdate({ rows: rows.map((row, ri) => row.map((cl, ci) => {
      if (ri === r && ci === c) return { ...cl, colspan: 1, rowspan: 1 };
      if (ri >= r && ri < r + (cell.rowspan||1) && ci >= c && ci < c + (cell.colspan||1)) return { ...cl, hidden: false };
      return cl;
    }))});
    setMode(null); setSelCells(new Set());
  };

  const updCell = (r, c, patch) =>
    onUpdate({ rows: rows.map((row, ri) => row.map((cell, ci) => ri===r&&ci===c ? {...cell,...patch} : cell)) });

  const addRow = () => onUpdate({ rows: [...rows, Array(numCols).fill(0).map(() => mkCell())] });
  const delRow = () => { if (rows.length > 1) onUpdate({ rows: rows.filter((_, i) => i !== rows.length-1) }); };
  const addCol = () => {
    const n = numCols + 1;
    onUpdate({ rows: rows.map(row => [...row, mkCell()]), colWidths: Array(n).fill(Math.floor(100/n)) });
  };
  const delCol = () => {
    if (numCols <= 1) return;
    const n = numCols - 1;
    onUpdate({ rows: rows.map(row => row.filter((_, i) => i !== numCols-1)), colWidths: Array(n).fill(Math.floor(100/n)) });
  };

  const applyBg = () => {
    if (!selCells.size || pendingBg === null) return;
    onUpdate({ rows: rows.map((row, ri) => row.map((cell, ci) =>
      selCells.has(key(ri, ci)) ? { ...cell, bg: pendingBg } : cell
    ))});
    setMode(null); setSelCells(new Set()); setPendingBg(null);
  };

  // 색상 — 더 진하고 선명한 팔레트
  const BG_COLORS = [
    { c: "none",    label: "없음" },
    { c: "#fde047", label: "노랑" },
    { c: "#4ade80", label: "초록" },
    { c: "#60a5fa", label: "파랑" },
    { c: "#f472b6", label: "분홍" },
    { c: "#a78bfa", label: "보라" },
    { c: "#fb923c", label: "주황" },
    { c: "#94a3b8", label: "회색" },
    { c: "#f87171", label: "빨강" },
    { c: "#2dd4bf", label: "민트" },
  ];

  const modeActive = mode !== null;
  const canConfirm =
    (mode==="merge" && selCells.size >= 2) ||
    (mode==="split" && selCells.size === 1) ||
    (mode==="color" && selCells.size >= 1 && pendingBg !== null);

  return (
    <div style={{ margin:"4px 0 8px", userSelect:"none" }} onClick={e => e.stopPropagation()}>

      {/* ── 툴바 ── */}
      <div style={{ display:"flex", alignItems:"center", gap:3, marginBottom:6, flexWrap:"wrap" }}>

        {/* 일반 모드 버튼들 */}
        {!modeActive && !showWidthUI && <>
          <button title="행 추가" style={tbIcon} onClick={addRow}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <rect x="1" y="3" width="14" height="4" rx="1" stroke="currentColor" strokeWidth="1.3" fill="none"/>
              <rect x="1" y="9" width="14" height="4" rx="1" stroke="currentColor" strokeWidth="1.3" fill="none"/>
              <line x1="6" y1="11" x2="10" y2="11" stroke="currentColor" strokeWidth="1.3"/>
              <line x1="8" y1="9" x2="8" y2="13" stroke="currentColor" strokeWidth="1.3"/>
            </svg>
          </button>
          <button title="행 삭제" style={tbIcon} onClick={delRow}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <rect x="1" y="3" width="14" height="4" rx="1" stroke="currentColor" strokeWidth="1.3" fill="none"/>
              <rect x="1" y="9" width="14" height="4" rx="1" stroke="currentColor" strokeWidth="1.3" fill="none"/>
              <line x1="6" y1="11" x2="10" y2="11" stroke="currentColor" strokeWidth="1.3"/>
            </svg>
          </button>
          <div style={{ width:1, height:14, background:"#dce8fb", margin:"0 1px" }}/>
          <button title="열 추가" style={tbIcon} onClick={addCol}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <rect x="1" y="1" width="6" height="14" rx="1" stroke="currentColor" strokeWidth="1.3" fill="none"/>
              <rect x="9" y="1" width="6" height="14" rx="1" stroke="currentColor" strokeWidth="1.3" fill="none"/>
              <line x1="12" y1="5" x2="12" y2="11" stroke="currentColor" strokeWidth="1.3"/>
              <line x1="9" y1="8" x2="15" y2="8" stroke="currentColor" strokeWidth="1.3"/>
            </svg>
          </button>
          <button title="열 삭제" style={tbIcon} onClick={delCol}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <rect x="1" y="1" width="6" height="14" rx="1" stroke="currentColor" strokeWidth="1.3" fill="none"/>
              <rect x="9" y="1" width="6" height="14" rx="1" stroke="currentColor" strokeWidth="1.3" fill="none"/>
              <line x1="10" y1="8" x2="14" y2="8" stroke="currentColor" strokeWidth="1.3"/>
            </svg>
          </button>
          <div style={{ width:1, height:14, background:"#dce8fb", margin:"0 1px" }}/>
          <button title="셀 병합" style={tbIcon} onClick={() => enterMode("merge")}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <rect x="1" y="1" width="6" height="6" rx="1" stroke="currentColor" strokeWidth="1.3" fill="none"/>
              <rect x="9" y="1" width="6" height="6" rx="1" stroke="currentColor" strokeWidth="1.3" fill="none"/>
              <rect x="1" y="9" width="6" height="6" rx="1" stroke="currentColor" strokeWidth="1.3" fill="none"/>
              <rect x="9" y="9" width="6" height="6" rx="1" stroke="currentColor" strokeWidth="1.3" fill="none"/>
              <line x1="5" y1="5" x2="11" y2="11" stroke="#2563eb" strokeWidth="1.3"/>
              <line x1="11" y1="5" x2="5" y2="11" stroke="#2563eb" strokeWidth="1.3"/>
            </svg>
          </button>
          <button title="셀 분리" style={{ ...tbIcon, opacity: mergedKeys.size===0 ? 0.35 : 1 }}
            disabled={mergedKeys.size===0} onClick={() => enterMode("split")}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <rect x="1" y="1" width="14" height="14" rx="1" stroke="currentColor" strokeWidth="1.3" fill="none"/>
              <line x1="8" y1="1" x2="8" y2="15" stroke="currentColor" strokeWidth="1.3"/>
              <line x1="1" y1="8" x2="15" y2="8" stroke="currentColor" strokeWidth="1.3"/>
            </svg>
          </button>
          {/* 배경색 */}
          <button title="셀 배경색" style={tbIcon} onClick={() => enterMode("color")}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <rect x="1" y="1" width="14" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.3" fill="none"/>
              <rect x="2" y="13" width="12" height="2" rx="1" fill="#7c3aed"/>
            </svg>
          </button>
          {/* 열 폭 조절 */}
          <button title="열 폭 조절 (%입력)" style={{ ...tbIcon, color:"#059669" }} onClick={openWidthUI}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <line x1="1" y1="8" x2="15" y2="8" stroke="currentColor" strokeWidth="1.5"/>
              <polyline points="4,5 1,8 4,11" stroke="currentColor" strokeWidth="1.3" fill="none"/>
              <polyline points="12,5 15,8 12,11" stroke="currentColor" strokeWidth="1.3" fill="none"/>
            </svg>
          </button>
          {/* 표 삭제 */}
          <button title="표 삭제" style={{ ...tbIcon, color:"#fca5a5", marginLeft:"auto" }} onClick={onDelete}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path d="M2 4h12M6 4V2h4v2M5 4v9a1 1 0 001 1h4a1 1 0 001-1V4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
            </svg>
          </button>
        </>}

        {/* 모드 활성: label + confirm + cancel */}
        {modeActive && (
          <div style={{ display:"flex", alignItems:"center", gap:6, width:"100%", flexWrap:"wrap" }}>
            <span style={{ fontSize:11, fontWeight:600, flex:1,
              color: mode==="merge"?"#2563eb": mode==="split"?"#ea580c":"#7c3aed" }}>
              {mode==="merge" ? `⊞ 병합 — 셀 선택 (${selCells.size})` :
               mode==="split" ? "⊟ 분리 — 병합 셀 선택" :
               `🎨 배경색 — 색 선택 후 셀 클릭 (${selCells.size})`}
            </span>
            {/* 색상 스와치 — 크고 선명하게 */}
            {mode==="color" && (
              <div style={{ display:"flex", gap:4, alignItems:"center", flexWrap:"wrap" }}>
                {BG_COLORS.map(({ c, label }) => {
                  const isNone = c==="none", isSel = pendingBg===c;
                  return (
                    <div key={c} onClick={() => setPendingBg(c)} title={label}
                      style={{ width:24, height:24, borderRadius:5, cursor:"pointer", flexShrink:0,
                        background: isNone ? "#fff" : c, position:"relative",
                        border: isSel ? "2.5px solid #7c3aed" : isNone ? "1.5px dashed #c2d0e8" : "1.5px solid rgba(0,0,0,.15)",
                        boxShadow: isSel ? "0 0 0 2px #ede9fe" : "none",
                        transform: isSel ? "scale(1.15)" : "scale(1)",
                        transition:"transform .1s, box-shadow .1s" }}>
                      {isNone && <span style={{ position:"absolute",inset:0,display:"flex",alignItems:"center",justifyContent:"center",fontSize:11,color:"#94a3b8",fontWeight:700 }}>✕</span>}
                    </div>
                  );
                })}
              </div>
            )}
            <button style={{ ...tbIcon, background:canConfirm?"#2563eb":"#e8eef8",
              color:canConfirm?"#fff":"#94a3b8",
              border:canConfirm?"1px solid #2563eb":"1px solid #e0eaf8",
              fontSize:15, width:28, height:28, borderRadius:7,
              cursor:canConfirm?"pointer":"default", transition:"all .12s" }}
              onClick={canConfirm ? confirmMode : undefined} title="적용">✓</button>
            <button style={{ ...tbIcon, fontSize:15, width:28, height:28, borderRadius:7 }}
              onClick={() => enterMode(mode)} title="취소">✕</button>
          </div>
        )}

        {/* 폭 조절 UI */}
        {showWidthUI && draftWidths && (
          <div style={{ display:"flex", alignItems:"center", gap:5, width:"100%", flexWrap:"wrap",
            background:"#f0fdf4", borderRadius:8, padding:"6px 10px", border:"1px solid #bbf7d0" }}>
            <span style={{ fontSize:11, fontWeight:700, color:"#059669", flexShrink:0 }}>⟺ 열 폭 설정</span>
            {draftWidths.slice(0, numCols - 1).map((v, ci) => (
              <div key={ci} style={{ display:"flex", alignItems:"center", gap:2 }}>
                <span style={{ fontSize:10, color:"#6b7280", flexShrink:0 }}>열{ci+1}</span>
                <input
                  value={v}
                  onChange={e => handleWidthChange(ci, e.target.value)}
                  onFocus={e => e.target.select()}
                  style={{ width:44, padding:"3px 4px", border:"1.5px solid #6ee7b7", borderRadius:5,
                    fontSize:12.5, color:"#059669", fontWeight:700, outline:"none",
                    fontFamily:"inherit", textAlign:"center", background:"#fff" }}
                  placeholder="25"
                />
                <span style={{ fontSize:10, color:"#6b7280" }}>%</span>
              </div>
            ))}
            {/* 마지막 열 자동 */}
            <div style={{ display:"flex", alignItems:"center", gap:2 }}>
              <span style={{ fontSize:10, color:"#6b7280", flexShrink:0 }}>열{numCols}</span>
              <div style={{ width:44, padding:"3px 4px", border:"1.5px solid #e0eaf8", borderRadius:5,
                fontSize:12.5, color:"#94a3b8", fontWeight:700, textAlign:"center",
                background:"#f8faff", fontFamily:"inherit" }}>{remainPct}</div>
              <span style={{ fontSize:10, color:"#6b7280" }}>%</span>
            </div>
            <span style={{ fontSize:10, fontWeight:600,
              color: Math.abs(usedPct + remainPct - 100) < 2 ? "#059669" : "#ef4444" }}>
              합계 {Math.round(usedPct + remainPct)}%
            </span>
            <button style={{ ...tbIcon, background:"#059669", color:"#fff", border:"none",
              width:28, height:28, borderRadius:7, fontSize:13, marginLeft:"auto" }}
              onClick={applyWidths} title="적용">✓</button>
            <button style={{ ...tbIcon, fontSize:13, width:28, height:28, borderRadius:7 }}
              onClick={() => { setShowWidthUI(false); setDraftWidths(null); }} title="취소">✕</button>
          </div>
        )}
      </div>

      {/* 표 본체 */}
      <div style={{ overflowX:"auto" }}>
        <table ref={tableRef} style={{ width:"100%", borderCollapse:"collapse", tableLayout:"fixed", fontSize:13 }}>
          <colgroup>
            {colWidths.map((w, ci) => <col key={ci} style={{ width:`${w}%` }} />)}
          </colgroup>
          <tbody>
            {rows.map((row, ri) => (
              <tr key={ri}>
                {row.map((cell, ci) => {
                  if (cell.hidden) return null;
                  const k = key(ri, ci);
                  const isSel = selCells.has(k);
                  const isSelectable = mode==="split" ? isMerged(cell) : true;

                  let borderColor = "#d1d9e6";
                  let bgColor = (cell.bg && cell.bg !== "transparent" && cell.bg !== "none") ? cell.bg : "#fff";
                  if (isSel && mode==="merge") { borderColor = "#2563eb"; bgColor = "rgba(37,99,235,.08)"; }
                  if (isSel && mode==="split") { borderColor = "#ea580c"; bgColor = "rgba(234,88,12,.07)"; }
                  if (!isSel && mode==="split" && isMerged(cell)) { borderColor = "#fdba74"; bgColor = "rgba(251,146,60,.06)"; }
                  if (isSel && mode==="color") { borderColor = "#7c3aed"; bgColor = pendingBg&&pendingBg!=="none" ? pendingBg : "rgba(124,58,237,.06)"; }

                  return (
                    <td key={cell.id}
                      colSpan={cell.colspan||1} rowSpan={cell.rowspan||1}
                      onClick={e => handleCellClick(ri, ci, e)}
                      style={{ border:`1.5px solid ${borderColor}`, background:bgColor,
                        padding:"6px 8px", verticalAlign:"top", position:"relative",
                        cursor: mode ? (isSelectable?"pointer":"default") : "cell",
                        minWidth:40, transition:"background .1s, border-color .1s" }}>
                      <RichTableCell
                        content={cell.content||""}
                        onChange={v => updCell(ri, ci, { content:v })}
                        disabled={!!mode}
                      />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!mode && !showWidthUI && (
        <div style={{ fontSize:10, color:"#b0c4de", marginTop:4 }}>
          셀 클릭으로 선택 (Shift/Cmd 다중) · ⟺ 로 열 폭 조절
        </div>
      )}
    </div>
  );
}
}
const tbBtn  = {background:"#f5f8ff",border:"1px solid #dce8fb",borderRadius:6,color:"#4b6fa8",fontSize:11.5,padding:"4px 9px",cursor:"pointer",fontFamily:"inherit",fontWeight:600};
const tbIcon = {background:"#f5f8ff",border:"1px solid #dce8fb",borderRadius:7,color:"#4b6fa8",cursor:"pointer",fontFamily:"inherit",padding:0,width:28,height:28,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0};

// ─── AttachmentItem ───────────────────────────────────────
function AttachmentItem({ att, onUpdate, onDelete }) {
  const [lightbox, setLightbox] = useState(false);
  const isImage = att.type === "image";

  const handleDownload = () => {
    const token = localStorage.getItem("gtoken");
    if (!token || !att.driveFileId) return;
    const url = `https://www.googleapis.com/drive/v3/files/${att.driveFileId}?alt=media`;
    fetch(url, { headers:{ Authorization:`Bearer ${token}` } })
      .then(r => r.blob())
      .then(blob => {
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = att.name;
        a.click();
        URL.revokeObjectURL(a.href);
      })
      .catch(() => alert("Download failed. Please re-login."));
  };

  if (!isImage) return (
    <div style={{ display:"flex", alignItems:"center", gap:8, background:"#f0f5ff",
      borderRadius:8, padding:"8px 12px", marginBottom:4, border:"1px solid #dce8fb" }}>
      <span style={{ fontSize:20, flexShrink:0 }}>📄</span>
      <span style={{ flex:1, fontSize:13, color:"#1e3a6e", fontWeight:500,
        overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{att.name}</span>
      <span style={{ fontSize:11, color:"#94a3b8", flexShrink:0 }}>
        {att.size ? (att.size/1024/1024).toFixed(1)+"MB" : ""}
      </span>
      <button style={{ background:"#2563eb", color:"#fff", border:"none", borderRadius:6,
        padding:"4px 10px", fontSize:12, cursor:"pointer", fontFamily:"inherit", fontWeight:600, flexShrink:0 }}
        onClick={handleDownload}>↓</button>
      <span style={{ color:"#fca5a5", fontSize:16, cursor:"pointer", flexShrink:0 }}
        onClick={onDelete}>×</span>
    </div>
  );

  // Image attachment
  if (att.collapsed) return (
    <div style={{ display:"flex", alignItems:"center", gap:8, background:"#f8faff",
      borderRadius:8, padding:"6px 10px", marginBottom:4, border:"1px solid #e0eaf8" }}>
      <span style={{ fontSize:16 }}>🖼</span>
      <span style={{ flex:1, fontSize:12.5, color:"#4b6fa8",
        overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{att.name}</span>
      <button title="Expand" style={{ background:"none", border:"1px solid #dce8fb", borderRadius:5,
        padding:"2px 8px", fontSize:11, cursor:"pointer", color:"#6b8bb5", fontFamily:"inherit" }}
        onClick={() => onUpdate({ collapsed:false })}>↕</button>
      <span style={{ color:"#fca5a5", fontSize:16, cursor:"pointer" }} onClick={onDelete}>×</span>
    </div>
  );

  return (
    <>
      <div style={{ display:"flex", gap:12, background:"#f8faff", borderRadius:10, padding:10,
        marginBottom:4, border:"1px solid #e0eaf8", alignItems:"flex-start" }}>
        {/* Thumbnail */}
        <img src={att.thumbnailDataUrl} alt={att.name}
          style={{ width:96, height:96, objectFit:"cover", borderRadius:7, cursor:"zoom-in",
            flexShrink:0, border:"1px solid #e0eaf8" }}
          onClick={() => setLightbox(true)} />
        {/* Script area */}
        <div style={{ flex:1, minWidth:0 }}>
          <div style={{ fontSize:11, color:"#94a3b8", marginBottom:4,
            overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{att.name}</div>
          <textarea
            value={att.script||""}
            onChange={e => onUpdate({ script:e.target.value })}
            placeholder="Add notes about this image..."
            style={{ width:"100%", border:"1px solid #e0eaf8", borderRadius:6, padding:"6px 8px",
              fontSize:12.5, color:"#1e3a6e", fontFamily:"inherit", resize:"vertical",
              minHeight:64, background:"#fff", outline:"none", boxSizing:"border-box",
              lineHeight:1.6 }} />
        </div>
        {/* Right actions */}
        <div style={{ display:"flex", flexDirection:"column", gap:6, flexShrink:0 }}>
          <button title="Download" style={{ background:"#2563eb", color:"#fff", border:"none",
            borderRadius:6, width:28, height:28, cursor:"pointer", fontSize:14,
            display:"flex", alignItems:"center", justifyContent:"center" }}
            onClick={handleDownload}>↓</button>
          <button title="Collapse" style={{ background:"none", border:"1px solid #dce8fb",
            borderRadius:6, width:28, height:28, cursor:"pointer", fontSize:12, color:"#6b8bb5",
            display:"flex", alignItems:"center", justifyContent:"center" }}
            onClick={() => onUpdate({ collapsed:true })}>↕</button>
          <button title="Delete" style={{ background:"none", border:"1px solid #fecaca",
            borderRadius:6, width:28, height:28, cursor:"pointer", fontSize:15, color:"#fca5a5",
            display:"flex", alignItems:"center", justifyContent:"center" }}
            onClick={onDelete}>×</button>
        </div>
      </div>
      {/* Lightbox */}
      {lightbox && (
        <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,.85)", zIndex:9000,
          display:"flex", alignItems:"center", justifyContent:"center" }}
          onClick={() => setLightbox(false)}>
          <img src={att.thumbnailDataUrl} alt={att.name}
            style={{ maxWidth:"90vw", maxHeight:"88vh", borderRadius:10, objectFit:"contain" }} />
          <div style={{ position:"absolute", top:16, right:20, display:"flex", gap:8 }}>
            <button style={{ background:"#2563eb", color:"#fff", border:"none", borderRadius:8,
              padding:"8px 16px", fontSize:13, cursor:"pointer", fontWeight:600, fontFamily:"inherit" }}
              onClick={e => { e.stopPropagation(); handleDownload(); }}>↓ Download</button>
            <button style={{ background:"rgba(255,255,255,.15)", color:"#fff", border:"1px solid rgba(255,255,255,.3)",
              borderRadius:8, padding:"8px 14px", fontSize:18, cursor:"pointer" }}
              onClick={() => setLightbox(false)}>×</button>
          </div>
        </div>
      )}
    </>
  );
}


function TextBlock({ item, isMobile, drag, bp, fs, onUpdate, onDelete, onFocus }) {
  const [showLM,      setShowLM]      = useState(false);
  const [uploading,   setUploading]   = useState(false);
  const fileInputRef = useRef(null);

  const addHS  = () => onUpdate({ hiddenSections:[...(item.hiddenSections||[]), { id:`hs${nextId++}`, label:"New Section", content:"", open:true }] });
  const updHS  = (id,p) => onUpdate({ hiddenSections:(item.hiddenSections||[]).map(h=>h.id===id?{...h,...p}:h) });
  const delHS  = id => onUpdate({ hiddenSections:(item.hiddenSections||[]).filter(h=>h.id!==id) });
  const addLk  = ({label,url}) => { onUpdate({ links:[...(item.links||[]),{id:`lk${nextId++}`,label,url}] }); setShowLM(false); };
  const delLk  = id => onUpdate({ links:(item.links||[]).filter(l=>l.id!==id) });
  const addTbl = () => onUpdate({ tables:[...(item.tables||[]), mkTable(2,3)] });
  const updTbl = (id,patch) => onUpdate({ tables:(item.tables||[]).map(t=>t.id===id?{...t,...patch}:t) });
  const delTbl = id => onUpdate({ tables:(item.tables||[]).filter(t=>t.id!==id) });
  const updAtt = (id,p) => onUpdate({ attachments:(item.attachments||[]).map(a=>a.id===id?{...a,...p}:a) });
  const delAtt = id => onUpdate({ attachments:(item.attachments||[]).filter(a=>a.id!==id) });

  const MAX_SIZE = 10 * 1024 * 1024; // 10MB

  const handleFileSelect = async (e) => {
    const file = e.target.files?.[0];
    if (!fileInputRef.current) return;
    fileInputRef.current.value = "";
    if (!file) return;
    if (file.size > MAX_SIZE) { alert(`File too large. Max 10MB (selected: ${(file.size/1024/1024).toFixed(1)}MB)`); return; }
    const token = localStorage.getItem("gtoken");
    if (!token) { alert("Please sign in with Google to upload files."); return; }
    setUploading(true);
    try {
      const isImage = file.type.startsWith("image/");
      const driveFile = await gdriveUploadFile(token, file);
      let thumbnailDataUrl = null;
      if (isImage) thumbnailDataUrl = await createThumbnail(file);
      const att = {
        id: `att${nextId++}`,
        type: isImage ? "image" : "file",
        name: file.name,
        size: file.size,
        driveFileId: driveFile.id,
        thumbnailDataUrl,
        script: "",
        collapsed: false,
      };
      onUpdate({ attachments:[...(item.attachments||[]), att] });
    } catch(err) {
      alert(err.message === "TOKEN_EXPIRED" ? "Session expired. Please re-login." : `Upload failed: ${err.message}`);
    } finally {
      setUploading(false);
    }
  };
  const pad = isMobile ? "14px" : "13px 14px";
  return (
    <>
      <div style={{ background:"#fff", borderRadius:12, marginBottom:5, boxShadow:"0 1px 4px rgba(15,32,68,.06)", display:"flex", flexDirection:"column", alignItems:"stretch", cursor:"grab", userSelect:"none", ...drag }} {...bp}>
        <div style={{ display:"flex", alignItems:"center", gap:8, padding:pad, paddingBottom:6 }}>
          <div style={{ width:3, height:16, borderRadius:2, background:item.starred?"#f59e0b":"#2563eb", flexShrink:0 }} />
          {item.starred && (
            <span style={{ fontSize:12, color:"#f59e0b", flexShrink:0, lineHeight:1, marginRight:-4, pointerEvents:"none" }}>★</span>
          )}
          <input style={{ color:"#0f2044", border:"none", background:"transparent", outline:"none", fontFamily:"inherit", fontSize:fs, fontWeight:600, flex:1 }}
            value={item.title} placeholder="Title..."
            onChange={e=>onUpdate({title:e.target.value})}
            onFocus={onFocus}
            onClick={e=>e.stopPropagation()} />
          <span style={{ fontSize:14, cursor:"pointer", userSelect:"none", flexShrink:0, color:item.starred?"#f59e0b":"#dbe6f5" }}
            onClick={()=>onUpdate({starred:!item.starred})}>★</span>
          <span style={{ color:"#d0ddef", fontSize:19, cursor:"pointer", lineHeight:1, padding:"0 2px", userSelect:"none", flexShrink:0 }} onClick={onDelete}>×</span>
        </div>
        <div style={{ paddingLeft:21, paddingRight:14, paddingBottom:6 }} onClick={e=>e.stopPropagation()}>
          <RichText html={item.body||""} onChange={v=>onUpdate({body:v})} placeholder="Write content here..." style={{fontSize:isMobile?14:13.5}} />
        </div>
        {(item.hiddenSections||[]).map(h=>(
          <HiddenSection key={h.id} section={h} isMobile={isMobile} onUpdate={p=>updHS(h.id,p)} onDelete={()=>delHS(h.id)} />
        ))}
        {(item.tables||[]).map(t=>(
          <div key={t.id} style={{padding:"0 14px 6px 21px"}} onClick={e=>e.stopPropagation()}>
            <TableBlock table={t} onUpdate={patch=>updTbl(t.id,patch)} onDelete={()=>delTbl(t.id)} />
          </div>
        ))}
        {(item.links||[]).length > 0 && (
          <div style={{ display:"flex", flexDirection:"column", gap:8, padding:"4px 14px 8px 21px" }}>
            {item.links.map(lk=>(<LinkItem key={lk.id} lk={lk} onDelete={()=>delLk(lk.id)} />))}
          </div>
        )}
        {(item.attachments||[]).length > 0 && (
          <div style={{ padding:"4px 14px 8px 21px", display:"flex", flexDirection:"column", gap:2 }}>
            {(item.attachments||[]).map(att=>(
              <AttachmentItem key={att.id} att={att}
                onUpdate={p=>updAtt(att.id,p)} onDelete={()=>delAtt(att.id)} />
            ))}
          </div>
        )}
        <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", padding:"6px 14px 10px", borderTop:"1px solid #f0f4fa", marginTop:4 }}>
          <span style={{ fontSize:10, color:"#a8bcd8" }}>{item.createdAt}</span>
          <div style={{ display:"flex", gap:5, alignItems:"center" }}>
            {/* § Section */}
            <button title="Add section" style={footBtn} onClick={e=>{e.stopPropagation();addHS();}}>
              <svg width="13" height="13" viewBox="0 0 14 14" fill="none" style={{display:"block"}}>
                <rect x="1" y="2" width="12" height="2.5" rx="1" fill="currentColor" opacity=".6"/>
                <rect x="1" y="5.5" width="12" height="6" rx="1" fill="none" stroke="currentColor" strokeWidth="1.2"/>
                <line x1="7" y1="7" x2="7" y2="10" stroke="currentColor" strokeWidth="1.2"/>
                <line x1="5.5" y1="8.5" x2="8.5" y2="8.5" stroke="currentColor" strokeWidth="1.2"/>
              </svg>
            </button>
            {/* ⊞ Table */}
            <button title="Add table" style={footBtn} onClick={e=>{e.stopPropagation();addTbl();}}>
              <svg width="13" height="13" viewBox="0 0 14 14" fill="none" style={{display:"block"}}>
                <rect x="1" y="1" width="12" height="12" rx="1.5" stroke="currentColor" strokeWidth="1.2" fill="none"/>
                <line x1="1" y1="4.5" x2="13" y2="4.5" stroke="currentColor" strokeWidth="1.1"/>
                <line x1="7" y1="4.5" x2="7" y2="13" stroke="currentColor" strokeWidth="1.1"/>
              </svg>
            </button>
            {/* 🔗 Link */}
            <button title="Add link" style={footBtn} onClick={e=>{e.stopPropagation();setShowLM(true);}}>
              <svg width="13" height="13" viewBox="0 0 14 14" fill="none" style={{display:"block"}}>
                <path d="M5.5 8.5L8.5 5.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
                <path d="M3.5 6.5L2.5 7.5a2.5 2.5 0 003.5 3.5l1-1" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
                <path d="M6.5 3.5l1-1a2.5 2.5 0 013.5 3.5L9.5 7.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
              </svg>
            </button>
            {/* 📎 Data (file/image upload) */}
            <button title="Upload file or image (max 10MB)" style={{...footBtn, position:"relative",
              ...(uploading?{opacity:.5,pointerEvents:"none"}:{})}}
              onClick={e=>{e.stopPropagation(); fileInputRef.current?.click();}}>
              {uploading
                ? <svg width="13" height="13" viewBox="0 0 14 14" style={{display:"block",animation:"spin .8s linear infinite"}}>
                    <circle cx="7" cy="7" r="5" stroke="currentColor" strokeWidth="1.5" fill="none" strokeDasharray="20" strokeDashoffset="10"/>
                  </svg>
                : <svg width="13" height="13" viewBox="0 0 14 14" fill="none" style={{display:"block"}}>
                    <path d="M2 10v1.5a.5.5 0 00.5.5h9a.5.5 0 00.5-.5V10" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
                    <path d="M7 1.5v7M4.5 4L7 1.5 9.5 4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
              }
            </button>
            <input ref={fileInputRef} type="file" accept="image/*,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.zip,.csv"
              style={{display:"none"}} onChange={handleFileSelect} />
          </div>
        </div>
      </div>
      {showLM && <LinkModal onConfirm={addLk} onClose={()=>setShowLM(false)} />}
    </>
  );
}
const footBtn = {background:"none",border:"1px dashed #b8cce8",borderRadius:6,color:"#6b8bb5",fontSize:11.5,padding:0,cursor:"pointer",fontFamily:"inherit",fontWeight:500,width:26,height:26,display:"flex",alignItems:"center",justifyContent:"center"};


// ─── SortableList ────────────────────────────────────────
function SortableList({ items, setItems, getKey, collapsedHdrs, toggleHdr, selMode, selected, togSel, isMobile, upd, softDel, folders, focusNewItem, onFocusItemDone, onFocusId }) {
  useEffect(() => {
    if (!focusNewItem) return;
    setTimeout(() => {
      const el = document.querySelector(`[data-todoitem="${focusNewItem}"]`);
      if (el) { el.focus(); onFocusItemDone?.(); }
    }, 60);
  }, [focusNewItem]);
  const containerRef = useRef(null);
  const { beginDrag } = useSortable(containerRef, items, setItems);

  // Build header sections — exclude done todos from main list
  const activeItems = items.filter(i => !(i.type === T.TODO && i.done));
  const doneTodos   = items.filter(i => i.type === T.TODO && i.done);
  const sections = [];
  let cur = null;
  activeItems.forEach((item) => {
    const idx = items.indexOf(item);
    if (item.type === T.HEADER) {
      cur = { header: item, hIdx: idx, children: [] };
      sections.push(cur);
    } else {
      if (!cur) { cur = { header: null, hIdx: -1, children: [] }; sections.push(cur); }
      cur.children.push({ item, idx });
    }
  });

  const handle = (idx, mt) => (
    <span
      style={{ color:"rgba(15,32,68,.2)", fontSize:16, cursor:"grab", padding:"0 4px",
               flexShrink:0, marginTop:mt||0, userSelect:"none", touchAction:"none", lineHeight:1 }}
      onMouseDown={e => beginDrag(e, idx)}
      onTouchStart={e => { const t=e.touches[0]; beginDrag({clientY:t.clientY,touches:e.touches,preventDefault:()=>e.preventDefault(),stopPropagation:()=>e.stopPropagation()},idx); }}>
      ⠿
    </span>
  );

  return (
    <div ref={containerRef}>
      {sections.map((sec, si) => {
        // 안정적인 key: header가 있으면 header.id, 없으면 첫 번째 child의 id 사용 (인덱스 기반 key 금지)
        const secKey = sec.header?.id || sec.children[0]?.item.id || `pre-${si}`;
        return (
        <div key={secKey}>
          {sec.header && (
            <div data-sortidx={sec.hIdx} style={{ display:"flex", alignItems:"center", gap:6, marginBottom:2, marginTop:12, width:"100%", boxSizing:"border-box", overflow:"hidden" }}>
              {selMode && (
                <div style={{ width:18,height:18,borderRadius:5,border:"1.5px solid #c2d0e8",display:"flex",alignItems:"center",justifyContent:"center",fontSize:11,color:"#fff",fontWeight:700,cursor:"pointer",flexShrink:0,marginTop:2,...(selected.has(sec.header.id)?{background:"#2563eb",borderColor:"#2563eb"}:{}) }}
                  onClick={() => togSel(sec.header.id)}>{selected.has(sec.header.id)&&"✓"}</div>
              )}
              <div style={{ flex:1, display:"flex", alignItems:"center", gap:8, minWidth:0,
                background:"linear-gradient(90deg,rgba(37,99,235,.09),rgba(37,99,235,.04))",
                border:"1px solid rgba(37,99,235,.12)", borderLeft:"3px solid #2563eb",
                borderRadius:9, padding:"10px 14px", overflow:"hidden" }}>
                <button style={{ background:"none",border:"none",cursor:"pointer",padding:"4px 8px",color:"#2563eb",fontSize:20,display:"flex",alignItems:"center",flexShrink:0,minWidth:32,minHeight:32,justifyContent:"center",borderRadius:6 }}
                  onClick={() => toggleHdr(sec.header.id)}>
                  <span style={{ display:"inline-block",transition:"transform .2s",transform:collapsedHdrs.has(sec.header.id)?"rotate(-90deg)":"rotate(0deg)" }}>▾</span>
                </button>
                <input style={{ fontWeight:700,color:"#1a3a78",flex:1,border:"none",background:"transparent",outline:"none",fontFamily:"inherit",fontSize:isMobile?15:14 }}
                  value={sec.header.title} placeholder="Header title..."
                  onChange={e => upd(sec.header.id,{title:e.target.value})}
                  onFocus={() => onFocusId?.(sec.header.id)}
                  onClick={e=>e.stopPropagation()} />
                {sec.children.length>0 && <span style={{ fontSize:10,color:"rgba(37,99,235,.5)",background:"rgba(37,99,235,.1)",borderRadius:10,padding:"1px 7px",flexShrink:0 }}>{sec.children.length}</span>}
                <span style={{ fontSize:14,cursor:"pointer",flexShrink:0,color:sec.header.starred?"#3b82f6":"rgba(59,130,246,.3)" }}
                  onClick={()=>upd(sec.header.id,{starred:!sec.header.starred})}>★</span>
                {handle(sec.hIdx)}
                <span style={{ color:"#94a3b8",fontSize:20,cursor:"pointer",lineHeight:1,padding:"0 4px",flexShrink:0 }}
                  onClick={()=>softDel(sec.header.id)}>×</span>
              </div>
            </div>
          )}
          {!collapsedHdrs.has(sec.header?.id) && sec.children.map(({ item, idx }) => (
            <div key={item.id} data-sortidx={idx} style={{ display:"flex", alignItems:"flex-start", gap:6, paddingLeft:0, width:"100%", boxSizing:"border-box", overflow:"hidden" }}>
              {selMode && (
                <div style={{ width:18,height:18,borderRadius:5,border:"1.5px solid #c2d0e8",display:"flex",alignItems:"center",justifyContent:"center",fontSize:11,color:"#fff",fontWeight:700,cursor:"pointer",flexShrink:0,marginTop:item.type===T.TEXT?16:14,...(selected.has(item.id)?{background:"#2563eb",borderColor:"#2563eb"}:{}) }}
                  onClick={()=>togSel(item.id)}>{selected.has(item.id)&&"✓"}</div>
              )}
              {handle(idx, item.type===T.TEXT?16:14)}
              <div style={{ flex:1 }}>
                <ItemBlock item={item} isMobile={isMobile} onUpdate={p=>upd(item.id,p)} onDelete={()=>softDel(item.id)}
                  onFocus={() => onFocusId?.(item.id)}
                  onMove={folderId => upd(item.id, { folder:folderId })} folders={folders}
                  onAddBelow={item.type===T.TODO ? () => {
                    const newId = `i${Date.now()}`;
                    const newTodo = { id:newId, type:T.TODO, folder:item.folder, starred:false, createdAt:item.createdAt, title:"", done:false };
                    setItems(arr => {
                      const a = [...arr];
                      const pos = a.findIndex(x => x.id===item.id);
                      a.splice(pos+1, 0, newTodo);
                      return a;
                    });
                    if (onFocusItemDone) setTimeout(() => {
                      const el = document.querySelector(`[data-todoitem="${newId}"]`);
                      if (el) el.focus();
                    }, 60);
                  } : undefined} />
              </div>
            </div>
          ))}
        </div>
        );
      })}
      {/* ── Completed section ── */}
      {doneTodos.length > 0 && (
        <CompletedSection doneTodos={doneTodos} upd={upd} softDel={softDel} isMobile={isMobile} />
      )}
    </div>
  );
}

function CompletedSection({ doneTodos, upd, softDel, isMobile }) {
  const [open, setOpen] = useState(false);
  const fs = isMobile ? 14 : 13.5;
  // Most recently completed first
  const sorted = [...doneTodos].reverse();
  return (
    <div style={{ marginTop:20, borderTop:"1px dashed #e0eaf8", paddingTop:10 }}>
      <div style={{ display:"flex", alignItems:"center", gap:8, cursor:"pointer", padding:"6px 4px", userSelect:"none" }}
        onClick={() => setOpen(v => !v)}>
        <span style={{ display:"inline-block", transition:"transform .2s",
          transform:open?"rotate(0deg)":"rotate(-90deg)", color:"#94a3b8", fontSize:13 }}>▾</span>
        <span style={{ fontSize:12, fontWeight:700, color:"#94a3b8" }}>Completed</span>
        {/* Badge */}
        <span style={{ background:"#e8eef8", color:"#6b8bb5", borderRadius:10,
          padding:"1px 8px", fontSize:11, fontWeight:700 }}>{doneTodos.length}</span>
        <span style={{ flex:1 }}/>
        {doneTodos.length > 0 && (
          <span style={{ fontSize:10, color:"#b0c4de" }}>
            Latest: {sorted[0]?.createdAt || ""}
          </span>
        )}
      </div>
      {open && (
        <div style={{ marginTop:4 }}>
          {sorted.map(item => (
            <div key={item.id} style={{ display:"flex", alignItems:"center", gap:8,
              background:"#f8faff", borderRadius:10, padding:"9px 12px", marginBottom:3,
              width:"100%", boxSizing:"border-box", overflow:"hidden",
              borderLeft:"3px solid #e0eaf8" }}>
              {/* Uncheck button */}
              <div style={{ borderRadius:5, border:"1.5px solid #c2d0e8", background:"#e8f0fe",
                display:"flex", alignItems:"center", justifyContent:"center",
                cursor:"pointer", flexShrink:0, width:18, height:18 }}
                title="Mark as incomplete"
                onClick={() => upd(item.id, { done:false })}>
                <span style={{ color:"#2563eb", fontSize:11, fontWeight:700 }}>✓</span>
              </div>
              <span style={{ flex:1, fontSize:fs, color:"#a0b4cc",
                textDecoration:"line-through", overflow:"hidden",
                textOverflow:"ellipsis", whiteSpace:"nowrap", minWidth:0 }}>
                {item.title||"(no title)"}
              </span>
              {!isMobile && item.createdAt && (
                <span style={{ fontSize:10, color:"#c0d0e4", flexShrink:0 }}>{item.createdAt}</span>
              )}
              {/* 휴지통으로 이동 버튼 */}
              <span
                title="휴지통으로 이동"
                style={{ color:"#fca5a5", fontSize:17, cursor:"pointer", lineHeight:1,
                  padding:"0 2px", flexShrink:0, userSelect:"none" }}
                onClick={e => { e.stopPropagation(); softDel(item.id); }}>×</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── MobileTodoTextarea ──────────────────────────────────
// 항상 전체 내용을 표시하는 auto-resize textarea (선택 없이도 줄바꿈 표시)
function MobileTodoTextarea({ id, value, done, fs, onUpdate, onFocus, onAddBelow }) {
  const ref = useRef(null);

  // 마운트 + value 변경 시 항상 높이 자동 조절
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = el.scrollHeight + "px";
  }); // 의존성 없이 매 렌더마다 실행 → 항상 정확한 높이 유지

  return (
    <textarea
      ref={ref}
      data-todoitem={id}
      rows={1}
      style={{ color:"#1e3a6e", border:"none", background:"transparent", outline:"none",
        fontFamily:"inherit", fontSize:fs, flex:1, minWidth:0, resize:"none",
        overflowY:"hidden", lineHeight:1.5, padding:0,
        ...(done?{textDecoration:"line-through",color:"#96acc8"}:{}) }}
      value={value}
      placeholder="Add a task..."
      onChange={e => {
        const el = e.target;
        el.style.height = "auto";
        el.style.height = el.scrollHeight + "px";
        onUpdate({ title:e.target.value });
      }}
      onFocus={e => { onFocus?.(); }}
      onClick={e => e.stopPropagation()}
      onKeyDown={e => { if (e.key==="Enter") { e.preventDefault(); onAddBelow?.(); } }}
    />
  );
}

function ItemBlock({ item, isMobile, onUpdate, onDelete, onMove, folders, onAddBelow, onFocus }) {
  const bp = {};
  const drag = {};
  const fs = isMobile ? 15 : 14;

  // menuState: null | 'main' | 'duedate' | 'moveto' | 'copyMove'
  const [menuState,  setMenuState]  = useState(null);
  const [dropPos,    setDropPos]    = useState({ top:0, left:0 });
  const [selFolder,  setSelFolder]  = useState(null); // Move to 선택한 폴더
  const btnRef  = useRef(null);
  const dropRef = useRef(null);

  const openMenu = e => {
    e.stopPropagation();
    if (!btnRef.current) return;
    const r = btnRef.current.getBoundingClientRect();
    setDropPos({ top: r.bottom + 6, left: r.right });
    setMenuState(s => s ? null : 'main');
  };

  const closeMenu = () => { setMenuState(null); setSelFolder(null); };

  // 외부 클릭만으로 닫기 (스크롤은 드롭다운 외부 스크롤만)
  useEffect(() => {
    if (!menuState) return;
    const onMouseDown = e => {
      if (dropRef.current && dropRef.current.contains(e.target)) return;
      if (btnRef.current && btnRef.current.contains(e.target)) return;
      closeMenu();
    };
    const onScroll = e => {
      // 드롭다운 내부 스크롤이면 무시
      if (dropRef.current && dropRef.current.contains(e.target)) return;
      closeMenu();
    };
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("scroll", onScroll, true);
    };
  }, [menuState]);

  if (item.type === T.HEADER) return (
    <div style={{ display:"flex", alignItems:"center", gap:8, background:"linear-gradient(90deg,rgba(37,99,235,.09),rgba(37,99,235,.04))", border:"1px solid rgba(37,99,235,.12)", borderLeft:`3px solid ${item.starred?"#f59e0b":"#2563eb"}`, borderRadius:9, marginBottom:8, marginTop:12, padding:"11px 14px", cursor:"grab", userSelect:"none", ...drag }} {...bp}>
      {item.starred && <span style={{ fontSize:12, color:"#f59e0b", flexShrink:0, lineHeight:1 }}>★</span>}
      <input style={{ fontWeight:700, color:"#1a3a78", flex:1, border:"none", background:"transparent", outline:"none", fontFamily:"inherit", fontSize:isMobile?15:14 }}
        value={item.title} placeholder="Header title..."
        onChange={e => onUpdate({ title:e.target.value })}
        onFocus={onFocus}
        onClick={e => e.stopPropagation()} />
      <span style={{ fontSize:14, cursor:"pointer", userSelect:"none", flexShrink:0, color:item.starred?"#f59e0b":"rgba(59,130,246,.3)" }}
        onClick={() => onUpdate({ starred:!item.starred })}>★</span>
      <span style={{ color:"#94a3b8", fontSize:19, cursor:"pointer", lineHeight:1, padding:"0 2px", userSelect:"none", flexShrink:0 }} onClick={onDelete}>×</span>
    </div>
  );

  if (item.type === T.TODO) return (
    <div style={{ background:"#fff", borderRadius:12, marginBottom:5, boxShadow:"0 1px 4px rgba(15,32,68,.06)", cursor:"grab", userSelect:"none", width:"100%", boxSizing:"border-box", position:"relative", ...drag }} {...bp}>
      {/* 메인 행 */}
      <div style={{ padding:isMobile?"10px 10px 8px":"10px 14px 8px", display:"flex",
        alignItems:isMobile?"flex-start":"center",
        gap:8, width:"100%", boxSizing:"border-box", minWidth:0 }}>
        {/* 체크박스 */}
        <div style={{ borderRadius:5, border:"1.5px solid #c2d0e8", display:"flex", alignItems:"center", justifyContent:"center", cursor:"pointer", flexShrink:0,
          width:isMobile?20:18, height:isMobile?20:18,
          marginTop:isMobile?2:0,
          ...(item.done?{background:"#2563eb",borderColor:"#2563eb"}:{}) }}
          onClick={() => onUpdate({ done:!item.done })}>
          {item.done && <span style={{ color:"#fff", fontSize:11, fontWeight:700 }}>✓</span>}
        </div>
        {item.starred && (
          <span style={{ fontSize:12, color:"#f59e0b", flexShrink:0, lineHeight:1, marginRight:-2, pointerEvents:"none", marginTop:isMobile?3:0 }}>★</span>
        )}
        {/* 텍스트: 모바일=textarea(항상 전체 표시), PC=input(한줄) */}
        {isMobile ? (
          <MobileTodoTextarea
            id={item.id}
            value={item.title}
            done={item.done}
            fs={fs}
            onUpdate={onUpdate}
            onFocus={onFocus}
            onAddBelow={onAddBelow}
          />
        ) : (
          <input
            data-todoitem={item.id}
            style={{ color:"#1e3a6e", border:"none", background:"transparent", outline:"none", fontFamily:"inherit", fontSize:fs, flex:1, minWidth:0, ...(item.done?{textDecoration:"line-through",color:"#96acc8"}:{}) }}
            value={item.title}
            placeholder="Add a task..."
            onChange={e => onUpdate({ title:e.target.value })}
            onFocus={onFocus}
            onClick={e => e.stopPropagation()}
            onKeyDown={e => { if (e.key==="Enter") { e.preventDefault(); onAddBelow?.(); } }}
          />
        )}
        {!isMobile && <span style={{ fontSize:10, color:"#a8bcd8", whiteSpace:"nowrap", flexShrink:0 }}>{item.createdAt}</span>}
        <span style={{ fontSize:14, cursor:"pointer", userSelect:"none", flexShrink:0, color:item.starred?"#f59e0b":"#dbe6f5", marginTop:isMobile?2:0 }}
          onClick={() => onUpdate({ starred:!item.starred })}>★</span>

        {/* ⋯ 버튼 — portal 드롭다운 */}
        {onMove && folders && (
          <div style={{ flexShrink:0 }}>
            <span
              ref={btnRef}
              style={{ color:"#c2d0e8", fontSize:16, cursor:"pointer", padding:"0 3px", userSelect:"none", lineHeight:1 }}
              onClick={openMenu}
              title="More options">⋯</span>

            {menuState && createPortal(
              <div
                ref={dropRef}
                style={{ position:"fixed", top:dropPos.top, left:Math.min(dropPos.left - 180, window.innerWidth - 200),
                  background:"#fff", borderRadius:12,
                  boxShadow:"0 8px 32px rgba(15,32,68,.2)", border:"1px solid #e0eaf8",
                  zIndex:9999, minWidth:180, overflow:"hidden",
                  fontFamily:"'SF Pro Display',-apple-system,'Helvetica Neue',sans-serif" }}
                onMouseDown={e => e.stopPropagation()}>

                {/* ── Level 1: 메인 메뉴 ── */}
                {menuState === 'main' && (
                  <>
                    <div style={{ padding:"8px 0 4px" }}>
                      {/* Due Date */}
                      <div
                        style={{ display:"flex", alignItems:"center", gap:10, padding:"10px 16px", cursor:"pointer", fontSize:13, fontWeight:600, color:"#1e3a6e" }}
                        onMouseEnter={e => e.currentTarget.style.background="#f5f8ff"}
                        onMouseLeave={e => e.currentTarget.style.background="transparent"}
                        onMouseDown={() => setMenuState('duedate')}>
                        <span style={{ fontSize:15 }}>📅</span>
                        <span style={{ flex:1 }}>Due Date</span>
                        {item.dueDate && <span style={{ fontSize:10, color:"#ef4444", fontWeight:700 }}>{item.dueDate}</span>}
                        <span style={{ color:"#c2d0e8", fontSize:12 }}>›</span>
                      </div>
                      {/* Move to */}
                      <div
                        style={{ display:"flex", alignItems:"center", gap:10, padding:"10px 16px", cursor:"pointer", fontSize:13, fontWeight:600, color:"#1e3a6e" }}
                        onMouseEnter={e => e.currentTarget.style.background="#f5f8ff"}
                        onMouseLeave={e => e.currentTarget.style.background="transparent"}
                        onMouseDown={() => setMenuState('moveto')}>
                        <span style={{ fontSize:15 }}>📂</span>
                        <span style={{ flex:1 }}>Move to</span>
                        <span style={{ color:"#c2d0e8", fontSize:12 }}>›</span>
                      </div>
                    </div>
                  </>
                )}

                {/* ── Level 2a: Due Date 달력 ── */}
                {menuState === 'duedate' && (
                  <>
                    <div style={{ display:"flex", alignItems:"center", padding:"10px 14px 6px", borderBottom:"1px solid #f0f4fa" }}>
                      <span style={{ color:"#94a3b8", fontSize:16, cursor:"pointer", marginRight:8, lineHeight:1 }}
                        onMouseDown={() => setMenuState('main')}>‹</span>
                      <span style={{ fontSize:12, fontWeight:700, color:"#1e3a6e" }}>Due Date</span>
                    </div>
                    <div style={{ padding:"10px 12px 12px" }}>
                      <TodoDatePicker
                        value={item.dueDate || ""}
                        onChange={d => { onUpdate({ dueDate: d }); closeMenu(); }}
                        onClear={() => { onUpdate({ dueDate: undefined }); closeMenu(); }}
                      />
                    </div>
                  </>
                )}

                {/* ── Level 2b: Move to 폴더 선택 ── */}
                {menuState === 'moveto' && (
                  <>
                    <div style={{ display:"flex", alignItems:"center", padding:"10px 14px 6px", borderBottom:"1px solid #f0f4fa" }}>
                      <span style={{ color:"#94a3b8", fontSize:16, cursor:"pointer", marginRight:8, lineHeight:1 }}
                        onMouseDown={() => setMenuState('main')}>‹</span>
                      <span style={{ fontSize:12, fontWeight:700, color:"#1e3a6e" }}>Select Folder</span>
                    </div>
                    <div style={{ maxHeight:200, overflowY:"auto" }}>
                      {folders.map(f => (
                        <div key={f.id}
                          style={{ display:"flex", alignItems:"center", padding:"9px 14px", fontSize:13, cursor:"pointer", fontWeight:500,
                            color: item.folder===f.id?"#94a3b8":"#1e3a6e",
                            background:"transparent",
                            opacity: item.folder===f.id ? 0.5 : 1 }}
                          onMouseEnter={e => { if (item.folder!==f.id) e.currentTarget.style.background="#f5f8ff"; }}
                          onMouseLeave={e => e.currentTarget.style.background="transparent"}
                          onMouseDown={() => {
                            if (item.folder === f.id) return;
                            setSelFolder(f);
                            setMenuState('copyMove');
                          }}>
                          <span style={{ flex:1 }}>{f.name}</span>
                          {item.folder===f.id && <span style={{ fontSize:10, color:"#94a3b8" }}>현재</span>}
                        </div>
                      ))}
                    </div>
                  </>
                )}

                {/* ── Level 3: Copy or Move 선택 ── */}
                {menuState === 'copyMove' && selFolder && (
                  <>
                    <div style={{ display:"flex", alignItems:"center", padding:"10px 14px 6px", borderBottom:"1px solid #f0f4fa" }}>
                      <span style={{ color:"#94a3b8", fontSize:16, cursor:"pointer", marginRight:8, lineHeight:1 }}
                        onMouseDown={() => { setMenuState('moveto'); setSelFolder(null); }}>‹</span>
                      <span style={{ fontSize:12, fontWeight:700, color:"#1e3a6e", flex:1 }}>{selFolder.name}</span>
                    </div>
                    <div style={{ padding:"8px 0 6px" }}>
                      {/* 이동 */}
                      <div
                        style={{ display:"flex", alignItems:"center", gap:10, padding:"10px 16px", cursor:"pointer", fontSize:13, fontWeight:600, color:"#1e3a6e" }}
                        onMouseEnter={e => e.currentTarget.style.background="#f5f8ff"}
                        onMouseLeave={e => e.currentTarget.style.background="transparent"}
                        onMouseDown={() => { onMove(selFolder.id); closeMenu(); }}>
                        <span style={{ fontSize:15 }}>✂️</span>
                        <div>
                          <div>이동</div>
                          <div style={{ fontSize:11, color:"#94a3b8", fontWeight:400 }}>이 폴더에서 제거됩니다</div>
                        </div>
                      </div>
                      {/* 복사 */}
                      <div
                        style={{ display:"flex", alignItems:"center", gap:10, padding:"10px 16px", cursor:"pointer", fontSize:13, fontWeight:600, color:"#1e3a6e" }}
                        onMouseEnter={e => e.currentTarget.style.background="#f5f8ff"}
                        onMouseLeave={e => e.currentTarget.style.background="transparent"}
                        onMouseDown={() => {
                          // 복사: 원본 유지 + 새 아이템 대상 폴더에 추가
                          const copy = {
                            ...item,
                            id: `i${Date.now()}_copy`,
                            folder: selFolder.id,
                            createdAt: mkDate(),
                          };
                          onUpdate({ _copy: copy }); // AppInner에서 처리
                          closeMenu();
                        }}>
                        <span style={{ fontSize:15 }}>📋</span>
                        <div>
                          <div>복사</div>
                          <div style={{ fontSize:11, color:"#94a3b8", fontWeight:400 }}>이 폴더에도 남아있습니다</div>
                        </div>
                      </div>
                    </div>
                  </>
                )}

              </div>,
              document.body
            )}
          </div>
        )}
        <span style={{ color:"#94a3b8", fontSize:19, cursor:"pointer", lineHeight:1, padding:"0 2px", userSelect:"none", flexShrink:0 }} onClick={onDelete}>×</span>
      </div>
      {/* 마감기한 표시 */}
      {item.dueDate && (
        <div style={{ display:"flex", alignItems:"center", gap:4, padding:"0 14px 8px", paddingLeft: isMobile?"38px":"40px" }}
          onClick={e => e.stopPropagation()}>
          <span style={{ fontSize:11, color:"#ef4444", fontWeight:600 }}>📅 {item.dueDate}</span>
          <span style={{ fontSize:13, color:"#fca5a5", cursor:"pointer", lineHeight:1, padding:"0 2px" }}
            title="마감기한 삭제"
            onClick={() => onUpdate({ dueDate: undefined })}>×</span>
        </div>
      )}
    </div>
  );

  if (item.type === T.TEXT) return (
    <TextBlock item={item} isMobile={isMobile} drag={drag} bp={bp} fs={fs} onUpdate={onUpdate} onDelete={onDelete} onFocus={onFocus} />
  );

  return null;
}

function NoticeView({ items, folders, isMobile, onUpdate, onDelete }) {
  const grouped = folders.map(f => ({ folder:f, items:items.filter(i => i.folder===f.id) })).filter(g => g.items.length > 0);
  return (
    <>
      {grouped.map(g => (
        <div key={g.folder.id} style={{ marginBottom:28 }}>
          <div style={{ fontSize:10, fontWeight:700, color:"#2563eb", letterSpacing:"1.5px", textTransform:"uppercase", marginBottom:8, marginTop:4 }}>{g.folder.name}</div>
          {g.items.map(item => (
            <ItemBlock key={item.id} item={item} isMobile={isMobile}


              onUpdate={p => onUpdate(item.id, p)} onDelete={() => onDelete(item.id)} />
          ))}
        </div>
      ))}
    </>
  );
}

// ─── App ──────────────────────────────────────────────────
function AppInner() {
  const isMobile = useIsMobile();
  // Load from localStorage ONLY if logged in (token exists in localStorage)
  // If not logged in → show clean initData, not someone's private data
  const isLoggedInOnLoad = !!localStorage.getItem("gtoken");
  const [sidebarItems, setSidebarItems] = useState(() => {
    if (!isLoggedInOnLoad) return initSidebar;
    try {
      const c = localStorage.getItem("notes_sidebar");
      return c ? JSON.parse(c) : initSidebar;
    } catch { return initSidebar; }
  });
  const [items, setItems] = useState(() => {
    if (!isLoggedInOnLoad) return initItems;
    try {
      const c = localStorage.getItem("notes_items");
      return c ? JSON.parse(c) : initItems;
    } catch { return initItems; }
  });
  const [worklogs, setWorklogs] = useState(() => {
    if (!isLoggedInOnLoad) return initWorklogs;
    try {
      const c = localStorage.getItem("notes_worklogs");
      return c ? JSON.parse(c) : initWorklogs;
    } catch { return initWorklogs; }
  });
  const [activeFolder, setActiveFolder] = useState("f1");
  const activeFolderRef = useRef("f1"); // 항상 최신 activeFolder 참조 (stale closure 방지)
  const [editingFN,    setEditingFN]    = useState(false);
  const [fnDraft,      setFnDraft]      = useState("");
  const [showAddMenu,  setShowAddMenu]  = useState(false);
  const [lastFocusedId, setLastFocusedId] = useState(null); // 마지막 포커스된 아이템 ID
  const [showSidebar,   setShowSidebar]   = useState(false);
  const [showGlobalSearch, setShowGlobalSearch] = useState(false);
  const [globalQuery,      setGlobalQuery]      = useState("");
  const [selMode,      setSelMode]      = useState(false);
  const [selected,     setSelected]     = useState(new Set());
  const [selMoveMenu,  setSelMoveMenu]  = useState(null); // null | 'folder' | {folderId, folderName}
  const [selMovePosn,  setSelMovePosn]  = useState({ top:0, left:0 });
  const selMoveBtnRef = useRef(null);
  // selMoveMenu 외부 클릭 시 닫기
  useEffect(() => {
    if (!selMoveMenu) return;
    const close = e => {
      if (selMoveBtnRef.current?.contains(e.target)) return;
      setSelMoveMenu(null);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [selMoveMenu]);
  const [collapsedHdrs,setCollapsedHdrs] = useState(() => {
    try {
      const saved = localStorage.getItem("notes_collapsedHdrs");
      return saved ? new Set(JSON.parse(saved)) : new Set();
    } catch { return new Set(); }
  });
  const toggleHdr = id => setCollapsedHdrs(prev => {
    const n = new Set(prev);
    n.has(id) ? n.delete(id) : n.add(id);
    try { localStorage.setItem("notes_collapsedHdrs", JSON.stringify([...n])); } catch {}
    return n;
  });
  const [user,         setUser]         = useState(null);
  const [accessToken,  setAccessToken]  = useState(null);
  const [showLogin,    setShowLogin]    = useState(false);
  const [driveFileId,  setDriveFileId]  = useState(null);
  const [syncStatus,   setSyncStatus]   = useState("");
  const [dataLoaded,   setDataLoaded]   = useState(false);
  const isRestoring = useRef(false); // prevent auto-save during restore

  const folders     = sidebarItems.filter(i => i.type === "folder");
  const isNotice    = activeFolder === NOTICE_ID;
  const isCalendar  = activeFolder === CALENDAR_ID;
  const isTrash     = activeFolder === TRASH_ID;
  const isWorklog   = activeFolder === WORKLOG_ID;
  const isManual    = activeFolder === MANUAL_ID;
  const isUpcoming  = activeFolder === UPCOMING_ID;
  const isSpecial   = isNotice || isCalendar || isTrash || isWorklog || isManual || isUpcoming;
  const liveItems   = items.filter(i => !i.deletedAt);
  const trashItems  = items.filter(i => !!i.deletedAt);
  const visibleItems = isNotice ? liveItems.filter(i => i.starred)
    : isCalendar ? liveItems
    : isTrash    ? trashItems
    : isWorklog  ? []
    : isManual   ? []
    : isUpcoming ? []
    : liveItems.filter(i => i.folder === activeFolder);
  const activeF = isNotice?{name:"Notice"}:isCalendar?{name:"Calendar"}:isTrash?{name:"Trash"}:isWorklog?{name:"Worklog"}:isManual?{name:"Manual"}:isUpcoming?{name:"Upcoming"}:folders.find(f => f.id===activeFolder);

  useEffect(() => { setItems(prev => prev.filter(i => !i.deletedAt || daysAgo(i.deletedAt) < TRASH_DAYS)); }, [activeFolder]);

  const startFE   = () => { if (isSpecial) return; setFnDraft(activeF?.name||""); setEditingFN(true); };
  const commitFE  = () => { if (!isSpecial && fnDraft.trim()) setSidebarItems(prev => prev.map(f => f.id===activeFolder ? {...f,name:fnDraft.trim()} : f)); setEditingFN(false); };

  const addItem = type => {
    if (isSpecial) return;
    const id = `i${nextId++}`;
    const ni = { id, type, folder:activeFolder, starred:false, createdAt:mkDate(), title:"" };
    if (type===T.TODO) ni.done = false;
    if (type===T.TEXT) { ni.body=""; ni.hiddenSections=[]; ni.links=[]; }
    setItems(prev => {
      // lastFocusedId 가 현재 폴더의 아이템이면 그 바로 아래에 삽입
      const focusIdx = lastFocusedId ? prev.findIndex(i => i.id === lastFocusedId && !i.deletedAt && i.folder === activeFolder) : -1;
      if (focusIdx !== -1) {
        const arr = [...prev];
        arr.splice(focusIdx + 1, 0, ni);
        return arr;
      }
      return [...prev, ni];
    });
    setShowAddMenu(false);
    setFocusNewItem(id);
  };
  const [focusNewSBI,  setFocusNewSBI]  = useState(null);
  const [focusNewItem, setFocusNewItem] = useState(null);
  const addSBI = (type, afterId) => {
    const id = `si${nextId++}`;
    const newItem =
      type==="folder"  ? { id, type:"folder",  name:"New Folder" } :
      type==="sheader" ? { id, type:"sheader", label:"NEW SECTION" } :
                         { id, type:"divider" };
    setSidebarItems(prev => {
      if (!afterId) return [...prev, newItem];
      const idx = prev.findIndex(i => i.id === afterId);
      if (idx === -1) return [...prev, newItem];
      const arr = [...prev];
      arr.splice(idx + 1, 0, newItem);
      return arr;
    });
    if (type !== "divider") setFocusNewSBI(id);
  };
  const upd = (id, patch) => {
    // 복사 기능: _copy 키가 있으면 원본 유지 + 새 아이템 추가
    if (patch._copy) {
      const { _copy, ...rest } = patch;
      setItems(prev => {
        const updated = rest && Object.keys(rest).length > 0
          ? prev.map(i => i.id===id ? {...i,...rest} : i)
          : [...prev];
        // 현재 아이템 위치 다음에 삽입
        const pos = updated.findIndex(i => i.id===id);
        const copy = { ..._copy, id:`i${Date.now()}_copy` };
        const arr = [...updated];
        arr.splice(pos+1, 0, copy);
        return arr;
      });
    } else {
      setItems(prev => prev.map(i => i.id===id ? {...i,...patch} : i));
    }
  };
  const softDel  = useCallback(id => {
    const item = items.find(i => i.id===id);
    if (!item) return;
    const fn = folders.find(f => f.id===item.folder)?.name || "Unknown";
    setItems(prev => prev.map(i => i.id===id ? {...i, deletedAt:mkTs(), originalFolder:i.folder, originalFolderName:fn} : i));
  }, [items, folders]);
  const delSel   = () => { selected.forEach(id => softDel(id)); setSelected(new Set()); setSelMode(false); };
  const moveSel  = folderId => {
    setItems(prev => prev.map(i => selected.has(i.id) ? {...i, folder:folderId} : i));
    setSelected(new Set()); setSelMode(false);
  };
  const copySel  = folderId => {
    const ordered = visibleItems.filter(i => selected.has(i.id));
    const copies = ordered.map((i, idx) => ({
      ...i,
      id: `i${Date.now()}_${idx}_${i.id.slice(-4)}_copy`,
      folder: folderId,
      createdAt: mkDate(),
    }));
    setItems(prev => [...prev, ...copies]);
    setSelected(new Set()); setSelMode(false);
  };
  const shareSel = () => {
    // 화면 표시 순서대로 정렬 (visibleItems 순서 기준)
    const orderedIds = visibleItems.map(i => i.id).filter(id => selected.has(id));
    const selItems = orderedIds.map(id => items.find(i => i.id === id)).filter(Boolean);
    if (!selItems.length) return;

    const folderName = activeF?.name || "Notes";
    const today = mkDate();

    // HTML 생성
    const itemsHtml = selItems.map(item => {
      if (item.type === T.HEADER) {
        return `
          <div style="margin:18px 0 8px;padding:8px 14px;background:#eff6ff;border-left:4px solid #2563eb;border-radius:6px;">
            <span style="font-size:15px;font-weight:700;color:#1a3a78;">${item.title||""}</span>
          </div>`;
      }
      if (item.type === T.TODO) {
        const check = item.done
          ? `<span style="display:inline-block;width:16px;height:16px;border-radius:4px;background:#2563eb;text-align:center;line-height:16px;color:#fff;font-size:11px;font-weight:700;margin-right:8px;flex-shrink:0;">✓</span>`
          : `<span style="display:inline-block;width:16px;height:16px;border-radius:4px;border:1.5px solid #c2d0e8;margin-right:8px;flex-shrink:0;"></span>`;
        const star = item.starred ? `<span style="color:#f59e0b;margin-right:4px;">★</span>` : "";
        const due = item.dueDate ? `<span style="color:#ef4444;font-size:11px;margin-left:8px;">📅 ${item.dueDate}</span>` : "";
        return `
          <div style="display:flex;align-items:flex-start;padding:7px 0;border-bottom:1px solid #f0f4fa;">
            ${check}
            <span style="font-size:13.5px;color:${item.done?"#96acc8":"#1e3a6e"};${item.done?"text-decoration:line-through;":""}flex:1;">${star}${item.title||""}${due}</span>
            <span style="font-size:10px;color:#a8bcd8;margin-left:8px;white-space:nowrap;">${item.createdAt||""}</span>
          </div>`;
      }
      if (item.type === T.TEXT) {
        const body = item.body ? `<div style="font-size:12.5px;color:#374151;line-height:1.7;margin-top:4px;">${item.body}</div>` : "";
        const star = item.starred ? `<span style="color:#f59e0b;margin-right:4px;">★</span>` : "";
        return `
          <div style="margin-bottom:12px;padding:10px 14px;background:#fff;border-radius:8px;border-left:3px solid ${item.starred?"#f59e0b":"#2563eb"};">
            <div style="font-size:14px;font-weight:600;color:#0f2044;margin-bottom:4px;">${star}${item.title||""}</div>
            ${body}
          </div>`;
      }
      return "";
    }).join("");

    const w = window.open("", "_blank", "width=794,height=1000");
    w.document.write(`<!DOCTYPE html><html><head>
      <meta charset="UTF-8">
      <title>${folderName} — ${today}</title>
      <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: 'Helvetica Neue', 'Segoe UI', Arial, sans-serif; color: #1e3a6e; padding: 40px 48px; max-width: 700px; margin: 0 auto; }
        .header { display:flex; justify-content:space-between; align-items:flex-end; border-bottom: 2px solid #2563eb; padding-bottom: 12px; margin-bottom: 24px; }
        .folder { font-size: 20px; font-weight: 800; color: #2563eb; }
        .meta { font-size: 11px; color: #94a3b8; text-align: right; }
        .count { font-size: 11px; color: #6b8bb5; margin-top: 2px; }
        .footer { margin-top: 32px; padding-top: 10px; border-top: 1px solid #e0eaf8; font-size: 10px; color: #94a3b8; text-align: center; }
        @media print {
          body { padding: 20px 28px; }
          @page { margin: 16mm 14mm; size: A4; }
        }
      </style>
    </head><body>
      <div class="header">
        <div>
          <div class="folder">📁 ${folderName}</div>
          <div class="count">${selItems.length}개 항목</div>
        </div>
        <div class="meta">theNOTES<br>${today}</div>
      </div>
      ${itemsHtml}
      <div class="footer">theNOTES · BAUMAN · Generated ${today}</div>
      <script>window.onload = () => { setTimeout(() => window.print(), 300); }<\/script>
    </body></html>`);
    w.document.close();

    setSelected(new Set());
    setSelMode(false);
  };
  const togSel   = id => setSelected(prev => { const n=new Set(prev); n.has(id)?n.delete(id):n.add(id); return n; });
  const allSel   = visibleItems.length > 0 && selected.size === visibleItems.length;
  const togAll   = () => setSelected(allSel ? new Set() : new Set(visibleItems.map(i => i.id)));
  const selectFolder = id => { setActiveFolder(id); activeFolderRef.current = id; setShowSidebar(false); setEditingFN(false); setSelMode(false); setSelected(new Set()); };
  const restoreItem  = id => setItems(prev => prev.map(i => i.id===id ? {...i, deletedAt:undefined, originalFolder:undefined, originalFolderName:undefined} : i));
  const permDel      = id => setItems(prev => prev.filter(i => i.id!==id));
  const emptyTrash   = () => setItems(prev => prev.filter(i => !i.deletedAt));
  // ─── Firebase Google Login (Redirect 방식) ──────────────
  const handleLoginResult = async (result) => {
    if (!result) return false;
    const credential = GoogleAuthProvider.credentialFromResult(result);
    const token = credential?.accessToken;
    if (!token) return false;
    const fbUser = result.user;
    const userInfo = { name: fbUser.displayName, email: fbUser.email, picture: fbUser.photoURL };
    // Drive 로드 중 자동저장 방지
    isRestoring.current = true;
    setAccessToken(token);
    setUser(userInfo);
    localStorage.setItem("gtoken", token);
    localStorage.setItem("gtoken_expiry", String(Date.now() + 3500000)); // 58분 후 만료 기록
    localStorage.setItem("guser", JSON.stringify(userInfo));
    try {
      const fileId = await gdriveFind(token);
      if (fileId) {
        setDriveFileId(fileId);
        const data = await gdriveRead(token, fileId);
        if (data) {
          if (data.sidebarItems) { setSidebarItems(data.sidebarItems); localStorage.setItem("notes_sidebar", JSON.stringify(data.sidebarItems)); }
          if (data.items)        { setItems(data.items);                localStorage.setItem("notes_items",   JSON.stringify(data.items)); }
          if (data.worklogs)     { setWorklogs(data.worklogs);          localStorage.setItem("notes_worklogs",JSON.stringify(data.worklogs)); }
          setSyncStatus("saved");
        }
      }
    } catch (e) { console.error("Drive load error:", e); }
    setDataLoaded(true);
    setShowLogin(false);
    setTimeout(() => { isRestoring.current = false; }, 2500); // React 렌더링 완료 후 여유있게 해제
    return true;
  };

  const googleLogin = async () => {
    try {
      // 먼저 redirect 결과가 있는지 확인 (페이지 로드 직후)
      const redirectResult = await getRedirectResult(firebaseAuth);
      if (redirectResult) {
        await handleLoginResult(redirectResult);
        return;
      }
      // 없으면 popup 시도, 실패시 redirect
      try {
        const popupResult = await signInWithPopup(firebaseAuth, googleProvider);
        await handleLoginResult(popupResult);
      } catch (popupErr) {
        // popup 차단됐으면 redirect로 fallback
        if (popupErr.code === "auth/popup-blocked" || popupErr.code === "auth/popup-closed-by-user") {
          await signInWithRedirect(firebaseAuth, googleProvider);
          // redirect 후 페이지가 다시 로드됨 — 위의 getRedirectResult가 처리
        } else {
          throw popupErr;
        }
      }
    } catch (e) {
      console.error("Login error:", e.code, e.message);
      alert("Login failed: " + (e.code || e.message));
    }
  };

  // ─── Redirect 결과 처리 (페이지 로드 시) ────────────────
  useEffect(() => {
    getRedirectResult(firebaseAuth).then(async (result) => {
      if (result) await handleLoginResult(result);
    }).catch(e => console.warn("Redirect result error:", e));
  }, []);

  // ─── Firebase Auth state listener (ArchCalc 패턴 통합) ──
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(firebaseAuth, async (fbUser) => {
      if (!fbUser) {
        // Firebase가 세션 만료 또는 로그아웃을 감지 — 상태 동기화
        const hadUser = localStorage.getItem("guser");
        if (hadUser) {
          // 예상치 못한 Firebase 로그아웃 → Drive token도 클리어, 재로그인 안내
          localStorage.removeItem("gtoken");
          localStorage.removeItem("gtoken_expiry");
          localStorage.removeItem("guser");
          setUser(null);
          setAccessToken(null);
          setSyncStatus("error");
        }
        return;
      }
      // fbUser 있음 — Drive token 유효성 확인 후 user 정보 업데이트
      const storedToken = localStorage.getItem("gtoken");
      if (!storedToken) return; // Drive token 없으면 무시 (로그인 후 handleLoginResult가 처리)
      const expiry = Number(localStorage.getItem("gtoken_expiry") || "0");
      if (expiry && Date.now() > expiry - 300000) {
        // Drive token 만료 임박 — error 표시만 (강제 로그아웃 안 함)
        setSyncStatus("error");
        return;
      }
      try {
        await fbUser.getIdToken(true); // Firebase ID token refresh
        const userInfo = { name: fbUser.displayName, email: fbUser.email, picture: fbUser.photoURL };
        setUser(userInfo);
        localStorage.setItem("guser", JSON.stringify(userInfo));
      } catch (e) {
        console.warn("Auth state error:", e);
      }
    });
    return () => unsubscribe(); // ← cleanup 필수 (없으면 로그인 상태 불안정)
  }, []);

  const handleLogout = async () => {
    // ── 로그아웃 전 즉시 Drive 저장 ──
    if (accessToken && driveFileId) {
      try {
        if (saveTimer.current) clearTimeout(saveTimer.current);
        setSyncStatus("saving");
        await gdriveSave(accessToken, { sidebarItems, items, worklogs }, driveFileId);
        setSyncStatus("saved");
      } catch (e) { console.warn("Pre-logout save failed:", e); }
    }
    try { await signOut(firebaseAuth); } catch {}
    localStorage.removeItem("gtoken");
    localStorage.removeItem("gtoken_expiry");
    localStorage.removeItem("guser");
    localStorage.removeItem("notes_sidebar");
    localStorage.removeItem("notes_items");
    localStorage.removeItem("notes_worklogs");
    localStorage.removeItem("notes_collapsedHdrs");
    localStorage.removeItem("notes_collapsedSB");
    setSidebarItems(initSidebar);
    setItems(initItems);
    setWorklogs(initWorklogs);
    setUser(null); setAccessToken(null); setDriveFileId(null);
    setDataLoaded(false); setSyncStatus("");
  };

  // ─── Auto-save to Google Drive ───────────────────────────
  const saveTimer = useRef(null);

  // ── Save to localStorage on every change (instant local backup) ──
  useEffect(() => {
    try { localStorage.setItem("notes_sidebar", JSON.stringify(sidebarItems)); } catch {}
  }, [sidebarItems]);
  useEffect(() => {
    try { localStorage.setItem("notes_items", JSON.stringify(items)); } catch {}
  }, [items]);
  useEffect(() => {
    try { localStorage.setItem("notes_worklogs", JSON.stringify(worklogs)); } catch {}
  }, [worklogs]);

  // ── Session restore on page reload ───────────────────────
  // Firebase Auth 상태가 먼저 확인된 후 Drive token으로 데이터 복원
  useEffect(() => {
    const savedToken = localStorage.getItem("gtoken");
    const savedUser  = localStorage.getItem("guser");
    // 두 가지 모두 있어야 복원 시도
    if (!savedToken || !savedUser) {
      setDataLoaded(true); // 토큰 없으면 즉시 로드 완료로 처리
      return;
    }

    // 만료된 token이면 복원 시도 안 함
    const expiry = Number(localStorage.getItem("gtoken_expiry") || "0");
    if (expiry && Date.now() > expiry) {
      localStorage.removeItem("gtoken");
      localStorage.removeItem("gtoken_expiry");
      setSyncStatus("error");
      setDataLoaded(true); // 만료돼도 로드 완료 처리
      return;
    }

    isRestoring.current = true;
    setAccessToken(savedToken);
    setUser(JSON.parse(savedUser));
    (async () => {
      try {
        const fileId = await gdriveFind(savedToken);
        if (fileId) {
          setDriveFileId(fileId);
          const data = await gdriveRead(savedToken, fileId);
          if (data) {
            if (data.sidebarItems) { setSidebarItems(data.sidebarItems); localStorage.setItem("notes_sidebar", JSON.stringify(data.sidebarItems)); }
            if (data.items)        { setItems(data.items);                localStorage.setItem("notes_items",   JSON.stringify(data.items)); }
            if (data.worklogs)     { setWorklogs(data.worklogs);          localStorage.setItem("notes_worklogs",JSON.stringify(data.worklogs)); }
          }
          setSyncStatus("saved");
        }
      } catch(e) {
        if (e.message === "TOKEN_EXPIRED") {
          // Drive token 만료 — localStorage 정리 후 재로그인 안내
          localStorage.removeItem("gtoken");
          localStorage.removeItem("gtoken_expiry");
          setSyncStatus("error");
          console.warn("Token expired — please re-login to sync.");
        } else {
          console.error("Session restore error:", e);
          setSyncStatus("error");
        }
      } finally {
        setDataLoaded(true);
        setTimeout(() => { isRestoring.current = false; }, 2500);
      }
    })();
  }, []);

  useEffect(() => {
    if (!accessToken || !dataLoaded) return;
    if (isRestoring.current) return; // skip save during restore
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      if (isRestoring.current) return; // 타이머 대기 중 restore 시작된 경우 재확인
      setSyncStatus("saving");
      try {
        const savedId = await gdriveSave(accessToken, { sidebarItems, items, worklogs }, driveFileId);
        if (savedId && !driveFileId) setDriveFileId(savedId);
        setSyncStatus("saved");
      } catch (e) {
        if (e.message === "TOKEN_EXPIRED" || String(e).includes("401")) {
          setSyncStatus("error");
          console.warn("Token expired during save.");
        } else {
          console.error("Drive save error:", e);
          setSyncStatus("error");
        }
      }
    }, 2000);
    return () => clearTimeout(saveTimer.current);
  }, [sidebarItems, items, worklogs, accessToken, dataLoaded]);

  const SC = (
    <SidebarInner sidebarItems={sidebarItems} setSidebarItems={setSidebarItems}
      activeFolder={activeFolder} onSelect={selectFolder} onAddItem={addSBI}
      user={user} onLogin={() => setShowLogin(true)} onLogout={handleLogout}
      trashCount={trashItems.length} syncStatus={syncStatus}
      activeSidebarId={activeFolder}
      focusNewId={focusNewSBI} onFocusDone={() => setFocusNewSBI(null)}
      allItems={items} allWorklogs={worklogs} />
  );

  const titlePre = isCalendar?"◷ ":isNotice?"★ ":isTrash?"🗑 ":isWorklog?"📋 ":isManual?"📖 ":isUpcoming?"📅 ":"";

  return (
    <div style={{ display:"flex", height:"100vh", background:"#f0f4fa", fontFamily:"'SF Pro Display',-apple-system,'Helvetica Neue',sans-serif", overflow:"hidden", position:"relative" }}
      onClick={() => setShowAddMenu(false)}>

      {isMobile && (
        <div style={{ position:"fixed", inset:0, background:"rgba(10,24,50,.5)", zIndex:300, display:"flex",
          opacity: showSidebar ? 1 : 0,
          pointerEvents: showSidebar ? "auto" : "none",
          transition:"opacity 0.22s ease" }}
          onClick={() => setShowSidebar(false)}>
          <div style={{ width:244, background:"linear-gradient(180deg,#1c6ef3 0%,#1a5fd4 40%,#1650b8 100%)",
            display:"flex", flexDirection:"column", height:"100%",
            boxShadow:"4px 0 24px rgba(28,110,243,.3)",
            transform: showSidebar ? "translateX(0)" : "translateX(-100%)",
            transition:"transform 0.25s cubic-bezier(.4,0,.2,1)" }}
            onClick={e => e.stopPropagation()}>{SC}</div>
        </div>
      )}
      {!isMobile && (
        <aside style={{ width:224, background:"linear-gradient(180deg,#1c6ef3 0%,#1a5fd4 40%,#1650b8 100%)", display:"flex", flexDirection:"column", flexShrink:0, boxShadow:"2px 0 24px rgba(28,110,243,.25)" }}>{SC}</aside>
      )}

      <main style={{ flex:1, display:"flex", flexDirection:"column", overflow:"hidden", position:"relative" }}>
        {/* Top bar */}
        <div style={{ background:"#f0f4fa", padding:isMobile?"16px 14px 10px":"26px 36px 14px" }}>

          {/* Row 1: hamburger + folder title */}
          <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom: isMobile ? 10 : 0 }}>
            {isMobile && (
              <button style={{ width:36, height:36, borderRadius:10, background:"rgba(37,99,235,.08)", border:"none", cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0 }}
                onClick={e => { e.stopPropagation(); setShowSidebar(v => !v); }}>
                <span style={{ fontSize:18, color:"#2563eb" }}>☰</span>
              </button>
            )}
            <div style={{ flex:1, minWidth:0 }}>
              {editingFN
                ? <input autoFocus style={{ fontWeight:700, color:"#0f2044", letterSpacing:"-0.5px", border:"none", borderBottom:"2px solid #2563eb", background:"transparent", outline:"none", fontFamily:"inherit", fontSize:isMobile?20:27, width:"100%", boxSizing:"border-box" }}
                    value={fnDraft} onChange={e => setFnDraft(e.target.value)} onBlur={commitFE} onKeyDown={e => (e.key==="Enter"||e.key==="Escape") && commitFE()} />
                : <div style={{ fontWeight:700, color:"#0f2044", letterSpacing:"-0.5px", display:"flex", alignItems:"center", gap:6, fontSize:isMobile?20:27, cursor:isSpecial?"default":"text", overflow:"hidden" }}
                    onClick={!isSpecial ? startFE : undefined}>
                    <span style={{ overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{titlePre}{activeF?.name}</span>
                    {!isSpecial && <span style={{ fontSize:13, color:"#b0c8e8", fontWeight:400, flexShrink:0 }}>✎</span>}
                  </div>
              }
              <div style={{ fontSize:11, color:"#8aa0c0", marginTop:2 }}>
                {isCalendar ? `${liveItems.length} total` : isTrash ? `${trashItems.length} items` : isWorklog ? `${worklogs.length} entries` : `${visibleItems.length} items`}
              </div>
            </div>
            {/* Desktop only: inline buttons */}
            {!isMobile && (
              <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                {syncStatus && (
                  <div title={syncStatus==="saving"?"Saving...":syncStatus==="saved"?"Synced with Drive":"Sync error — tap to re-login"}
                    style={{ width:34, height:34, borderRadius:9, display:"flex", alignItems:"center", justifyContent:"center", background:syncStatus==="error"?"rgba(229,62,62,.08)":"rgba(37,99,235,.07)", cursor:syncStatus==="error"?"pointer":"default" }}
                    onClick={syncStatus==="error" ? () => setShowLogin(true) : undefined}>
                    <span style={{ fontSize:16 }}>{syncStatus==="saving"?"⏳":syncStatus==="saved"?"☁️":"❌"}</span>
                  </div>
                )}
                <button style={{ width:34, height:34, borderRadius:9, background:"rgba(37,99,235,.07)", border:"none", cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center" }}
                  title="Search all notes"
                  onClick={() => setShowGlobalSearch(v => !v)}>
                  <span style={{ fontSize:16 }}>🔍</span>
                </button>
                {showGlobalSearch && (
                  <div style={{ position:"fixed", inset:0, background:"rgba(15,32,68,.35)", zIndex:700, display:"flex", alignItems:"flex-start", justifyContent:"center", paddingTop:60 }}
                    onClick={() => { setShowGlobalSearch(false); setGlobalQuery(""); }}>
                    <div style={{ background:"#fff", borderRadius:16, padding:20, width:"min(560px,92vw)", boxShadow:"0 16px 48px rgba(15,32,68,.22)" }}
                      onClick={e => e.stopPropagation()}>
                      <input autoFocus
                        style={{ width:"100%", padding:"12px 16px", borderRadius:10, border:"1.5px solid #e0eaf8", fontSize:15, color:"#1e3a6e", outline:"none", fontFamily:"inherit", boxSizing:"border-box", marginBottom:12 }}
                        placeholder="노트, Worklog, 마감기한 전체 검색..."
                        value={globalQuery}
                        onChange={e => setGlobalQuery(e.target.value)} />
                      {globalQuery.trim() && (() => {
                        const q = globalQuery.trim().toLowerCase();
                        // ① 노트 검색: title + body + dueDate
                        const noteResults = liveItems.filter(i =>
                          (i.title||"").toLowerCase().includes(q) ||
                          (i.body||"").toLowerCase().includes(q) ||
                          (i.dueDate||"").toLowerCase().includes(q) ||
                          (i.tables||[]).some(t => t.rows?.some(r => r.some(c => (c.content||"").toLowerCase().includes(q))))
                        );
                        // ② Worklog 검색: keyPoint + details + notes + project
                        const wlogResults = worklogs.filter(w =>
                          (w.keyPoint||"").toLowerCase().includes(q) ||
                          (w.details||"").toLowerCase().includes(q) ||
                          (w.notes||"").toLowerCase().includes(q) ||
                          (w.project||"").toLowerCase().includes(q) ||
                          (w.date||"").toLowerCase().includes(q)
                        );

                        const hl = (text) => {
                          if (!text) return "";
                          const idx = text.toLowerCase().indexOf(q);
                          if (idx < 0) return text.slice(0, 60);
                          const start = Math.max(0, idx-15);
                          const end = Math.min(text.length, idx+q.length+30);
                          return (start>0?"…":"")+text.slice(start,end)+(end<text.length?"…":"");
                        };

                        const total = noteResults.length + wlogResults.length;
                        if (total === 0) return <div style={{ textAlign:"center", color:"#94a3b8", padding:"20px 0", fontSize:13 }}>검색 결과 없음</div>;

                        return (
                          <div style={{ maxHeight:400, overflowY:"auto" }}>
                            {/* 카운트 */}
                            <div style={{ fontSize:11, color:"#94a3b8", marginBottom:8 }}>
                              노트 {noteResults.length}개 · Worklog {wlogResults.length}개
                            </div>
                            {/* 노트 결과 */}
                            {noteResults.map(item => {
                              const folder = folders.find(f => f.id===item.folder);
                              const snippet = hl(item.body?.replace(/<[^>]*>/g,"") || "");
                              return (
                                <div key={item.id}
                                  style={{ display:"flex", alignItems:"flex-start", gap:10, padding:"9px 12px", borderRadius:9, cursor:"pointer", marginBottom:2 }}
                                  onMouseEnter={e => e.currentTarget.style.background="#f0f5ff"}
                                  onMouseLeave={e => e.currentTarget.style.background="transparent"}
                                  onClick={() => {
                                    selectFolder(item.folder);
                                    setShowGlobalSearch(false); setGlobalQuery("");
                                    // 해당 항목으로 스크롤
                                    setTimeout(() => {
                                      const el = document.querySelector(`[data-itemid="${item.id}"]`) || document.querySelector(`[data-todoitem="${item.id}"]`);
                                      if (el) el.scrollIntoView({ behavior:"smooth", block:"center" });
                                    }, 300);
                                  }}>
                                  <span style={{ fontSize:12, color:item.type==="header"?"#2563eb":item.type==="todo"?"#059669":"#8b5cf6", fontWeight:700, flexShrink:0, marginTop:2 }}>
                                    {item.type==="header"?"▬":item.type==="todo"?"☐":"T"}
                                  </span>
                                  <div style={{ flex:1, minWidth:0 }}>
                                    <div style={{ fontSize:13.5, color:"#1e3a6e", fontWeight:500, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{item.title||"(untitled)"}</div>
                                    {snippet && <div style={{ fontSize:11, color:"#6b8bb5", marginTop:1, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{snippet}</div>}
                                    <div style={{ fontSize:10, color:"#94a3b8", marginTop:1, display:"flex", gap:8 }}>
                                      {folder && <span>{folder.name}</span>}
                                      {item.dueDate && <span style={{ color:"#ef4444" }}>📅 {item.dueDate}</span>}
                                    </div>
                                  </div>
                                </div>
                              );
                            })}
                            {/* Worklog 결과 */}
                            {wlogResults.length > 0 && (
                              <div style={{ fontSize:10, fontWeight:700, color:"#94a3b8", textTransform:"uppercase", letterSpacing:"1px", margin:"8px 4px 4px" }}>Worklog</div>
                            )}
                            {wlogResults.map(w => (
                              <div key={w.id}
                                style={{ display:"flex", alignItems:"flex-start", gap:10, padding:"9px 12px", borderRadius:9, cursor:"pointer", marginBottom:2 }}
                                onMouseEnter={e => e.currentTarget.style.background="#f0f5ff"}
                                onMouseLeave={e => e.currentTarget.style.background="transparent"}
                                onClick={() => { selectFolder(WORKLOG_ID); setShowGlobalSearch(false); setGlobalQuery(""); }}>
                                <span style={{ fontSize:12, flexShrink:0, marginTop:2 }}>📋</span>
                                <div style={{ flex:1, minWidth:0 }}>
                                  <div style={{ fontSize:13, color:"#1e3a6e", fontWeight:500, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                                    {w.keyPoint||"(내용 없음)"}
                                  </div>
                                  <div style={{ fontSize:10, color:"#94a3b8", marginTop:1, display:"flex", gap:8 }}>
                                    <span>{w.date}</span>
                                    {w.project && <span>{w.project}</span>}
                                    {w.details && <span style={{ color:"#6b8bb5" }}>{hl(w.details)}</span>}
                                  </div>
                                </div>
                              </div>
                            ))}
                          </div>
                        );
                      })()}
                    </div>
                  </div>
                )}
                {!isSpecial && (
                  selMode ? (
                    <div style={{ display:"flex", alignItems:"center", gap:6 }}>
                      <div style={{ display:"flex", alignItems:"center", gap:6, cursor:"pointer" }} onClick={togAll}>
                        <div style={{ width:18, height:18, borderRadius:5, border:"1.5px solid #c2d0e8", display:"flex", alignItems:"center", justifyContent:"center", fontSize:11, color:"#fff", fontWeight:700, ...(allSel?{background:"#2563eb",borderColor:"#2563eb"}:{}) }}>
                          {allSel && "✓"}
                        </div>
                        <span style={{ fontSize:12, color:"#4b6fa8" }}>All</span>
                      </div>
                      {selected.size > 0 && (
                        <>
                          <button style={{ background:"#eff6ff", border:"1px solid #bfdbfe", borderRadius:8, padding:"7px 13px", fontSize:12.5, cursor:"pointer", fontFamily:"inherit", fontWeight:600, color:"#2563eb" }} onClick={shareSel}>↓ PDF</button>
                          <button
                            ref={selMoveBtnRef}
                            style={{ background:"#f0fdf4", border:"1px solid #bbf7d0", borderRadius:8, padding:"7px 13px", fontSize:12.5, cursor:"pointer", fontFamily:"inherit", fontWeight:600, color:"#166534" }}
                            onClick={e => {
                              const r = selMoveBtnRef.current?.getBoundingClientRect();
                              if (r) setSelMovePosn({ top: r.bottom + 4, left: r.left });
                              setSelMoveMenu(v => v ? null : 'folder');
                            }}>Move/Copy</button>
                          <button style={{ background:"#fff5f5", border:"1px solid #fecaca", borderRadius:8, padding:"7px 13px", fontSize:12.5, cursor:"pointer", fontFamily:"inherit", fontWeight:600, color:"#e53e3e" }} onClick={delSel}>Delete</button>
                        </>
                      )}
                      <button style={{ background:"none", border:"1px solid #e2e8f4", borderRadius:8, padding:"7px 13px", fontSize:12.5, cursor:"pointer", fontFamily:"inherit", fontWeight:600, color:"#6b7280" }}
                        onClick={() => { setSelMode(false); setSelected(new Set()); }}>Cancel</button>
                    </div>
                  ) : (
                    <button style={{ background:"none", border:"1px solid #e2e8f4", borderRadius:8, padding:"7px 13px", fontSize:12.5, cursor:"pointer", fontFamily:"inherit", fontWeight:600, color:"#4b6fa8" }}
                      onClick={() => setSelMode(true)}>Select</button>
                  )
                )}
                {/* 폴더 Excel Export / Import */}
                {!isSpecial && !selMode && (
                  <>
                    {/* Export */}
                    <button title="이 폴더를 Excel로 내보내기"
                      style={{ height:34, padding:"0 10px", borderRadius:8, border:"1px solid #bfdbfe", background:"#eff6ff", color:"#2563eb", fontSize:12, fontWeight:600, cursor:"pointer", fontFamily:"inherit", whiteSpace:"nowrap" }}
                      onClick={() => {
                        const folderName = activeF?.name || "folder";
                        const folderItems = visibleItems;
                        if (!folderItems.length) { alert("내보낼 항목이 없습니다."); return; }
                        const rows = folderItems.map(i => ({
                          Type: i.type==="header"?"Header":i.type==="todo"?"Todo":"Text",
                          Title: i.title||"",
                          Body: i.body||"",
                          Done: i.type==="todo"?(i.done?"Yes":"No"):"",
                          Starred: i.starred?"★":"",
                          Date: i.createdAt||"",
                        }));
                        const ws = XLSX.utils.json_to_sheet(rows);
                        ws["!cols"] = [{wch:8},{wch:35},{wch:50},{wch:6},{wch:6},{wch:12}];
                        const wb = XLSX.utils.book_new();
                        XLSX.utils.book_append_sheet(wb, ws, folderName.slice(0,31));
                        XLSX.writeFile(wb, `${folderName}_notes.xlsx`);
                      }}>↓ Excel</button>
                    {/* Import */}
                    <label title="Excel에서 이 폴더로 불러오기"
                      style={{ height:34, padding:"0 10px", borderRadius:8, border:"1px solid #6ee7b7", background:"#f0fdf4", color:"#059669", fontSize:12, fontWeight:600, cursor:"pointer", fontFamily:"inherit", whiteSpace:"nowrap", display:"flex", alignItems:"center" }}>
                      ↑ Import
                      <input type="file" accept=".xlsx,.xls" style={{ display:"none" }}
                        onChange={e => {
                          const file = e.target.files?.[0];
                          if (!file) return;
                          e.target.value = "";
                          const reader = new FileReader();
                          reader.onload = ev => {
                            try {
                              const wb = XLSX.read(ev.target.result, { type:"array" });
                              const ws = wb.Sheets[wb.SheetNames[0]];
                              const rows = XLSX.utils.sheet_to_json(ws, { defval:"" });
                              const typeMap = { "header":T.HEADER, "todo":T.TODO, "text":T.TEXT };
                              const newItems = rows.map(r => {
                                const rawType = String(r["Type"]||r["type"]||"text").toLowerCase();
                                const type = typeMap[rawType] || T.TEXT;
                                const ni = {
                                  id: `i${Date.now()}_${Math.random().toString(36).slice(2,6)}`,
                                  type,
                                  folder: activeFolder,
                                  title: String(r["Title"]||r["title"]||"").trim(),
                                  starred: !!(r["Starred"]||r["starred"]),
                                  createdAt: String(r["Date"]||r["date"]||"") || mkDate(),
                                };
                                if (type===T.TODO) { ni.done = String(r["Done"]||"").toLowerCase()==="yes"; }
                                if (type===T.TEXT) { ni.body = String(r["Body"]||r["body"]||""); ni.hiddenSections=[]; ni.links=[]; }
                                return ni;
                              }).filter(i => i.title || i.body);
                              if (!newItems.length) { alert("불러올 항목이 없습니다.\n열 이름: Type, Title, Body, Done, Starred, Date"); return; }
                              setItems(prev => [...prev, ...newItems]);
                              alert(`${newItems.length}개 항목을 현재 폴더에 추가했습니다.`);
                            } catch(err) { alert("파일 읽기 실패: " + err.message); }
                          };
                          reader.readAsArrayBuffer(file);
                        }} />
                    </label>
                  </>
                )}
                {!isSpecial && !selMode && (
                  <div style={{ position:"relative" }}>
                    <button style={{ width:38, height:38, borderRadius:10, background:"#2563eb", color:"#fff", border:"none", fontSize:24, cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center", boxShadow:"0 4px 12px rgba(37,99,235,.35)", fontWeight:300, lineHeight:1 }}
                      onClick={e => { e.stopPropagation(); setShowAddMenu(v => !v); }}>+</button>
                    {showAddMenu && (
                      <div style={{ position:"absolute", background:"#fff", borderRadius:12, boxShadow:"0 8px 32px rgba(15,32,68,.18)", overflow:"hidden", zIndex:200, minWidth:145, border:"1px solid rgba(37,99,235,.08)", right:0, top:46 }}>
                        {[{type:T.HEADER,label:"Header",icon:"▬"},{type:T.TODO,label:"To-do",icon:"☐"},{type:T.TEXT,label:"Text",icon:"T"}].map(o => (
                          <div key={o.type} style={{ display:"flex", alignItems:"center", gap:10, padding:"13px 18px", fontSize:14, color:"#1e3a6e", cursor:"pointer", fontWeight:500 }}
                            onClick={() => addItem(o.type)}>
                            <span style={{ width:20, fontSize:13, color:"#2563eb", textAlign:"center" }}>{o.icon}</span>{o.label}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Row 2 (mobile only): sync + search + select + add */}
          {isMobile && (
            <div style={{ display:"flex", alignItems:"center", gap:8, flexWrap:"wrap" }}>
              {syncStatus && (
                <div title={syncStatus==="saving"?"Saving...":syncStatus==="saved"?"Synced with Drive":"Sync error"}
                  style={{ width:32, height:32, borderRadius:8, display:"flex", alignItems:"center", justifyContent:"center", background:syncStatus==="error"?"rgba(229,62,62,.08)":"rgba(37,99,235,.07)", cursor:syncStatus==="error"?"pointer":"default" }}
                  onClick={syncStatus==="error"?()=>setShowLogin(true):undefined}>
                  <span style={{ fontSize:15 }}>{syncStatus==="saving"?"⏳":syncStatus==="saved"?"☁️":"❌"}</span>
                </div>
              )}
              <button style={{ width:32, height:32, borderRadius:8, background:"rgba(37,99,235,.07)", border:"none", cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center" }}
                onClick={() => setShowGlobalSearch(v => !v)}>
                <span style={{ fontSize:15 }}>🔍</span>
              </button>
              <div style={{ flex:1 }} />
              {!isSpecial && (
                selMode ? (
                  <div style={{ display:"flex", alignItems:"center", gap:6 }}>
                    {selected.size > 0 && (
                      <>
                        <button style={{ background:"#eff6ff", border:"1px solid #bfdbfe", borderRadius:8, padding:"6px 10px", fontSize:12, cursor:"pointer", fontFamily:"inherit", fontWeight:600, color:"#2563eb" }} onClick={shareSel}>↓ PDF</button>
                        <button
                          style={{ background:"#f0fdf4", border:"1px solid #bbf7d0", borderRadius:8, padding:"6px 10px", fontSize:12, cursor:"pointer", fontFamily:"inherit", fontWeight:600, color:"#166534" }}
                          onClick={e => {
                            const r = e.currentTarget.getBoundingClientRect();
                            setSelMovePosn({ top: r.bottom + 4, left: Math.max(4, r.left) });
                            setSelMoveMenu(v => v ? null : 'folder');
                          }}>Move/Copy</button>
                        <button style={{ background:"#fff5f5", border:"1px solid #fecaca", borderRadius:8, padding:"6px 10px", fontSize:12, cursor:"pointer", fontFamily:"inherit", fontWeight:600, color:"#e53e3e" }} onClick={delSel}>Delete</button>
                      </>
                    )}
                    <button style={{ background:"none", border:"1px solid #e2e8f4", borderRadius:8, padding:"6px 10px", fontSize:12, cursor:"pointer", fontFamily:"inherit", fontWeight:600, color:"#6b7280" }}
                      onClick={() => { setSelMode(false); setSelected(new Set()); }}>Cancel</button>
                  </div>
                ) : (
                  <button style={{ background:"none", border:"1px solid #e2e8f4", borderRadius:8, padding:"6px 10px", fontSize:12, cursor:"pointer", fontFamily:"inherit", fontWeight:600, color:"#4b6fa8" }}
                    onClick={() => setSelMode(true)}>Select</button>
                )
              )}
              {!isSpecial && (
                <div style={{ position:"relative" }}>
                  <button style={{ width:36, height:36, borderRadius:10, background:"#2563eb", color:"#fff", border:"none", fontSize:22, cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center", boxShadow:"0 4px 12px rgba(37,99,235,.35)", fontWeight:300, lineHeight:1 }}
                    onClick={e => { e.stopPropagation(); setShowAddMenu(v => !v); }}>+</button>
                  {showAddMenu && (
                    <div style={{ position:"absolute", background:"#fff", borderRadius:12, boxShadow:"0 8px 32px rgba(15,32,68,.18)", overflow:"hidden", zIndex:200, minWidth:145, border:"1px solid rgba(37,99,235,.08)", right:0, top:44 }}>
                      {[{type:T.HEADER,label:"Header",icon:"▬"},{type:T.TODO,label:"To-do",icon:"☐"},{type:T.TEXT,label:"Text",icon:"T"}].map(o => (
                        <div key={o.type} style={{ display:"flex", alignItems:"center", gap:10, padding:"13px 18px", fontSize:14, color:"#1e3a6e", cursor:"pointer", fontWeight:500 }}
                          onClick={() => addItem(o.type)}>
                          <span style={{ width:20, fontSize:13, color:"#2563eb", textAlign:"center" }}>{o.icon}</span>{o.label}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

        </div>

        {/* Content area */}
        <div style={{ flex:1, overflowY:"auto", WebkitOverflowScrolling:"touch", padding: isWorklog ? (isMobile?"12px 16px 40px":"8px 36px 40px") : isManual ? "0" : (isMobile?"4px 16px 40px":"4px 36px 40px") }}>
          {isWorklog && <WorklogView worklogs={worklogs} setWorklogs={setWorklogs} folders={folders} isMobile={isMobile} />}
          {isCalendar && <CalendarView items={liveItems} folders={folders} accessToken={accessToken} onUpdate={upd} />}
          {isTrash && <TrashView items={items} onRestore={restoreItem} onPermDel={permDel} onEmpty={emptyTrash} />}
          {isManual && <ManualView isMobile={isMobile} />}
          {isUpcoming && <UpcomingView items={liveItems} folders={folders} onSelectFolder={selectFolder} />}
          {isNotice && (
            <>
              <NoticeView items={visibleItems} folders={folders} isMobile={isMobile} onUpdate={upd} onDelete={softDel} />
              {visibleItems.length === 0 && (
                <div style={{ display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", padding:"80px 0", color:"#b0c4de" }}>
                  <div style={{ fontSize:36, marginBottom:10 }}>★</div>
                  <div style={{ fontSize:13 }}>No starred items.</div>
                </div>
              )}
            </>
          )}
          {!isSpecial && (() => {
            // Build flat sortable list preserving order
            const flatItems = visibleItems; // already in order from state
            // Group into header sections for collapse display
            const sections = [];
            let cur = null;
            for (const item of flatItems) {
              if (item.type === T.HEADER) {
                cur = { header: item, children: [] };
                sections.push(cur);
              } else {
                if (!cur) { cur = { header: null, children: [] }; sections.push(cur); }
                cur.children.push(item);
              }
            }
            // Flat array for sortable
            const sortableFlat = flatItems;

            return (
              <SortableList
                items={sortableFlat}
                setItems={newArr => setItems(prev => {
                  // activeFolderRef.current 사용 → 빠른 폴더 전환 시 stale closure 방지
                  const folder = activeFolderRef.current;
                  const visibleNow = prev.filter(i => !i.deletedAt && i.folder === folder);
                  const resolved = typeof newArr === 'function' ? newArr(visibleNow) : newArr;
                  const others = prev.filter(i => i.deletedAt || i.folder !== folder);
                  return [...others, ...resolved];
                })}
                getKey={i => i.id}
                collapsedHdrs={collapsedHdrs}
                toggleHdr={toggleHdr}
                selMode={selMode}
                selected={selected}
                togSel={togSel}
                isMobile={isMobile}
                upd={upd}
                softDel={softDel}
                folders={folders}
                focusNewItem={focusNewItem}
                onFocusItemDone={() => setFocusNewItem(null)}
                onFocusId={setLastFocusedId}
              />
            );
          })()}
          {!isSpecial && visibleItems.length === 0 && (
            <div style={{ display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", padding:"60px 0 80px", color:"#b0c4de", textAlign:"center" }}>
              <div style={{ fontSize:40, marginBottom:12, opacity:.5 }}>◌</div>
              <div style={{ fontSize:14, color:"#94a3b8", fontWeight:600, marginBottom:8 }}>This folder is empty</div>
              <div style={{ fontSize:12.5, color:"#b0c4de", lineHeight:1.8, maxWidth:220 }}>
                Tap the <span style={{ background:"#2563eb", color:"#fff", borderRadius:6, padding:"1px 7px", fontSize:12, fontWeight:700 }}>+</span> button to add<br/>
                a Header, To-do, or Text note
              </div>
              <div style={{ marginTop:20, fontSize:11, color:"#c8d8ee" }}>
                ↗ top right corner
              </div>
            </div>
          )}
        </div>

        <div style={{ position:"absolute", bottom:0, left:0, right:0, padding:"10px 0 14px", display:"flex", justifyContent:"center", alignItems:"center", pointerEvents:"none" }}>
          <span style={{ fontSize:11, fontWeight:800, letterSpacing:"4px", color:"rgba(15,32,68,.12)", textTransform:"uppercase", fontFamily:"'Arial Black','Helvetica Neue',sans-serif" }}>BAUMAN</span>
        </div>
      </main>

      {showLogin && (
        <div style={{ position:"fixed", inset:0, background:"rgba(15,32,68,.4)", display:"flex", alignItems:"center", justifyContent:"center", zIndex:800 }}
          onClick={() => setShowLogin(false)}>
          <div style={{ background:"#fff", borderRadius:18, padding:"28px 24px 22px", width:320, boxShadow:"0 16px 48px rgba(15,32,68,.22)", textAlign:"center" }}
            onClick={e => e.stopPropagation()}>
            <svg width="40" height="40" viewBox="0 0 24 24" style={{ marginBottom:8 }}>
              <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
              <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
              <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
              <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
            </svg>
            <div style={{ fontSize:16, fontWeight:700, color:"#0f2044", marginBottom:6 }}>Sign in with Google</div>
            <p style={{ fontSize:13, color:"#6b8bb5", marginBottom:20, lineHeight:1.6 }}>Sign in to sync your notes with Google Drive automatically.</p>
            <button style={{ width:"100%", display:"flex", alignItems:"center", justifyContent:"center", gap:10, padding:"13px", borderRadius:10, border:"none", background:"#2563eb", color:"#fff", fontSize:14, fontWeight:600, cursor:"pointer", fontFamily:"inherit", boxShadow:"0 4px 10px rgba(37,99,235,.3)" }}
              onClick={() => { setShowLogin(false); googleLogin(); }}>Continue with Google</button>
            <button style={{ width:"100%", padding:"9px", borderRadius:10, border:"none", background:"transparent", color:"#9ca3af", fontSize:13, cursor:"pointer", fontFamily:"inherit", marginTop:8 }}
              onClick={() => setShowLogin(false)}>Cancel</button>
          </div>
        </div>
      )}

      {/* ── Select Move/Copy portal dropdown ── */}
      {selMoveMenu && createPortal(
        <div
          style={{ position:"fixed", top:selMovePosn.top, left:selMovePosn.left,
            background:"#fff", borderRadius:12, boxShadow:"0 8px 32px rgba(15,32,68,.2)",
            border:"1px solid #e0eaf8", zIndex:9999, minWidth:190, overflow:"hidden",
            fontFamily:"'SF Pro Display',-apple-system,'Helvetica Neue',sans-serif" }}
          onMouseDown={e => e.stopPropagation()}>
          {selMoveMenu === 'folder' ? (
            <>
              <div style={{ padding:"10px 14px 6px", fontSize:10, fontWeight:700, color:"#94a3b8", letterSpacing:"1px", textTransform:"uppercase", borderBottom:"1px solid #f0f4fa" }}>
                폴더 선택 ({selected.size}개 항목)
              </div>
              <div style={{ maxHeight:220, overflowY:"auto" }}>
                {folders.filter(f => f.id !== activeFolder).map(f => (
                  <div key={f.id}
                    style={{ display:"flex", alignItems:"center", padding:"9px 14px", fontSize:13, cursor:"pointer", color:"#1e3a6e", fontWeight:500 }}
                    onMouseEnter={e => e.currentTarget.style.background="#f5f8ff"}
                    onMouseLeave={e => e.currentTarget.style.background="transparent"}
                    onMouseDown={() => setSelMoveMenu({ folderId:f.id, folderName:f.name })}>
                    <span style={{ flex:1 }}>{f.name}</span>
                    <span style={{ color:"#c2d0e8", fontSize:12 }}>›</span>
                  </div>
                ))}
              </div>
            </>
          ) : selMoveMenu?.folderId ? (
            <>
              <div style={{ display:"flex", alignItems:"center", padding:"10px 14px 6px", borderBottom:"1px solid #f0f4fa" }}>
                <span style={{ color:"#94a3b8", fontSize:16, cursor:"pointer", marginRight:8 }}
                  onMouseDown={() => setSelMoveMenu('folder')}>‹</span>
                <span style={{ fontSize:12, fontWeight:700, color:"#1e3a6e", flex:1 }}>{selMoveMenu.folderName}</span>
              </div>
              <div style={{ padding:"8px 0 6px" }}>
                <div
                  style={{ display:"flex", alignItems:"center", gap:10, padding:"10px 16px", cursor:"pointer", fontSize:13, fontWeight:600, color:"#1e3a6e" }}
                  onMouseEnter={e => e.currentTarget.style.background="#f5f8ff"}
                  onMouseLeave={e => e.currentTarget.style.background="transparent"}
                  onMouseDown={() => { moveSel(selMoveMenu.folderId); setSelMoveMenu(null); }}>
                  <span style={{ fontSize:15 }}>✂️</span>
                  <div>
                    <div>이동</div>
                    <div style={{ fontSize:11, color:"#94a3b8", fontWeight:400 }}>이 폴더에서 제거됩니다</div>
                  </div>
                </div>
                <div
                  style={{ display:"flex", alignItems:"center", gap:10, padding:"10px 16px", cursor:"pointer", fontSize:13, fontWeight:600, color:"#1e3a6e" }}
                  onMouseEnter={e => e.currentTarget.style.background="#f5f8ff"}
                  onMouseLeave={e => e.currentTarget.style.background="transparent"}
                  onMouseDown={() => { copySel(selMoveMenu.folderId); setSelMoveMenu(null); }}>
                  <span style={{ fontSize:15 }}>📋</span>
                  <div>
                    <div>복사</div>
                    <div style={{ fontSize:11, color:"#94a3b8", fontWeight:400 }}>이 폴더에도 남아있습니다</div>
                  </div>
                </div>
              </div>
            </>
          ) : null}
        </div>,
        document.body
      )}
    </div>
  );
}

export default function App() {
  return (
    <>
      <AppInner />
    </>
  );
}

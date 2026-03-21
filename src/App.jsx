import { useState, useRef, useCallback, useEffect } from "react";
import * as XLSX from "xlsx";
import { GoogleOAuthProvider, useGoogleLogin } from "@react-oauth/google";

const GOOGLE_CLIENT_ID = "167666540402-ug48sj0qfst2g08lhcckkf69jvjhel21.apps.googleusercontent.com";
const DRIVE_FILE_NAME  = "notes-app-data.json";

// ─── Google Drive helpers ─────────────────────────────────
async function gdriveFind(token) {
  const q = encodeURIComponent(`name='${DRIVE_FILE_NAME}' and trashed=false`);
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${q}&spaces=drive&fields=files(id,name)`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const data = await res.json();
  return data.files?.[0]?.id || null;
}

async function gdriveRead(token, fileId) {
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) return null;
  return res.json();
}

async function gdriveSave(token, data, existingFileId) {
  const body = JSON.stringify(data);
  if (existingFileId) {
    await fetch(
      `https://www.googleapis.com/upload/drive/v3/files/${existingFileId}?uploadType=media`,
      {
        method: "PATCH",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body,
      }
    );
  } else {
    const form = new FormData();
    form.append("metadata", new Blob([JSON.stringify({ name: DRIVE_FILE_NAME, mimeType: "application/json" })], { type: "application/json" }));
    form.append("file", new Blob([body], { type: "application/json" }));
    await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });
  }
}

// ─── Constants ────────────────────────────────────────────
const T = { HEADER: "header", TODO: "todo", TEXT: "text" };
const NOTICE_ID = "__notice__";
const CALENDAR_ID = "__calendar__";
const TRASH_ID = "__trash__";
const WORKLOG_ID = "__worklog__";
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

    // Snapshot DOM positions of all sortable rows
    const rows = Array.from(container.querySelectorAll('[data-sortidx]'));
    if (!rows[index]) return;
    const rect = rows[index].getBoundingClientRect();

    // Ghost
    const ghost = rows[index].cloneNode(true);
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
    rows[index].style.opacity = '0.25';

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
      if (rs[D.current.active]) rs[D.current.active].style.opacity = '';

      const from = D.current.active;
      let to = D.current.insert;
      // Adjust: after removal, indices shift
      if (to > from) to = to - 1;

      if (from !== to && to >= 0) {
        const arr = [...itemsRef.current];
        const [moved] = arr.splice(from, 1);
        arr.splice(to, 0, moved);
        setItems(arr);
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

let nextId = 400;

const initSidebar = [
  { id:"f1", type:"folder", name:"PROJECT" },
  { id:"f2", type:"folder", name:"AREA" },
  { id:"div1", type:"divider" },
  { id:"f3", type:"folder", name:"RESOURCE" },
  { id:"f4", type:"folder", name:"ARCHIVE" },
];

const initItems = [
  { id:"i1", type:T.HEADER, title:"Q2 Product Launch", folder:"f1", starred:false, createdAt:"2026.03.19" },
  { id:"i2", type:T.TODO, title:"Landing page copy finalized", folder:"f1", done:false, starred:false, createdAt:"2026.03.19" },
  { id:"i3", type:T.TODO, title:"Stakeholder deck reviewed", folder:"f1", done:true, starred:true, createdAt:"2026.03.18" },
  { id:"i4", type:T.TEXT, title:"Launch strategy overview", folder:"f1", starred:true, createdAt:"2026.03.17",
    body:"Core objective: drive 20% adoption in the first 60 days. Focus channels are email, in-app messaging, and partner co-marketing.",
    hiddenSections:[{id:"h1",label:"Risk factors",content:"Delayed QA sign-off may push launch by one week. Contingency: soft launch to beta users first.",open:false}],
    links:[] },
  { id:"i5", type:T.TEXT, title:"Competitor pricing notes", folder:"f1", starred:false, createdAt:"2026.03.19", body:"Three main competitors revised pricing in Q1. Our mid-tier plan is currently 12% above market average.", hiddenSections:[], links:[] },
  { id:"i6", type:T.HEADER, title:"Team Operations", folder:"f2", starred:false, createdAt:"2026.03.15" },
  { id:"i7", type:T.TODO, title:"Weekly sync agenda prepared", folder:"f2", done:false, starred:true, createdAt:"2026.03.16" },
  { id:"i8", type:T.TEXT, title:"Onboarding checklist", folder:"f2", starred:false, createdAt:"2026.03.14", body:"New member onboarding: tool access, intro meetings with each team lead, 30-day check-in scheduled.", hiddenSections:[], links:[] },
  { id:"i9", type:T.HEADER, title:"Learning & Development", folder:"f3", starred:false, createdAt:"2026.03.10" },
  { id:"i10", type:T.TODO, title:"Book summary: Thinking Fast and Slow", folder:"f3", done:false, starred:false, createdAt:"2026.03.12" },
  { id:"i11", type:T.TEXT, title:"Useful frameworks", folder:"f3", starred:true, createdAt:"2026.03.08",
    body:"MECE, First Principles, Jobs-to-be-Done, and the Eisenhower Matrix are the four I keep coming back to.",
    hiddenSections:[], links:[] },
  { id:"i12", type:T.TODO, title:"Archive 2025 project files", folder:"f4", done:false, starred:false, createdAt:"2026.03.01" },
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
  const { tb, checkSel, exec: execBase, tbRef, hide } = useFloatingToolbar(containerRef);

  useEffect(() => {
    if (ref.current && ref.current.innerHTML !== (html || "")) {
      ref.current.innerHTML = html || "";
    }
  }, []); // eslint-disable-line

  const exec = (cmd, val) => {
    // Do NOT call focus() here — e.preventDefault() on toolbar mousedown keeps selection alive
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
        onInput={() => onChange?.(ref.current.innerHTML)}
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
        {[["#fef08a","노랑"],["#bbf7d0","초록"],["#bfdbfe","파랑"],["transparent","제거"]].map(([c,t])=>(
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
        <span style={{ fontSize:13.5, fontWeight:700, color:"#1e3a6e" }}>{cur.y}년 {cur.m+1}월</span>
        <button onClick={() => setCur(p => p.m===11 ? {y:p.y+1,m:0} : {...p,m:p.m+1})} style={PB}>›</button>
      </div>
      <div style={{ display:"grid", gridTemplateColumns:"repeat(7,1fr)", gap:2 }}>
        {["일","월","화","수","목","금","토"].map(d => (
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
  const MN = ["1월","2월","3월","4월","5월","6월","7월","8월","9월","10월","11월","12월"];
  const PB = { background:"none", border:"none", fontSize:18, cursor:"pointer", color:"#6b8bb5", padding:"2px 8px", borderRadius:6, fontFamily:"inherit" };
  return (
    <div style={{ position:"absolute", zIndex:700, background:"#fff", borderRadius:14, boxShadow:"0 8px 32px rgba(15,32,68,.2)", padding:16, width:210, top:"100%", right:0, marginTop:4, border:"1px solid #e0eaf8" }}>
      {label && <div style={{ fontSize:11, fontWeight:700, color:"#2563eb", letterSpacing:"1px", marginBottom:10 }}>{label}</div>}
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:10 }}>
        <button onClick={() => setY(y-1)} style={PB}>‹</button>
        <span style={{ fontSize:13.5, fontWeight:700, color:"#1e3a6e" }}>{y}년</span>
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
function WorklogView({ worklogs, setWorklogs, folders, isMobile }) {
  const now = new Date();
  const todayYM = `${now.getFullYear()}.${String(now.getMonth()+1).padStart(2,"0")}`;
  const [search,        setSearch]        = useState("");
  const [navYM,         setNavYM]         = useState(null);
  const [showNav,       setShowNav]       = useState(false);
  const [showDl,        setShowDl]        = useState(false);
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
    ? "전체"
    : filterFolders.size === 1
      ? [...filterFolders][0]
      : `${filterFolders.size}개 선택`;

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

  // colGrid: cb | date | keyPoint | project | details | notes | actions
  const colGrid = isMobile
    ? "20px 80px 1fr 100px 28px"
    : "20px 90px 1fr 120px 1fr 80px 28px";

  return (
    <div style={{display:"flex",flexDirection:"column",height:"100%"}} onClick={()=>setShowFilter(false)}>

      {/* ── Top controls ── */}
      <div style={{display:"flex",alignItems:"center",gap:6,flexWrap:"wrap",paddingBottom:10,borderBottom:"1px solid #eef3ff",marginBottom:8}}>
        <div style={{flex:1,minWidth:120,position:"relative"}}>
          <span style={{position:"absolute",left:9,top:"50%",transform:"translateY(-50%)",color:"#a0b4cc",fontSize:13}}>🔍</span>
          <input style={{width:"100%",padding:"7px 10px 7px 28px",borderRadius:9,border:"1.5px solid #e0eaf8",fontSize:12.5,color:"#1e3a6e",outline:"none",fontFamily:"inherit",background:"#fff",boxSizing:"border-box"}}
            placeholder="검색..." value={search} onChange={e=>setSearch(e.target.value)} />
        </div>

        {/* Folder filter button */}
        <div style={{position:"relative"}} onClick={e=>e.stopPropagation()}>
          <button style={{...wBtn, ...(allSelected?{}:{background:"#eef3ff",color:"#2563eb",borderColor:"#bfdbfe"})}}
            onClick={()=>setShowFilter(v=>!v)}>
            ⊞ {filterLabel}
          </button>
          {showFilter && (
            <div style={{position:"absolute",top:"100%",left:0,marginTop:4,background:"#fff",borderRadius:12,boxShadow:"0 6px 24px rgba(15,32,68,.16)",border:"1px solid #e0eaf8",zIndex:400,minWidth:170,overflow:"hidden"}}>
              <div style={{padding:"6px 12px 4px",fontSize:10,fontWeight:700,color:"#94a3b8",letterSpacing:"1px",textTransform:"uppercase"}}>폴더 필터</div>
              {/* 전체 */}
              <div style={{display:"flex",alignItems:"center",gap:8,padding:"9px 14px",cursor:"pointer",borderBottom:"1px solid #f0f4fa",background:allSelected?"#eff6ff":"transparent"}}
                onClick={()=>setFilterFolders(new Set())}>
                <div style={{width:15,height:15,borderRadius:4,border:"1.5px solid",borderColor:allSelected?"#2563eb":"#c2d0e8",background:allSelected?"#2563eb":"transparent",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
                  {allSelected && <span style={{color:"#fff",fontSize:10,fontWeight:700}}>✓</span>}
                </div>
                <span style={{fontSize:13,fontWeight:600,color:allSelected?"#2563eb":"#1e3a6e"}}>전체</span>
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

        <div style={{position:"relative"}}>
          <button style={wBtn} onClick={()=>setShowNav(v=>!v)}>📅 {navYM||todayYM}</button>
          {showNav && <MonthPicker value={navYM||todayYM} onChange={navigateTo} onClose={()=>setShowNav(false)} label="년월로 이동"/>}
        </div>
        <button style={{...wBtn,background:"#2563eb",color:"#fff",border:"none",boxShadow:"0 2px 8px rgba(37,99,235,.3)"}} onClick={()=>setShowDl(true)}>↓ 엑셀</button>
        {selected.size>0 && <button style={{...wBtn,color:"#e53e3e",borderColor:"#fecaca"}} onClick={delSel}>삭제({selected.size})</button>}
        <button style={{...wBtn,color:"#2563eb",borderColor:"#bfdbfe",fontWeight:700}} onClick={()=>addEntry(mkDate())}>＋ 추가</button>
      </div>

      {/* ── List ── */}
      <div ref={listRef} style={{flex:1,overflowY:"auto",paddingBottom:40}}>
        {sortedYMs.length===0 && (
          <div style={{display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:"60px 0",color:"#b0c4de"}}>
            <div style={{fontSize:32,marginBottom:10}}>📋</div>
            <div style={{fontSize:13}}>{search||!allSelected?"결과 없음":"업무일지를 작성해보세요."}</div>
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
                <div style={{fontSize:13,fontWeight:700,color:"#1e3a6e",background:"#eef3ff",borderRadius:20,padding:"4px 14px",flexShrink:0}}>{yy}년 {parseInt(mm)}월</div>
                <div style={{flex:1,height:1,background:"rgba(37,99,235,.1)"}}/>
                <span style={{fontSize:11,color:"#94a3b8",flexShrink:0}}>{grouped[ym].length}건</span>
              </div>
              {/* Column headers */}
              <div style={{display:"grid",gridTemplateColumns:colGrid,gap:4,padding:"2px 8px",fontSize:10,fontWeight:700,color:"#94a3b8",textTransform:"uppercase",marginBottom:2}}>
                <div/><div>날짜</div><div>핵심사항</div><div>폴더</div>
                {!isMobile&&<><div>세부내용</div><div>비고</div></>}
                <div/>
              </div>
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
function WRow({ entry, wi, isMobile, colGrid, folders, isSel, onToggleSel, onUpdate, onDelete, onAddBelow }) {
  const [showDP, setShowDP] = useState(false);
  const [showFP, setShowFP] = useState(false);
  const selFolder = folders.find(f => f.name===entry.project);

  return (
    <div style={{display:"grid",gridTemplateColumns:colGrid,gap:4,alignItems:"center",
      background:isSel?"#eff6ff":"#fff",borderRadius:10,padding:"7px 8px",marginBottom:3,
      boxShadow:isSel?"0 0 0 1.5px #93c5fd":"0 1px 3px rgba(15,32,68,.05)"}}>
      <div style={{...wCB,...(isSel?wCBOn:{})}} onClick={onToggleSel}>{isSel&&"✓"}</div>

      {/* Date pill */}
      <div style={{position:"relative"}}>
        {wi===0
          ? <div style={wDatePill} onClick={()=>setShowDP(v=>!v)}>{entry.date||"날짜"}</div>
          : <div style={{...wDatePill,opacity:.2,pointerEvents:"none",fontSize:11}}>{entry.date}</div>
        }
        {showDP && <DatePicker value={entry.date} onChange={d=>{onUpdate({date:d});setShowDP(false);}} onClose={()=>setShowDP(false)}/>}
      </div>

      {/* Key point */}
      <input style={wCell} value={entry.keyPoint} placeholder="핵심사항..." onChange={e=>onUpdate({keyPoint:e.target.value})}/>

      {/* Folder picker pill */}
      <div style={{position:"relative"}}>
        <div style={{...wDatePill,
          color: selFolder?"#1650b8":"#94a3b8",
          borderColor: selFolder?"#bfdbfe":"#e8eef8",
          background: selFolder?"#eff6ff":"#f8faff",
          overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}
          onClick={()=>setShowFP(v=>!v)}>
          {selFolder ? entry.project : "폴더"}
        </div>
        {showFP && (
          <div style={{position:"absolute",zIndex:500,background:"#fff",borderRadius:12,
            boxShadow:"0 6px 24px rgba(15,32,68,.16)",border:"1px solid #e0eaf8",
            top:"100%",left:0,marginTop:4,minWidth:150,overflow:"hidden"}}>
            <div style={{padding:"6px 12px 4px",fontSize:10,fontWeight:700,color:"#94a3b8",letterSpacing:"1px",textTransform:"uppercase"}}>폴더 선택</div>
            {entry.project && (
              <div style={{padding:"8px 14px",fontSize:12,color:"#e53e3e",cursor:"pointer",fontWeight:500,borderBottom:"1px solid #f0f4fa"}}
                onMouseDown={()=>{onUpdate({project:""});setShowFP(false);}}>× 선택 해제</div>
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
        )}
      </div>

      {!isMobile && <input style={wCell} value={entry.details} placeholder="세부내용..." onChange={e=>onUpdate({details:e.target.value})}/>}
      {!isMobile && <input style={{...wCell,fontSize:12}} value={entry.notes} placeholder="비고..." onChange={e=>onUpdate({notes:e.target.value})}/>}
      <div style={{display:"flex",flexDirection:"column",gap:2}}>
        <button style={wRowBtn} onClick={onAddBelow} title="행 추가">＋</button>
        <button style={{...wRowBtn,color:"#fca5a5"}} onClick={onDelete} title="삭제">×</button>
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
      .map(w => ({ 날짜:w.date||"", 프로젝트:w.project||"", 핵심사항:w.keyPoint||"", 세부내용:w.details||"", 비고:w.notes||"" }));
    if (!rows.length) { alert("해당 기간에 데이터가 없습니다."); return; }
    const ws = XLSX.utils.json_to_sheet(rows);
    ws["!cols"] = [{wch:12},{wch:22},{wch:30},{wch:40},{wch:20}];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "업무일지");
    XLSX.writeFile(wb, `업무일지_${from}_${to}.xlsx`);
    onClose();
  };

  return (
    <div style={{ position:"fixed", inset:0, background:"rgba(15,32,68,.4)", display:"flex", alignItems:"center", justifyContent:"center", zIndex:800 }}
      onClick={onClose}>
      <div style={{ background:"#fff", borderRadius:18, padding:"26px 24px 20px", width:300, boxShadow:"0 16px 48px rgba(15,32,68,.22)" }}
        onClick={e => e.stopPropagation()}>
        <div style={{ fontSize:15, fontWeight:700, color:"#0f2044", marginBottom:4 }}>📥 엑셀 다운로드</div>
        <div style={{ fontSize:12, color:"#8aa0c0", marginBottom:18, lineHeight:1.6 }}>기간을 선택하여 xlsx 파일로 저장합니다.</div>
        <div style={{ display:"flex", gap:10, marginBottom:18 }}>
          {[["시작", from, setFrom, showF, setShowF], ["종료", to, setTo, showT, setShowT]].map(([lbl, val, set, show, setShow]) => (
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
          onClick={doDownload}>다운로드</button>
        <button style={{ width:"100%", padding:"9px", borderRadius:10, border:"none", background:"transparent", color:"#9ca3af", fontSize:13, cursor:"pointer", fontFamily:"inherit", marginTop:8 }}
          onClick={onClose}>취소</button>
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
function CalendarView({ items, folders }) {
  const now = new Date();
  const todayYM = `${now.getFullYear()}.${String(now.getMonth()+1).padStart(2,"0")}`;
  const [search,        setSearch]        = useState("");
  const [navYM,         setNavYM]         = useState(null);
  const [showNav,       setShowNav]       = useState(false);
  const [filterFolders, setFilterFolders] = useState(new Set());
  const [showFilter,    setShowFilter]    = useState(false);
  const [showDl,        setShowDl]        = useState(false);
  const listRef = useRef(null);

  const allSelected = filterFolders.size === 0;
  const toggleFF = name => setFilterFolders(prev => {
    const n = new Set(prev); n.has(name) ? n.delete(name) : n.add(name); return n;
  });
  const filterLabel = allSelected ? "전체" : filterFolders.size === 1 ? [...filterFolders][0] : `${filterFolders.size}개 선택`;

  const getFN  = id => folders.find(f => f.id===id)?.name || "—";
  const getFId = id => folders.find(f => f.id===id);
  const tIcon  = t => t===T.HEADER?"▬":t===T.TODO?"☐":"T";
  const tColor = t => t===T.HEADER?"#2563eb":t===T.TODO?"#059669":"#8b5cf6";

  const q = search.trim().toLowerCase();
  const filtered = [...items]
    .filter(i => !i.deletedAt)
    .filter(i => !q || (i.title||"").toLowerCase().includes(q))
    .filter(i => allSelected || filterFolders.has(getFN(i.folder)))
    .sort((a,b) => (b.createdAt||"").localeCompare(a.createdAt||""));

  const grouped = {};
  filtered.forEach(item => {
    const d = item.createdAt || "날짜 없음";
    if (!grouped[d]) grouped[d] = [];
    grouped[d].push(item);
  });

  // Group by YM for section headers
  const ymGroups = {};
  Object.entries(grouped).forEach(([date, dayItems]) => {
    const ym = date.slice(0,7);
    if (!ymGroups[ym]) ymGroups[ym] = {};
    ymGroups[ym][date] = dayItems;
  });
  const sortedYMs = Object.keys(ymGroups).sort((a,b) => b.localeCompare(a));

  const navigateTo = ym => {
    setNavYM(ym); setShowNav(false);
    setTimeout(() => {
      listRef.current?.querySelector(`[data-calym="${ym}"]`)?.scrollIntoView({ behavior:"smooth", block:"start" });
    }, 100);
  };

  const doDownload = () => {
    const rows = filtered.map(item => ({
      날짜: item.createdAt||"",
      폴더: getFN(item.folder),
      유형: item.type===T.HEADER?"헤더":item.type===T.TODO?"할일":"텍스트",
      제목: item.title||"",
      완료: item.type===T.TODO?(item.done?"완료":"진행"):"",
      별표: item.starred?"★":"",
    }));
    if (!rows.length) { alert("데이터가 없습니다."); return; }
    const ws = XLSX.utils.json_to_sheet(rows);
    ws["!cols"] = [{wch:12},{wch:14},{wch:8},{wch:40},{wch:6},{wch:4}];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "캘린더");
    XLSX.writeFile(wb, `calendar_${navYM||todayYM}.xlsx`);
    setShowDl(false);
  };

  return (
    <div style={{ display:"flex", flexDirection:"column", height:"100%" }} onClick={() => setShowFilter(false)}>

      {/* Controls */}
      <div style={{ display:"flex", alignItems:"center", gap:6, flexWrap:"wrap", paddingBottom:10, borderBottom:"1px solid #eef3ff", marginBottom:8 }}>
        <div style={{ flex:1, minWidth:120, position:"relative" }}>
          <span style={{ position:"absolute", left:9, top:"50%", transform:"translateY(-50%)", color:"#a0b4cc", fontSize:13 }}>🔍</span>
          <input style={{ width:"100%", padding:"7px 10px 7px 28px", borderRadius:9, border:"1.5px solid #e0eaf8", fontSize:12.5, color:"#1e3a6e", outline:"none", fontFamily:"inherit", background:"#fff", boxSizing:"border-box" }}
            placeholder="검색..." value={search} onChange={e => setSearch(e.target.value)} />
        </div>

        {/* Folder filter */}
        <div style={{ position:"relative" }} onClick={e => e.stopPropagation()}>
          <button style={{ ...wBtn, ...(allSelected?{}:{background:"#eef3ff",color:"#2563eb",borderColor:"#bfdbfe"}) }}
            onClick={() => setShowFilter(v => !v)}>
            ⊞ {filterLabel}
          </button>
          {showFilter && (
            <div style={{ position:"absolute", top:"100%", left:0, marginTop:4, background:"#fff", borderRadius:12, boxShadow:"0 6px 24px rgba(15,32,68,.16)", border:"1px solid #e0eaf8", zIndex:400, minWidth:170, overflow:"hidden" }}>
              <div style={{ padding:"6px 12px 4px", fontSize:10, fontWeight:700, color:"#94a3b8", letterSpacing:"1px", textTransform:"uppercase" }}>폴더 필터</div>
              <div style={{ display:"flex", alignItems:"center", gap:8, padding:"9px 14px", cursor:"pointer", borderBottom:"1px solid #f0f4fa", background:allSelected?"#eff6ff":"transparent" }}
                onClick={() => setFilterFolders(new Set())}>
                <div style={{ width:15,height:15,borderRadius:4,border:"1.5px solid",borderColor:allSelected?"#2563eb":"#c2d0e8",background:allSelected?"#2563eb":"transparent",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0 }}>
                  {allSelected && <span style={{color:"#fff",fontSize:10,fontWeight:700}}>✓</span>}
                </div>
                <span style={{ fontSize:13, fontWeight:600, color:allSelected?"#2563eb":"#1e3a6e" }}>전체</span>
              </div>
              {folders.map(f => {
                const on = filterFolders.has(f.name);
                return (
                  <div key={f.id} style={{ display:"flex", alignItems:"center", gap:8, padding:"9px 14px", cursor:"pointer", background:on?"#eff6ff":"transparent" }}
                    onClick={() => toggleFF(f.name)}>
                    <div style={{ width:15,height:15,borderRadius:4,border:"1.5px solid",borderColor:on?"#2563eb":"#c2d0e8",background:on?"#2563eb":"transparent",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0 }}>
                      {on && <span style={{color:"#fff",fontSize:10,fontWeight:700}}>✓</span>}
                    </div>
                    <span style={{ fontSize:13, fontWeight:500, color:on?"#2563eb":"#1e3a6e" }}>{f.name}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Month nav */}
        <div style={{ position:"relative" }}>
          <button style={wBtn} onClick={() => setShowNav(v => !v)}>📅 {navYM||todayYM}</button>
          {showNav && <MonthPicker value={navYM||todayYM} onChange={navigateTo} onClose={() => setShowNav(false)} label="년월로 이동" />}
        </div>

        {/* Excel download */}
        <button style={{ ...wBtn, background:"#2563eb", color:"#fff", border:"none", boxShadow:"0 2px 8px rgba(37,99,235,.3)" }}
          onClick={doDownload}>↓ 엑셀</button>
      </div>

      {/* List */}
      <div ref={listRef} style={{ flex:1, overflowY:"auto", paddingBottom:40 }}>
        {sortedYMs.length === 0 && (
          <div style={{ display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", padding:"60px 0", color:"#b0c4de" }}>
            <div style={{ fontSize:32, marginBottom:10 }}>◷</div>
            <div style={{ fontSize:13 }}>{search||!allSelected ? "결과 없음" : "항목이 없습니다."}</div>
          </div>
        )}
        {sortedYMs.map(ym => {
          const [yy, mm] = ym.split(".");
          const dayEntries = Object.entries(ymGroups[ym]).sort((a,b) => b[0].localeCompare(a[0]));
          const total = dayEntries.reduce((s,[,v]) => s+v.length, 0);
          return (
            <div key={ym} data-calym={ym} style={{ marginBottom:28 }}>
              <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:8, marginTop:4 }}>
                <div style={{ fontSize:13, fontWeight:700, color:"#1e3a6e", background:"#eef3ff", borderRadius:20, padding:"4px 14px", flexShrink:0 }}>{yy}년 {parseInt(mm)}월</div>
                <div style={{ flex:1, height:1, background:"rgba(37,99,235,.1)" }} />
                <span style={{ fontSize:11, color:"#94a3b8", flexShrink:0 }}>{total}건</span>
              </div>
              {dayEntries.map(([date, dayItems]) => (
                <div key={date} style={{ marginBottom:12 }}>
                  <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:4 }}>
                    <div style={{ flex:1, height:1, background:"rgba(37,99,235,.08)" }} />
                    <div style={{ fontSize:11, fontWeight:700, color:"#2563eb", padding:"2px 8px", background:"#eef3ff", borderRadius:10, whiteSpace:"nowrap" }}>{date}</div>
                    <div style={{ flex:1, height:1, background:"rgba(37,99,235,.08)" }} />
                  </div>
                  {dayItems.map(item => (
                    <div key={item.id} style={{ display:"flex", alignItems:"center", gap:10, background:"#fff", borderRadius:9, padding:"10px 14px", boxShadow:"0 1px 3px rgba(15,32,68,.05)", marginBottom:3 }}>
                      <span style={{ fontSize:12, fontWeight:700, width:16, flexShrink:0, textAlign:"center", color:tColor(item.type) }}>{tIcon(item.type)}</span>
                      <span style={{ flex:1, fontSize:13.5, color:"#1e3a6e", fontWeight:500, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{item.title||"(제목 없음)"}</span>
                      {item.starred && <span style={{ color:"#f59e0b", fontSize:12 }}>★</span>}
                      <span style={{ fontSize:10, color:"#6b8bb5", background:"#f0f5fc", borderRadius:8, padding:"2px 7px", flexShrink:0 }}>{getFN(item.folder)}</span>
                      {item.type===T.TODO && (
                        <span style={{ fontSize:10, borderRadius:8, padding:"2px 7px", flexShrink:0, ...(item.done?{color:"#065f46",background:"#d1fae5"}:{color:"#b45309",background:"#fef3c7"}) }}>
                          {item.done?"완료":"진행"}
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

// ─── TrashView ────────────────────────────────────────────
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
            <span style={{ fontSize:12, color:"#6b8bb5" }}>전체 선택</span>
          </div>
          <div style={{ display:"flex", gap:6 }}>
            {sel.size > 0 && (
              <>
                <button style={{ background:"none", border:"1px solid #bfdbfe", borderRadius:7, padding:"5px 11px", fontSize:12, cursor:"pointer", fontFamily:"inherit", fontWeight:600, color:"#2563eb" }}
                  onClick={() => { sel.forEach(id => onRestore(id)); setSel(new Set()); }}>복원({sel.size})</button>
                <button style={{ background:"none", border:"1px solid #fecaca", borderRadius:7, padding:"5px 11px", fontSize:12, cursor:"pointer", fontFamily:"inherit", fontWeight:600, color:"#e53e3e" }}
                  onClick={() => { sel.forEach(id => onPermDel(id)); setSel(new Set()); }}>삭제({sel.size})</button>
              </>
            )}
            <button style={{ background:"none", border:"1px solid #e5e7eb", borderRadius:7, padding:"5px 11px", fontSize:12, cursor:"pointer", fontFamily:"inherit", fontWeight:600, color:"#9ca3af" }}
              onClick={() => { onEmpty(); setSel(new Set()); }}>전체 비우기</button>
          </div>
        </div>
      )}
      {trash.length === 0 && (
        <div style={{ display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", padding:"80px 0", color:"#b0c4de" }}>
          <div style={{ fontSize:32, marginBottom:10 }}>🗑</div>
          <div style={{ fontSize:13 }}>휴지통이 비어있습니다.</div>
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
              <div style={{ fontSize:13.5, color:"#4b5563", fontWeight:500, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", textDecoration:"line-through" }}>{item.title||"(제목 없음)"}</div>
              <div style={{ fontSize:10, color:l<=3?"#e53e3e":"#9ca3af", marginTop:2 }}>
                {l===0?"오늘 영구 삭제":`${l}일 후 자동 삭제`} · {item.originalFolderName||"알 수 없는 폴더"}
              </div>
            </div>
            <button style={{ background:"none", border:"1px solid #bfdbfe", borderRadius:7, color:"#2563eb", fontSize:11.5, padding:"4px 10px", cursor:"pointer", fontFamily:"inherit", fontWeight:600, flexShrink:0 }}
              onClick={() => onRestore(item.id)}>복원</button>
            <button style={{ background:"none", border:"none", color:"#d0ddef", fontSize:18, cursor:"pointer", padding:"0 2px", flexShrink:0 }}
              onClick={() => onPermDel(item.id)}>×</button>
          </div>
        );
      })}
      <div style={{ fontSize:11, color:"#c0c8d8", textAlign:"center", marginTop:16, lineHeight:1.6 }}>{TRASH_DAYS}일 후 자동 영구 삭제됩니다.</div>
    </div>
  );
}

// ─── SwipeFolder: single folder row with swipe-to-delete ──
// ─── Sidebar ──────────────────────────────────────────────
function SidebarInner({ sidebarItems, setSidebarItems, activeFolder, onSelect, onAddItem, user, onLogin, onLogout, trashCount, syncStatus }) {
  const [showAdd,      setShowAdd]      = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(null);
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
        {sidebarItems.map((item, index) => {
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
              <input
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
            <div key={item.id} data-sortidx={index}
              style={{ ...NI, color:"rgba(255,255,255,.6)", ...(activeFolder===item.id?{background:"rgba(255,255,255,.12)",color:"#fff"}:{}) }}
              onClick={() => onSelect(item.id)}>
              <span style={{ fontSize:11, width:16, color:"rgba(255,255,255,.4)", flexShrink:0 }}>○</span>
              <span style={{ flex:1, fontSize:13.5 }}>{item.name}</span>
              <span
                style={{ color:"rgba(255,120,120,.5)", fontSize:16, lineHeight:1, cursor:"pointer", padding:"0 3px", flexShrink:0 }}
                title="폴더 삭제"
                onMouseDown={e => { e.stopPropagation(); setConfirmDelete(item); }}>×</span>
              {handle}
            </div>
          );
          return null;
        })}

        <div style={{ marginTop:8, paddingTop:8, borderTop:"1px solid rgba(255,255,255,.08)" }}>
          {[
            { id:NOTICE_ID,   label:"Notice",   icon:"★",  ac:"#fde68a",  ic:"rgba(255,220,80,.65)" },
            { id:CALENDAR_ID, label:"Calendar", icon:"◷",  ac:"#a5f3fc",  ic:"rgba(125,211,252,.65)" },
            { id:WORKLOG_ID,  label:"Worklog",  icon:"📋", ac:"#c4b5fd",  ic:"rgba(167,139,250,.7)" },
            { id:TRASH_ID,    label:"Trash",    icon:"🗑", ac:"#fca5a5",  ic:"rgba(252,165,165,.7)", badge:trashCount },
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
            <div style={{ fontSize:15, fontWeight:700, color:"#0f2044", marginBottom:8 }}>폴더 삭제</div>
            <div style={{ fontSize:13, color:"#6b8bb5", marginBottom:22, lineHeight:1.6 }}>
              <span style={{ fontWeight:700, color:"#1e3a6e" }}>"{confirmDelete.name}"</span> 폴더를 삭제하시겠습니까?<br/>
              폴더 안의 노트는 삭제되지 않습니다.
            </div>
            <div style={{ display:"flex", gap:10 }}>
              <button style={{ flex:1, padding:"11px", borderRadius:10, border:"1.5px solid #e0eaf8", background:"transparent", color:"#6b8bb5", fontSize:14, cursor:"pointer", fontFamily:"inherit", fontWeight:600 }}
                onClick={() => setConfirmDelete(null)}>취소</button>
              <button style={{ flex:1, padding:"11px", borderRadius:10, border:"none", background:"#e53e3e", color:"#fff", fontSize:14, cursor:"pointer", fontFamily:"inherit", fontWeight:700, boxShadow:"0 4px 12px rgba(229,62,62,.3)" }}
                onClick={() => deleteFolder(confirmDelete)}>삭제</button>
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
              <div style={{ fontSize:12, color:"#6b8bb5", marginBottom:4 }}>{user?.email || "Sign in to sync your notes"}</div>
              {syncStatus==="saved" && <div style={{ fontSize:11, color:"#16a34a" }}>✅ Google Drive synced</div>}
              {syncStatus==="saving" && <div style={{ fontSize:11, color:"#ca8a04" }}>⏳ Saving...</div>}
              {syncStatus==="error" && <div style={{ fontSize:11, color:"#dc2626" }}>❌ Sync error</div>}
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
                {[["Folder","folder"],["Header","sheader"],["Divider","divider"]].map(([l,t]) => (
                  <div key={t} style={{ padding:"10px 16px", color:"rgba(255,255,255,.75)", fontSize:13, cursor:"pointer", fontWeight:500 }}
                    onClick={() => { onAddItem(t); setShowAdd(false); }}>{l}</div>
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
              <div style={{ fontSize:9, marginTop:1, color: syncStatus==="saving"?"#fde68a":syncStatus==="saved"?"#86efac":syncStatus==="error"?"#fca5a5":"transparent" }}>
                {syncStatus==="saving"?"⏳ Saving...":syncStatus==="saved"?"✅ Synced":syncStatus==="error"?"❌ Save failed":"·"}
              </div>
            </div>
            <button style={{ background:"none", border:"1px solid rgba(255,255,255,.2)", borderRadius:7, color:"rgba(255,255,255,.5)", fontSize:11, padding:"4px 8px", cursor:"pointer", fontFamily:"inherit", flexShrink:0 }}
              onClick={onLogout}>로그아웃</button>
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
        onClick={() => window.open(lk.url, "_blank", "noopener,noreferrer")}>
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
          value={section.label} onChange={e => onUpdate({ label:e.target.value })} placeholder="섹션 제목..."
          onClick={e => e.stopPropagation()} />
        <span style={{ color:"#c0cfe8", fontSize:15, cursor:"pointer", padding:"0 2px" }} onClick={onDelete}>×</span>
      </div>
      {section.open && (
        <div style={{ padding:"10px 12px", borderTop:"1px solid #e8eef8" }}>
          <RichText html={section.content||""} onChange={v => onUpdate({ content:v })}
            placeholder="내용을 입력하세요..." style={{ fontSize:isMobile?13.5:13, minHeight:36 }} />
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
    onConfirm({ label: label.trim() || url, url: url.trim() });
  };

  return (
    <div style={{ position:"fixed", inset:0, background:"rgba(15,32,68,.4)", display:"flex", alignItems:"center", justifyContent:"center", zIndex:600 }}
      onClick={onClose}>
      <div style={{ background:"#fff", borderRadius:18, padding:"28px 24px 22px", width:310, boxShadow:"0 16px 48px rgba(15,32,68,.22)" }}
        onClick={e => e.stopPropagation()}>
        <div style={{ fontSize:16, fontWeight:700, color:"#0f2044", marginBottom:16 }}>
          {ytDetected ? "▶ YouTube 링크 추가" : "🔗 링크 추가"}
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
            <div style={{ fontSize:11, color:"#e53e3e", marginTop:4, fontWeight:500 }}>▶ YouTube 동영상 감지됨</div>
          )}
        </div>

        {/* Label */}
        <div style={{ marginBottom:20 }}>
          <div style={{ fontSize:11, fontWeight:700, color:"#6b8bb5", marginBottom:5, letterSpacing:"0.5px", display:"flex", alignItems:"center", gap:6 }}>
            제목
            {fetching && <span style={{ fontSize:10, color:"#94a3b8", fontWeight:400 }}>불러오는 중...</span>}
          </div>
          <input
            style={{ ...mInput, marginBottom:0 }}
            placeholder={ytDetected ? "동영상 제목을 입력하거나 자동 입력됩니다" : "링크 이름 (선택)"}
            value={label}
            onChange={e => setLabel(e.target.value)}
            onKeyDown={e => e.key==="Enter" && submit()}
          />
        </div>

        <div style={{ display:"flex", gap:10, justifyContent:"flex-end" }}>
          <button style={mBtnC} onClick={onClose}>취소</button>
          <button style={{ ...mBtnP, background: ytDetected ? "#e53e3e" : "#2563eb", boxShadow: ytDetected ? "0 4px 10px rgba(229,62,62,.3)" : "0 4px 10px rgba(37,99,235,.3)" }}
            onClick={submit}>추가</button>
        </div>
      </div>
    </div>
  );
}
const mInput = { width:"100%", padding:"12px 14px", borderRadius:10, border:"1.5px solid #d0dcef", fontSize:15, color:"#1e3a6e", outline:"none", fontFamily:"inherit", boxSizing:"border-box", marginBottom:18, display:"block" };
const mBtnC  = { padding:"10px 20px", borderRadius:10, border:"1.5px solid #d0dcef", background:"transparent", color:"#6b8bb5", fontSize:14, cursor:"pointer", fontFamily:"inherit" };
const mBtnP  = { padding:"10px 20px", borderRadius:10, border:"none", background:"#2563eb", color:"#fff", fontSize:14, fontWeight:600, cursor:"pointer", fontFamily:"inherit", boxShadow:"0 4px 10px rgba(37,99,235,.3)" };


// ─── Table helpers ────────────────────────────────────────
const mkCell = (content="",colspan=1,rowspan=1,bg=null) => ({ id:`tc${Math.random().toString(36).slice(2,7)}`, content, colspan, rowspan, bg });
const mkTable = (rows=2,cols=3) => ({ id:`tbl${nextId++}`, rows: Array(rows).fill(0).map(()=>Array(cols).fill(0).map(()=>mkCell())) });

// ─── TableBlock ───────────────────────────────────────────
// ─── RichTableCell: contentEditable cell with floating toolbar ──
function RichTableCell({ content, onChange, disabled }) {
  const ref = useRef(null);
  // Toolbar state — all managed locally, no shared containerRef needed
  const tbRef  = useRef(null);
  const [tb, setTb] = useState(null);

  useEffect(() => {
    if (ref.current && ref.current.innerHTML !== content) {
      ref.current.innerHTML = content;
    }
  }, []); // eslint-disable-line

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
            {[["#fef08a","노랑"],["#bbf7d0","초록"],["#bfdbfe","파랑"],["transparent","제거"]].map(([c,t])=>(
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
  // mode: null | "merge" | "split" | "color"
  const [mode,       setMode]     = useState(null);
  const [selCells,   setSelCells] = useState(new Set()); // "r,c"
  const [pendingBg,  setPendingBg] = useState(null); // selected color in color mode

  const rows    = table.rows;
  const numCols = rows[0]?.length || 0;
  const key     = (r,c) => `${r},${c}`;

  // Check if a cell is merged (colspan>1 or rowspan>1)
  const isMerged = (cell) => (cell.colspan||1) > 1 || (cell.rowspan||1) > 1;

  // Collect all merged-anchor cells for split mode highlighting
  const mergedKeys = new Set();
  rows.forEach((row,ri) => row.forEach((cell,ci) => { if (!cell.hidden && isMerged(cell)) mergedKeys.add(key(ri,ci)); }));

  const enterMode = (m) => {
    if (mode === m) { setMode(null); setSelCells(new Set()); return; }
    setMode(m); setSelCells(new Set());
    setShowBgPic(false);
  };

  const handleCellClick = (r,c,e) => {
    e.stopPropagation();
    const k = key(r,c);
    if (mode === "merge") {
      setSelCells(prev => { const n=new Set(prev); n.has(k)?n.delete(k):n.add(k); return n; });
    } else if (mode === "split") {
      const cell = rows[r][c];
      if (!isMerged(cell)) return; // only selectable if merged
      setSelCells(new Set([k]));
    } else if (mode === "color") {
      setSelCells(prev => { const n=new Set(prev); n.has(k)?n.delete(k):n.add(k); return n; });
    } else {
      // Normal: single select
      setSelCells(prev => { const n=new Set(prev); if(e.shiftKey||e.metaKey||e.ctrlKey){n.has(k)?n.delete(k):n.add(k);}else{n.clear();n.add(k);} return n; });
    }
  };

  const confirm = () => {
    if (mode === "merge") doMerge();
    else if (mode === "split") doSplit();
    else if (mode === "color") applyBg();
  };

  const doMerge = () => {
    if (selCells.size < 2) return;
    const coords = [...selCells].map(k=>k.split(",").map(Number));
    const minR=Math.min(...coords.map(([r])=>r)), maxR=Math.max(...coords.map(([r])=>r));
    const minC=Math.min(...coords.map(([,c])=>c)), maxC=Math.max(...coords.map(([,c])=>c));
    const newRows = rows.map((row,ri)=>row.map((cell,ci)=>{
      if (ri===minR && ci===minC) return {...cell, rowspan:maxR-minR+1, colspan:maxC-minC+1};
      if (ri>=minR && ri<=maxR && ci>=minC && ci<=maxC) return {...cell, hidden:true};
      return cell;
    }));
    onUpdate({ rows: newRows });
    setMode(null); setSelCells(new Set());
  };

  const doSplit = () => {
    if (selCells.size !== 1) return;
    const [r,c] = [...selCells][0].split(",").map(Number);
    const cell = rows[r][c];
    if (!isMerged(cell)) return;
    const newRows = rows.map((row,ri)=>row.map((cl,ci)=>{
      if (ri===r && ci===c) return {...cl, colspan:1, rowspan:1};
      if (ri>=r && ri<r+(cell.rowspan||1) && ci>=c && ci<c+(cell.colspan||1)) return {...cl, hidden:false};
      return cl;
    }));
    onUpdate({ rows: newRows });
    setMode(null); setSelCells(new Set());
  };

  const updCell = (r,c,patch) => {
    onUpdate({ rows: rows.map((row,ri)=>row.map((cell,ci)=>ri===r&&ci===c?{...cell,...patch}:cell)) });
  };

  const addRow = () => onUpdate({ rows: [...rows, Array(numCols).fill(0).map(()=>mkCell())] });
  const delRow = () => {
    if (rows.length<=1) return;
    onUpdate({ rows: rows.filter((_,i)=>i!==rows.length-1) });
  };
  const addCol = () => onUpdate({ rows: rows.map(row=>[...row,mkCell()]) });
  const delCol = () => {
    if (numCols<=1) return;
    onUpdate({ rows: rows.map(row=>row.filter((_,i)=>i!==numCols-1)) });
  };

  const applyBg = () => {
    if (selCells.size===0 || pendingBg===null) return;
    onUpdate({ rows: rows.map((row,ri)=>row.map((cell,ci)=>selCells.has(key(ri,ci))?{...cell,bg:pendingBg}:cell)) });
    setMode(null); setSelCells(new Set()); setPendingBg(null);
  };

  const BG_COLORS = ["none","#fef9c3","#dcfce7","#dbeafe","#fce7f3","#ede9fe","#ffedd5","#f1f5f9","#e2e8f0"];
  const modeActive = mode !== null;
  const canConfirm = (mode==="merge" && selCells.size>=2) || (mode==="split" && selCells.size===1) || (mode==="color" && selCells.size>=1 && pendingBg!==null);

  return (
    <div style={{margin:"4px 0 8px",userSelect:"none"}} onClick={e=>e.stopPropagation()}>

      {/* Toolbar */}
      <div style={{display:"flex",alignItems:"center",gap:4,flexWrap:"wrap",marginBottom:6}}>
        {/* Row/Col controls — hidden in mode */}
        {!modeActive && <>
          {[["＋행",addRow],["－행",delRow],["＋열",addCol],["－열",delCol]].map(([l,fn])=>(
            <button key={l} style={tbBtn} onClick={fn}>{l}</button>
          ))}
          <div style={{width:1,height:16,background:"#e0eaf8",margin:"0 2px"}}/>
        </>}

        {/* Merge button */}
        <button
          style={{...tbBtn,...(mode==="merge"?{background:"#eff6ff",color:"#2563eb",borderColor:"#93c5fd"}:{})}}
          onClick={()=>enterMode("merge")}>
          {mode==="merge" ? "합치기 ✕" : "합치기"}
        </button>

        {/* Split button */}
        <button
          style={{...tbBtn,...(mode==="split"?{background:"#fff7ed",color:"#ea580c",borderColor:"#fdba74"}:{}),
            opacity: mergedKeys.size===0&&mode!=="split" ? 0.4 : 1}}
          disabled={mergedKeys.size===0&&mode!=="split"}
          onClick={()=>enterMode("split")}>
          {mode==="split" ? "나누기 ✕" : "나누기"}
        </button>

        {/* Shared confirm checkmark */}
        {modeActive && (
          <button
            style={{...tbBtn,
              background: canConfirm?"#2563eb":"#e0eaf8",
              color: canConfirm?"#fff":"#94a3b8",
              borderColor: canConfirm?"#2563eb":"#e0eaf8",
              fontSize:15, padding:"4px 10px",
              cursor: canConfirm?"pointer":"default",
              transition:"all .15s"}}
            onClick={canConfirm ? confirm : undefined}
            title="확인">✓</button>
        )}

        {/* Color mode button */}
        <div style={{width:1,height:16,background:"#e0eaf8",margin:"0 2px"}}/>
        <button
          style={{...tbBtn,...(mode==="color"?{background:"#fdf4ff",color:"#7c3aed",borderColor:"#c4b5fd"}:{})}}
          onClick={()=>enterMode("color")}>
          {mode==="color" ? "색 ✕" : "색"}
        </button>

        {/* Color picker — only in color mode */}
        {mode==="color" && (
          <div style={{display:"flex",alignItems:"center",gap:5,padding:"2px 8px",background:"#fdf4ff",borderRadius:8,border:"1px solid #e9d5ff"}}>
            {BG_COLORS.map(c=>{
              const isNone = c==="none";
              const isSel  = pendingBg===c;
              return (
                <div key={c} onClick={()=>setPendingBg(c)}
                  title={isNone?"색 없음":c}
                  style={{
                    width:20,height:20,borderRadius:4,cursor:"pointer",flexShrink:0,
                    background: isNone?"#fff":c,
                    border: isSel?"2.5px solid #7c3aed": isNone?"2px dashed #c2d0e8":"2px solid rgba(0,0,0,.07)",
                    boxShadow: isSel?"0 0 0 1px #7c3aed":"none",
                    position:"relative",
                  }}>
                  {isNone && <span style={{position:"absolute",inset:0,display:"flex",alignItems:"center",justifyContent:"center",fontSize:9,color:"#94a3b8",fontWeight:700,lineHeight:1}}>✕</span>}
                </div>
              );
            })}
          </div>
        )}

        <button style={{...tbBtn,marginLeft:"auto",color:"#fca5a5",borderColor:"#fecaca"}} onClick={onDelete}>표 삭제</button>
      </div>

      {/* Mode hint */}
      {mode && (
        <div style={{fontSize:11,color:mode==="merge"?"#2563eb":mode==="color"?"#7c3aed":"#ea580c",marginBottom:6,fontWeight:500,padding:"4px 8px",background:mode==="merge"?"#eff6ff":mode==="color"?"#fdf4ff":"#fff7ed",borderRadius:6,display:"inline-block"}}>
          {mode==="merge"
            ? `셀을 클릭해서 선택 (${selCells.size}개 선택됨) → ✓ 로 합치기`
            : mode==="color"
            ? `색 선택 후 셀 클릭 (${selCells.size}개 선택됨) → ✓ 로 적용`
            : mergedKeys.size===0 ? "합쳐진 셀이 없습니다"
            : `합쳐진 셀을 클릭해서 선택 → ✓ 로 나누기`}
        </div>
      )}

      {/* Table */}
      <div style={{overflowX:"auto"}}>
        <table style={{width:"100%",borderCollapse:"collapse",tableLayout:"fixed",fontSize:13}}>
          <tbody>
            {rows.map((row,ri)=>(
              <tr key={ri}>
                {row.map((cell,ci)=>{
                  if (cell.hidden) return null;
                  const k = key(ri,ci);
                  const isSel = selCells.has(k);
                  const isSelectable = mode==="split" ? isMerged(cell) : true;
                  const isMergedCell = isMerged(cell);

                  let borderColor = "#e0eaf8";
                  let bgColor = (cell.bg && cell.bg!=="transparent" && cell.bg!=="none") ? cell.bg : "#fff";
                  if (isSel && mode==="merge") { borderColor="#2563eb"; bgColor="rgba(37,99,235,.08)"; }
                  if (isSel && mode==="split") { borderColor="#ea580c"; bgColor="rgba(234,88,12,.07)"; }
                  if (!isSel && mode==="split" && isMergedCell) { borderColor="#fdba74"; bgColor="rgba(251,146,60,.06)"; }
                  if (isSel && mode==="color") { borderColor="#7c3aed"; bgColor = pendingBg&&pendingBg!=="none" ? pendingBg : "rgba(124,58,237,.06)"; }

                  return (
                    <td key={cell.id}
                      colSpan={cell.colspan||1} rowSpan={cell.rowspan||1}
                      onClick={e=>handleCellClick(ri,ci,e)}
                      style={{
                        border:`1.5px solid ${borderColor}`,
                        background: bgColor,
                        padding:"6px 8px",
                        verticalAlign:"top",
                        position:"relative",
                        cursor: mode ? (isSelectable?"pointer":"default") : "cell",
                        minWidth:60,
                        transition:"background .1s, border-color .1s",
                      }}>
                      <RichTableCell
                        content={cell.content||""}
                        onChange={v=>updCell(ri,ci,{content:v})}
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
      {!mode && <div style={{fontSize:10,color:"#b0c4de",marginTop:4}}>셀 클릭 후 Shift/Cmd 추가 선택 → 색 적용</div>}
    </div>
  );
}
const tbBtn = {background:"#f5f8ff",border:"1px solid #dce8fb",borderRadius:6,color:"#4b6fa8",fontSize:11.5,padding:"4px 9px",cursor:"pointer",fontFamily:"inherit",fontWeight:600};

function TextBlock({ item, isMobile, drag, bp, fs, onUpdate, onDelete }) {
  const [showLM, setShowLM] = useState(false);
  const addHS  = () => onUpdate({ hiddenSections:[...(item.hiddenSections||[]), { id:`hs${nextId++}`, label:"새 섹션", content:"", open:false }] });
  const updHS  = (id,p) => onUpdate({ hiddenSections:(item.hiddenSections||[]).map(h=>h.id===id?{...h,...p}:h) });
  const delHS  = id => onUpdate({ hiddenSections:(item.hiddenSections||[]).filter(h=>h.id!==id) });
  const addLk  = ({label,url}) => { onUpdate({ links:[...(item.links||[]),{id:`lk${nextId++}`,label,url}] }); setShowLM(false); };
  const delLk  = id => onUpdate({ links:(item.links||[]).filter(l=>l.id!==id) });
  const addTbl = () => onUpdate({ tables:[...(item.tables||[]), mkTable(2,3)] });
  const updTbl = (id,patch) => onUpdate({ tables:(item.tables||[]).map(t=>t.id===id?{...t,...patch}:t) });
  const delTbl = id => onUpdate({ tables:(item.tables||[]).filter(t=>t.id!==id) });
  const pad = isMobile ? "14px" : "13px 14px";
  return (
    <>
      <div style={{ background:"#fff", borderRadius:12, marginBottom:5, boxShadow:"0 1px 4px rgba(15,32,68,.06)", display:"flex", flexDirection:"column", alignItems:"stretch", cursor:"grab", userSelect:"none", ...drag }} {...bp}>
        <div style={{ display:"flex", alignItems:"center", gap:8, padding:pad, paddingBottom:6 }}>
          <div style={{ width:3, height:16, borderRadius:2, background:"#2563eb", flexShrink:0 }} />
          <input style={{ color:"#0f2044", border:"none", background:"transparent", outline:"none", fontFamily:"inherit", fontSize:fs, fontWeight:600, flex:1 }}
            value={item.title} placeholder="제목..." onChange={e=>onUpdate({title:e.target.value})} onClick={e=>e.stopPropagation()} />
          <span style={{ fontSize:14, cursor:"pointer", userSelect:"none", flexShrink:0, color:item.starred?"#f59e0b":"#dbe6f5" }}
            onClick={()=>onUpdate({starred:!item.starred})}>★</span>
          <span style={{ color:"#d0ddef", fontSize:19, cursor:"pointer", lineHeight:1, padding:"0 2px", userSelect:"none", flexShrink:0 }} onClick={onDelete}>×</span>
        </div>
        <div style={{ paddingLeft:21, paddingRight:14, paddingBottom:6 }} onClick={e=>e.stopPropagation()}>
          <RichText html={item.body||""} onChange={v=>onUpdate({body:v})} placeholder="내용을 입력하세요..." style={{fontSize:isMobile?14:13.5}} />
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
        <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", padding:"6px 14px 10px", borderTop:"1px solid #f0f4fa", marginTop:4 }}>
          <span style={{ fontSize:10, color:"#a8bcd8" }}>{item.createdAt}</span>
          <div style={{ display:"flex", gap:6 }}>
            <button style={footBtn} onClick={e=>{e.stopPropagation();addHS();}}>＋ 섹션</button>
            <button style={footBtn} onClick={e=>{e.stopPropagation();addTbl();}}>⊞ 표</button>
            <button style={footBtn} onClick={e=>{e.stopPropagation();setShowLM(true);}}>🔗 링크</button>
          </div>
        </div>
      </div>
      {showLM && <LinkModal onConfirm={addLk} onClose={()=>setShowLM(false)} />}
    </>
  );
}
const footBtn = {background:"none",border:"1px dashed #b8cce8",borderRadius:6,color:"#6b8bb5",fontSize:11.5,padding:"4px 10px",cursor:"pointer",fontFamily:"inherit",fontWeight:500};


// ─── SortableList ────────────────────────────────────────
function SortableList({ items, setItems, getKey, collapsedHdrs, toggleHdr, selMode, selected, togSel, isMobile, upd, softDel }) {
  const containerRef = useRef(null);
  const { beginDrag } = useSortable(containerRef, items, setItems);

  // Build header sections with flat indices
  const sections = [];
  let cur = null;
  items.forEach((item, idx) => {
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
      {sections.map((sec, si) => (
        <div key={sec.header?.id || `pre-${si}`}>
          {sec.header && (
            <div data-sortidx={sec.hIdx} style={{ display:"flex", alignItems:"center", gap:6, marginBottom:2, marginTop:12 }}>
              {selMode && (
                <div style={{ width:18,height:18,borderRadius:5,border:"1.5px solid #c2d0e8",display:"flex",alignItems:"center",justifyContent:"center",fontSize:11,color:"#fff",fontWeight:700,cursor:"pointer",flexShrink:0,marginTop:2,...(selected.has(sec.header.id)?{background:"#2563eb",borderColor:"#2563eb"}:{}) }}
                  onClick={() => togSel(sec.header.id)}>{selected.has(sec.header.id)&&"✓"}</div>
              )}
              <div style={{ flex:1, display:"flex", alignItems:"center", gap:8,
                background:"linear-gradient(90deg,rgba(37,99,235,.09),rgba(37,99,235,.04))",
                border:"1px solid rgba(37,99,235,.12)", borderLeft:"3px solid #2563eb",
                borderRadius:9, padding:"10px 14px" }}>
                <button style={{ background:"none",border:"none",cursor:"pointer",padding:"4px 8px",color:"#2563eb",fontSize:20,display:"flex",alignItems:"center",flexShrink:0,minWidth:32,minHeight:32,justifyContent:"center",borderRadius:6 }}
                  onClick={() => toggleHdr(sec.header.id)}>
                  <span style={{ display:"inline-block",transition:"transform .2s",transform:collapsedHdrs.has(sec.header.id)?"rotate(-90deg)":"rotate(0deg)" }}>▾</span>
                </button>
                <input style={{ fontWeight:700,color:"#1a3a78",flex:1,border:"none",background:"transparent",outline:"none",fontFamily:"inherit",fontSize:isMobile?15:14 }}
                  value={sec.header.title} placeholder="Header title..."
                  onChange={e => upd(sec.header.id,{title:e.target.value})} onClick={e=>e.stopPropagation()} />
                {sec.children.length>0 && <span style={{ fontSize:10,color:"rgba(37,99,235,.5)",background:"rgba(37,99,235,.1)",borderRadius:10,padding:"1px 7px",flexShrink:0 }}>{sec.children.length}</span>}
                <span style={{ fontSize:14,cursor:"pointer",flexShrink:0,color:sec.header.starred?"#3b82f6":"rgba(59,130,246,.3)" }}
                  onClick={()=>upd(sec.header.id,{starred:!sec.header.starred})}>★</span>
                {handle(sec.hIdx)}
                <span style={{ color:"#d0ddef",fontSize:19,cursor:"pointer",lineHeight:1,padding:"0 2px",flexShrink:0 }}
                  onClick={()=>softDel(sec.header.id)}>×</span>
              </div>
            </div>
          )}
          {!collapsedHdrs.has(sec.header?.id) && sec.children.map(({ item, idx }) => (
            <div key={item.id} data-sortidx={idx} style={{ display:"flex", alignItems:"flex-start", gap:6, paddingLeft: sec.header ? 18 : 0 }}>
              {selMode && (
                <div style={{ width:18,height:18,borderRadius:5,border:"1.5px solid #c2d0e8",display:"flex",alignItems:"center",justifyContent:"center",fontSize:11,color:"#fff",fontWeight:700,cursor:"pointer",flexShrink:0,marginTop:item.type===T.TEXT?16:14,...(selected.has(item.id)?{background:"#2563eb",borderColor:"#2563eb"}:{}) }}
                  onClick={()=>togSel(item.id)}>{selected.has(item.id)&&"✓"}</div>
              )}
              {handle(idx, item.type===T.TEXT?16:14)}
              <div style={{ flex:1 }}>
                <ItemBlock item={item} isMobile={isMobile} onUpdate={p=>upd(item.id,p)} onDelete={()=>softDel(item.id)} />
              </div>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function ItemBlock({ item, isMobile, onUpdate, onDelete }) {
  const bp = {};
  const drag = {};
  const fs = isMobile ? 15 : 14;

  if (item.type === T.HEADER) return (
    <div style={{ display:"flex", alignItems:"center", gap:8, background:"linear-gradient(90deg,rgba(37,99,235,.09),rgba(37,99,235,.04))", border:"1px solid rgba(37,99,235,.12)", borderLeft:"3px solid #2563eb", borderRadius:9, marginBottom:8, marginTop:12, padding:"11px 14px", cursor:"grab", userSelect:"none", ...drag }} {...bp}>
      <input style={{ fontWeight:700, color:"#1a3a78", flex:1, border:"none", background:"transparent", outline:"none", fontFamily:"inherit", fontSize:isMobile?15:14 }}
        value={item.title} placeholder="Header title..." onChange={e => onUpdate({ title:e.target.value })} onClick={e => e.stopPropagation()} />
      <span style={{ fontSize:14, cursor:"pointer", userSelect:"none", flexShrink:0, color:item.starred?"#3b82f6":"rgba(59,130,246,.3)" }}
        onClick={() => onUpdate({ starred:!item.starred })}>★</span>
      <span style={{ color:"#d0ddef", fontSize:19, cursor:"pointer", lineHeight:1, padding:"0 2px", userSelect:"none", flexShrink:0 }} onClick={onDelete}>×</span>
    </div>
  );

  if (item.type === T.TODO) return (
    <div style={{ background:"#fff", borderRadius:12, marginBottom:5, boxShadow:"0 1px 4px rgba(15,32,68,.06)", display:"flex", cursor:"grab", userSelect:"none", ...drag }} {...bp}>
      <div style={{ padding:isMobile?"14px":"12px 14px", display:"flex", alignItems:"center", gap:10, width:"100%", boxSizing:"border-box" }}>
        <div style={{ borderRadius:5, border:"1.5px solid #c2d0e8", display:"flex", alignItems:"center", justifyContent:"center", cursor:"pointer", flexShrink:0, width:isMobile?21:18, height:isMobile?21:18, ...(item.done?{background:"#2563eb",borderColor:"#2563eb"}:{}) }}
          onClick={() => onUpdate({ done:!item.done })}>
          {item.done && <span style={{ color:"#fff", fontSize:11, fontWeight:700 }}>✓</span>}
        </div>
        <input style={{ color:"#1e3a6e", border:"none", background:"transparent", outline:"none", fontFamily:"inherit", fontSize:fs, flex:1, ...(item.done?{textDecoration:"line-through",color:"#96acc8"}:{}) }}
          value={item.title} placeholder="할 일 입력..." onChange={e => onUpdate({ title:e.target.value })} onClick={e => e.stopPropagation()} />
        <span style={{ fontSize:10, color:"#a8bcd8", whiteSpace:"nowrap", flexShrink:0 }}>{item.createdAt}</span>
        <span style={{ fontSize:14, cursor:"pointer", userSelect:"none", flexShrink:0, color:item.starred?"#f59e0b":"#dbe6f5" }}
          onClick={() => onUpdate({ starred:!item.starred })}>★</span>
        <span style={{ color:"#d0ddef", fontSize:19, cursor:"pointer", lineHeight:1, padding:"0 2px", userSelect:"none", flexShrink:0 }} onClick={onDelete}>×</span>
      </div>
    </div>
  );

  if (item.type === T.TEXT) return (
    <TextBlock item={item} isMobile={isMobile} drag={drag} bp={bp} fs={fs} onUpdate={onUpdate} onDelete={onDelete} />
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
  const [sidebarItems, setSidebarItems] = useState(initSidebar);
  const [items,        setItems]        = useState(initItems);
  const [worklogs,     setWorklogs]     = useState(initWorklogs);
  const [activeFolder, setActiveFolder] = useState("f1");
  const [editingFN,    setEditingFN]    = useState(false);
  const [fnDraft,      setFnDraft]      = useState("");
  const [showAddMenu,  setShowAddMenu]  = useState(false);
  const [showSidebar,  setShowSidebar]  = useState(false);
  const [selMode,      setSelMode]      = useState(false);
  const [selected,     setSelected]     = useState(new Set());
  const [collapsedHdrs,setCollapsedHdrs] = useState(new Set());
  const toggleHdr = id => setCollapsedHdrs(prev => { const n=new Set(prev); n.has(id)?n.delete(id):n.add(id); return n; });
  const [user,         setUser]         = useState(null);
  const [accessToken,  setAccessToken]  = useState(null);
  const [showLogin,    setShowLogin]    = useState(false);
  const [driveFileId,  setDriveFileId]  = useState(null);
  const [syncStatus,   setSyncStatus]   = useState("");
  const [dataLoaded,   setDataLoaded]   = useState(false);

  const folders     = sidebarItems.filter(i => i.type === "folder");
  const isNotice    = activeFolder === NOTICE_ID;
  const isCalendar  = activeFolder === CALENDAR_ID;
  const isTrash     = activeFolder === TRASH_ID;
  const isWorklog   = activeFolder === WORKLOG_ID;
  const isSpecial   = isNotice || isCalendar || isTrash || isWorklog;
  const liveItems   = items.filter(i => !i.deletedAt);
  const trashItems  = items.filter(i => !!i.deletedAt);
  const visibleItems = isNotice ? liveItems.filter(i => i.starred)
    : isCalendar ? liveItems
    : isTrash    ? trashItems
    : isWorklog  ? []
    : liveItems.filter(i => i.folder === activeFolder);
  const activeF = isNotice?{name:"Notice"}:isCalendar?{name:"Calendar"}:isTrash?{name:"Trash"}:isWorklog?{name:"Worklog"}:folders.find(f => f.id===activeFolder);

  useEffect(() => { setItems(prev => prev.filter(i => !i.deletedAt || daysAgo(i.deletedAt) < TRASH_DAYS)); }, [activeFolder]);

  const startFE   = () => { if (isSpecial) return; setFnDraft(activeF?.name||""); setEditingFN(true); };
  const commitFE  = () => { if (!isSpecial && fnDraft.trim()) setSidebarItems(prev => prev.map(f => f.id===activeFolder ? {...f,name:fnDraft.trim()} : f)); setEditingFN(false); };

  const addItem = type => {
    if (isSpecial) return;
    const id = `i${nextId++}`;
    const ni = { id, type, folder:activeFolder, starred:false, createdAt:mkDate(), title:"" };
    if (type===T.TODO) ni.done = false;
    if (type===T.TEXT) { ni.body=""; ni.hiddenSections=[]; ni.links=[]; }
    setItems(prev => [...prev, ni]);
    setShowAddMenu(false);
  };
  const addSBI = type => {
    const id = `si${nextId++}`;
    if (type==="folder")   setSidebarItems(prev => [...prev, { id, type:"folder",  name:"New Folder" }]);
    if (type==="sheader")  setSidebarItems(prev => [...prev, { id, type:"sheader", label:"NEW SECTION" }]);
    if (type==="divider")  setSidebarItems(prev => [...prev, { id, type:"divider" }]);
  };
  const upd      = (id, patch) => setItems(prev => prev.map(i => i.id===id ? {...i,...patch} : i));
  const softDel  = useCallback(id => {
    const item = items.find(i => i.id===id);
    if (!item) return;
    const fn = folders.find(f => f.id===item.folder)?.name || "Unknown";
    setItems(prev => prev.map(i => i.id===id ? {...i, deletedAt:mkTs(), originalFolder:i.folder, originalFolderName:fn} : i));
  }, [items, folders]);
  const delSel   = () => { selected.forEach(id => softDel(id)); setSelected(new Set()); setSelMode(false); };
  const shareSel = () => {
    const txt = [...selected].map(id => items.find(i => i.id===id)?.title||"").join("\n");
    if (navigator.share) navigator.share({ title:"Notes", text:txt });
    else { navigator.clipboard?.writeText(txt); alert("클립보드에 복사되었습니다."); }
    setSelected(new Set()); setSelMode(false);
  };
  const togSel   = id => setSelected(prev => { const n=new Set(prev); n.has(id)?n.delete(id):n.add(id); return n; });
  const allSel   = visibleItems.length > 0 && selected.size === visibleItems.length;
  const togAll   = () => setSelected(allSel ? new Set() : new Set(visibleItems.map(i => i.id)));
  const selectFolder = id => { setActiveFolder(id); setShowSidebar(false); setEditingFN(false); setSelMode(false); setSelected(new Set()); };
  const restoreItem  = id => setItems(prev => prev.map(i => i.id===id ? {...i, deletedAt:undefined, originalFolder:undefined, originalFolderName:undefined} : i));
  const permDel      = id => setItems(prev => prev.filter(i => i.id!==id));
  const emptyTrash   = () => setItems(prev => prev.filter(i => !i.deletedAt));
  // ─── Google Login ───────────────────────────────────────
  const googleLogin = useGoogleLogin({
    scope: "https://www.googleapis.com/auth/drive.file",
    onSuccess: async (tokenResponse) => {
      const token = tokenResponse.access_token;
      setAccessToken(token);
      try {
        const res = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
          headers: { Authorization: `Bearer ${token}` },
        });
        const info = await res.json();
        setUser({ name: info.name, email: info.email, picture: info.picture });
      } catch (e) {
        setUser({ name: "User", email: "" });
      }
      try {
        const fileId = await gdriveFind(token);
        if (fileId) {
          setDriveFileId(fileId);
          const data = await gdriveRead(token, fileId);
          if (data) {
            if (data.sidebarItems) setSidebarItems(data.sidebarItems);
            if (data.items)        setItems(data.items);
            if (data.worklogs)     setWorklogs(data.worklogs);
            setSyncStatus("saved");
          }
        }
      } catch (e) { console.error("Drive load error:", e); }
      setDataLoaded(true);
      setShowLogin(false);
    },
    onError: () => alert("Google 로그인에 실패했습니다."),
  });

  const handleLogout = () => {
    setUser(null); setAccessToken(null); setDriveFileId(null);
    setDataLoaded(false); setSyncStatus("");
  };

  // ─── Auto-save to Google Drive ───────────────────────────
  const saveTimer = useRef(null);
  useEffect(() => {
    if (!accessToken || !dataLoaded) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      setSyncStatus("saving");
      try {
        await gdriveSave(accessToken, { sidebarItems, items, worklogs }, driveFileId);
        if (!driveFileId) {
          const fid = await gdriveFind(accessToken);
          if (fid) setDriveFileId(fid);
        }
        setSyncStatus("saved");
      } catch (e) { console.error("Drive save error:", e); setSyncStatus("error"); }
    }, 2000);
    return () => clearTimeout(saveTimer.current);
  }, [sidebarItems, items, worklogs, accessToken, dataLoaded]);

  const SC = (
    <SidebarInner sidebarItems={sidebarItems} setSidebarItems={setSidebarItems}
      activeFolder={activeFolder} onSelect={selectFolder} onAddItem={addSBI}
      user={user} onLogin={() => setShowLogin(true)} onLogout={handleLogout}
      trashCount={trashItems.length} syncStatus={syncStatus} />
  );

  const titlePre = isCalendar?"◷ ":isNotice?"★ ":isTrash?"🗑 ":isWorklog?"📋 ":"";

  return (
    <div style={{ display:"flex", height:"100vh", background:"#f0f4fa", fontFamily:"'SF Pro Display',-apple-system,'Helvetica Neue',sans-serif", overflow:"hidden", position:"relative" }}
      onClick={() => setShowAddMenu(false)}>

      {isMobile && showSidebar && (
        <div style={{ position:"fixed", inset:0, background:"rgba(10,24,50,.5)", zIndex:300, display:"flex" }}
          onClick={() => setShowSidebar(false)}>
          <div style={{ width:244, background:"linear-gradient(180deg,#1c6ef3 0%,#1a5fd4 40%,#1650b8 100%)", display:"flex", flexDirection:"column", height:"100%", boxShadow:"4px 0 24px rgba(28,110,243,.3)" }}
            onClick={e => e.stopPropagation()}>{SC}</div>
        </div>
      )}
      {!isMobile && (
        <aside style={{ width:224, background:"linear-gradient(180deg,#1c6ef3 0%,#1a5fd4 40%,#1650b8 100%)", display:"flex", flexDirection:"column", flexShrink:0, boxShadow:"2px 0 24px rgba(28,110,243,.25)" }}>{SC}</aside>
      )}

      <main style={{ flex:1, display:"flex", flexDirection:"column", overflow:"hidden", position:"relative" }}>
        {/* Top bar */}
        <div style={{ display:"flex", alignItems:"flex-start", justifyContent:"space-between", background:"#f0f4fa", padding:isMobile?"20px 18px 14px":"26px 36px 14px" }}>
          <div style={{ display:"flex", alignItems:"center", gap:12 }}>
            {isMobile && (
              <button style={{ width:38, height:38, borderRadius:10, background:"rgba(37,99,235,.08)", border:"none", cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center" }}
                onClick={e => { e.stopPropagation(); setShowSidebar(v => !v); }}>
                <span style={{ fontSize:18, color:"#2563eb" }}>☰</span>
              </button>
            )}
            <div>
              {editingFN
                ? <input autoFocus style={{ fontWeight:700, color:"#0f2044", letterSpacing:"-0.5px", border:"none", borderBottom:"2px solid #2563eb", background:"transparent", outline:"none", fontFamily:"inherit", fontSize:isMobile?22:27, width:200 }}
                    value={fnDraft} onChange={e => setFnDraft(e.target.value)} onBlur={commitFE} onKeyDown={e => (e.key==="Enter"||e.key==="Escape") && commitFE()} />
                : <div style={{ fontWeight:700, color:"#0f2044", letterSpacing:"-0.5px", display:"flex", alignItems:"center", gap:8, fontSize:isMobile?22:27, cursor:isSpecial?"default":"text" }}
                    onClick={!isSpecial ? startFE : undefined}>
                    {titlePre}{activeF?.name}
                    {!isSpecial && <span style={{ fontSize:14, color:"#b0c8e8", fontWeight:400 }}>✎</span>}
                  </div>
              }
              <div style={{ fontSize:11, color:"#8aa0c0", marginTop:3 }}>
                {isCalendar ? `${liveItems.length} total` : isTrash ? `${trashItems.length} items` : isWorklog ? `${worklogs.length} entries` : `${visibleItems.length} items`}
              </div>
            </div>
          </div>

          <div style={{ display:"flex", alignItems:"center", gap:8 }}>
            {!isSpecial && (
              selMode ? (
                <div style={{ display:"flex", alignItems:"center", gap:6 }}>
                  <div style={{ display:"flex", alignItems:"center", gap:6, cursor:"pointer" }} onClick={togAll}>
                    <div style={{ width:18, height:18, borderRadius:5, border:"1.5px solid #c2d0e8", display:"flex", alignItems:"center", justifyContent:"center", fontSize:11, color:"#fff", fontWeight:700, ...(allSel?{background:"#2563eb",borderColor:"#2563eb"}:{}) }}>
                      {allSel && "✓"}
                    </div>
                    <span style={{ fontSize:12, color:"#4b6fa8" }}>전체</span>
                  </div>
                  {selected.size > 0 && (
                    <>
                      <button style={{ background:"#eff6ff", border:"1px solid #bfdbfe", borderRadius:8, padding:"7px 13px", fontSize:12.5, cursor:"pointer", fontFamily:"inherit", fontWeight:600, color:"#2563eb" }} onClick={shareSel}>공유</button>
                      <button style={{ background:"#fff5f5", border:"1px solid #fecaca", borderRadius:8, padding:"7px 13px", fontSize:12.5, cursor:"pointer", fontFamily:"inherit", fontWeight:600, color:"#e53e3e" }} onClick={delSel}>삭제</button>
                    </>
                  )}
                  <button style={{ background:"none", border:"1px solid #e2e8f4", borderRadius:8, padding:"7px 13px", fontSize:12.5, cursor:"pointer", fontFamily:"inherit", fontWeight:600, color:"#6b7280" }}
                    onClick={() => { setSelMode(false); setSelected(new Set()); }}>취소</button>
                </div>
              ) : (
                <button style={{ background:"none", border:"1px solid #e2e8f4", borderRadius:8, padding:"7px 13px", fontSize:12.5, cursor:"pointer", fontFamily:"inherit", fontWeight:600, color:"#4b6fa8" }}
                  onClick={() => setSelMode(true)}>선택</button>
              )
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
        </div>

        {/* Content area */}
        <div style={{ flex:1, overflowY:"auto", WebkitOverflowScrolling:"touch", padding: isWorklog ? (isMobile?"12px 16px 40px":"8px 36px 40px") : (isMobile?"4px 16px 40px":"4px 36px 40px") }}>
          {isWorklog && <WorklogView worklogs={worklogs} setWorklogs={setWorklogs} folders={folders} isMobile={isMobile} />}
          {isCalendar && <CalendarView items={items} folders={folders} />}
          {isTrash && <TrashView items={items} onRestore={restoreItem} onPermDel={permDel} onEmpty={emptyTrash} />}
          {isNotice && (
            <>
              <NoticeView items={visibleItems} folders={folders} isMobile={isMobile} onUpdate={upd} onDelete={softDel} />
              {visibleItems.length === 0 && (
                <div style={{ display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", padding:"80px 0", color:"#b0c4de" }}>
                  <div style={{ fontSize:36, marginBottom:10 }}>★</div>
                  <div style={{ fontSize:13 }}>별표 항목이 없습니다.</div>
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
                  const folderItems = newArr;
                  const others = prev.filter(i => i.deletedAt || i.folder !== activeFolder);
                  return [...others, ...folderItems];
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
              />
            );
          })()}
          {!isSpecial && visibleItems.length === 0 && (
            <div style={{ display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", padding:"80px 0", color:"#b0c4de" }}>
              <div style={{ fontSize:36, marginBottom:10 }}>◌</div>
              <div style={{ fontSize:13 }}>Empty. Add something.</div>
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
            <div style={{ fontSize:16, fontWeight:700, color:"#0f2044", marginBottom:6 }}>Google로 로그인</div>
            <p style={{ fontSize:13, color:"#6b8bb5", marginBottom:20, lineHeight:1.6 }}>로그인하면 노트가 Google Drive에<br/>자동 동기화됩니다. (현재 데모 모드)</p>
            <button style={{ width:"100%", display:"flex", alignItems:"center", justifyContent:"center", gap:10, padding:"13px", borderRadius:10, border:"none", background:"#2563eb", color:"#fff", fontSize:14, fontWeight:600, cursor:"pointer", fontFamily:"inherit", boxShadow:"0 4px 10px rgba(37,99,235,.3)" }}
              onClick={() => { setShowLogin(false); googleLogin(); }}>Continue with Google</button>
            <button style={{ width:"100%", padding:"9px", borderRadius:10, border:"none", background:"transparent", color:"#9ca3af", fontSize:13, cursor:"pointer", fontFamily:"inherit", marginTop:8 }}
              onClick={() => setShowLogin(false)}>취소</button>
          </div>
        </div>
      )}
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

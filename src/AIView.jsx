import { useState, useRef, useEffect } from "react";
import { getFirestore, doc, getDoc, setDoc } from "firebase/firestore";
import { getAuth } from "firebase/auth";

var SYSTEM_PROMPT = "You are a helpful assistant. When users write in Korean, respond in Korean. When users write in English, respond in English. Be concise, practical, and clear. When analyzing notes provided, focus on what's most useful to the user.";
var HISTORY_KEY = "ai_chat_history";

async function callGroq(messages) {
  var res = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: messages, systemPrompt: SYSTEM_PROMPT }),
  });
  if (!res.ok) throw new Error("API 오류 " + res.status);
  var data = await res.json();
  return data.content || "";
}

function TypingDots() {
  return (
    <span style={{ display:"inline-flex", gap:3, alignItems:"center" }}>
      {[0,1,2].map(function(i) {
        return <span key={i} style={{ width:6, height:6, borderRadius:"50%", background:"#94a3b8", animation:"aiDot .9s ease-in-out " + (i*0.2) + "s infinite" }}></span>;
      })}
    </span>
  );
}

// ── Firestore 대화 기록 저장/로드 ──────────────────────────
var db = getFirestore();
var auth = getAuth();

async function loadHistory() {
  var fbUser = auth.currentUser;
  if (!fbUser) return [];
  try {
    var snap = await getDoc(doc(db, "users", fbUser.uid, "ai", "history"));
    return snap.exists() ? (snap.data().messages || []) : [];
  } catch { return []; }
}

async function saveHistory(msgs) {
  var fbUser = auth.currentUser;
  if (!fbUser) return;
  try {
    // 최근 100개만 보관
    var trimmed = msgs.slice(-100);
    await setDoc(doc(db, "users", fbUser.uid, "ai", "history"), {
      messages: trimmed,
      updatedAt: new Date().toISOString(),
    });
  } catch (e) { console.warn("AI history save failed:", e); }
}

function AIView(props) {
  var items       = props.items       || [];
  var folders     = props.folders     || [];
  var worklogs    = props.worklogs    || [];
  var isMobile    = props.isMobile    || false;
  var isPanel     = props.isPanel     || false;
  var onClose     = props.onClose;
  var onUpdateItem = props.onUpdateItem; // 노트 직접 수정
  var currentFolder = props.currentFolder || "";
  var currentItems  = props.currentItems  || [];

  var [messages,   setMessages]  = useState([]);
  var [input,      setInput]     = useState("");
  var [loading,    setLoading]   = useState(false);
  var [scope,      setScope]     = useState("current");
  var [noteCtx,    setNoteCtx]   = useState(null);
  var [histLoaded, setHistLoaded] = useState(false);
  var [applyTarget, setApplyTarget] = useState(null); // 노트 반영 대상
  var bottomRef = useRef(null);
  var inputRef  = useRef(null);
  var saveTimer = useRef(null);

  // 대화 기록 로드 (마운트 시 1회)
  useEffect(function() {
    loadHistory().then(function(hist) {
      if (hist.length > 0) setMessages(hist);
      setHistLoaded(true);
    });
  }, []);

  // 대화 기록 Firestore 저장 (debounce)
  useEffect(function() {
    if (!histLoaded || messages.length === 0) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(function() { saveHistory(messages); }, 3000);
    return function() { clearTimeout(saveTimer.current); };
  }, [messages, histLoaded]);

  // 인라인 버튼에서 노트 컨텍스트 수신
  useEffect(function() {
    function check() {
      if (window.__aiNoteContext) {
        var note = window.__aiNoteContext;
        window.__aiNoteContext = null;
        setNoteCtx(note);
        setApplyTarget(note);
        setScope("note");
        if (inputRef.current) inputRef.current.focus();
      }
    }
    check();
    var t = setInterval(check, 300);
    return function() { clearInterval(t); };
  }, []);

  // 스크롤
  useEffect(function() {
    if (bottomRef.current) bottomRef.current.scrollIntoView({ behavior:"smooth" });
  }, [messages, loading]);

  function buildContext() {
    if (scope === "note" && noteCtx) {
      return "제목: " + (noteCtx.title||"") + "\n내용: " + ((noteCtx.body||"").replace(/<[^>]*>/g,""));
    }
    if (scope === "current" && currentItems.length > 0) {
      return currentItems.slice(0,30).map(function(i) {
        return "[" + i.type + "] " + (i.title||"") + (i.body ? "\n" + i.body.replace(/<[^>]*>/g,"").slice(0,300) : "");
      }).join("\n---\n");
    }
    if (scope === "all") {
      return items.filter(function(i){ return !i.deletedAt; }).slice(0,50).map(function(i) {
        var f = folders.find(function(ff){ return ff.id===i.folder; });
        return "[" + (f?f.name:"") + "] " + (i.title||"") + (i.body ? ": " + i.body.replace(/<[^>]*>/g,"").slice(0,200) : "");
      }).join("\n");
    }
    if (scope === "worklog") {
      return worklogs.slice(0,50).map(function(w) {
        return "[" + (w.date||"") + "] " + (w.folder||"") + " — " + (w.keyPoint||"") + " " + (w.details||"");
      }).join("\n");
    }
    return "";
  }

  async function send() {
    var text = input.trim();
    if (!text || loading) return;
    var ctx = buildContext();
    var userContent = ctx ? text + "\n\n[참고 데이터]\n" + ctx : text;
    var newMessages = messages.concat([{
      role:"user", content: userContent, displayContent: text,
      ts: new Date().toISOString(),
    }]);
    setMessages(newMessages);
    setInput("");
    setLoading(true);
    try {
      var apiMessages = newMessages.map(function(m) { return { role: m.role, content: m.content }; });
      var reply = await callGroq(apiMessages);
      var updated = newMessages.concat([{
        role:"assistant", content: reply,
        ts: new Date().toISOString(),
      }]);
      setMessages(updated);
    } catch(e) {
      setMessages(newMessages.concat([{ role:"assistant", content:"❌ 오류: " + e.message, ts: new Date().toISOString() }]));
    } finally { setLoading(false); }
  }

  function handleKey(e) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
  }

  function clearChat() {
    if (!window.confirm("대화 기록을 모두 삭제하시겠습니까?")) return;
    setMessages([]);
    setNoteCtx(null);
    setApplyTarget(null);
    setScope("current");
    saveHistory([]);
  }

  // AI 답변을 노트에 반영
  function applyToNote(content) {
    if (!applyTarget || !onUpdateItem) {
      alert("반영할 노트가 선택되지 않았습니다.\n노트의 🤖 버튼을 통해 질문하면 반영할 수 있습니다.");
      return;
    }
    var current = applyTarget.body || "";
    var newBody = current ? current + "<br><br>" + content.replace(/\n/g,"<br>") : content.replace(/\n/g,"<br>");
    onUpdateItem(applyTarget.id, { body: newBody });
    alert("✅ 노트에 내용이 추가됐습니다.");
  }

  var quickBtns = [
    { label:"요약",   prompt:"위 내용을 핵심만 3~5줄로 요약해줘" },
    { label:"개선",   prompt:"위 내용에서 보완하면 좋을 점을 알려줘" },
    { label:"번역",   prompt:"위 내용을 영어로 번역해줘" },
    { label:"보고서", prompt:"위 내용을 바탕으로 보고서 형식으로 정리해줘" },
  ];

  var scopeOptions = [];
  if (noteCtx) scopeOptions.push({ id:"note", label:"📝 " + (noteCtx.title||"이 노트") });
  scopeOptions.push({ id:"current", label: currentFolder ? "📂 " + currentFolder : "📂 현재 폴더" });
  scopeOptions.push({ id:"all",     label:"📋 전체 노트" });
  scopeOptions.push({ id:"worklog", label:"📊 워크로그" });

  var S = {
    wrap:    { display:"flex", flexDirection:"column", height:"100%", background:"#f8faff", overflow:"hidden" },
    header:  { background:"linear-gradient(135deg,#7c3aed,#6d28d9)", padding: isPanel ? "14px 18px 12px" : "18px 24px 14px", flexShrink:0 },
    scopeBar: { display:"flex", gap:6, padding:"8px 12px", background:"#fff", borderBottom:"1px solid #e0eaf8", flexShrink:0, overflowX:"auto" },
    scopeBtn: { padding:"4px 12px", borderRadius:20, fontSize:11.5, fontWeight:600, cursor:"pointer", whiteSpace:"nowrap", border:"none", fontFamily:"inherit", background:"#f1f5f9", color:"#64748b" },
    scopeBtnA: { padding:"4px 12px", borderRadius:20, fontSize:11.5, fontWeight:700, cursor:"pointer", whiteSpace:"nowrap", border:"none", fontFamily:"inherit", background:"#ede9fe", color:"#7c3aed" },
    msgs:    { flex:1, overflowY:"auto", padding:"14px 14px 0" },
    bubble:  { maxWidth:"85%", borderRadius:12, padding:"9px 13px", fontSize:13.5, lineHeight:1.65, marginBottom:10, whiteSpace:"pre-wrap", wordBreak:"break-word" },
    userB:   { background:"#7c3aed", color:"#fff", alignSelf:"flex-end", borderBottomRightRadius:4 },
    aiB:     { background:"#fff", color:"#1e3a6e", alignSelf:"flex-start", borderBottomLeftRadius:4, boxShadow:"0 1px 4px rgba(15,32,68,.08)" },
    quickRow: { display:"flex", gap:5, padding:"8px 12px 4px", flexWrap:"wrap", flexShrink:0 },
    quickBtn: { padding:"4px 10px", borderRadius:20, fontSize:11.5, background:"#ede9fe", color:"#7c3aed", border:"none", cursor:"pointer", fontWeight:600, fontFamily:"inherit" },
    inputRow: { display:"flex", gap:8, padding:"10px 12px 14px", borderTop:"1px solid #e0eaf8", background:"#fff", flexShrink:0, alignItems:"flex-end" },
    ta:      { flex:1, padding:"9px 12px", borderRadius:10, border:"1.5px solid #e0eaf8", fontSize:13.5, outline:"none", fontFamily:"inherit", resize:"none", lineHeight:1.5, color:"#1e3a6e", minHeight:40, maxHeight:120, boxSizing:"border-box" },
    sendBtn: { width:38, height:38, borderRadius:10, border:"none", background:"#7c3aed", color:"#fff", fontSize:18, cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0 },
    applyBtn: { padding:"3px 9px", borderRadius:8, fontSize:11, background:"#f0fdf4", color:"#166534", border:"1px solid #bbf7d0", cursor:"pointer", marginTop:5, fontFamily:"inherit", fontWeight:600 },
    ts:      { fontSize:10, color:"#94a3b8", marginTop:2 },
  };

  function formatTs(ts) {
    if (!ts) return "";
    var d = new Date(ts);
    return (d.getMonth()+1) + "/" + d.getDate() + " " + d.getHours() + ":" + String(d.getMinutes()).padStart(2,"0");
  }

  return (
    <div style={S.wrap}>
      <style>{`@keyframes aiDot{0%,80%,100%{opacity:.2;transform:scale(.8)}40%{opacity:1;transform:scale(1)}}`}</style>

      <div style={S.header}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start" }}>
          <div>
            <div style={{ fontSize: isPanel?16:18, fontWeight:800, color:"#fff", marginBottom:2 }}>🤖 AI 어시스턴트</div>
            <div style={{ fontSize:11, color:"rgba(255,255,255,.65)" }}>Llama 3.3 70B · 대화 기록이 자동 저장됩니다</div>
          </div>
          <div style={{ display:"flex", gap:6 }}>
            {messages.length > 0 && (
              <button onClick={clearChat} style={{ background:"rgba(255,255,255,.15)", border:"none", borderRadius:7, padding:"4px 10px", color:"#fff", fontSize:11, cursor:"pointer", fontFamily:"inherit" }}>
                기록 삭제
              </button>
            )}
            {isPanel && onClose && (
              <button onClick={onClose} style={{ background:"rgba(255,255,255,.15)", border:"none", borderRadius:7, padding:"4px 8px", color:"#fff", fontSize:16, cursor:"pointer", lineHeight:1 }}>
                ✕
              </button>
            )}
          </div>
        </div>
      </div>

      <div style={S.scopeBar}>
        {scopeOptions.map(function(o) {
          return (
            <button key={o.id} style={scope===o.id ? S.scopeBtnA : S.scopeBtn}
              onClick={function(){ setScope(o.id); }}>
              {o.label}
            </button>
          );
        })}
      </div>

      <div style={S.msgs}>
        {messages.length === 0 && histLoaded && (
          <div style={{ textAlign:"center", paddingTop:32, color:"#94a3b8" }}>
            <div style={{ fontSize:36, marginBottom:12 }}>🤖</div>
            <div style={{ fontSize:13.5, fontWeight:600, color:"#64748b", marginBottom:6 }}>무엇이든 물어보세요</div>
            <div style={{ fontSize:12, color:"#94a3b8", lineHeight:1.7 }}>
              노트 요약·번역·보고서 작성 등<br/>아래 빠른 버튼을 눌러 시작해 보세요
            </div>
          </div>
        )}
        <div style={{ display:"flex", flexDirection:"column" }}>
          {messages.map(function(m, i) {
            var isUser = m.role === "user";
            var display = isUser ? (m.displayContent || m.content.replace(/\n\n\[참고 데이터\][\s\S]*/,"")) : m.content;
            var isLast = i === messages.length - 1;
            return (
              <div key={i} style={{ display:"flex", flexDirection:"column", alignItems: isUser?"flex-end":"flex-start", marginBottom:4 }}>
                <div style={Object.assign({}, S.bubble, isUser ? S.userB : S.aiB)}>
                  {display}
                </div>
                {!isUser && isLast && onUpdateItem && applyTarget && (
                  <button style={S.applyBtn} onClick={function(){ applyToNote(display); }}>
                    ✏️ 노트에 추가
                  </button>
                )}
                <div style={Object.assign({}, S.ts, { alignSelf: isUser?"flex-end":"flex-start" })}>
                  {formatTs(m.ts)}
                </div>
              </div>
            );
          })}
          {loading && (
            <div style={{ display:"flex", justifyContent:"flex-start", marginBottom:10 }}>
              <div style={Object.assign({}, S.bubble, S.aiB, { padding:"11px 14px" })}>
                <TypingDots />
              </div>
            </div>
          )}
        </div>
        <div ref={bottomRef} />
      </div>

      <div style={S.quickRow}>
        {quickBtns.map(function(b) {
          return (
            <button key={b.label} style={S.quickBtn}
              onClick={function(){ setInput(b.prompt); inputRef.current && inputRef.current.focus(); }}>
              {b.label}
            </button>
          );
        })}
      </div>

      <div style={S.inputRow}>
        <textarea
          ref={inputRef}
          value={input}
          onChange={function(e){ setInput(e.target.value); }}
          onKeyDown={handleKey}
          placeholder="메시지를 입력하세요... (Shift+Enter 줄바꿈)"
          rows={1}
          style={S.ta}
        ></textarea>
        <button onClick={send} disabled={loading || !input.trim()}
          style={Object.assign({}, S.sendBtn, (!input.trim()||loading)?{opacity:.4,cursor:"default"}:{})}>
          ↑
        </button>
      </div>
    </div>
  );
}

export default AIView;

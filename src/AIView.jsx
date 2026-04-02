import { useState, useRef, useEffect } from "react";

// ── localStorage 키 생성 ───────────────────────────────────
// contextType: "all" | "folder" | "__worklog__" | "__notice__" 등
// folderId: 폴더일 때만 사용
function historyKey(contextType, folderId) {
  if (contextType === "all")          return "notes_ai_history_all";
  if (contextType === "__worklog__")  return "notes_ai_history_worklog";
  if (contextType === "__notice__")   return "notes_ai_history_notice";
  if (contextType === "__calendar__") return "notes_ai_history_calendar";
  if (contextType === "folder" && folderId) return "notes_ai_history_f_" + folderId;
  return "notes_ai_history_all";
}

function loadHistory(contextType, folderId) {
  try {
    var raw = localStorage.getItem(historyKey(contextType, folderId));
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function saveHistory(contextType, folderId, msgs) {
  try {
    localStorage.setItem(historyKey(contextType, folderId), JSON.stringify(msgs.slice(-100)));
  } catch {}
}

// ── Groq API 호출 ──────────────────────────────────────────
var SYSTEM = "You are a helpful assistant. Respond in the same language the user writes in. Be concise and practical.";

async function callGroq(messages) {
  var res = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: messages, systemPrompt: SYSTEM }),
  });
  if (!res.ok) throw new Error("API 오류 " + res.status);
  var data = await res.json();
  return data.content || "";
}

// ── 타이핑 점 애니메이션 ───────────────────────────────────
function Dots() {
  return (
    <span style={{ display:"inline-flex", gap:3, alignItems:"center" }}>
      {[0,1,2].map(function(i) {
        return <span key={i} style={{ width:6, height:6, borderRadius:"50%", background:"#94a3b8", animation:"aiDot .9s ease-in-out " + (i*0.2) + "s infinite" }} />;
      })}
    </span>
  );
}

// ── 컨텍스트 레이블 ────────────────────────────────────────
function ctxLabel(contextType, folderName) {
  if (contextType === "all")          return "📋 전체 노트";
  if (contextType === "__worklog__")  return "📊 Worklog";
  if (contextType === "__notice__")   return "★ Notice";
  if (contextType === "__calendar__") return "◷ Calendar";
  if (contextType === "__upcoming__") return "📅 Upcoming";
  if (contextType === "folder")       return "📂 " + (folderName || "폴더");
  return "📋 전체 노트";
}

// ── 메인 컴포넌트 ──────────────────────────────────────────
function AIView(props) {
  var items       = props.items       || [];
  var folders     = props.folders     || [];
  var worklogs    = props.worklogs    || [];
  var isMobile    = props.isMobile    || false;
  var isPanel     = props.isPanel     || false;
  var onClose     = props.onClose;
  var onUpdateItem = props.onUpdateItem;
  var currentItems = props.currentItems || [];

  // 초기 컨텍스트 — 진입점에 따라 결정됨
  var initCtxType  = props.contextType || "all";
  var initFolderId = props.folderId    || null;
  var initFolderName = props.folderName || "";

  var [ctxType,    setCtxType]    = useState(initCtxType);
  var [folderId,   setFolderId]   = useState(initFolderId);
  var [folderName, setFolderName] = useState(initFolderName);
  var [messages,   setMessages]   = useState(function() { return loadHistory(initCtxType, initFolderId); });
  var [input,      setInput]      = useState("");
  var [loading,    setLoading]    = useState(false);
  var [applyTarget, setApplyTarget] = useState(null);
  var [showFolderPicker, setShowFolderPicker] = useState(false);

  var bottomRef = useRef(null);
  var inputRef  = useRef(null);
  var saveTimer = useRef(null);

  // 인라인 버튼(노트 🤖)에서 진입한 경우 수신
  useEffect(function() {
    function check() {
      if (window.__aiNoteContext) {
        var note = window.__aiNoteContext;
        window.__aiNoteContext = null;
        setApplyTarget(note);
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

  // 기록 저장 (debounce)
  useEffect(function() {
    if (messages.length === 0) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(function() {
      saveHistory(ctxType, folderId, messages);
    }, 2000);
    return function() { clearTimeout(saveTimer.current); };
  }, [messages, ctxType, folderId]);

  // 컨텍스트 변경 시 해당 기록 로드
  function switchContext(newCtxType, newFolderId, newFolderName) {
    // 현재 기록 즉시 저장
    saveHistory(ctxType, folderId, messages);
    // 새 컨텍스트로 전환
    setCtxType(newCtxType);
    setFolderId(newFolderId);
    setFolderName(newFolderName || "");
    setMessages(loadHistory(newCtxType, newFolderId));
    setShowFolderPicker(false);
    setApplyTarget(null);
  }

  // 데이터 컨텍스트 구성
  function buildContext() {
    if (ctxType === "folder" && folderId) {
      // 현재 폴더 아이템 (prop 또는 전체에서 필터)
      var folderItems = currentItems.length > 0
        ? currentItems
        : items.filter(function(i){ return !i.deletedAt && i.folder === folderId; });
      return folderItems.slice(0,40).map(function(i) {
        return "[" + i.type + "] " + (i.title||"") + (i.body ? "\n" + i.body.replace(/<[^>]*>/g,"").slice(0,300) : "");
      }).join("\n---\n");
    }
    if (ctxType === "__worklog__") {
      return worklogs.slice(0,50).map(function(w) {
        return "[" + (w.date||"") + "] " + (w.folder||"") + " — " + (w.keyPoint||"") + " " + (w.details||"");
      }).join("\n");
    }
    if (ctxType === "all") {
      return items.filter(function(i){ return !i.deletedAt; }).slice(0,50).map(function(i) {
        var f = folders.find(function(ff){ return ff.id===i.folder; });
        return "[" + (f?f.name:"") + "] " + (i.title||"") + (i.body ? ": " + i.body.replace(/<[^>]*>/g,"").slice(0,200) : "");
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
      role:"user", content: userContent, display: text,
      ts: new Date().toISOString(),
    }]);
    setMessages(newMessages);
    setInput("");
    setLoading(true);
    try {
      var api = newMessages.map(function(m) { return { role: m.role, content: m.content }; });
      var reply = await callGroq(api);
      setMessages(newMessages.concat([{ role:"assistant", content: reply, ts: new Date().toISOString() }]));
    } catch(e) {
      setMessages(newMessages.concat([{ role:"assistant", content:"❌ 오류: " + e.message, ts: new Date().toISOString() }]));
    } finally { setLoading(false); }
  }

  function handleKey(e) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
  }

  function clearChat() {
    if (messages.length > 0 && !window.confirm("이 대화 기록을 삭제하시겠습니까?")) return;
    setMessages([]);
    saveHistory(ctxType, folderId, []);
    setApplyTarget(null);
  }

  function applyToNote(content) {
    if (!applyTarget || !onUpdateItem) {
      alert("반영할 노트가 없습니다.\n노트의 🤖 버튼을 통해 질문하면 반영할 수 있습니다.");
      return;
    }
    var cur = applyTarget.body || "";
    var next = cur ? cur + "<br><br>" + content.replace(/\n/g,"<br>") : content.replace(/\n/g,"<br>");
    onUpdateItem(applyTarget.id, { body: next });
    alert("✅ 노트에 추가됐습니다.");
  }

  function fmtTs(ts) {
    if (!ts) return "";
    var d = new Date(ts);
    return (d.getMonth()+1) + "/" + d.getDate() + " " + d.getHours() + ":" + String(d.getMinutes()).padStart(2,"0");
  }

  var quickBtns = [
    { label:"요약",   prompt:"위 내용을 핵심만 3~5줄로 요약해줘" },
    { label:"개선",   prompt:"위 내용에서 보완하면 좋을 점을 알려줘" },
    { label:"번역",   prompt:"위 내용을 영어로 번역해줘" },
    { label:"보고서", prompt:"위 내용을 보고서 형식으로 정리해줘" },
  ];

  // 진입점별 UI 제한
  // - 폴더/워크로그 진입: 컨텍스트 고정, 스위처 없음
  // - 사이드바 AI: 폴더 선택 가능
  var isSidebarAI = !isPanel && initCtxType === "all";
  var isFixed = isPanel || (initCtxType !== "all"); // 패널이거나 특정 컨텍스트로 들어온 경우

  var S = {
    wrap:    { display:"flex", flexDirection:"column", height:"100%", background:"#f8faff", overflow:"hidden" },
    header:  { background:"linear-gradient(135deg,#7c3aed,#6d28d9)", padding: isPanel?"14px 18px 12px":"18px 24px 14px", flexShrink:0 },
    msgs:    { flex:1, overflowY:"auto", padding:"14px 14px 0" },
    userB:   { background:"#7c3aed", color:"#fff", borderBottomRightRadius:4 },
    aiB:     { background:"#fff", color:"#1e3a6e", borderBottomLeftRadius:4, boxShadow:"0 1px 4px rgba(15,32,68,.08)" },
    bubble:  { maxWidth:"85%", borderRadius:12, padding:"9px 13px", fontSize:13.5, lineHeight:1.65, marginBottom:4, whiteSpace:"pre-wrap", wordBreak:"break-word" },
    quickRow:{ display:"flex", gap:5, padding:"8px 12px 4px", flexWrap:"wrap", flexShrink:0 },
    quickBtn:{ padding:"4px 10px", borderRadius:20, fontSize:11.5, background:"#ede9fe", color:"#7c3aed", border:"none", cursor:"pointer", fontWeight:600, fontFamily:"inherit" },
    inputRow:{ display:"flex", gap:8, padding:"10px 12px 14px", borderTop:"1px solid #e0eaf8", background:"#fff", flexShrink:0, alignItems:"flex-end" },
    ta:      { flex:1, padding:"9px 12px", borderRadius:10, border:"1.5px solid #e0eaf8", fontSize:13.5, outline:"none", fontFamily:"inherit", resize:"none", lineHeight:1.5, color:"#1e3a6e", minHeight:40, maxHeight:120, boxSizing:"border-box" },
    sendBtn: { width:38, height:38, borderRadius:10, border:"none", background:"#7c3aed", color:"#fff", fontSize:18, cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0 },
    applyBtn:{ padding:"3px 9px", borderRadius:8, fontSize:11, background:"#f0fdf4", color:"#166534", border:"1px solid #bbf7d0", cursor:"pointer", marginTop:5, fontFamily:"inherit", fontWeight:600 },
    ts:      { fontSize:10, color:"#94a3b8", marginTop:2 },
    ctxBtn:  { background:"rgba(255,255,255,.2)", border:"none", borderRadius:8, padding:"5px 12px", color:"#fff", fontSize:12, fontWeight:700, cursor:"pointer", fontFamily:"inherit", display:"flex", alignItems:"center", gap:4 },
    picker:  { position:"absolute", top:"100%", left:0, marginTop:4, background:"#fff", borderRadius:10, boxShadow:"0 8px 24px rgba(15,32,68,.18)", zIndex:100, minWidth:180, overflow:"hidden" },
    pickerItem: { padding:"10px 16px", fontSize:13, color:"#1e3a6e", cursor:"pointer", fontFamily:"inherit", border:"none", background:"none", width:"100%", textAlign:"left", fontWeight:500 },
    pickerItemA: { padding:"10px 16px", fontSize:13, color:"#7c3aed", cursor:"pointer", fontFamily:"inherit", border:"none", background:"#f5f3ff", width:"100%", textAlign:"left", fontWeight:700 },
  };

  var curLabel = ctxLabel(ctxType, folderName);

  return (
    <div style={S.wrap}>
      <style>{`@keyframes aiDot{0%,80%,100%{opacity:.2;transform:scale(.8)}40%{opacity:1;transform:scale(1)}}`}</style>

      {/* 헤더 */}
      <div style={S.header}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start" }}>
          <div style={{ flex:1 }}>
            <div style={{ fontSize: isPanel?15:18, fontWeight:800, color:"#fff", marginBottom:6 }}>🤖 AI 어시스턴트</div>

            {/* 컨텍스트 표시 / 사이드바AI는 드롭다운 */}
            <div style={{ position:"relative", display:"inline-block" }}>
              {isSidebarAI ? (
                <button style={S.ctxBtn} onClick={function(){ setShowFolderPicker(function(v){return !v;}); }}>
                  {curLabel} <span style={{ fontSize:10 }}>▼</span>
                </button>
              ) : (
                <span style={{ background:"rgba(255,255,255,.2)", borderRadius:8, padding:"5px 12px", color:"#fff", fontSize:12, fontWeight:700 }}>
                  {curLabel}
                </span>
              )}

              {/* 폴더 선택 드롭다운 (사이드바 AI 전용) */}
              {showFolderPicker && (
                <div style={S.picker} onClick={function(e){e.stopPropagation();}}>
                  <button style={ctxType==="all" ? S.pickerItemA : S.pickerItem}
                    onClick={function(){ switchContext("all", null, ""); }}>
                    📋 전체 노트
                  </button>
                  {folders.map(function(f) {
                    var isActive = ctxType==="folder" && folderId===f.id;
                    return (
                      <button key={f.id} style={isActive ? S.pickerItemA : S.pickerItem}
                        onClick={function(){ switchContext("folder", f.id, f.name); }}>
                        {"📂 " + f.name}
                      </button>
                    );
                  })}
                  <button style={ctxType==="__worklog__" ? S.pickerItemA : S.pickerItem}
                    onClick={function(){ switchContext("__worklog__", null, "Worklog"); }}>
                    📊 Worklog
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* 버튼들 */}
          <div style={{ display:"flex", gap:5, flexShrink:0, marginLeft:8 }}>
            {messages.length > 0 && (
              <button onClick={clearChat}
                style={{ background:"rgba(255,255,255,.15)", border:"none", borderRadius:7, padding:"4px 9px", color:"#fff", fontSize:11, cursor:"pointer", fontFamily:"inherit" }}>
                삭제
              </button>
            )}
            {isPanel && onClose && (
              <button onClick={onClose}
                style={{ background:"rgba(255,255,255,.15)", border:"none", borderRadius:7, padding:"4px 8px", color:"#fff", fontSize:16, cursor:"pointer", lineHeight:1 }}>
                ✕
              </button>
            )}
          </div>
        </div>
        <div style={{ fontSize:10, color:"rgba(255,255,255,.5)", marginTop:6 }}>
          Llama 3.3 70B · 대화 기록은 이 컨텍스트에만 저장됩니다
        </div>
      </div>

      {/* 드롭다운 닫기 오버레이 */}
      {showFolderPicker && (
        <div style={{ position:"fixed", inset:0, zIndex:99 }} onClick={function(){ setShowFolderPicker(false); }} />
      )}

      {/* 메시지 영역 */}
      <div style={S.msgs} onClick={function(){ setShowFolderPicker(false); }}>
        {messages.length === 0 && (
          <div style={{ textAlign:"center", paddingTop:32, color:"#94a3b8" }}>
            <div style={{ fontSize:32, marginBottom:10 }}>🤖</div>
            <div style={{ fontSize:13, fontWeight:600, color:"#64748b", marginBottom:6 }}>
              {curLabel + " 기반 AI 대화"}
            </div>
            <div style={{ fontSize:12, color:"#94a3b8", lineHeight:1.7 }}>
              아래 빠른 버튼으로 시작하거나<br/>직접 질문을 입력하세요
            </div>
          </div>
        )}
        <div style={{ display:"flex", flexDirection:"column" }}>
          {messages.map(function(m, i) {
            var isUser = m.role === "user";
            var display = isUser ? (m.display || m.content.replace(/\n\n\[참고 데이터\][\s\S]*/,"")) : m.content;
            var isLast = !isUser && i === messages.length - 1;
            return (
              <div key={i} style={{ display:"flex", flexDirection:"column", alignItems: isUser?"flex-end":"flex-start", marginBottom:6 }}>
                <div style={Object.assign({}, S.bubble, isUser ? S.userB : S.aiB)}>
                  {display}
                </div>
                {isLast && onUpdateItem && applyTarget && (
                  <button style={S.applyBtn} onClick={function(){ applyToNote(display); }}>
                    ✏️ 노트에 추가
                  </button>
                )}
                <div style={Object.assign({}, S.ts, { alignSelf: isUser?"flex-end":"flex-start" })}>
                  {fmtTs(m.ts)}
                </div>
              </div>
            );
          })}
          {loading && (
            <div style={{ display:"flex", justifyContent:"flex-start", marginBottom:10 }}>
              <div style={Object.assign({}, S.bubble, S.aiB, { padding:"11px 14px" })}>
                <Dots />
              </div>
            </div>
          )}
        </div>
        <div ref={bottomRef} />
      </div>

      {/* 빠른 버튼 */}
      <div style={S.quickRow}>
        {quickBtns.map(function(b) {
          return (
            <button key={b.label} style={S.quickBtn}
              onClick={function(){ setInput(b.prompt); if(inputRef.current) inputRef.current.focus(); }}>
              {b.label}
            </button>
          );
        })}
      </div>

      {/* 입력창 */}
      <div style={S.inputRow}>
        <textarea
          ref={inputRef}
          value={input}
          onChange={function(e){ setInput(e.target.value); }}
          onKeyDown={handleKey}
          placeholder="메시지 입력... (Shift+Enter 줄바꿈)"
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

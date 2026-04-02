import { useState, useRef, useEffect } from "react";

var SYSTEM_PROMPT = "You are a helpful assistant. When users write in Korean, respond in Korean. When users write in English, respond in English. Be concise, practical, and clear. When analyzing notes provided, focus on what's most useful to the user.";

async function callGroq(messages, noteContext) {
  var systemFull = SYSTEM_PROMPT;
  if (noteContext) {
    systemFull += "\n\n[현재 노트 내용]\n제목: " + (noteContext.title || "") + "\n내용: " + (noteContext.body ? noteContext.body.replace(/<[^>]*>/g, "") : "");
  }
  var res = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: messages, systemPrompt: systemFull }),
  });
  if (!res.ok) throw new Error("API 오류 " + res.status);
  var data = await res.json();
  return data.content || "";
}

function TypingDots() {
  return (
    <span style={{ display:"inline-flex", gap:3, alignItems:"center" }}>
      {[0,1,2].map(function(i) {
        return <span key={i} style={{
          width:6, height:6, borderRadius:"50%", background:"#94a3b8",
          animation:"aiDot .9s ease-in-out " + (i*0.2) + "s infinite",
        }}></span>;
      })}
    </span>
  );
}

function AIView(props) {
  var items      = props.items     || [];
  var folders    = props.folders   || [];
  var worklogs   = props.worklogs  || [];
  var isMobile   = props.isMobile  || false;
  var isPanel    = props.isPanel   || false;
  var onClose    = props.onClose;
  var currentFolder = props.currentFolder || "";
  var currentItems  = props.currentItems  || [];

  var [messages, setMessages]   = useState([]);
  var [input,    setInput]      = useState("");
  var [loading,  setLoading]    = useState(false);
  var [scope,    setScope]      = useState("current"); // "current" | "all" | "worklog"
  var [noteCtx,  setNoteCtx]    = useState(null); // 인라인 버튼에서 전달된 노트
  var bottomRef  = useRef(null);
  var inputRef   = useRef(null);

  // 인라인 버튼에서 노트 컨텍스트 수신
  useEffect(function() {
    function checkCtx() {
      if (window.__aiNoteContext) {
        setNoteCtx(window.__aiNoteContext);
        setScope("note");
        window.__aiNoteContext = null;
        if (inputRef.current) inputRef.current.focus();
      }
    }
    checkCtx();
    var t = setInterval(checkCtx, 300);
    return function() { clearInterval(t); };
  }, []);

  // 스크롤 최하단 유지
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
        var folder = folders.find(function(f){ return f.id===i.folder; });
        return "[" + (folder?folder.name:"") + "] " + (i.title||"") + (i.body ? ": " + i.body.replace(/<[^>]*>/g,"").slice(0,200) : "");
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
    var newMessages = messages.concat([{ role:"user", content: userContent }]);
    setMessages(newMessages);
    setInput("");
    setLoading(true);
    try {
      var reply = await callGroq(
        newMessages.map(function(m) { return { role: m.role, content: m.content }; }),
        scope === "note" ? noteCtx : null
      );
      setMessages(newMessages.concat([{ role:"assistant", content: reply }]));
    } catch(e) {
      setMessages(newMessages.concat([{ role:"assistant", content: "❌ 오류가 발생했습니다: " + e.message }]));
    } finally { setLoading(false); }
  }

  function handleKey(e) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
  }

  function clearChat() { setMessages([]); setNoteCtx(null); setScope("current"); }

  // 빠른 질문 버튼
  var quickBtns = [
    { label:"요약", prompt:"위 내용을 핵심만 3~5줄로 요약해줘" },
    { label:"개선", prompt:"위 내용에서 보완하면 좋을 점을 알려줘" },
    { label:"번역", prompt:"위 내용을 영어로 번역해줘" },
    { label:"보고서", prompt:"위 내용을 바탕으로 보고서 형식으로 정리해줘" },
  ];

  var S = {
    wrap:   { display:"flex", flexDirection:"column", height:"100%", background:"#f8faff", overflow:"hidden" },
    header: { background:"linear-gradient(135deg,#7c3aed,#6d28d9)", padding: isPanel ? "14px 18px 12px" : "18px 24px 14px", flexShrink:0 },
    htitle: { fontSize: isPanel?16:18, fontWeight:800, color:"#fff", marginBottom:2 },
    hsub:   { fontSize:11, color:"rgba(255,255,255,.65)" },
    scopeBar: { display:"flex", gap:6, padding:"8px 12px", background:"#fff", borderBottom:"1px solid #e0eaf8", flexShrink:0, overflowX:"auto" },
    scopeBtn: { padding:"4px 12px", borderRadius:20, fontSize:11.5, fontWeight:600, cursor:"pointer", whiteSpace:"nowrap", border:"none", fontFamily:"inherit", background:"#f1f5f9", color:"#64748b" },
    scopeBtnA: { padding:"4px 12px", borderRadius:20, fontSize:11.5, fontWeight:700, cursor:"pointer", whiteSpace:"nowrap", border:"none", fontFamily:"inherit", background:"#ede9fe", color:"#7c3aed" },
    msgs:   { flex:1, overflowY:"auto", padding:"14px 14px 0" },
    bubble: { maxWidth:"85%", borderRadius:12, padding:"9px 13px", fontSize:13.5, lineHeight:1.65, marginBottom:10, whiteSpace:"pre-wrap", wordBreak:"break-word" },
    userB:  { background:"#7c3aed", color:"#fff", alignSelf:"flex-end", borderBottomRightRadius:4 },
    aiBubble: { background:"#fff", color:"#1e3a6e", alignSelf:"flex-start", borderBottomLeftRadius:4, boxShadow:"0 1px 4px rgba(15,32,68,.08)" },
    quickRow: { display:"flex", gap:5, padding:"8px 12px 4px", flexWrap:"wrap", flexShrink:0 },
    quickBtn: { padding:"4px 10px", borderRadius:20, fontSize:11.5, background:"#ede9fe", color:"#7c3aed", border:"none", cursor:"pointer", fontWeight:600, fontFamily:"inherit" },
    inputRow: { display:"flex", gap:8, padding:"10px 12px 14px", borderTop:"1px solid #e0eaf8", background:"#fff", flexShrink:0, alignItems:"flex-end" },
    ta: { flex:1, padding:"9px 12px", borderRadius:10, border:"1.5px solid #e0eaf8", fontSize:13.5, outline:"none", fontFamily:"inherit", resize:"none", lineHeight:1.5, color:"#1e3a6e", minHeight:40, maxHeight:120 },
    sendBtn: { width:38, height:38, borderRadius:10, border:"none", background:"#7c3aed", color:"#fff", fontSize:18, cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0 },
  };

  var scopeOptions = [
    { id:"current", label: currentFolder ? "📂 " + currentFolder : "📂 현재 폴더" },
    { id:"all",     label:"📋 전체 노트" },
    { id:"worklog", label:"📊 워크로그" },
  ];
  if (noteCtx) scopeOptions.unshift({ id:"note", label:"📝 " + (noteCtx.title||"이 노트") });

  return (
    <div style={S.wrap}>
      <style>{`@keyframes aiDot{0%,80%,100%{opacity:.2;transform:scale(.8)}40%{opacity:1;transform:scale(1)}}`}</style>

      <div style={S.header}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start" }}>
          <div>
            <div style={S.htitle}>🤖 AI 어시스턴트</div>
            <div style={S.hsub}>Llama 3.3 70B · 질문하거나 노트 분석을 요청해 보세요</div>
          </div>
          <div style={{ display:"flex", gap:6 }}>
            {messages.length > 0 && (
              <button onClick={clearChat}
                style={{ background:"rgba(255,255,255,.15)", border:"none", borderRadius:7, padding:"4px 10px", color:"#fff", fontSize:11, cursor:"pointer", fontFamily:"inherit" }}>
                초기화
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
      </div>

      {/* 범위 선택 */}
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

      {/* 메시지 영역 */}
      <div style={S.msgs}>
        {messages.length === 0 && (
          <div style={{ textAlign:"center", paddingTop:32, color:"#94a3b8" }}>
            <div style={{ fontSize:36, marginBottom:12 }}>🤖</div>
            <div style={{ fontSize:13.5, fontWeight:600, color:"#64748b", marginBottom:6 }}>무엇이든 물어보세요</div>
            <div style={{ fontSize:12, color:"#94a3b8", lineHeight:1.7 }}>
              노트 요약, 내용 개선, 번역, 보고서 작성 등<br/>아래 빠른 버튼을 눌러 시작해 보세요
            </div>
          </div>
        )}
        <div style={{ display:"flex", flexDirection:"column" }}>
          {messages.map(function(m, i) {
            var isUser = m.role === "user";
            var displayContent = isUser ? m.content.replace(/\n\n\[참고 데이터\][\s\S]*/,"") : m.content;
            return (
              <div key={i} style={{ display:"flex", justifyContent: isUser?"flex-end":"flex-start", marginBottom:10 }}>
                <div style={Object.assign({}, S.bubble, isUser ? S.userB : S.aiBubble)}>
                  {displayContent}
                </div>
              </div>
            );
          })}
          {loading && (
            <div style={{ display:"flex", justifyContent:"flex-start", marginBottom:10 }}>
              <div style={Object.assign({}, S.bubble, S.aiBubble, { padding:"11px 14px" })}>
                <TypingDots />
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
              onClick={function(){ setInput(b.prompt); inputRef.current?.focus(); }}>
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
          placeholder="메시지를 입력하세요... (Shift+Enter 줄바꿈)"
          rows={1}
          style={S.ta}
        />
        <button onClick={send} disabled={loading || !input.trim()} style={Object.assign({}, S.sendBtn, (!input.trim()||loading)?{opacity:.4,cursor:"default"}:{})}>
          ↑
        </button>
      </div>
    </div>
  );
}

export default AIView;

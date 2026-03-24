import { useState, useEffect } from "react";

const GCAL_BASE = "https://www.googleapis.com/calendar/v3/calendars/primary";

async function gcalFetch(token, tMin, tMax) {
  var params = new URLSearchParams({ timeMin: tMin, timeMax: tMax, maxResults: "250", singleEvents: "true", orderBy: "startTime" });
  var res = await fetch(GCAL_BASE + "/events?" + params.toString(), { headers: { Authorization: "Bearer " + token } });
  if (res.status === 401) throw new Error("TOKEN_EXPIRED");
  if (res.status === 403) throw new Error("CALENDAR_PERMISSION");
  if (!res.ok) throw new Error("gcal " + res.status);
  var data = await res.json();
  return data.items || [];
}

async function gcalCreate(token, title, date) {
  var res = await fetch(GCAL_BASE + "/events", {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify({ summary: title, start: { date: date }, end: { date: date } }),
  });
  if (res.status === 401) throw new Error("TOKEN_EXPIRED");
  if (!res.ok) throw new Error("gcal create " + res.status);
  return await res.json();
}

async function gcalPatch(token, id, summary, description) {
  var res = await fetch(GCAL_BASE + "/events/" + id, {
    method: "PATCH",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify({ summary: summary, description: description }),
  });
  if (res.status === 401) throw new Error("TOKEN_EXPIRED");
  if (!res.ok) throw new Error("gcal patch " + res.status);
  return await res.json();
}

async function gcalRemove(token, id) {
  var res = await fetch(GCAL_BASE + "/events/" + id, { method: "DELETE", headers: { Authorization: "Bearer " + token } });
  if (res.status === 401) throw new Error("TOKEN_EXPIRED");
}

function p2(n) { return String(n).padStart(2, "0"); }

function EditModal(props) {
  var ev = props.ev;
  function onSummary(e) { props.onChange({ id: ev.id, summary: e.target.value, description: ev.description || "" }); }
  function onDesc(e) { props.onChange({ id: ev.id, summary: ev.summary || "", description: e.target.value }); }
  var overlay = { position:"fixed", top:0, left:0, right:0, bottom:0, background:"rgba(15,32,68,.4)", display:"flex", alignItems:"center", justifyContent:"center", zIndex:9999 };
  var box = { background:"#fff", borderRadius:14, padding:"20px 22px", width:340, boxShadow:"0 12px 40px rgba(15,32,68,.25)" };
  var inp = { width:"100%", padding:"7px 10px", borderRadius:8, border:"1.5px solid #e0eaf8", fontSize:13, color:"#1e3a6e", outline:"none", boxSizing:"border-box", fontFamily:"inherit" };
  var ta  = { width:"100%", padding:"7px 10px", borderRadius:8, border:"1.5px solid #e0eaf8", fontSize:13, color:"#1e3a6e", outline:"none", resize:"vertical", boxSizing:"border-box", fontFamily:"inherit" };
  return (
    <div style={overlay} onClick={props.onClose}>
      <div style={box} onClick={function(e){e.stopPropagation();}}>
        <div style={{fontSize:14,fontWeight:700,color:"#1e3a6e",marginBottom:14}}>Google Calendar 이벤트 편집</div>
        <div style={{marginBottom:10}}>
          <div style={{fontSize:11,color:"#94a3b8",marginBottom:4}}>제목</div>
          <input value={ev.summary||""} onChange={onSummary} style={inp} />
        </div>
        <div style={{marginBottom:14}}>
          <div style={{fontSize:11,color:"#94a3b8",marginBottom:4}}>설명</div>
          <textarea value={ev.description||""} onChange={onDesc} rows={3} style={ta}></textarea>
        </div>
        <div style={{display:"flex",gap:8}}>
          <button style={{flex:1,padding:"9px",borderRadius:9,border:"none",background:"#2563eb",color:"#fff",fontSize:13,fontWeight:600,cursor:"pointer",fontFamily:"inherit"}} onClick={props.onSave}>저장</button>
          <button style={{flex:1,padding:"9px",borderRadius:9,border:"1px solid #e0eaf8",background:"#fff",color:"#6b7280",fontSize:13,cursor:"pointer",fontFamily:"inherit"}} onClick={props.onClose}>취소</button>
        </div>
      </div>
    </div>
  );
}

function CalendarView(props) {
  var items = props.items || [];
  var accessToken = props.accessToken;
  var now = new Date();

  var [y, setY] = useState(now.getFullYear());
  var [m, setM] = useState(now.getMonth());
  var [evts, setEvts] = useState([]);
  var [loading, setLoading] = useState(false);
  var [err, setErr] = useState("");
  var [selDay, setSelDay] = useState(null);
  var [newTitle, setNewTitle] = useState("");
  var [showNew, setShowNew] = useState(false);
  var [editing, setEditing] = useState(null);
  var [mode, setMode] = useState("month");

  var todayStr = now.getFullYear() + "." + p2(now.getMonth()+1) + "." + p2(now.getDate());
  var ymStr = y + "." + p2(m+1);
  var daysInM = new Date(y, m+1, 0).getDate();
  var firstDow = new Date(y, m, 1).getDay();

  function goBack() { if (m===0){setY(y-1);setM(11);}else setM(m-1); }
  function goFwd()  { if (m===11){setY(y+1);setM(0);}else setM(m+1); }

  useEffect(function() {
    if (!accessToken) return;
    setLoading(true); setErr("");
    var tMin = new Date(y, m, 1).toISOString();
    var tMax = new Date(y, m+1, 0, 23, 59, 59).toISOString();
    gcalFetch(accessToken, tMin, tMax)
      .then(function(r){ setEvts(r); setLoading(false); })
      .catch(function(e){
        if (e.message==="TOKEN_EXPIRED") setErr("TOKEN_EXPIRED");
        else if (e.message==="CALENDAR_PERMISSION") setErr("CALENDAR_PERMISSION");
        else setErr("ERROR");
        setLoading(false);
      });
  }, [y, m, accessToken]);

  var byDay = {};
  evts.forEach(function(ev) {
    var d = ev.start ? (ev.start.date || (ev.start.dateTime ? ev.start.dateTime.slice(0,10) : null)) : null;
    if (!d) return;
    var parts = d.split("-");
    var k = parts[0]+"."+parts[1]+"."+parts[2];
    if (!byDay[k]) byDay[k]=[];
    byDay[k].push(ev);
  });

  var dueByDay = {};
  items.forEach(function(i) {
    if (i.deletedAt || i.type!=="todo" || !i.dueDate || !i.dueDate.startsWith(ymStr)) return;
    if (!dueByDay[i.dueDate]) dueByDay[i.dueDate]=[];
    dueByDay[i.dueDate].push(i);
  });

  function doCreate() {
    if (!newTitle.trim()||!selDay||!accessToken) return;
    var pts = selDay.split(".");
    gcalCreate(accessToken, newTitle.trim(), pts[0]+"-"+pts[1]+"-"+pts[2])
      .then(function(ev){ setEvts(evts.concat([ev])); setNewTitle(""); setShowNew(false); })
      .catch(function(e){ alert("생성 실패: "+e.message); });
  }

  function doSave() {
    if (!editing||!accessToken) return;
    gcalPatch(accessToken, editing.id, editing.summary, editing.description||"")
      .then(function(u){ setEvts(evts.map(function(e){return e.id===u.id?u:e;})); setEditing(null); })
      .catch(function(e){ alert("수정 실패: "+e.message); });
  }

  function doDel(id) {
    if (!accessToken) return;
    if (!window.confirm("삭제하시겠습니까?")) return;
    gcalRemove(accessToken, id).then(function(){ setEvts(evts.filter(function(e){return e.id!==id;})); })
      .catch(function(e){ alert("삭제 실패: "+e.message); });
  }

  // 월간 그리드
  var cells = [];
  for (var fi=0; fi<firstDow; fi++) cells.push(null);
  for (var dd=1; dd<=daysInM; dd++) cells.push(dd);

  var rows = [];
  for (var ri=0; ri<Math.ceil(cells.length/7); ri++) {
    rows.push(cells.slice(ri*7, ri*7+7));
  }

  var selEvts = selDay ? (byDay[selDay]||[]) : [];
  var selDue  = selDay ? (dueByDay[selDay]||[]) : [];

  var tb = { background:"#f5f8ff", border:"1px solid #dce8fb", borderRadius:6, color:"#4b6fa8", fontSize:11.5, padding:"4px 9px", cursor:"pointer", fontFamily:"inherit", fontWeight:600 };

  return (
    <div style={{display:"flex",flexDirection:"column",height:"100%",overflow:"hidden"}}>

      <div style={{display:"flex",alignItems:"center",gap:8,padding:"10px 20px 8px",borderBottom:"1px solid #e0eaf8",flexShrink:0,flexWrap:"wrap"}}>
        <button style={tb} onClick={goBack}>&#8249;</button>
        <span style={{fontSize:16,fontWeight:700,color:"#1e3a6e",minWidth:120,textAlign:"center"}}>{y+"년 "+(m+1)+"월"}</span>
        <button style={tb} onClick={goFwd}>&#8250;</button>
        <button style={tb} onClick={function(){setY(now.getFullYear());setM(now.getMonth());}}>Today</button>
        <div style={{flex:1}}></div>
        {loading && <span style={{fontSize:11,color:"#6b8bb5"}}>로딩 중...</span>}
        {err==="CALENDAR_PERMISSION" && <span style={{fontSize:11,color:"#f59e0b",fontWeight:600}}>⚠️ Calendar 권한 없음</span>}
        {err==="TOKEN_EXPIRED" && <span style={{fontSize:11,color:"#ef4444"}}>❌ 토큰 만료</span>}
        {!accessToken && <span style={{fontSize:11,color:"#94a3b8"}}>Google 로그인 시 연동됩니다</span>}
        {accessToken&&!loading&&!err && <span style={{fontSize:11,color:"#059669"}}>{"✅ 연동됨 ("+evts.length+"개)"}</span>}
        <button style={tb} onClick={function(){setMode(mode==="month"?"list":"month");}}>
          {mode==="month" ? "📋 목록" : "📅 월간"}
        </button>
      </div>

      {err==="CALENDAR_PERMISSION" && (
        <div style={{background:"#fffbeb",border:"1px solid #fde68a",borderRadius:10,padding:"10px 16px",margin:"0 12px 8px",flexShrink:0}}>
          <div style={{fontSize:12.5,fontWeight:700,color:"#92400e",marginBottom:3}}>⚠️ Google Calendar 권한이 없습니다</div>
          <div style={{fontSize:11.5,color:"#78350f"}}>사이드바 하단 Log out 후 재로그인 → Calendar 허용</div>
        </div>
      )}

      <div style={{flex:1,display:"flex",overflow:"hidden"}}>

        {mode==="month" && (
          <div style={{flex:1,overflowY:"auto",padding:"8px 12px"}}>
            <table style={{width:"100%",borderCollapse:"collapse",tableLayout:"fixed"}}>
              <thead>
                <tr>
                  {["일","월","화","수","목","금","토"].map(function(d,i){
                    return <th key={d} style={{padding:"6px 0",fontSize:11,fontWeight:700,textAlign:"center",color:i===0?"#ef4444":i===6?"#6b7280":"#374151",borderBottom:"2px solid #e0eaf8"}}>{d}</th>;
                  })}
                </tr>
              </thead>
              <tbody>
                {rows.map(function(row, ri) {
                  return (
                    <tr key={ri}>
                      {row.map(function(day, ci) {
                        if (!day) {
                          return <td key={"e"+ri+ci} style={{border:"1px solid #e0eaf8",background:"#f8faff",height:76}}></td>;
                        }
                        var k = y+"."+p2(m+1)+"."+p2(day);
                        var isToday = k===todayStr;
                        var isSel = k===selDay;
                        var g = byDay[k]||[];
                        var due = dueByDay[k]||[];
                        var bg = isSel?"#eff6ff":isToday?"#fefce8":"#fff";
                        return (
                          <td key={k} onClick={function(kk){return function(){setSelDay(isSel?null:kk);};}(k)}
                            style={{border:"1px solid #e0eaf8",verticalAlign:"top",padding:"4px 5px",height:76,cursor:"pointer",background:bg}}>
                            <div style={{display:"flex",justifyContent:"space-between",marginBottom:2}}>
                              <span style={{fontSize:12,fontWeight:isToday?800:500,color:isToday?"#2563eb":"#374151",background:isToday?"#dbeafe":"transparent",borderRadius:"50%",width:22,height:22,display:"flex",alignItems:"center",justifyContent:"center"}}>{day}</span>
                              {g.length>0 && <span style={{fontSize:9,color:"#6b7280"}}>{"G"+g.length}</span>}
                            </div>
                            {g.slice(0,2).map(function(ev){
                              return <div key={ev.id} style={{fontSize:10,background:"#dbeafe",color:"#1d4ed8",borderRadius:3,padding:"1px 4px",marginBottom:1,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}
                                onClick={function(ev2){return function(e){e.stopPropagation();setEditing({id:ev2.id,summary:ev2.summary||"",description:ev2.description||""});};}(ev)}>{ev.summary||"(제목 없음)"}</div>;
                            })}
                            {due.slice(0,1).map(function(i){
                              return <div key={i.id} style={{fontSize:10,background:"#fef2f2",color:"#dc2626",borderRadius:3,padding:"1px 4px",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{"⏰ "+i.title}</div>;
                            })}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {mode==="list" && (
          <div style={{flex:1,overflowY:"auto",padding:"12px 20px"}}>
            {Object.keys(byDay).sort().map(function(day){
              if (!day.startsWith(ymStr)) return null;
              return (
                <div key={day} style={{marginBottom:16}}>
                  <div style={{fontSize:12,fontWeight:700,color:"#2563eb",background:"#eff6ff",borderRadius:8,padding:"3px 10px",marginBottom:6,display:"inline-block"}}>{day}</div>
                  {(byDay[day]||[]).map(function(ev){
                    return (
                      <div key={ev.id} style={{display:"flex",alignItems:"center",gap:8,background:"#fff",borderRadius:8,padding:"7px 12px",marginBottom:3,boxShadow:"0 1px 3px rgba(15,32,68,.05)",borderLeft:"3px solid #2563eb"}}>
                        <span style={{flex:1,fontSize:13,color:"#1e3a6e"}}>{ev.summary||"(제목 없음)"}</span>
                        <button style={{background:"none",border:"1px solid #e0eaf8",borderRadius:5,padding:"2px 7px",fontSize:11,cursor:"pointer"}}
                          onClick={function(ev2){return function(){setEditing({id:ev2.id,summary:ev2.summary||"",description:ev2.description||""});};}(ev)}>편집</button>
                        <button style={{background:"none",border:"1px solid #fecaca",borderRadius:5,padding:"2px 7px",fontSize:11,cursor:"pointer",color:"#ef4444"}}
                          onClick={function(eid){return function(){doDel(eid);};}(ev.id)}>삭제</button>
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        )}

        {selDay && mode==="month" && (
          <div style={{width:260,borderLeft:"1px solid #e0eaf8",display:"flex",flexDirection:"column",background:"#f8faff",overflowY:"auto",flexShrink:0}}>
            <div style={{padding:"10px 14px 6px",display:"flex",alignItems:"center",justifyContent:"space-between",borderBottom:"1px solid #e0eaf8"}}>
              <span style={{fontSize:13,fontWeight:700,color:"#1e3a6e"}}>{selDay}</span>
              {accessToken && <button style={tb} onClick={function(){setShowNew(true);}}>+ 추가</button>}
            </div>
            <div style={{flex:1,overflowY:"auto",padding:"8px 12px"}}>
              {showNew && (
                <div style={{background:"#fff",borderRadius:8,padding:"8px 10px",marginBottom:8}}>
                  <input value={newTitle} onChange={function(e){setNewTitle(e.target.value);}} placeholder="이벤트 제목..." autoFocus
                    style={{width:"100%",border:"none",borderBottom:"1px solid #e0eaf8",outline:"none",fontSize:12.5,color:"#1e3a6e",background:"transparent",marginBottom:6,padding:"2px 0",boxSizing:"border-box"}} />
                  <div style={{display:"flex",gap:4}}>
                    <button style={{background:"#2563eb",color:"#fff",border:"none",borderRadius:6,padding:"4px 10px",fontSize:11,cursor:"pointer"}} onClick={doCreate}>저장</button>
                    <button style={{background:"#f5f8ff",border:"1px solid #dce8fb",borderRadius:6,padding:"4px 10px",fontSize:11,cursor:"pointer"}} onClick={function(){setShowNew(false);setNewTitle("");}}>취소</button>
                  </div>
                </div>
              )}
              {selEvts.length>0 && <div style={{fontSize:10,fontWeight:700,color:"#94a3b8",textTransform:"uppercase",letterSpacing:"1px",marginBottom:4}}>Google Calendar</div>}
              {selEvts.map(function(ev){
                return (
                  <div key={ev.id} style={{background:"#fff",borderRadius:8,padding:"7px 10px",marginBottom:4,borderLeft:"3px solid #2563eb"}}>
                    <div style={{fontSize:12.5,color:"#1e3a6e",fontWeight:600,marginBottom:2}}>{ev.summary||"(제목 없음)"}</div>
                    {ev.description && <div style={{fontSize:11,color:"#6b8bb5"}}>{ev.description}</div>}
                    <div style={{display:"flex",gap:4,marginTop:5}}>
                      <button style={{background:"#f5f8ff",border:"1px solid #dce8fb",borderRadius:5,padding:"2px 7px",fontSize:10,cursor:"pointer"}}
                        onClick={function(ev2){return function(){setEditing({id:ev2.id,summary:ev2.summary||"",description:ev2.description||""});};}(ev)}>편집</button>
                      <button style={{background:"#fff5f5",border:"1px solid #fecaca",borderRadius:5,padding:"2px 7px",fontSize:10,cursor:"pointer",color:"#ef4444"}}
                        onClick={function(eid){return function(){doDel(eid);};}(ev.id)}>삭제</button>
                    </div>
                  </div>
                );
              })}
              {selDue.length>0 && <div style={{fontSize:10,fontWeight:700,color:"#94a3b8",textTransform:"uppercase",letterSpacing:"1px",marginBottom:4,marginTop:8}}>마감기한</div>}
              {selDue.map(function(i){
                return <div key={i.id} style={{background:"#fef2f2",borderRadius:8,padding:"6px 10px",marginBottom:3,borderLeft:"3px solid #ef4444"}}><div style={{fontSize:12,color:"#dc2626",fontWeight:600}}>{i.title||""}</div></div>;
              })}
              {selEvts.length===0&&selDue.length===0 && <div style={{fontSize:12,color:"#94a3b8",textAlign:"center",paddingTop:20}}>이 날 항목 없음</div>}
            </div>
          </div>
        )}

      </div>

      {editing && <EditModal ev={editing} onChange={setEditing} onSave={doSave} onClose={function(){setEditing(null);}} />}

    </div>
  );
}

export default CalendarView;

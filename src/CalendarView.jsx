import { useState } from "react";

function p2(n) { return String(n).padStart(2, "0"); }
function makeId() { return "ev" + Date.now() + "_" + Math.random().toString(36).slice(2, 7); }
function makeKey(y, m, d) { return y + "." + p2(m) + "." + p2(d); }

var CAT_COLORS = {
  "업무":    { bg: "#dbeafe", text: "#1d4ed8", border: "#93c5fd" },
  "개인":    { bg: "#dcfce7", text: "#166534", border: "#86efac" },
  "회의":    { bg: "#fef9c3", text: "#854d0e", border: "#fde047" },
  "기타":    { bg: "#f3e8ff", text: "#6b21a8", border: "#d8b4fe" },
};
var CATS = Object.keys(CAT_COLORS);

function EventModal(props) {
  var ev      = props.ev;
  var onSave  = props.onSave;
  var onDel   = props.onDel;
  var onClose = props.onClose;
  var isNew   = props.isNew;

  var [title, setTitle] = useState(ev.title || "");
  var [cat,   setCat]   = useState(ev.cat   || "업무");
  var [memo,  setMemo]  = useState(ev.memo  || "");
  var [date,  setDate]  = useState(ev.date  || ev.defaultDate || "");

  function handleSave() {
    if (!title.trim()) { alert("제목을 입력해 주세요."); return; }
    if (!date) { alert("날짜를 선택해 주세요."); return; }
    onSave({ id: ev.id || makeId(), title: title.trim(), cat: cat, memo: memo, date: date });
  }

  var overlay = { position:"fixed", top:0, left:0, right:0, bottom:0, background:"rgba(15,32,68,.4)", display:"flex", alignItems:"center", justifyContent:"center", zIndex:9999 };
  var box     = { background:"#fff", borderRadius:14, padding:"22px 24px", width:"min(340px,90vw)", boxShadow:"0 12px 40px rgba(15,32,68,.25)" };
  var label   = { fontSize:11, color:"#94a3b8", marginBottom:4, fontWeight:600 };
  var inp     = { width:"100%", padding:"8px 10px", borderRadius:8, border:"1.5px solid #e0eaf8", fontSize:13, color:"#1e3a6e", outline:"none", boxSizing:"border-box", fontFamily:"inherit" };
  var ta      = { width:"100%", padding:"8px 10px", borderRadius:8, border:"1.5px solid #e0eaf8", fontSize:13, color:"#1e3a6e", outline:"none", resize:"vertical", boxSizing:"border-box", fontFamily:"inherit" };

  return (
    <div style={overlay} onClick={onClose}>
      <div style={box} onClick={function(e){e.stopPropagation();}}>
        <div style={{fontSize:15,fontWeight:700,color:"#1e3a6e",marginBottom:16}}>
          {isNew ? "📅 새 일정 추가" : "📅 일정 편집"}
        </div>
        <div style={{marginBottom:12}}>
          <div style={label}>제목 *</div>
          <input value={title} onChange={function(e){setTitle(e.target.value);}} autoFocus style={inp} placeholder="일정 제목" />
        </div>
        <div style={{marginBottom:12}}>
          <div style={label}>날짜 *</div>
          <input type="date" value={date} onChange={function(e){setDate(e.target.value);}} style={inp} />
        </div>
        <div style={{marginBottom:12}}>
          <div style={label}>분류</div>
          <div style={{display:"flex", gap:6, flexWrap:"wrap"}}>
            {CATS.map(function(c) {
              var col = CAT_COLORS[c];
              var sel = cat === c;
              return (
                <button key={c} onClick={function(cc){return function(){setCat(cc);};}(c)}
                  style={{padding:"4px 12px", borderRadius:20, fontSize:12, fontWeight:600, cursor:"pointer", border:"1.5px solid " + (sel ? col.border : "#e0eaf8"), background: sel ? col.bg : "#f8faff", color: sel ? col.text : "#6b7280"}}>
                  {c}
                </button>
              );
            })}
          </div>
        </div>
        <div style={{marginBottom:18}}>
          <div style={label}>메모</div>
          <textarea value={memo} onChange={function(e){setMemo(e.target.value);}} rows={3} style={ta} placeholder="메모 (선택)"></textarea>
        </div>
        <div style={{display:"flex", gap:8}}>
          <button onClick={handleSave}
            style={{flex:1, padding:"10px", borderRadius:9, border:"none", background:"#2563eb", color:"#fff", fontSize:13, fontWeight:700, cursor:"pointer", fontFamily:"inherit"}}>저장</button>
          {!isNew && (
            <button onClick={onDel}
              style={{padding:"10px 16px", borderRadius:9, border:"1px solid #fecaca", background:"#fff5f5", color:"#ef4444", fontSize:13, fontWeight:600, cursor:"pointer", fontFamily:"inherit"}}>삭제</button>
          )}
          <button onClick={onClose}
            style={{padding:"10px 16px", borderRadius:9, border:"1px solid #e0eaf8", background:"#f8faff", color:"#6b7280", fontSize:13, cursor:"pointer", fontFamily:"inherit"}}>취소</button>
        </div>
      </div>
    </div>
  );
}

function CalendarView(props) {
  var items      = props.items      || [];
  var calEvents  = props.calEvents  || [];
  var setCalEvents = props.setCalEvents;

  var now = new Date();
  var [y, setY] = useState(now.getFullYear());
  var [m, setM] = useState(now.getMonth());
  var [modal, setModal] = useState(null);

  var todayKey  = makeKey(now.getFullYear(), now.getMonth()+1, now.getDate());
  var ymStr     = y + "." + p2(m+1);
  var daysInM   = new Date(y, m+1, 0).getDate();
  var firstDow  = new Date(y, m, 1).getDay();

  function goBack() { if (m===0){setY(y-1);setM(11);}else setM(m-1); }
  function goFwd()  { if (m===11){setY(y+1);setM(0);}else setM(m+1); }

  var evByDay = {};
  calEvents.forEach(function(ev) {
    if (!ev.date) return;
    var k = ev.date.replace(/-/g, ".");
    if (!evByDay[k]) evByDay[k] = [];
    evByDay[k].push(ev);
  });

  var dueByDay = {};
  items.forEach(function(item) {
    if (item.deletedAt || item.type !== "todo" || !item.dueDate) return;
    if (!item.dueDate.startsWith(ymStr)) return;
    if (!dueByDay[item.dueDate]) dueByDay[item.dueDate] = [];
    dueByDay[item.dueDate].push(item);
  });

  function openNew(dateKey) {
    var isoDate = dateKey ? dateKey.replace(/\./g, "-") : "";
    setModal({ ev: { defaultDate: isoDate }, isNew: true });
  }
  function openEdit(ev) { setModal({ ev: ev, isNew: false }); }

  function saveEvent(ev) {
    var n = Object.assign({}, ev, { date: ev.date.replace(/-/g, ".") });
    if (modal.isNew) {
      setCalEvents(calEvents.concat([n]));
    } else {
      setCalEvents(calEvents.map(function(e) { return e.id === n.id ? n : e; }));
    }
    setModal(null);
  }

  function delEvent(id) {
    if (!window.confirm("이 일정을 삭제하시겠습니까?")) return;
    setCalEvents(calEvents.filter(function(e) { return e.id !== id; }));
    setModal(null);
  }

  var cells = [];
  var fi;
  for (fi = 0; fi < firstDow; fi++) cells.push(null);
  for (var dd = 1; dd <= daysInM; dd++) cells.push(dd);
  var rows = [];
  for (var ri = 0; ri < Math.ceil(cells.length/7); ri++) {
    rows.push(cells.slice(ri*7, ri*7+7));
  }

  var monthEvts = calEvents.filter(function(ev) {
    return ev.date && ev.date.replace(/-/g, ".").startsWith(ymStr);
  }).sort(function(a, b) { return a.date.localeCompare(b.date); });

  var tb     = { background:"#f5f8ff", border:"1px solid #dce8fb", borderRadius:6, color:"#4b6fa8", fontSize:11.5, padding:"5px 11px", cursor:"pointer", fontFamily:"inherit", fontWeight:600 };
  var tbBlue = { background:"#2563eb", border:"none", color:"#fff", fontSize:11.5, padding:"5px 11px", borderRadius:6, cursor:"pointer", fontFamily:"inherit", fontWeight:700, boxShadow:"0 2px 8px rgba(37,99,235,.3)" };

  return (
    <div style={{display:"flex",flexDirection:"column",height:"100%",overflow:"hidden"}}>

      <div style={{display:"flex",alignItems:"center",gap:8,padding:"10px 20px",borderBottom:"1px solid #e0eaf8",flexShrink:0,flexWrap:"wrap"}}>
        <button style={tb} onClick={goBack}>&#8249;</button>
        <span style={{fontSize:16,fontWeight:700,color:"#1e3a6e",minWidth:110,textAlign:"center"}}>{y+"년 "+(m+1)+"월"}</span>
        <button style={tb} onClick={goFwd}>&#8250;</button>
        <button style={tb} onClick={function(){setY(now.getFullYear());setM(now.getMonth());}}>Today</button>
        <span style={{fontSize:11,color:"#94a3b8"}}>{monthEvts.length+"개"}</span>
        <div style={{flex:1}}></div>
        <button style={tbBlue} onClick={function(){ openNew(todayKey); }}>+ 일정 추가</button>
      </div>

      <div style={{flex:1,display:"flex",overflow:"hidden"}}>

        <div style={{flex:1,overflowY:"auto",padding:"8px 10px"}}>
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
                        return <td key={"e"+ri+"-"+ci} style={{border:"1px solid #e0eaf8",background:"#f8faff",height:80}}></td>;
                      }
                      var k = makeKey(y, m+1, day);
                      var isToday = k === todayKey;
                      var dow = (firstDow + day - 1) % 7;
                      var isSun = dow === 0;
                      var isSat = dow === 6;
                      var dayEvts  = evByDay[k] || [];
                      var dueTodos = dueByDay[k] || [];
                      return (
                        <td key={k}
                          onClick={function(kk){return function(){openNew(kk);};}(k)}
                          onMouseEnter={function(e){e.currentTarget.style.background="#f0f5ff";}}
                          onMouseLeave={function(e){e.currentTarget.style.background="#fff";}}
                          style={{border:"1px solid #e0eaf8",verticalAlign:"top",padding:"3px 4px",height:80,cursor:"pointer",background:"#fff"}}>
                          <div style={{marginBottom:2}}>
                            <span style={{fontSize:12,fontWeight:isToday?800:400,color:isToday?"#fff":isSun?"#ef4444":isSat?"#6b7280":"#374151",background:isToday?"#2563eb":"transparent",borderRadius:"50%",width:22,height:22,display:"inline-flex",alignItems:"center",justifyContent:"center"}}>
                              {day}
                            </span>
                          </div>
                          {dayEvts.slice(0,2).map(function(ev){
                            var col = CAT_COLORS[ev.cat] || CAT_COLORS["기타"];
                            return (
                              <div key={ev.id}
                                onClick={function(ev2){return function(e){e.stopPropagation();openEdit(ev2);};}(ev)}
                                style={{fontSize:10,background:col.bg,color:col.text,borderRadius:3,padding:"1px 5px",marginBottom:1,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",cursor:"pointer",fontWeight:500}}>
                                {ev.title}
                              </div>
                            );
                          })}
                          {dayEvts.length > 2 && <div style={{fontSize:9,color:"#94a3b8"}}>{"+" + (dayEvts.length-2) + "개"}</div>}
                          {dueTodos.slice(0,1).map(function(i){
                            return <div key={i.id} style={{fontSize:10,background:"#fef2f2",color:"#dc2626",borderRadius:3,padding:"1px 5px",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{"⏰ " + (i.title||"")}</div>;
                          })}
                        </td>
                      );
                    })}
                    {row.length < 7 && Array.from({length: 7-row.length}).map(function(_,i){
                      return <td key={"t"+i} style={{border:"1px solid #e0eaf8",background:"#f8faff"}}></td>;
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {monthEvts.length > 0 && (
          <div style={{width:220,borderLeft:"1px solid #e0eaf8",overflowY:"auto",padding:"10px 12px",background:"#f8faff",flexShrink:0}}>
            <div style={{fontSize:11,fontWeight:700,color:"#94a3b8",textTransform:"uppercase",letterSpacing:"1px",marginBottom:8}}>
              {(m+1) + "월 " + monthEvts.length + "개"}
            </div>
            {monthEvts.map(function(ev) {
              var col = CAT_COLORS[ev.cat] || CAT_COLORS["기타"];
              var ds = ev.date.replace(/\./g,"/").replace(/-/g,"/").slice(5);
              return (
                <div key={ev.id}
                  onClick={function(ev2){return function(){openEdit(ev2);};}(ev)}
                  style={{background:"#fff",borderRadius:9,padding:"8px 10px",marginBottom:5,borderLeft:"3px solid "+col.border,cursor:"pointer",boxShadow:"0 1px 3px rgba(15,32,68,.05)"}}>
                  <div style={{display:"flex",alignItems:"center",gap:5,marginBottom:3}}>
                    <span style={{fontSize:10,background:col.bg,color:col.text,borderRadius:10,padding:"1px 7px",fontWeight:700,flexShrink:0}}>{ev.cat}</span>
                    <span style={{fontSize:10,color:"#94a3b8"}}>{ds}</span>
                  </div>
                  <div style={{fontSize:12.5,color:"#1e3a6e",fontWeight:600,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{ev.title}</div>
                  {ev.memo && <div style={{fontSize:11,color:"#6b8bb5",marginTop:2,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{ev.memo}</div>}
                </div>
              );
            })}
          </div>
        )}

      </div>

      {modal && (
        <EventModal
          ev={modal.ev}
          isNew={modal.isNew}
          onSave={saveEvent}
          onDel={function(){ delEvent(modal.ev.id); }}
          onClose={function(){ setModal(null); }}
        />
      )}

    </div>
  );
}

export default CalendarView;

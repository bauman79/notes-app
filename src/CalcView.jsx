import { useState } from "react";

// ── 공통 스타일 ────────────────────────────────────────────
var PW = "3691215";

var S = {
  wrap:    { display:"flex", flexDirection:"column", height:"100%", overflow:"hidden", background:"#f8faff" },
  header:  { background:"linear-gradient(135deg,#2563eb,#1650b8)", padding:"18px 24px 14px", flexShrink:0 },
  htitle:  { fontSize:20, fontWeight:800, color:"#fff", marginBottom:4 },
  hsub:    { fontSize:12, color:"rgba(255,255,255,.65)" },
  tabs:    { display:"flex", gap:4, padding:"10px 14px 0", background:"#fff", borderBottom:"2px solid #e0eaf8", flexShrink:0, overflowX:"auto", flexWrap:"nowrap" },
  tab:     { padding:"7px 14px", borderRadius:"8px 8px 0 0", fontSize:12.5, fontWeight:600, cursor:"pointer", whiteSpace:"nowrap", border:"none", fontFamily:"inherit", background:"transparent", color:"#94a3b8" },
  tabA:    { padding:"7px 14px", borderRadius:"8px 8px 0 0", fontSize:12.5, fontWeight:700, cursor:"pointer", whiteSpace:"nowrap", border:"none", fontFamily:"inherit", background:"#eff6ff", color:"#2563eb", borderBottom:"2px solid #2563eb" },
  body:    { flex:1, overflowY:"auto", padding:"20px 20px 40px" },
  card:    { background:"#fff", borderRadius:12, padding:"18px 20px", marginBottom:16, boxShadow:"0 1px 6px rgba(15,32,68,.07)" },
  ctitle:  { fontSize:14, fontWeight:700, color:"#1e3a6e", marginBottom:14, paddingBottom:8, borderBottom:"1px solid #e0eaf8" },
  row:     { display:"flex", gap:12, marginBottom:12, flexWrap:"wrap" },
  fgrp:    { display:"flex", flexDirection:"column", gap:4, flex:1, minWidth:140 },
  label:   { fontSize:11, fontWeight:600, color:"#6b8bb5" },
  inp:     { padding:"8px 10px", borderRadius:8, border:"1.5px solid #e0eaf8", fontSize:13, color:"#1e3a6e", outline:"none", fontFamily:"inherit", width:"100%", boxSizing:"border-box" },
  sel:     { padding:"8px 10px", borderRadius:8, border:"1.5px solid #e0eaf8", fontSize:13, color:"#1e3a6e", outline:"none", fontFamily:"inherit", width:"100%", boxSizing:"border-box", background:"#fff" },
  result:  { background:"linear-gradient(135deg,#eff6ff,#e0f2fe)", borderRadius:10, padding:"14px 18px", marginTop:12 },
  rrow:    { display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:6 },
  rlabel:  { fontSize:12, color:"#4b6fa8", fontWeight:500 },
  rval:    { fontSize:14, fontWeight:700, color:"#1e3a6e" },
  rvalBig: { fontSize:18, fontWeight:800, color:"#2563eb" },
  note:    { fontSize:11, color:"#94a3b8", marginTop:10, lineHeight:1.6, padding:"8px 12px", background:"#f8faff", borderRadius:8 },
  divider: { height:1, background:"#e0eaf8", margin:"10px 0" },
};

function Inp(props) {
  return (
    <div style={S.fgrp}>
      <label style={S.label}>{props.label}</label>
      <input type="number" value={props.value} min={props.min||0}
        onChange={function(e){ props.onChange(e.target.value); }}
        style={S.inp} placeholder={props.ph||""} />
    </div>
  );
}

function Sel(props) {
  return (
    <div style={S.fgrp}>
      <label style={S.label}>{props.label}</label>
      <select value={props.value} onChange={function(e){ props.onChange(e.target.value); }} style={S.sel}>
        {props.options.map(function(o) {
          return <option key={o.v} value={o.v}>{o.l}</option>;
        })}
      </select>
    </div>
  );
}

function RRow(props) {
  return (
    <div style={S.rrow}>
      <span style={S.rlabel}>{props.label}</span>
      <span style={props.big ? S.rvalBig : S.rval}>{props.value}</span>
    </div>
  );
}

function fmt(n, digits) {
  if (n === null || n === undefined || isNaN(n)) return "-";
  return n.toFixed(digits||0).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

// ── 1. 주차장 램프 산정 ──────────────────────────────────────
function CalcRamp() {
  // 램프 길이 산정
  var [r1s, setR1s] = useState(""); // 직선램프 단면높이
  var [r1c, setR1c] = useState(""); // 곡선램프 단면높이
  var [r1sg, setR1sg] = useState("17"); // 직선 구배 %
  var [r1cg, setR1cg] = useState("12"); // 곡선 구배 %

  // 램프 높이 산정
  var [r2s, setR2s] = useState(""); // 직선 구간합
  var [r2c, setR2c] = useState(""); // 곡선 구간합
  var [r2sg, setR2sg] = useState("17");
  var [r2cg, setR2cg] = useState("12");

  var r1sv = parseFloat(r1s), r1cv = parseFloat(r1c);
  var r1sgv = parseFloat(r1sg)/100, r1cgv = parseFloat(r1cg)/100;
  var len1total = Math.floor(r1sv + r1cv);
  var len1s = isNaN(r1sv/r1sgv) ? null : Math.floor(r1sv/r1sgv);
  var len1c = isNaN(r1cv/r1cgv) ? null : Math.floor(r1cv/r1cgv);
  var len1sum = (len1s||0) + (len1c||0);

  var r2sv = parseFloat(r2s), r2cv = parseFloat(r2c);
  var r2sgv = parseFloat(r2sg)/100, r2cgv = parseFloat(r2cg)/100;
  var ht2total = Math.floor(r2sv + r2cv);
  var ht2s = isNaN(r2sv*r2sgv) ? null : Math.floor(r2sv*r2sgv);
  var ht2c = isNaN(r2cv*r2cgv) ? null : Math.floor(r2cv*r2cgv);
  var ht2sum = (ht2s||0) + (ht2c||0);

  return (
    <div>
      <div style={S.card}>
        <div style={S.ctitle}>① 램프 길이 산정 (단면높이 → 필요 램프 길이)</div>
        <div style={S.row}>
          <Inp label="직선램프 단면높이 (mm)" value={r1s} onChange={setR1s} ph="예: 3000" />
          <Inp label="곡선램프 단면높이 (mm)" value={r1c} onChange={setR1c} ph="예: 2800" />
        </div>
        <div style={S.row}>
          <Inp label="직선 구배 (%)" value={r1sg} onChange={setR1sg} ph="17" />
          <Inp label="곡선 구배 (%)" value={r1cg} onChange={setR1cg} ph="12" />
        </div>
        <div style={S.result}>
          <RRow label="단면높이 합계" value={fmt(len1total) + " mm"} />
          <div style={S.divider} />
          <RRow label="직선램프 필요 길이" value={fmt(len1s) + " mm"} />
          <RRow label="곡선램프 필요 길이" value={fmt(len1c) + " mm"} />
          <RRow label="합계 필요 길이" value={fmt(len1sum) + " mm"} big />
        </div>
      </div>

      <div style={S.card}>
        <div style={S.ctitle}>② 램프 높이 산정 (램프 길이 → 획득 단면높이)</div>
        <div style={S.row}>
          <Inp label="직선구간 합 (mm)" value={r2s} onChange={setR2s} ph="예: 20000" />
          <Inp label="곡선구간 합 (mm)" value={r2c} onChange={setR2c} ph="예: 15000" />
        </div>
        <div style={S.row}>
          <Inp label="직선 구배 (%)" value={r2sg} onChange={setR2sg} ph="17" />
          <Inp label="곡선 구배 (%)" value={r2cg} onChange={setR2cg} ph="12" />
        </div>
        <div style={S.result}>
          <RRow label="램프 길이 합계" value={fmt(ht2total) + " mm"} />
          <div style={S.divider} />
          <RRow label="직선구간 획득 높이" value={fmt(ht2s) + " mm"} />
          <RRow label="곡선구간 획득 높이" value={fmt(ht2c) + " mm"} />
          <RRow label="합계 획득 단면높이" value={fmt(ht2sum) + " mm"} big />
        </div>
        <div style={S.note}>
          ※ 직선램프 최대구배 17%, 곡선램프 최대구배 12% (주차장법 시행규칙 제6조)<br/>
          ※ 지자체마다 기준이 상이할 수 있으므로 참고용으로만 활용하세요.
        </div>
      </div>
    </div>
  );
}

// ── 2. 주차대수 산정 ─────────────────────────────────────────
function CalcParking() {
  var [useType, setUseType] = useState("apt");
  var [area, setArea] = useState("");
  var [units, setUnits] = useState("");
  var [region, setRegion] = useState("metro");

  var areaV = parseFloat(area);
  var unitsV = parseFloat(units);

  // 주차장법 시행규칙 별표 1 기준 (단위: 대/㎡ or 대/세대)
  var calcResult = null;
  var basis = "";

  if (useType === "apt") {
    // 공동주택: 세대당 주차대수 (수도권/광역시 기준)
    var rateMap = { metro:"1.0", city:"0.8", other:"0.7" };
    var rate = parseFloat(rateMap[region]);
    if (!isNaN(unitsV)) {
      calcResult = Math.ceil(unitsV * rate);
      basis = "세대당 " + rateMap[region] + "대 (공동주택, " + (region==="metro"?"수도권·광역시":region==="city"?"지방도시":"기타") + ")";
    }
  } else if (useType === "office") {
    if (!isNaN(areaV)) {
      calcResult = Math.ceil(areaV / 150);
      basis = "바닥면적 150㎡당 1대 (업무시설)";
    }
  } else if (useType === "retail") {
    if (!isNaN(areaV)) {
      calcResult = Math.ceil(areaV / 134);
      basis = "바닥면적 134㎡당 1대 (판매시설, 수도권)";
    }
  } else if (useType === "hotel") {
    if (!isNaN(areaV)) {
      calcResult = Math.ceil(areaV / 200);
      basis = "바닥면적 200㎡당 1대 (숙박시설)";
    }
  } else if (useType === "medical") {
    if (!isNaN(areaV)) {
      calcResult = Math.ceil(areaV / 100);
      basis = "바닥면적 100㎡당 1대 (의료시설)";
    }
  } else if (useType === "edu") {
    if (!isNaN(areaV)) {
      calcResult = Math.ceil(areaV / 200);
      basis = "바닥면적 200㎡당 1대 (교육연구시설)";
    }
  } else if (useType === "restaurant") {
    if (!isNaN(areaV)) {
      calcResult = Math.ceil(areaV / 134);
      basis = "바닥면적 134㎡당 1대 (음식점, 수도권)";
    }
  }

  var useTypes = [
    { v:"apt",        l:"공동주택 (아파트·연립)" },
    { v:"office",     l:"업무시설 (오피스)" },
    { v:"retail",     l:"판매시설 (쇼핑몰·마트)" },
    { v:"hotel",      l:"숙박시설 (호텔·모텔)" },
    { v:"medical",    l:"의료시설 (병원)" },
    { v:"edu",        l:"교육연구시설" },
    { v:"restaurant", l:"근린생활시설 (음식점 등)" },
  ];

  return (
    <div style={S.card}>
      <div style={S.ctitle}>주차대수 산정 (주차장법 시행규칙 별표 1)</div>
      <div style={S.row}>
        <Sel label="용도" value={useType} onChange={setUseType} options={useTypes} />
        {useType === "apt" && (
          <Sel label="지역" value={region} onChange={setRegion} options={[
            { v:"metro", l:"수도권·광역시" },
            { v:"city",  l:"지방도시" },
            { v:"other", l:"기타" },
          ]} />
        )}
      </div>
      {useType === "apt" ? (
        <div style={S.row}>
          <Inp label="세대수 (세대)" value={units} onChange={setUnits} ph="예: 100" />
        </div>
      ) : (
        <div style={S.row}>
          <Inp label="연면적 (㎡)" value={area} onChange={setArea} ph="예: 3000" />
        </div>
      )}
      {calcResult !== null && (
        <div style={S.result}>
          <RRow label="산정 기준" value={basis} />
          <div style={S.divider} />
          <RRow label="법정 최소 주차대수" value={fmt(calcResult) + " 대"} big />
        </div>
      )}
      <div style={S.note}>
        ※ 주차장법 시행규칙 별표 1 기준 (시·군·구 조례에 따라 강화 가능)<br/>
        ※ 실제 적용 시 해당 지자체 주차장 조례를 반드시 확인하세요.
      </div>
    </div>
  );
}

// ── 3. 피난안전구역 산정 ─────────────────────────────────────
function CalcRefuge() {
  var [floors, setFloors] = useState("");
  var [occupants, setOccupants] = useState("");

  var floorsV = parseFloat(floors);
  var occupantsV = parseFloat(occupants);

  // 건축법 시행령 제34조의2: 30층 이상이거나 높이 120m 초과 시 설치
  // 피난안전구역 면적: 피난층 외의 층의 바닥면적 합계 × 1/100 이상
  // 실제로는 재실자 1인당 0.28㎡ 이상
  var requiredByOcc = null;
  var interval = null;

  if (!isNaN(floorsV) && floorsV >= 30) {
    interval = Math.floor(floorsV / 2); // 대략 중간층
  }

  if (!isNaN(occupantsV)) {
    requiredByOcc = Math.ceil(occupantsV * 0.28);
  }

  var needsRefuge = !isNaN(floorsV) && floorsV >= 30;

  return (
    <div style={S.card}>
      <div style={S.ctitle}>피난안전구역 규모 산정 (건축법 시행령 제34조의2)</div>
      <div style={S.row}>
        <Inp label="건물 층수" value={floors} onChange={setFloors} ph="예: 50" />
        <Inp label="피난층 제외 최대 재실자수 (명)" value={occupants} onChange={setOccupants} ph="예: 500" />
      </div>

      <div style={S.result}>
        <RRow label="설치 의무 여부"
          value={isNaN(floorsV) ? "-" : needsRefuge ? "✅ 설치 의무 (30층 이상)" : "❌ 설치 불필요 (" + floorsV + "층)"} />
        {needsRefuge && (
          <>
            <div style={S.divider} />
            <RRow label="설치 위치 (권장)" value={interval ? "약 " + interval + "층 (중간층 기준)" : "-"} />
            {requiredByOcc !== null && (
              <RRow label="필요 면적 (재실자 × 0.28㎡)" value={fmt(requiredByOcc) + " ㎡ 이상"} big />
            )}
          </>
        )}
      </div>
      <div style={S.note}>
        ※ 건축법 시행령 제34조의2: 층수 30층 이상 또는 높이 120m 초과 건축물<br/>
        ※ 피난안전구역 면적: 1인당 0.28㎡ 이상 (재실자 수 기준)<br/>
        ※ 설치 층: 지상층 기준 30층마다 1개소 (피난층, 최상층 제외)<br/>
        ※ 실제 설계 시 관할 인허가청 및 소방관서와 협의 필요
      </div>
    </div>
  );
}

// ── 4. 교통영향평가 대상 판정 ────────────────────────────────
function CalcTraffic() {
  var [useType, setUseType] = useState("apt");
  var [area, setArea] = useState("");
  var [units, setUnits] = useState("");

  var areaV = parseFloat(area);
  var unitsV = parseFloat(units);

  // 도시교통정비 촉진법 시행령 별표 1
  var thresholds = {
    apt:       { areaMin: null, unitsMin: 100,  label: "공동주택",                 basis: "100세대 이상" },
    office:    { areaMin: 5000, unitsMin: null, label: "업무시설",                 basis: "연면적 5,000㎡ 이상" },
    retail:    { areaMin: 3000, unitsMin: null, label: "판매시설",                 basis: "연면적 3,000㎡ 이상" },
    hotel:     { areaMin: 5000, unitsMin: null, label: "숙박시설",                 basis: "연면적 5,000㎡ 이상" },
    medical:   { areaMin: 5000, unitsMin: null, label: "의료시설",                 basis: "연면적 5,000㎡ 이상" },
    industry:  { areaMin: 10000, unitsMin: null, label: "공장·창고",              basis: "연면적 10,000㎡ 이상" },
    education: { areaMin: 5000, unitsMin: null, label: "교육연구시설",             basis: "연면적 5,000㎡ 이상" },
    culture:   { areaMin: 5000, unitsMin: null, label: "문화·집회·종교시설",      basis: "연면적 5,000㎡ 이상" },
  };

  var t = thresholds[useType];
  var subject = null;
  var margin = null;

  if (t.unitsMin !== null && !isNaN(unitsV)) {
    subject = unitsV >= t.unitsMin;
    margin = unitsV - t.unitsMin;
  } else if (t.areaMin !== null && !isNaN(areaV)) {
    subject = areaV >= t.areaMin;
    margin = areaV - t.areaMin;
  }

  var useTypes = [
    { v:"apt",       l:"공동주택" },
    { v:"office",    l:"업무시설" },
    { v:"retail",    l:"판매시설" },
    { v:"hotel",     l:"숙박시설" },
    { v:"medical",   l:"의료시설" },
    { v:"industry",  l:"공장·창고" },
    { v:"education", l:"교육연구시설" },
    { v:"culture",   l:"문화·집회·종교" },
  ];

  return (
    <div style={S.card}>
      <div style={S.ctitle}>교통영향평가 대상사업 판정 (도시교통정비 촉진법 시행령 별표 1)</div>
      <div style={S.row}>
        <Sel label="용도" value={useType} onChange={setUseType} options={useTypes} />
      </div>
      {t.unitsMin !== null ? (
        <div style={S.row}>
          <Inp label="세대수 (세대)" value={units} onChange={setUnits} ph={"기준: " + t.unitsMin + "세대"} />
        </div>
      ) : (
        <div style={S.row}>
          <Inp label="연면적 (㎡)" value={area} onChange={setArea} ph={"기준: " + t.areaMin.toLocaleString() + "㎡"} />
        </div>
      )}

      {subject !== null && (
        <div style={S.result}>
          <RRow label="기준" value={t.label + " — " + t.basis} />
          <div style={S.divider} />
          <RRow label="판정"
            value={subject ? "✅ 교통영향평가 대상" : "❌ 대상 아님"} big />
          {margin !== null && (
            <RRow label={subject ? "기준 초과" : "기준까지 부족"}
              value={Math.abs(margin).toLocaleString() + (t.unitsMin ? " 세대" : " ㎡")} />
          )}
        </div>
      )}
      <div style={S.note}>
        ※ 도시교통정비 촉진법 시행령 별표 1 기준<br/>
        ※ 특별시·광역시·시·군 조례에 따라 강화 적용 가능<br/>
        ※ 동일 대지 내 복합용도는 각 용도별 합산 여부 확인 필요
      </div>
    </div>
  );
}

// ── 5. 승강기 대수 산정 ──────────────────────────────────────
function CalcElevator() {
  var [floors, setFloors] = useState("");
  var [units, setUnits] = useState("");
  var [area, setArea] = useState("");
  var [useType, setUseType] = useState("apt");

  var floorsV = parseFloat(floors);
  var unitsV = parseFloat(units);
  var areaV = parseFloat(area);

  var result = null;
  var basis = "";
  var required = false;

  // 건축법 시행령 제89조 (6층 이상, 연면적 2000㎡ 이상 시 설치 의무)
  // 승강기 대수: 건축법 시행규칙 제5조의2
  if (useType === "apt") {
    // 공동주택: 100세대마다 1대 + 15층 초과시 추가
    if (!isNaN(unitsV) && !isNaN(floorsV)) {
      required = floorsV >= 6;
      var base = Math.ceil(unitsV / 100);
      var extra = floorsV > 15 ? Math.ceil(unitsV / 200) : 0;
      result = base + extra;
      basis = "100세대당 1대" + (floorsV > 15 ? " + 15층 초과 200세대당 1대 추가" : "");
    }
  } else {
    // 업무·판매 등: 연면적 3000㎡마다 1대
    if (!isNaN(areaV) && !isNaN(floorsV)) {
      required = floorsV >= 6 && areaV >= 2000;
      result = Math.max(1, Math.ceil(areaV / 3000));
      basis = "연면적 3,000㎡당 1대 (최소 1대)";
    }
  }

  var useTypes = [
    { v:"apt",    l:"공동주택" },
    { v:"office", l:"업무·판매·숙박·의료" },
  ];

  return (
    <div style={S.card}>
      <div style={S.ctitle}>승강기 설치기준 및 대수 산정 (건축법 시행령 제89~90조)</div>
      <div style={S.row}>
        <Sel label="용도" value={useType} onChange={setUseType} options={useTypes} />
        <Inp label="건물 층수" value={floors} onChange={setFloors} ph="예: 20" />
      </div>
      {useType === "apt" ? (
        <div style={S.row}>
          <Inp label="세대수 (세대)" value={units} onChange={setUnits} ph="예: 200" />
        </div>
      ) : (
        <div style={S.row}>
          <Inp label="연면적 (㎡)" value={area} onChange={setArea} ph="예: 6000" />
        </div>
      )}

      {result !== null && (
        <div style={S.result}>
          <RRow label="설치 의무"
            value={isNaN(floorsV) ? "-" : (floorsV >= 6 ? "✅ 설치 의무 (6층 이상)" : "❌ 설치 불필요 (" + floorsV + "층)")} />
          <div style={S.divider} />
          <RRow label="산정 기준" value={basis} />
          <RRow label="최소 설치 대수" value={fmt(result) + " 대"} big />
        </div>
      )}
      <div style={S.note}>
        ※ 건축법 시행령 제89조: 6층 이상 or 연면적 2,000㎡ 이상 시 의무 설치<br/>
        ※ 비상용 승강기: 높이 31m 초과 시 별도 설치 (건축법 제64조)<br/>
        ※ 공동주택 비상용 승강기는 승객용 겸용 가능
      </div>
    </div>
  );
}

// ── 6. 주민공동시설 총량제 ───────────────────────────────────
function CalcCommonFacility() {
  var [units, setUnits] = useState("");
  var [region, setRegion] = useState("metro");

  var unitsV = parseFloat(units);

  // 주택법 시행규칙 제7조 별표 1 기준
  // 수도권: 세대당 2.5㎡, 지방: 세대당 2.0㎡ (500세대 미만 기준)
  var rateMap = {
    metro: { base: 2.5, label: "수도권·광역시" },
    other: { base: 2.0, label: "기타 지방" },
  };

  var r = rateMap[region];
  var totalArea = null;
  var breakdown = null;

  if (!isNaN(unitsV) && unitsV > 0) {
    totalArea = Math.ceil(unitsV * r.base);

    // 시설별 배분 (권장 비율)
    breakdown = [
      { name: "경로당",            ratio: 0.20, minArea: 50  },
      { name: "어린이놀이터",       ratio: 0.20, minArea: 100 },
      { name: "어린이집",           ratio: 0.25, minArea: 0   },
      { name: "주민운동시설",       ratio: 0.15, minArea: 0   },
      { name: "작은도서관",        ratio: 0.10, minArea: 0   },
      { name: "기타 공동시설",     ratio: 0.10, minArea: 0   },
    ].map(function(f) {
      return Object.assign({}, f, {
        area: Math.ceil(totalArea * f.ratio),
      });
    });
  }

  return (
    <div style={S.card}>
      <div style={S.ctitle}>주민공동시설 총량제 산정 (주택법 시행규칙 별표 1)</div>
      <div style={S.row}>
        <Inp label="세대수 (세대)" value={units} onChange={setUnits} ph="예: 300" />
        <Sel label="지역" value={region} onChange={setRegion} options={[
          { v:"metro", l:"수도권·광역시" },
          { v:"other", l:"기타 지방" },
        ]} />
      </div>

      {totalArea !== null && (
        <div style={S.result}>
          <RRow label={"세대당 기준 (" + r.label + ")"} value={r.base + " ㎡/세대"} />
          <RRow label="의무 설치 최소 총면적" value={fmt(totalArea) + " ㎡"} big />
          {breakdown && (
            <>
              <div style={S.divider} />
              <div style={{ fontSize:11, color:"#4b6fa8", fontWeight:700, marginBottom:6 }}>시설별 권장 배분 (참고)</div>
              {breakdown.map(function(f) {
                return (
                  <div key={f.name} style={{ display:"flex", justifyContent:"space-between", fontSize:12.5, color:"#374151", marginBottom:4 }}>
                    <span>{f.name} ({(f.ratio*100).toFixed(0)}%)</span>
                    <span style={{ fontWeight:600 }}>{fmt(f.area)} ㎡{f.minArea > 0 ? " (최소 " + f.minArea + "㎡)" : ""}</span>
                  </div>
                );
              })}
            </>
          )}
        </div>
      )}
      <div style={S.note}>
        ※ 주택법 시행규칙 별표 1: 500세대 이상 의무 설치<br/>
        ※ 세대수·지역·규모에 따라 필수 설치 시설 종류 상이<br/>
        ※ 시설별 배분 비율은 권장 기준이며 사업계획 승인 시 조정 가능<br/>
        ※ 지자체 조례에 따라 추가 기준 적용 가능
      </div>
    </div>
  );
}

// ── 비밀번호 모달 ─────────────────────────────────────────────
function PwModal(props) {
  var [pw, setPw] = useState("");
  var [err, setErr] = useState(false);

  function check() {
    if (pw === PW) {
      props.onUnlock();
    } else {
      setErr(true);
      setPw("");
    }
  }

  var overlay = {
    display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center",
    height:"100%", background:"linear-gradient(135deg,#f0f4ff,#e8f0fe)", padding:24,
  };
  var box = {
    background:"#fff", borderRadius:16, padding:"32px 28px", width:"min(340px,90vw)",
    boxShadow:"0 8px 32px rgba(15,32,68,.12)", textAlign:"center",
  };

  return (
    <div style={overlay}>
      <div style={box}>
        <div style={{ fontSize:40, marginBottom:12 }}>🏗</div>
        <div style={{ fontSize:18, fontWeight:800, color:"#1e3a6e", marginBottom:6 }}>건축계산기</div>
        <div style={{ fontSize:12.5, color:"#6b8bb5", marginBottom:24, lineHeight:1.6 }}>
          이 기능은 접근 코드가 필요합니다.<br/>코드를 입력하세요.
        </div>
        <input
          type="password"
          value={pw}
          onChange={function(e){ setPw(e.target.value); setErr(false); }}
          onKeyDown={function(e){ if (e.key==="Enter") check(); }}
          placeholder="접근 코드 입력"
          autoFocus
          style={{ width:"100%", padding:"11px 14px", borderRadius:10, border:"1.5px solid " + (err?"#fca5a5":"#e0eaf8"), fontSize:16, outline:"none", textAlign:"center", letterSpacing:4, boxSizing:"border-box", marginBottom:8, fontFamily:"inherit", color:"#1e3a6e" }}
        />
        {err && (
          <div style={{ fontSize:12, color:"#ef4444", marginBottom:10, fontWeight:600 }}>
            🔒 현재 비공개 된 기능입니다.
          </div>
        )}
        <button onClick={check}
          style={{ width:"100%", padding:"11px", borderRadius:10, border:"none", background:"#2563eb", color:"#fff", fontSize:14, fontWeight:700, cursor:"pointer", fontFamily:"inherit", marginTop:4 }}>
          확인
        </button>
      </div>
    </div>
  );
}

// ── 메인 CalcView ─────────────────────────────────────────────
var TABS = [
  { id:"ramp",     label:"🚗 주차장 램프",   comp: CalcRamp           },
  { id:"parking",  label:"🅿️ 주차대수",       comp: CalcParking        },
  { id:"refuge",   label:"🚨 피난안전구역",   comp: CalcRefuge         },
  { id:"traffic",  label:"🚦 교통영향평가",   comp: CalcTraffic        },
  { id:"elevator", label:"🛗 승강기",         comp: CalcElevator       },
  { id:"facility", label:"🏘 주민공동시설",   comp: CalcCommonFacility },
];

function CalcView(props) {
  var calcUnlocked = props.calcUnlocked;
  var setCalcUnlocked = props.setCalcUnlocked;
  var [activeTab, setActiveTab] = useState("ramp");

  if (!calcUnlocked) {
    return <PwModal onUnlock={function(){ setCalcUnlocked(true); }} />;
  }

  var ActiveComp = TABS.find(function(t){ return t.id === activeTab; }).comp;

  return (
    <div style={S.wrap}>
      <div style={S.header}>
        <div style={S.htitle}>🏗 건축계산기</div>
        <div style={S.hsub}>주차장·교통·피난·설비 관련 건축법규 계산기</div>
      </div>
      <div style={S.tabs}>
        {TABS.map(function(t) {
          return (
            <button key={t.id}
              onClick={function(){ setActiveTab(t.id); }}
              style={activeTab === t.id ? S.tabA : S.tab}>
              {t.label}
            </button>
          );
        })}
      </div>
      <div style={S.body}>
        <ActiveComp />
      </div>
    </div>
  );
}

export default CalcView;

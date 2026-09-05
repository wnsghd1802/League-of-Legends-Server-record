import * as cheerio from "cheerio";

const RIOT_STATUS_URL =
  "https://status.riotgames.com/?locale=ko_KR&product=leagueoflegends&region=kr";

const sleep = ms => new Promise(r => setTimeout(r, ms));

function kstDate(iso = new Date().toISOString()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(new Date(iso));
  const get = t => parts.find(p => p.type === t)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function pickLocale(items = [], field = "content") {
  return items.find(x => x.locale === "ko_KR")?.[field]
    || items.find(x => x.locale?.startsWith("ko"))?.[field]
    || items.find(x => x.locale === "en_US")?.[field]
    || items[0]?.[field] || "";
}

async function fetchWithTimeout(url, options = {}, ms = 9000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function normalizeFromRiotApi(j, checkedAt) {
  const incidents = Array.isArray(j.incidents) ? j.incidents : [];
  const maint = Array.isArray(j.maintenances) ? j.maintenances : [];
  const active = [...incidents, ...maint];
  const firstIncident = incidents[0];
  const firstMaintenance = maint[0];
  let status = "normal";
  if (firstIncident) {
    status = firstIncident.incident_severity === "critical" ? "critical"
      : firstIncident.incident_severity === "info" ? "info" : "warning";
  } else if (firstMaintenance) status = "maintenance";

  const first = firstIncident || firstMaintenance;
  const title = first ? pickLocale(first.titles) : "특이사항 또는 문제 없음";
  const update = first?.updates?.[0];
  const description = update ? pickLocale(update.translations) :
    (active.length ? "현재 Riot Games 공지가 있습니다." : "현재 보고된 장애 또는 점검이 없습니다.");

  return {
    issueCount: active.length,
    status,
    title,
    description,
    platforms: first?.platforms || [],
    sourceTime: first?.updated_at || first?.created_at || null,
    sourceResponseTime: checkedAt,
    checkedAt,
    sourceUrl: RIOT_STATUS_URL,
    sourceMode: "riot-api",
    rawExcerpt: JSON.stringify({incidents: incidents.length, maintenances: maint.length, id: j.id}).slice(0,500)
  };
}

async function fetchRiotApi(checkedAt) {
  if (!process.env.RIOT_API_KEY) return null;
  const r = await fetchWithTimeout(
    "https://kr.api.riotgames.com/lol/status/v4/platform-data",
    { headers: { "X-Riot-Token": process.env.RIOT_API_KEY, "Accept": "application/json" } },
    9000
  );
  if (!r.ok) throw Object.assign(new Error(`Riot API HTTP ${r.status}`), { status: r.status });
  const j = await r.json();
  return normalizeFromRiotApi(j, checkedAt);
}

function extractActiveSection(text) {
  const productStart = text.indexOf("리그 오브 레전드");
  let segment = productStart >= 0 ? text.slice(productStart) : text;
  const nextProduct = segment.indexOf("레전드 오브 룬테라");
  if (nextProduct > 0) segment = segment.slice(0, nextProduct);

  const current = segment.indexOf("현재 상태");
  if (current >= 0) segment = segment.slice(current + "현재 상태".length);
  const closed = segment.indexOf("최근 종료된 내역");
  if (closed >= 0) segment = segment.slice(0, closed);
  return segment.trim();
}

function parsePublicStatus(html, checkedAt, responseDate) {
  const $ = cheerio.load(html);
  $("script,style,noscript").remove();
  const text = $("body").text().replace(/\s+/g, " ").trim();
  const section = extractActiveSection(text);

  if (!section || section.length < 3) {
    throw Object.assign(new Error("League of Legends 현재 상태 영역을 찾지 못했습니다."), { code:"SCHEMA_CHANGED" });
  }

  const noIssuePhrases = ["특이사항 또는 문제 없음","특이사항이나 문제 없음","No recent issues or events to report"];
  if (noIssuePhrases.some(p => section.includes(p))) {
    return {
      issueCount:0,status:"normal",title:"특이사항 또는 문제 없음",
      description:"현재 보고된 장애 또는 점검이 없습니다.",
      platforms:[],sourceTime:responseDate || checkedAt,sourceResponseTime:responseDate || checkedAt,
      checkedAt,sourceUrl:RIOT_STATUS_URL,sourceMode:"public-status-page",
      rawExcerpt:section.slice(0,500)
    };
  }

  const severityPatterns = [
    ["critical",/(치명적|Critical)/i],["warning",/(경고|Warning)/i],
    ["maintenance",/(점검|Maintenance)/i],["info",/(정보|안내|Informational)/i]
  ];
  let status = "warning", severityWord = "";
  for (const [s,re] of severityPatterns) {
    const m = section.match(re); if(m){status=s;severityWord=m[0];break;}
  }

  const timePatterns = [
    /\d{4}년\s*\d{1,2}월\s*\d{1,2}일\s*\d{1,2}:\d{2}\s*(?:GMT[+-]\d+|KST)?/i,
    /(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4}\s+at\s+\d{1,2}:\d{2}\s+(?:UTC|GMT[+-]\d+)?/i
  ];
  let timeMatch = null;
  for (const re of timePatterns){ timeMatch = section.match(re); if(timeMatch) break; }

  let afterSeverity = severityWord ? section.slice(section.indexOf(severityWord)+severityWord.length).trim() : section;
  let title = "Riot Games 현재 공지";
  if (timeMatch) {
    const idx = afterSeverity.indexOf(timeMatch[0]);
    if (idx > 0) title = afterSeverity.slice(0, idx).trim().slice(0,120) || title;
  } else {
    title = afterSeverity.split(/(?<=[.!?])\s/)[0].slice(0,120) || title;
  }

  let description = "현재 Riot Games에서 활성 공지를 표시하고 있습니다.";
  if (timeMatch) {
    const idx = section.indexOf(timeMatch[0]);
    if (idx >= 0) {
      let tail = section.slice(idx + timeMatch[0].length).trim();
      const platformIdx = tail.search(/(?:영향받는 플랫폼|영향 플랫폼|Platforms affected)/i);
      if (platformIdx >= 0) tail = tail.slice(0,platformIdx);
      if (tail) description = tail.slice(0,600);
    }
  }

  let platforms = [];
  const pm = section.match(/(?:영향받는 플랫폼|영향 플랫폼|Platforms affected)\s*:?\s*([^|]+)$/i);
  if (pm) platforms = pm[1].split(/,|·|\//).map(x=>x.trim()).filter(Boolean).slice(0,8);

  const statusMatches = [...section.matchAll(/(?:치명적|Critical|경고|Warning|점검|Maintenance|정보|안내|Informational)/gi)];
  const issueCount = Math.max(1, statusMatches.length);

  return {
    issueCount,status,title,description,platforms,
    sourceTime:timeMatch ? timeMatch[0] : (responseDate || checkedAt),
    sourceResponseTime:responseDate || checkedAt,checkedAt,
    sourceUrl:RIOT_STATUS_URL,sourceMode:"public-status-page",rawExcerpt:section.slice(0,500)
  };
}

async function fetchPublicStatus(checkedAt) {
  const r = await fetchWithTimeout(RIOT_STATUS_URL, {
    headers: {
      "User-Agent":"Mozilla/5.0 (compatible; LOL-KR-Status-Board/1.0)",
      "Accept-Language":"ko-KR,ko;q=0.9,en;q=0.6"
    },
    cache:"no-store"
  }, 9000);
  if (!r.ok) throw Object.assign(new Error(`Riot 공개 상태 페이지 HTTP ${r.status}`), { status:r.status });
  const html = await r.text();
  return parsePublicStatus(html, checkedAt, r.headers.get("date"));
}

async function getLiveStatus() {
  const checkedAt = new Date().toISOString();
  // 기본은 비밀키가 없는 Riot 공식 공개 상태 페이지.
  try {
    return await fetchPublicStatus(checkedAt);
  } catch (publicErr) {
    // 페이지 구조가 바뀌었을 때만 서버 환경변수의 공식 Riot API를 보조 경로로 사용.
    const api = await fetchRiotApi(checkedAt);
    if (api) return api;
    throw publicErr;
  }
}

const getDbKey = () =>
  process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || "";

const hasDb = () => Boolean(process.env.SUPABASE_URL && getDbKey());

async function dbRequest(path, options = {}) {
  const url = `${process.env.SUPABASE_URL}/rest/v1/${path}`;
  const key = getDbKey();
  const headers = {
    "apikey": key,
    "Content-Type":"application/json",
    ...(options.headers||{})
  };

  // 최신 sb_secret_* 키는 apikey 헤더로만 보냅니다.
  // 예전 JWT 기반 service_role 키를 사용하는 경우에만 Bearer 헤더를 추가합니다.
  if (key.startsWith("eyJ")) {
    headers["Authorization"] = `Bearer ${key}`;
  }

  const r = await fetch(url, {
    ...options,
    headers
  });
  if(!r.ok) throw new Error(`DB HTTP ${r.status}: ${await r.text()}`);
  if(r.status===204) return null;
  return await r.json();
}

async function getHistory(limit=14) {
  if(!hasDb()) return [];
  return await dbRequest(`lol_daily_status?select=*&order=date_kst.desc&limit=${limit}`);
}

async function upsertDaily(current) {
  if(!hasDb()) return null;
  const row = {
    date_kst:kstDate(current.checkedAt),
    issue_count:current.issueCount,
    status:current.status,
    issue_title:current.title || "",
    source_url:current.sourceUrl,
    source_time: typeof current.sourceTime === "string" && current.sourceTime.match(/^\d{4}-\d{2}-\d{2}T/) ? current.sourceTime : null,
    checked_at:current.checkedAt,
    raw_excerpt:current.rawExcerpt || ""
  };
  return await dbRequest("lol_daily_status?on_conflict=date_kst",{
    method:"POST",
    headers:{"Prefer":"resolution=merge-duplicates,return=representation"},
    body:JSON.stringify(row)
  });
}

async function failurePayload(code,label,message,status=503) {
  const history = await getHistory().catch(()=>[]);
  const last = history[0] || null;
  const lastGood = last ? {
    issueCount:Number(last.issue_count),status:last.status,title:last.issue_title,
    description:"마지막으로 성공적으로 저장된 Riot 상태입니다.",
    platforms:[],sourceTime:last.source_time,checkedAt:last.checked_at,
    sourceMode:"database-history",sourceUrl:last.source_url
  } : null;
  return { status, body:{ok:false,errorCode:code,errorLabel:label,message,stale:true,lastGood,history,storageMode:hasDb()?"database":"browser"}};
}

export default async function handler(req,res) {
  res.setHeader("Cache-Control","no-store");
  const test = String(req.query?.test || "");
  try{
    if(test==="slow"){
      await sleep(3500);
      const p=await failurePayload("SOURCE_TIMEOUT","느린 외부 응답","합성 시험: 원천 응답 시간이 제한을 초과했습니다.",504);
      return res.status(p.status).json(p.body);
    }
    if(test==="403"){
      const p=await failurePayload("SOURCE_FORBIDDEN","원천 접근 거부","합성 시험: 외부 원천이 401/403으로 요청을 거절했습니다.",403);
      return res.status(p.status).json(p.body);
    }
    if(test==="429"){
      const p=await failurePayload("SOURCE_RATE_LIMIT","호출 제한","합성 시험: 외부 원천의 호출 제한에 도달했습니다.",429);
      return res.status(p.status).json(p.body);
    }
    if(test==="offline"){
      const p=await failurePayload("SOURCE_OFFLINE","오프라인","합성 시험: 외부 원천에 연결할 수 없습니다.",503);
      return res.status(p.status).json(p.body);
    }
    if(test==="schema"){
      const p=await failurePayload("SCHEMA_CHANGED","응답 형식 변경","합성 시험: 예상 필드가 사라져 응답을 안전하게 해석할 수 없습니다.",502);
      return res.status(p.status).json(p.body);
    }

    const current = await getLiveStatus();
    await upsertDaily(current);
    const history = await getHistory();
    return res.status(200).json({
      ok:true,current,history,
      stale:false,errorCode:"none",
      storageMode:hasDb()?"database":"browser"
    });
  }catch(e){
    const code=e?.code==="SCHEMA_CHANGED"?"SCHEMA_CHANGED":
      e?.name==="AbortError"?"SOURCE_TIMEOUT":
      e?.status===403?"SOURCE_FORBIDDEN":
      e?.status===429?"SOURCE_RATE_LIMIT":"SOURCE_UNAVAILABLE";
    const label={
      SCHEMA_CHANGED:"응답 형식 변경",SOURCE_TIMEOUT:"느린 외부 응답",
      SOURCE_FORBIDDEN:"원천 접근 거부",SOURCE_RATE_LIMIT:"호출 제한",
      SOURCE_UNAVAILABLE:"원천 조회 실패"
    }[code];
    const p=await failurePayload(code,label,e.message||"Riot 상태를 조회하지 못했습니다.",502);
    return res.status(p.status).json(p.body);
  }
}
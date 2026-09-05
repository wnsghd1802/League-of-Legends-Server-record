const RIOT_API_URL = "https://kr.api.riotgames.com/lol/status/v4/platform-data";
const RIOT_STATUS_URL =
  "https://status.riotgames.com/?locale=ko_KR&product=leagueoflegends&region=kr";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function kstDate(iso = new Date().toISOString()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(iso));

  const get = (type) => parts.find((p) => p.type === type)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function pickLocale(items = [], field = "content") {
  return (
    items.find((x) => x.locale === "ko_KR")?.[field] ||
    items.find((x) => x.locale?.startsWith("ko"))?.[field] ||
    items.find((x) => x.locale === "en_US")?.[field] ||
    items[0]?.[field] ||
    ""
  );
}

function getDbKey() {
  return (
    process.env.SUPABASE_SECRET_KEY ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    ""
  );
}

function hasDb() {
  return Boolean(process.env.SUPABASE_URL && getDbKey());
}

async function dbRequest(path, options = {}) {
  const key = getDbKey();
  const headers = {
    apikey: key,
    "Content-Type": "application/json",
    ...(options.headers || {}),
  };

  // legacy service_role JWT 키를 쓸 때만 Bearer 사용
  if (key.startsWith("eyJ")) {
    headers.Authorization = `Bearer ${key}`;
  }

  const response = await fetch(
    `${process.env.SUPABASE_URL}/rest/v1/${path}`,
    { ...options, headers }
  );

  if (!response.ok) {
    throw new Error(`DB HTTP ${response.status}: ${await response.text()}`);
  }

  if (response.status === 204) return null;
  return response.json();
}

async function getHistory(limit = 14) {
  if (!hasDb()) return [];
  return dbRequest(
    `lol_daily_status?select=*&order=date_kst.desc&limit=${limit}`
  );
}

async function upsertDaily(current) {
  if (!hasDb()) return null;

  const row = {
    date_kst: kstDate(current.checkedAt),
    issue_count: current.issueCount,
    status: current.status,
    issue_title: current.title || "",
    source_url: current.sourceUrl,
    source_time: current.sourceTime || null,
    checked_at: current.checkedAt,
    raw_excerpt: current.rawExcerpt || "",
  };

  return dbRequest("lol_daily_status?on_conflict=date_kst", {
    method: "POST",
    headers: {
      Prefer: "resolution=merge-duplicates,return=representation",
    },
    body: JSON.stringify(row),
  });
}

function normalizeStatus(data, checkedAt, sourceResponseTime) {
  if (
    !data ||
    !Array.isArray(data.incidents) ||
    !Array.isArray(data.maintenances)
  ) {
    const error = new Error("Riot API 응답 형식이 예상과 다릅니다.");
    error.code = "SCHEMA_CHANGED";
    throw error;
  }

  const incidents = data.incidents;
  const maintenances = data.maintenances;
  const active = [...incidents, ...maintenances];

  const firstIncident = incidents[0] || null;
  const firstMaintenance = maintenances[0] || null;
  const first = firstIncident || firstMaintenance;

  let status = "normal";
  if (firstIncident) {
    if (firstIncident.incident_severity === "critical") status = "critical";
    else if (firstIncident.incident_severity === "info") status = "info";
    else status = "warning";
  } else if (firstMaintenance) {
    status = "maintenance";
  }

  const title = first
    ? pickLocale(first.titles)
    : "특이사항 또는 문제 없음";

  const update = first?.updates?.[0] || null;
  const description = update
    ? pickLocale(update.translations)
    : active.length
      ? "현재 Riot Games에서 활성 공지를 표시하고 있습니다."
      : "현재 보고된 장애 또는 점검이 없습니다.";

  const sourceTime =
    first?.updated_at ||
    first?.created_at ||
    sourceResponseTime ||
    checkedAt;

  return {
    issueCount: active.length,
    status,
    title,
    description,
    platforms: Array.isArray(first?.platforms) ? first.platforms : [],
    sourceTime,
    sourceResponseTime: sourceResponseTime || checkedAt,
    checkedAt,
    sourceUrl: RIOT_STATUS_URL,
    sourceMode: "riot-api",
    rawExcerpt: JSON.stringify({
      id: data.id,
      name: data.name,
      incidents: incidents.length,
      maintenances: maintenances.length,
      firstIncidentId: firstIncident?.id ?? null,
      firstMaintenanceId: firstMaintenance?.id ?? null,
    }).slice(0, 900),
  };
}

async function getLiveStatus() {
  const apiKey = process.env.RIOT_API_KEY;

  if (!apiKey) {
    const error = new Error(
      "Vercel 환경변수 RIOT_API_KEY가 설정되지 않았습니다."
    );
    error.code = "RIOT_KEY_MISSING";
    throw error;
  }

  const checkedAt = new Date().toISOString();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 9000);

  try {
    const response = await fetch(RIOT_API_URL, {
      headers: {
        "X-Riot-Token": apiKey,
        Accept: "application/json",
      },
      signal: controller.signal,
      cache: "no-store",
    });

    if (!response.ok) {
      const error = new Error(`Riot API HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }

    const sourceResponseTime =
      response.headers.get("date") || checkedAt;

    const data = await response.json();
    return normalizeStatus(data, checkedAt, sourceResponseTime);
  } finally {
    clearTimeout(timer);
  }
}

async function failurePayload(code, label, message, status = 503) {
  const history = await getHistory().catch(() => []);
  const last = history[0] || null;

  const lastGood = last
    ? {
        issueCount: Number(last.issue_count),
        status: last.status,
        title: last.issue_title,
        description: "마지막으로 성공적으로 저장된 Riot 상태입니다.",
        platforms: [],
        sourceTime: last.source_time,
        checkedAt: last.checked_at,
        sourceMode: "database-history",
        sourceUrl: last.source_url,
      }
    : null;

  return {
    status,
    body: {
      ok: false,
      errorCode: code,
      errorLabel: label,
      message,
      stale: true,
      lastGood,
      history,
      storageMode: hasDb() ? "database" : "browser",
    },
  };
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  const test = String(req.query?.test || "");

  try {
    // 합성 실패 테스트
    if (test === "slow") {
      await sleep(3500);
      const p = await failurePayload(
        "SOURCE_TIMEOUT",
        "느린 외부 응답",
        "합성 시험: 원천 응답 시간이 제한을 초과했습니다.",
        504
      );
      return res.status(p.status).json(p.body);
    }

    if (test === "403") {
      const p = await failurePayload(
        "SOURCE_FORBIDDEN",
        "원천 접근 거부",
        "합성 시험: 외부 원천이 401/403으로 요청을 거절했습니다.",
        403
      );
      return res.status(p.status).json(p.body);
    }

    if (test === "429") {
      const p = await failurePayload(
        "SOURCE_RATE_LIMIT",
        "호출 제한",
        "합성 시험: 외부 원천의 호출 제한에 도달했습니다.",
        429
      );
      return res.status(p.status).json(p.body);
    }

    if (test === "offline") {
      const p = await failurePayload(
        "SOURCE_OFFLINE",
        "오프라인",
        "합성 시험: 외부 원천에 연결할 수 없습니다.",
        503
      );
      return res.status(p.status).json(p.body);
    }

    if (test === "schema") {
      const p = await failurePayload(
        "SCHEMA_CHANGED",
        "응답 형식 변경",
        "합성 시험: 예상 필드가 사라져 응답을 안전하게 해석할 수 없습니다.",
        502
      );
      return res.status(p.status).json(p.body);
    }

    const current = await getLiveStatus();

    // 같은 KST 날짜는 PRIMARY KEY(date_kst) 기준으로 UPDATE/UPSERT
    await upsertDaily(current);

    const history = await getHistory();

    return res.status(200).json({
      ok: true,
      current,
      history,
      stale: false,
      errorCode: "none",
      storageMode: hasDb() ? "database" : "browser",
    });
  } catch (error) {
    let code = "SOURCE_UNAVAILABLE";
    let label = "원천 조회 실패";
    let httpStatus = 502;

    if (error.code === "RIOT_KEY_MISSING") {
      code = "RIOT_KEY_MISSING";
      label = "Riot API 키 없음";
      httpStatus = 500;
    } else if (error.code === "SCHEMA_CHANGED") {
      code = "SCHEMA_CHANGED";
      label = "응답 형식 변경";
    } else if (error.name === "AbortError") {
      code = "SOURCE_TIMEOUT";
      label = "느린 외부 응답";
      httpStatus = 504;
    } else if (error.status === 401 || error.status === 403) {
      code = "SOURCE_FORBIDDEN";
      label = "Riot API 인증 실패";
      httpStatus = error.status;
    } else if (error.status === 429) {
      code = "SOURCE_RATE_LIMIT";
      label = "호출 제한";
      httpStatus = 429;
    }

    const p = await failurePayload(
      code,
      label,
      error.message || "Riot 상태를 조회하지 못했습니다.",
      httpStatus
    );

    return res.status(p.status).json(p.body);
  }
}

# LOL KR 서버 상태 기록판

Riot Games 공식 서비스 상태를 바탕으로 **현재 활성 이슈 수(값) / 건(단위)** 을 표시하고,
KST 날짜당 한 건만 저장하는 Vercel용 프로젝트입니다.

## 구현된 과제 조건

### 1. 실제 공개 원천 + 맥락
- 기본 원천: Riot Games 공식 공개 상태 페이지
  - https://status.riotgames.com/?locale=ko_KR&product=leagueoflegends&region=kr
- 화면 표시:
  - 현재 활성 이슈 수
  - 단위 `건`
  - 상태
  - 대표 이슈
  - Riot 원천/공지 시각
  - 우리 페이지 조회 시각
  - 기준 시간대 `Asia/Seoul`
  - 출처 링크
- 원자료에서 정규화한 값 / 저장값 / 화면값을 한 화면에서 대조합니다.

### 2. 비밀 없는 호출
- 브라우저는 `/api/status`만 호출합니다.
- 기본 Riot 조회는 비밀키가 필요 없는 공식 공개 상태 페이지를 서버에서 읽습니다.
- 공개 페이지 구조가 바뀌었을 경우에만 `RIOT_API_KEY`를 서버 환경변수로 넣으면
  Riot 공식 `lol/status/v4/platform-data`를 보조 경로로 사용할 수 있습니다.
- 키를 HTML, Git, 브라우저 네트워크 응답에 넣지 않습니다.

### 3. 다섯 실패 합성 재생
화면 하단 버튼:
- 느린 응답
- 401/403
- 429 호출 제한
- 오프라인
- 응답 형식 변경

실패 중에는 마지막 성공값을 유지하고 `stale` 표시를 붙입니다.
`정상 상태로 복구`를 누르면 실제 Riot 원천을 다시 조회합니다.

### 4. 하루 한 줄
Supabase가 연결되면 `date_kst`가 PRIMARY KEY이므로
같은 KST 날짜에 여러 번 성공해도 한 행만 존재하고 최신 성공값으로 갱신됩니다.
다음 KST 날짜에는 새 행이 생깁니다.

---

## 가장 빠른 실행

### 1) 파일을 GitHub 저장소에 올리기
이 폴더 전체를 저장소 루트에 올립니다.

### 2) Supabase 만들기
Supabase 프로젝트를 만들고 `schema.sql`을 SQL Editor에서 실행합니다.

### 3) Vercel 환경변수
Vercel → Project → Settings → Environment Variables:

- `SUPABASE_URL`
- `SUPABASE_SECRET_KEY`

`SUPABASE_SECRET_KEY`에는 Supabase의 최신 `sb_secret_...` 키를 넣습니다.
이 값은 **절대 HTML이나 GitHub에 넣지 마세요.**

참고: 기존 프로젝트의 legacy `service_role` 키를 써야 하는 경우에는
`SUPABASE_SERVICE_ROLE_KEY` 환경변수도 호환되도록 해두었습니다.

선택:
- `RIOT_API_KEY`
  - 공개 상태 페이지 파싱이 깨졌을 때 보조 경로로만 사용됩니다.
  - 이것도 Vercel 환경변수에만 넣습니다.

### 4) 배포
Vercel에서 GitHub 저장소를 Import하고 Deploy 합니다.

---

## DB 없이도 열리나요?

네. DB 환경변수가 없으면 브라우저 `localStorage`에 날짜별 기록을 저장하므로 기능을 바로 볼 수 있습니다.
다만 **공개 심사자가 같은 기록을 보게 하려면 Supabase 연결이 필요합니다.**

## 참고
Riot 공개 상태 페이지의 문구/HTML 구조가 크게 바뀌면 파서가 `SCHEMA_CHANGED`를 표시합니다.
그 경우 마지막 성공값은 지워지지 않습니다.

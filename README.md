# 자산관리

부부가 함께 쓰는 예금·주식 자산관리 앱. 휴대폰 홈 화면에 설치해서 쓰는 웹앱(PWA)이에요.

- 화면: 정적 파일(`index.html`, `sw.js`, `manifest.webmanifest`, `icons/`). GitHub Pages로 올려요.
- 데이터: Supabase. 로그인(이메일+비밀번호), 자산 공유, 실시간 반영.
- 시세: Supabase Edge Function `quotes`가 Yahoo Finance에서 주가와 원/달러 환율을 받아 1분 캐시. 미국 주식은 장전·장후 가격도 반영하고, 앱을 보는 동안 1분마다 자동 갱신.
- 소식: `news` 테이블. Claude가 매일 아침 요약해서 갱신.

## 처음 설정
1. Supabase 프로젝트를 만들고 `supabase/schema.sql`을 실행해요.
2. `members` 테이블에 두 사람 이메일을 넣어요. 명단에 없는 계정은 아무것도 못 봐요.
3. `supabase/functions/quotes`를 Edge Function으로 배포해요.
4. `config.js`에 프로젝트 주소와 공개(anon) 키를 넣어요.
5. Supabase Auth 설정의 Site URL과 Redirect URL에 앱 주소를 넣어요.
6. 개인 데이터(`private/seed.sql`)는 저장소에 올리지 않고 SQL 편집기에서만 실행해요.

## 휴대폰에 설치
- 아이폰: Safari로 앱 주소 열기 → 공유 → 홈 화면에 추가
- 안드로이드: Chrome으로 열기 → 메뉴 → 앱 설치(홈 화면에 추가)

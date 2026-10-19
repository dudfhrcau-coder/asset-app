// 시세 서버: 로그인한 가족만 호출. 주가와 원/달러 환율을 Yahoo Finance에서 받아 1분 동안 캐시해요.
// 미국 주식은 장전·장후 거래 가격도 반영하고, 그 경우 session에 'pre' 또는 'post'를 붙여요.
// prev는 전날 종가(오늘 등락률 계산용)예요.
// 국내 종목은 005930.KS 형식, 미국 종목은 IONQ 형식으로 받아요.
// 국내 종목은 Yahoo가 20분쯤 늦어서 네이버 증권 실시간 시세를 먼저 쓰고, 실패하면 Yahoo로 받아요.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const TTL_MS = 60 * 1000;
const FX = "KRW=X";

type Quote = { price: number; session: string | null; prev: number | null };
const WRONG = "wrong"; // 시장이 안 맞는 심볼(코스닥 종목의 .KS 등)

async function yahoo(symbol: string): Promise<Quote | typeof WRONG | null> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1m&includePrePost=true`;
  try {
    const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!r.ok) return null;
    const j = await r.json();
    const res = j?.chart?.result?.[0];
    const meta = res?.meta;
    const p = meta?.regularMarketPrice;
    if (typeof p !== "number") return null;
    // 코스닥 종목을 .KS로 물으면 Yahoo가 엉뚱한 옛 가격(펀드로 분류된 항목)을 줘요. 시장이 안 맞는 응답은 버려요.
    const ex = String(meta?.fullExchangeName ?? "");
    if (symbol.endsWith(".KS") && ex === "KOSDAQ") return WRONG;
    if (symbol.endsWith(".KQ") && ex !== "KOSDAQ") return WRONG;
    if (meta?.instrumentType === "MUTUALFUND") return WRONG;
    // 정규장 밖에서 체결된 마지막 1분봉이 있으면 그 가격을 씀
    const prev = typeof meta?.chartPreviousClose === "number" ? meta.chartPreviousClose : null;
    const reg = meta?.currentTradingPeriod?.regular;
    const ts: number[] = res?.timestamp ?? [];
    const close: (number | null)[] = res?.indicators?.quote?.[0]?.close ?? [];
    for (let i = ts.length - 1; i >= 0; i--) {
      if (typeof close[i] !== "number") continue;
      if (reg && ts[i] >= reg.end) return { price: close[i] as number, session: "post", prev };
      if (reg && ts[i] < reg.start) return { price: close[i] as number, session: "pre", prev };
      break;
    }
    return { price: p, session: null, prev };
  } catch {
    return null;
  }
}

async function naver(symbol: string): Promise<Quote | typeof WRONG | null> {
  const [code, suffix] = symbol.split(".");
  try {
    const r = await fetch(`https://polling.finance.naver.com/api/realtime/domestic/stock/${code}`, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!r.ok) return null;
    const d = (await r.json())?.datas?.[0];
    const price = Number(d?.closePriceRaw);
    if (!price) return null;
    const ex = d?.stockExchangeType?.code;
    if (ex && ex !== suffix) return WRONG;
    const diff = Number(d?.compareToPreviousClosePriceRaw);
    return { price, session: null, prev: Number.isFinite(diff) ? price - diff : null };
  } catch {
    return null;
  }
}

// 최근 2년 최고가(주봉 고가 중 최댓값). 시뮬레이션 화면에서만 요청하고 12시간 캐시해요.
const HI_TTL_MS = 12 * 60 * 60 * 1000;
async function high2y(symbol: string): Promise<number | null> {
  try {
    const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=2y&interval=1wk`, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!r.ok) return null;
    const res = (await r.json())?.chart?.result?.[0];
    const meta = res?.meta;
    const ex = String(meta?.fullExchangeName ?? "");
    if (meta?.instrumentType === "MUTUALFUND" || (symbol.endsWith(".KS") && ex === "KOSDAQ") || (symbol.endsWith(".KQ") && ex !== "KOSDAQ")) return null;
    const hs = ((res?.indicators?.quote?.[0]?.high ?? []) as (number | null)[]).filter((x): x is number => typeof x === "number");
    return hs.length ? Math.max(...hs) : null;
  } catch {
    return null;
  }
}

const quote = async (s: string) => (/\.K[SQ]$/.test(s) ? (await naver(s)) ?? (await yahoo(s)) : await yahoo(s));

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

  const url = Deno.env.get("SUPABASE_URL")!;
  const user = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
  });
  const { data: member } = await user.rpc("is_member");
  if (!member) return json({ error: "not a family member" }, 403);

  const { symbols = [], highs = false } = await req.json().catch(() => ({}));
  const wanted = [...new Set([...(symbols as string[]).filter((s) => /^[A-Z0-9.\-^=]{1,15}$/.test(s)), FX])].slice(0, 60);

  const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  if (highs) {
    const syms = wanted.filter((s) => s !== FX);
    const { data: hc } = await admin.from("quotes").select("symbol,hi2y,hi_at").in("symbol", syms);
    const out: Record<string, number> = {};
    const todo: string[] = [];
    for (const s of syms) {
      const c = hc?.find((r) => r.symbol === s);
      if (c?.hi2y && c.hi_at && Date.now() - new Date(c.hi_at).getTime() < HI_TTL_MS) out[s] = Number(c.hi2y);
      else todo.push(s);
    }
    const got = await Promise.all(todo.map(async (s) => [s, await high2y(s)] as const));
    for (const [s, h] of got) {
      if (h == null) continue;
      out[s] = h;
      if (hc?.some((r) => r.symbol === s)) await admin.from("quotes").update({ hi2y: h, hi_at: new Date().toISOString() }).eq("symbol", s);
    }
    return json({ highs: out });
  }
  const { data: cached } = await admin.from("quotes").select("symbol,price,session,prev,fetched_at").in("symbol", wanted);
  const fresh = new Map<string, Quote>();
  for (const q of cached ?? []) if (Date.now() - new Date(q.fetched_at).getTime() < TTL_MS) fresh.set(q.symbol, { price: Number(q.price), session: q.session, prev: q.prev == null ? null : Number(q.prev) });

  const stale = wanted.filter((s) => !fresh.has(s));
  const got = await Promise.all(stale.map(async (s) => [s, await quote(s)] as const));
  const wrong = got.filter(([, q]) => q === WRONG).map(([s]) => s);
  if (wrong.length) await admin.from("quotes").delete().in("symbol", wrong);
  const rows = got.flatMap(([symbol, q]) => (q && q !== WRONG ? [{ symbol, price: q.price, session: q.session, prev: q.prev, fetched_at: new Date().toISOString() }] : []));
  if (rows.length) await admin.from("quotes").upsert(rows);
  for (const r of rows) fresh.set(r.symbol, { price: r.price, session: r.session, prev: r.prev });
  // Yahoo가 실패하면 마지막으로 받은 값이라도 돌려줌
  for (const q of cached ?? []) if (!fresh.has(q.symbol) && !wrong.includes(q.symbol)) fresh.set(q.symbol, { price: Number(q.price), session: q.session, prev: q.prev == null ? null : Number(q.prev) });

  const usdkrw = fresh.get(FX)?.price ?? null;
  fresh.delete(FX);
  const prices = Object.fromEntries([...fresh].map(([k, q]) => [k, q.price]));
  const sessions = Object.fromEntries([...fresh].filter(([, q]) => q.session).map(([k, q]) => [k, q.session]));
  const prev = Object.fromEntries([...fresh].filter(([, q]) => q.prev).map(([k, q]) => [k, q.prev]));
  return json({ prices, sessions, prev, usdkrw, at: Date.now() });
});

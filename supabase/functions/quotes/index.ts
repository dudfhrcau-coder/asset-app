// 시세 서버: 로그인한 가족만 호출. 주가와 원/달러 환율을 Yahoo Finance에서 받아 10분 동안 캐시해요.
// 국내 종목은 005930.KS 형식, 미국 종목은 IONQ 형식으로 받아요.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const TTL_MS = 10 * 60 * 1000;
const FX = "KRW=X";

async function yahoo(symbol: string): Promise<number | null> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1d`;
  try {
    const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!r.ok) return null;
    const j = await r.json();
    const p = j?.chart?.result?.[0]?.meta?.regularMarketPrice;
    return typeof p === "number" ? p : null;
  } catch {
    return null;
  }
}

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

  const { symbols = [] } = await req.json().catch(() => ({}));
  const wanted = [...new Set([...(symbols as string[]).filter((s) => /^[A-Z0-9.\-^=]{1,15}$/.test(s)), FX])].slice(0, 60);

  const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: cached } = await admin.from("quotes").select("symbol,price,fetched_at").in("symbol", wanted);
  const fresh = new Map<string, number>();
  for (const q of cached ?? []) if (Date.now() - new Date(q.fetched_at).getTime() < TTL_MS) fresh.set(q.symbol, Number(q.price));

  const stale = wanted.filter((s) => !fresh.has(s));
  const got = await Promise.all(stale.map(async (s) => [s, await yahoo(s)] as const));
  const rows = got.filter(([, p]) => p !== null).map(([symbol, price]) => ({ symbol, price, fetched_at: new Date().toISOString() }));
  if (rows.length) await admin.from("quotes").upsert(rows);
  for (const r of rows) fresh.set(r.symbol, r.price as number);
  // Yahoo가 실패하면 마지막으로 받은 값이라도 돌려줌
  for (const q of cached ?? []) if (!fresh.has(q.symbol)) fresh.set(q.symbol, Number(q.price));

  const usdkrw = fresh.get(FX) ?? null;
  fresh.delete(FX);
  return json({ prices: Object.fromEntries(fresh), usdkrw, at: Date.now() });
});

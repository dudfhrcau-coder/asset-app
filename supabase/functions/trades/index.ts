// 실거래 서버: 로그인한 가족만 호출. 국토부 아파트 매매 실거래가(상세) API에서 단지별 최근 거래를 골라 돌려줘요.
// 인증키는 Supabase 비밀값 MOLIT_KEY(data.go.kr 일반 인증키, Decoding)에 넣어요. 지역·월별 응답은 molit_cache에 캐시해요.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const API = "https://apis.data.go.kr/1613000/RTMSDataSvcAptTradeDev/getRTMSDataSvcAptTradeDev";

type Row = { apt: string; umd: string; dong: string; floor: number; area: number; price: number; d: string; cancel: boolean };
type Want = { id: string; lawd: string; apt: string[]; umd?: string; area?: [number, number]; months?: number };

const tag = (x: string, t: string) => (x.match(new RegExp(`<${t}>([^<]*)</${t}>`)) ?? [])[1]?.trim() ?? "";

async function fetchMonth(key: string, lawd: string, ym: string): Promise<Row[] | null> {
  const u = `${API}?serviceKey=${encodeURIComponent(key)}&LAWD_CD=${lawd}&DEAL_YMD=${ym}&numOfRows=1000&pageNo=1`;
  const r = await fetch(u);
  if (!r.ok) return null;
  const x = await r.text();
  if (tag(x, "resultCode") && !/^0+$/.test(tag(x, "resultCode"))) return null;
  return [...x.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(([, it]) => ({
    apt: tag(it, "aptNm"),
    umd: tag(it, "umdNm"),
    dong: tag(it, "aptDong").replace(/동$/, ""),
    floor: Number(tag(it, "floor")),
    area: Number(tag(it, "excluUseAr")),
    price: Number(tag(it, "dealAmount").replace(/,/g, "")),
    d: `${tag(it, "dealYear")}-${tag(it, "dealMonth").padStart(2, "0")}-${tag(it, "dealDay").padStart(2, "0")}`,
    cancel: tag(it, "cdealType") === "O",
  }));
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
  const key = Deno.env.get("MOLIT_KEY");
  if (!key) return json({ error: "no_key" });

  const { items = [] } = await req.json().catch(() => ({}));
  const wants = (items as Want[]).filter((w) => /^\d{5}$/.test(w.lawd) && Array.isArray(w.apt)).slice(0, 10);
  const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  // 이번 달과 지난달은 6시간, 그 전 달은 3일 동안 캐시
  const now = new Date(Date.now() + 9 * 3600e3);
  const yms = (n: number) => Array.from({ length: n }, (_, i) => {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  });
  const memo = new Map<string, Row[]>();
  async function month(lawd: string, ym: string, i: number): Promise<Row[]> {
    const k = `${lawd}:${ym}`;
    if (memo.has(k)) return memo.get(k)!;
    const { data: c } = await admin.from("molit_cache").select("body,fetched_at").eq("key", k).maybeSingle();
    const ttl = i < 2 ? 6 * 3600e3 : 3 * 86400e3;
    let rows: Row[] | null = c && Date.now() - new Date(c.fetched_at).getTime() < ttl ? c.body : null;
    if (!rows) {
      rows = await fetchMonth(key!, lawd, ym);
      if (rows) await admin.from("molit_cache").upsert({ key: k, body: rows, fetched_at: new Date().toISOString() });
      else rows = c?.body ?? [];
    }
    memo.set(k, rows!);
    return rows!;
  }

  const out: Record<string, unknown> = {};
  for (const w of wants) {
    const list = yms(Math.min(w.months ?? 6, 12));
    const rows = (await Promise.all(list.map((ym, i) => month(w.lawd, ym, i)))).flat();
    const [lo, hi] = w.area ?? [0, 999];
    out[w.id] = rows
      .filter((r) => !r.cancel && w.apt.every((t) => r.apt.replace(/\s/g, "").includes(t)) && (!w.umd || r.umd === w.umd) && r.area >= lo && r.area <= hi)
      .sort((a, b) => b.d.localeCompare(a.d))
      .slice(0, 8)
      .map(({ d, dong, floor, price, area }) => ({ d, dong, floor, price, area }));
  }
  return json({ trades: out, at: Date.now() });
});

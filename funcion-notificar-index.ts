// AgroRuta Equipo · función "notificar" (Supabase Edge Function)
// Crear en Supabase → Edge Functions → nombre: notificar → pegar todo → Deploy
// IMPORTANTE: en los ajustes de la función, apagar "Verify JWT" (Enforce JWT verification).
// Secretos necesarios (Edge Functions → Secrets): VAPID_PUBLIC, VAPID_PRIVATE, AGRO_SECRET
import webpush from "npm:web-push@3.6.7";
import { createClient } from "npm:@supabase/supabase-js@2";

const URL_SB = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SECRET = Deno.env.get("AGRO_SECRET") ?? "";
webpush.setVapidDetails("https://agroruta-mx.github.io", Deno.env.get("VAPID_PUBLIC")!, Deno.env.get("VAPID_PRIVATE")!);

const db = createClient(URL_SB, SERVICE, { auth: { persistSession: false } });
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-agro-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

const MAQ: Record<string, string> = { tractor: "Tractor", camioneta: "Camioneta", cosechadora: "Cosechadora", bomba: "Motobomba", aspersora: "Aspersora", generador: "Generador" };
const money = (n: number) => "$" + Math.round(n || 0).toLocaleString("es-MX");

const fecha = (s: string) => { try { return new Date(s + "T12:00:00Z").toLocaleDateString("es-MX", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }) } catch { return s } };

function hoyMX(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Mexico_City" }).format(new Date());
}

async function autorizado(req: Request): Promise<boolean> {
  if (SECRET && req.headers.get("x-agro-secret") === SECRET) return true;
  const auth = req.headers.get("authorization") || "";
  const tok = auth.replace(/^Bearer\s+/i, "");
  if (!tok) return false;
  const { data } = await db.auth.getUser(tok);
  const email = (data?.user?.email || "").toLowerCase();
  if (!email) return false;
  const { data: fila } = await db.from("equipo").select("email").eq("email", email).maybeSingle();
  return !!fila;
}

async function enviar(payload: { title: string; body: string; url?: string; tag?: string }) {
  const { data: subs } = await db.from("push_subs").select("endpoint, sub");
  let ok = 0, fail = 0;
  const errores: string[] = [];
  for (const s of subs || []) {
    try {
      await webpush.sendNotification(s.sub, JSON.stringify(payload), { TTL: 60 * 60 * 12, urgency: "high" });
      ok++;
    } catch (e: any) {
      fail++;
      const host = (() => { try { return new URL(s.endpoint).host } catch { return "?" } })();
      errores.push(`${host}: ${e?.statusCode || ""} ${String(e?.body || e?.message || e).slice(0, 160)}`);
      console.error("push fallo", host, e?.statusCode, e?.body || e?.message);
      if (e?.statusCode === 404 || e?.statusCode === 410) await db.from("push_subs").delete().eq("endpoint", s.endpoint);
    }
  }
  console.log("push", { ok, fail, total: (subs || []).length });
  return { ok, fail, total: (subs || []).length, errores };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (!(await autorizado(req))) return json({ error: "no autorizado" }, 401);
  let b: any = {};
  try { b = await req.json(); } catch { /* vacío */ }

  if (b.tipo === "prueba") {
    return json(await enviar({ title: "AgroRuta Equipo", body: "✅ Las notificaciones funcionan en este aparato.", url: "./", tag: "prueba" }));
  }

  if (b.tipo === "nueva_orden") {
    const o = b.orden || {};
    if (o.origen !== "app-clientes" && b.forzar !== true) return json({ skip: "orden creada por el equipo" });
    const maq = [MAQ[o.machine] || "Máquina", o.model].filter(Boolean).join(" ");
    const lugar = [o.muni, o.place].filter(Boolean).join(", ");
    const cuando = [o.date ? fecha(o.date) : "", o.slot, o.urgent ? "URGENTE" : ""].filter(Boolean).join(" ");
    return json(await enviar({
      title: "🚜 Pedido nuevo · " + (o.name || "Cliente"),
      body: [maq, lugar, cuando, o.total ? money(o.total) : ""].filter(Boolean).join(" · "),
      url: "./#orden=" + encodeURIComponent(b.id || ""),
      tag: "orden-" + (b.id || ""),
    }));
  }

  if (b.tipo === "agenda") {
    const hoy = hoyMX();
    const { data: rows } = await db.from("ordenes").select("id, data").limit(1000);
    const ords = (rows || []).map((r: any) => ({ id: r.id, ...(r.data || {}) }));
    const deHoy = ords.filter((o: any) => o.date === hoy && !["cancelada", "terminada"].includes(o.estado))
      .sort((a: any, c: any) => (a.slot === "mañana" ? 0 : 1) - (c.slot === "mañana" ? 0 : 1));
    const pend = ords.filter((o: any) => o.estado === "pendiente").length;
    if (!deHoy.length && !pend) return json({ skip: "nada hoy" });
    const lineas = deHoy.slice(0, 4).map((o: any) => `${o.slot === "tarde" ? "Tarde" : "Mañana"} · ${o.name || ""} · ${MAQ[o.machine] || ""} · ${o.muni || ""}`);
    if (deHoy.length > 4) lineas.push(`+${deHoy.length - 4} más`);
    if (pend) lineas.push(`⏳ ${pend} por confirmar`);
    return json(await enviar({
      title: deHoy.length ? `📅 Hoy: ${deHoy.length} servicio${deHoy.length > 1 ? "s" : ""}` : "📅 Sin servicios hoy",
      body: lineas.join("\n"),
      url: "./",
      tag: "agenda",
    }));
  }

  return json({ error: "tipo desconocido" }, 400);
});

const crypto = require("crypto");

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

// Normaliza teléfono para Meta: sin +, solo dígitos, con prefijo de país
function normalizePhone(raw) {
  const clean = raw.replace(/[\s\-().]/g, "");
  if (clean.startsWith("+")) return clean.slice(1);
  if (/^[6789]\d{8}$/.test(clean)) return "34" + clean;
  return clean;
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).end();

  const { nombre, email, telefono, sector, source, website, event_id, fbp, fbc, user_agent } = req.body || {};

  // Honeypot: los bots rellenan el campo oculto "website"
  if (website) return res.status(200).json({ ok: true });

  if (!nombre || !telefono) {
    return res.status(400).json({ ok: false, message: "Faltan campos obligatorios." });
  }

  if (nombre.trim().length < 2 || /[<>{}/\\]/.test(nombre)) {
    return res.status(400).json({ ok: false, message: "Nombre no válido." });
  }

  const telClean = telefono.replace(/[\s\-().]/g, "");
  const validPhone = /^\+\d{7,15}$/.test(telClean) || /^[6789]\d{8}$/.test(telClean);
  if (!validPhone) {
    return res.status(400).json({ ok: false, message: "Teléfono no válido." });
  }

  // Rate limit básico por IP
  const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || "unknown";
  const ts = Date.now();
  if (!global._rl) global._rl = {};
  const last = global._rl[ip] || 0;
  if (ts - last < 30000) {
    return res.status(429).json({ ok: false, message: "Demasiadas solicitudes." });
  }
  global._rl[ip] = ts;

  const now = new Date().toLocaleString("es-ES", {
    timeZone: "Europe/Madrid",
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });

  const sectorLabel = {
    clinica:      "Clínica / Estética",
    inmobiliaria: "Inmobiliaria",
    ecommerce:    "E-commerce",
    agencia:      "Agencia marketing",
    consultora:   "Consultoría",
    educacion:    "Educación / Academia",
    hosteleria:   "Hostelería",
    otro:         "Otro",
  }[sector] || sector || "No indicado";

  // Telegram
  const tgToken = process.env.TELEGRAM_BOT_TOKEN;
  const tgChat  = process.env.TELEGRAM_OWNER_ID;
  if (tgToken && tgChat) {
    const nombreCorto = nombre.slice(0, 22).replace(/:/g, "-");
    const telLimpio   = telefono.replace(/\s/g, "").slice(0, 16);
    const msg = [
      "🔥 *Nuevo lead — HisfIA Ads*",
      "──────────────────────────",
      `👤 *${nombre}*`,
      `📞 \`${telefono}\``,
      `🏢 ${sectorLabel}`,
      `🌐 ${source || "ads.hisfia.com"}`,
      `🕐 ${now}`,
    ].join("\n");
    const keyboard = {
      inline_keyboard: [
        [
          { text: "📞 Llamar con Sofía", callback_data: `alc:${nombreCorto}:${telLimpio}:${sectorLabel.slice(0,12)}` },
          { text: "📋 Ver contacto",     callback_data: `ale:${nombreCorto}:${telLimpio}:${sectorLabel.slice(0,12)}` },
        ],
        [{ text: "⏰ Posponer 1h", callback_data: `als:${nombreCorto}:${telLimpio}` }],
      ],
    };
    await fetch(`https://api.telegram.org/bot${tgToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: tgChat, text: msg, parse_mode: "Markdown", reply_markup: keyboard }),
    }).catch(e => console.error("Telegram error:", e.message));
  }

  // Supabase
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_ANON_KEY;
  if (supabaseUrl && supabaseKey) {
    await fetch(`${supabaseUrl}/rest/v1/leads`, {
      method: "POST",
      headers: {
        "Content-Type":  "application/json",
        "apikey":        supabaseKey,
        "Authorization": `Bearer ${supabaseKey}`,
        "Prefer":        "return=minimal",
      },
      body: JSON.stringify({
        nombre,
        email:      email || "",
        telefono,
        sector:     sectorLabel,
        source:     source || "ads.hisfia.com",
        created_at: new Date().toISOString(),
      }),
    }).catch(e => console.error("Supabase error:", e.message));
  }

  // Meta Conversions API (server-side)
  const capiToken = process.env.META_CAPI_TOKEN;
  const pixelId   = "1290762733001124";
  if (capiToken) {
    const evId = event_id || `lead_${ts}_${Math.random().toString(36).slice(2, 8)}`;

    const userData = { ph: [sha256(normalizePhone(telefono))] };
    if (ip !== "unknown")          userData.client_ip_address = ip;
    if (user_agent)                userData.client_user_agent = user_agent;
    else if (req.headers["user-agent"]) userData.client_user_agent = req.headers["user-agent"];
    if (fbp) userData.fbp = fbp;
    if (fbc) userData.fbc = fbc;

    const capiPayload = {
      data: [{
        event_name:       "Lead",
        event_time:       Math.floor(ts / 1000),
        event_id:         evId,
        event_source_url: "https://ads.hisfia.com",
        action_source:    "website",
        user_data:        userData,
        custom_data: {
          content_name:     "Sesion_gratuita",
          content_category: sector || "general",
        },
      }],
    };

    // Código de test activo mientras se verifican eventos
    const testCode = process.env.META_TEST_CODE;
    if (testCode) capiPayload.test_event_code = testCode;

    await fetch(
      `https://graph.facebook.com/v19.0/${pixelId}/events?access_token=${capiToken}`,
      {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(capiPayload),
      }
    ).catch(e => console.error("CAPI error:", e.message));
  }

  res.status(200).json({ ok: true });
};

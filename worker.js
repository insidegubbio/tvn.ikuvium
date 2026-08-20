const ALLOWED_ORIGIN_PATTERN =
  /^https?:\/\/(([\w-]+\.)?insidegubbio\.com|([\w-]+\.)?insidegubbio\.framer\.ai)$/

const DEFAULT_MODEL = "gemini-3.5-flash-lite"
const GEMINI_TIMEOUT = 15000
const MAX_OUTPUT_TOKENS = 200

function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGIN_PATTERN.test(origin || "")
    ? origin
    : "https://insidegubbio.com"
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  }
}

function jsonResponse(data, status = 200, origin = "") {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
  })
}

function withTimeout(promise, ms, label = "timeout") {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} dopo ${ms}ms`)), ms)
    ),
  ])
}

function parseApiKeys(env) {
  const raw = env.GEMINI_API_KEYS || env.GEMINI_API_KEY || ""
  return raw.split(",").map(k => k.trim()).filter(Boolean)
}

async function fetchGeminiWithFallback(url, options, keys) {
  if (!keys.length) throw new Error("Nessuna chiave API Gemini configurata")

  let lastErr
  const pool = [...keys].sort(() => Math.random() - 0.5)

  for (const key of pool) {
    const urlWithKey = url.replace(/key=[^&]+/, `key=${key}`)
    try {
      const res = await fetch(urlWithKey, options)
      if (res.status === 429 || res.status === 403) {
        lastErr = new Error(`Quota esaurita su una chiave (status ${res.status})`)
        continue
      }
      return res
    } catch (err) {
      lastErr = err
    }
  }
  throw lastErr || new Error("Tutte le chiavi API hanno esaurito la quota")
}

function extractJsonBlock(text) {
  const match = text.match(/\{[\s\S]*\}/)
  if (!match) return null
  try {
    return JSON.parse(match[0])
  } catch {
    return null
  }
}

async function verificaConGemini(apiKeys, model, systemPrompt, domanda, rispostaCorretta, rispostaUtente) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=PLACEHOLDER`

  const userPrompt = `Domanda: ${domanda}
Risposta corretta attesa: ${rispostaCorretta}
Risposta data dall'utente: ${rispostaUtente}`

  const res = await withTimeout(
    fetchGeminiWithFallback(
      url,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: userPrompt }] }],
          systemInstruction: { parts: [{ text: systemPrompt }] },
          generationConfig: {
            temperature: 0,
            maxOutputTokens: MAX_OUTPUT_TOKENS,
            responseMimeType: "application/json",
          },
        }),
      },
      apiKeys
    ),
    GEMINI_TIMEOUT,
    "Gemini verifica"
  )

  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err?.error?.message || `Gemini HTTP ${res.status}`)
  }

  const data = await res.json()
  const text = (data?.candidates?.[0]?.content?.parts || [])
    .map(p => p.text || "")
    .join("")

  const parsed = extractJsonBlock(text)
  if (!parsed || typeof parsed.corretta !== "boolean") {
    throw new Error("Risposta del modello non interpretabile")
  }
  return parsed.corretta
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || ""
    const url = new URL(request.url)

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) })
    }

    if (request.method === "GET" && url.pathname === "/api/v1/health") {
      return jsonResponse({ status: "ok" }, 200, origin)
    }

    if (request.method === "POST" && url.pathname === "/api/v1/verifica-risposta") {
      if (!ALLOWED_ORIGIN_PATTERN.test(origin)) {
        return jsonResponse({ error: "Origine non autorizzata" }, 403, origin)
      }

      const apiKeys = parseApiKeys(env)
      if (!apiKeys.length) {
        return jsonResponse({ error: "Configurazione server mancante" }, 500, origin)
      }

      const systemPrompt = env.SYSTEM_PROMPT_VERIFICA
      if (!systemPrompt) {
        return jsonResponse({ error: "SYSTEM_PROMPT_VERIFICA non configurato" }, 500, origin)
      }

      let body
      try {
        body = await request.json()
      } catch {
        return jsonResponse({ error: "Body JSON non valido" }, 400, origin)
      }

      const domanda = (body?.domanda || "").trim()
      const rispostaCorretta = (body?.rispostaCorretta || "").trim()
      const rispostaUtente = (body?.rispostaUtente || "").trim()

      if (!domanda || !rispostaCorretta || !rispostaUtente) {
        return jsonResponse(
          { error: "Campi 'domanda', 'rispostaCorretta' e 'rispostaUtente' sono obbligatori" },
          400,
          origin
        )
      }

      const model = env.GEMINI_MODEL || DEFAULT_MODEL

      try {
        const corretta = await verificaConGemini(apiKeys, model, systemPrompt, domanda, rispostaCorretta, rispostaUtente)
        return jsonResponse({ corretta }, 200, origin)
      } catch (err) {
        return jsonResponse({ error: err.message || "Errore Gemini" }, 502, origin)
      }
    }

    return jsonResponse({ error: "Not found" }, 404, origin)
  },
}

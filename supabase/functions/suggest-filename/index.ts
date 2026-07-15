import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const model = Deno.env.get("ANTHROPIC_MODEL") ?? "claude-haiku-4-5";
const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY");
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return Response.json(body, {
    status,
    headers: corsHeaders
  });
}

function sanitizeExtension(filename: string) {
  const match = filename.match(/(\.[A-Za-z0-9]{1,12})$/);
  return match?.[1] ?? "";
}

function isValidSuggestion(value: string, extension: string) {
  if (!value.endsWith(extension)) return false;
  if (value.length > 80) return false;
  return /^[a-z0-9]+(?:-[a-z0-9]+)*(\.[A-Za-z0-9]{1,12})?$/.test(value);
}

function extractText(data: any): string {
  if (!Array.isArray(data?.content)) return "";
  for (const block of data.content) {
    if (block?.type === "text" && typeof block.text === "string") {
      return block.text;
    }
  }
  return "";
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405, headers: corsHeaders });
  }

  if (!anthropicKey) {
    return jsonResponse({ error: "ANTHROPIC_API_KEY is not configured" }, 500);
  }

  const { originalFilename, mimeType } = await request.json();
  const extension = sanitizeExtension(originalFilename ?? "");

  const prompt = [
    "Generate a short descriptive filename.",
    "Requirements:",
    "- lowercase",
    "- words separated by hyphens",
    "- keep extension exactly",
    "- maximum 6 words",
    "- no punctuation except hyphen and extension dot",
    "- no dates unless obvious",
    "- no generic words like image, photo, file",
    "Return only the filename.",
    `Original filename: ${originalFilename}`,
    `MIME type: ${mimeType ?? "unknown"}`
  ].join("\n");

  const aiResponse = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": anthropicKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      max_tokens: 64,
      messages: [{ role: "user", content: prompt }]
    })
  });

  if (!aiResponse.ok) {
    return jsonResponse({ error: "AI filename request failed" }, 502);
  }

  const data = await aiResponse.json();
  const suggestion = String(extractText(data)).trim();

  if (!isValidSuggestion(suggestion, extension)) {
    return jsonResponse({ error: "AI filename suggestion was invalid" }, 422);
  }

  return jsonResponse({ filename: suggestion });
});

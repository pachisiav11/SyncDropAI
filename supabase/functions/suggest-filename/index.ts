import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const model = Deno.env.get("OPENAI_MODEL") ?? "gpt-5.4-nano";
const openAiKey = Deno.env.get("OPENAI_API_KEY");
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

function extractOutputText(data: any): string {
  if (typeof data?.output_text === "string") return data.output_text;
  const output = Array.isArray(data?.output) ? data.output : [];
  for (const item of output) {
    if (item?.type !== "message" || !Array.isArray(item.content)) continue;
    for (const part of item.content) {
      if (part?.type === "output_text" && typeof part.text === "string") {
        return part.text;
      }
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

  if (!openAiKey) {
    return jsonResponse({ error: "OPENAI_API_KEY is not configured" }, 500);
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

  const aiResponse = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${openAiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      input: prompt,
      max_output_tokens: 40
    })
  });

  if (!aiResponse.ok) {
    return jsonResponse({ error: "AI filename request failed" }, 502);
  }

  const data = await aiResponse.json();
  const suggestion = String(extractOutputText(data)).trim();

  if (!isValidSuggestion(suggestion, extension)) {
    return jsonResponse({ error: "AI filename suggestion was invalid" }, 422);
  }

  return jsonResponse({ filename: suggestion });
});

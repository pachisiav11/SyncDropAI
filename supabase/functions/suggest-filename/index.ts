import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const model = Deno.env.get("OPENAI_MODEL") ?? "gpt-5.4-nano";
const openAiKey = Deno.env.get("OPENAI_API_KEY");

function sanitizeExtension(filename: string) {
  const match = filename.match(/(\.[A-Za-z0-9]{1,12})$/);
  return match?.[1] ?? "";
}

function isValidSuggestion(value: string, extension: string) {
  if (!value.endsWith(extension)) return false;
  if (value.length > 80) return false;
  return /^[a-z0-9]+(?:-[a-z0-9]+)*(\.[A-Za-z0-9]{1,12})?$/.test(value);
}

Deno.serve(async (request) => {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  if (!openAiKey) {
    return Response.json({ error: "OPENAI_API_KEY is not configured" }, { status: 500 });
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
    return Response.json({ error: "AI filename request failed" }, { status: 502 });
  }

  const data = await aiResponse.json();
  const suggestion = String(data.output_text ?? "").trim();

  if (!isValidSuggestion(suggestion, extension)) {
    return Response.json({ error: "AI filename suggestion was invalid" }, { status: 422 });
  }

  return Response.json({ filename: suggestion });
});

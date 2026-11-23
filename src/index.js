export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/api/probar") {
      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders() });
      }
      if (request.method !== "POST") {
        return jsonError("Metodo no permitido. Usa POST.", 405);
      }
      return handleProbarConIA(request, env);
    }

    return env.ASSETS.fetch(request);
  }
};

async function handleProbarConIA(request, env) {
  try {
    const contentType = request.headers.get("content-type") || "";
    if (!contentType.includes("multipart/form-data")) {
      return jsonError("Envia los datos como multipart/form-data.", 400);
    }

    const formData = await request.formData();
    const selfie = formData.get("selfie");
    const lente = formData.get("lente");
    const modelo = String(formData.get("modelo") || "Retro Carey").trim();

    if (!(selfie instanceof File) || !(lente instanceof File)) {
      return jsonError("Debes enviar los archivos selfie y lente.", 400);
    }

    const [selfieBuf, lenteBuf] = await Promise.all([
      selfie.arrayBuffer(),
      lente.arrayBuffer()
    ]);

    const provider = (env.AI_PROVIDER || "meta").toLowerCase();

    let result;
    if (provider === "meta") {
      if (!env.MODEL_API_KEY) {
        return jsonError("Falta MODEL_API_KEY en el Worker.", 500);
      }
      result = await runMetaMuseTryOn({
        apiKey: env.MODEL_API_KEY,
        modelo,
        selfieBase64: arrayBufferToBase64(selfieBuf),
        selfieMime: selfie.type || "image/jpeg",
        lenteBase64: arrayBufferToBase64(lenteBuf),
        lenteMime: lente.type || "image/png"
      });
    } else if (provider === "gemini") {
      if (!env.GEMINI_API_KEY) {
        return jsonError("Falta GEMINI_API_KEY en el Worker.", 500);
      }
      result = await runGeminiTryOn({
        apiKey: env.GEMINI_API_KEY,
        modelName: env.GEMINI_IMAGE_MODEL || "gemini-2.5-flash-image",
        modelo,
        selfieBase64: arrayBufferToBase64(selfieBuf),
        selfieMime: selfie.type || "image/jpeg",
        lenteBase64: arrayBufferToBase64(lenteBuf),
        lenteMime: lente.type || "image/png"
      });
    } else {
      return jsonError("Proveedor no soportado: " + provider, 400);
    }

    return new Response(result.bytes, {
      status: 200,
      headers: {
        "Content-Type": result.mimeType || "image/jpeg",
        "Cache-Control": "no-store",
        ...corsHeaders()
      }
    });
  } catch (err) {
    return jsonError(err && err.message ? err.message : "Error interno al generar la prueba.", 500);
  }
}

function buildTryOnPrompt(modelo) {
  return [
    "Combine the two reference images into a realistic virtual try-on photograph (Image 1 + Image 2 = Image 3).",
    "First image (Image 1): the user's selfie portrait.",
    "Second image (Image 2): the target eyeglasses frame.",
    "Place the eyeglasses from Image 2 (" + modelo + ") naturally onto the person's face in Image 1.",
    "Keep the person's identity, facial proportions, skin texture, hair, pose, hand position, lighting, and background faithful to Image 1.",
    "Match head tilt, perspective, bridge fit on the nose, subtle shadows, and realistic subtle reflections on the lenses.",
    "Return only the clean photograph without borders, phone UI frames, captions, or watermarks."
  ].join(" ");
}

async function runMetaMuseTryOn({ apiKey, modelo, selfieBase64, selfieMime, lenteBase64, lenteMime }) {
  const selfieDataUrl = "data:" + selfieMime + ";base64," + selfieBase64;
  const lenteDataUrl = "data:" + lenteMime + ";base64," + lenteBase64;

  const res = await fetch("https://api.meta.ai/v1/responses", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + apiKey,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "muse-image-1.0",
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: buildTryOnPrompt(modelo) },
            { type: "input_image", image_url: selfieDataUrl },
            { type: "input_image", image_url: lenteDataUrl }
          ]
        }
      ],
      tools: [
        {
          type: "image_generation",
          output_format: "jpeg",
          size: "1024x1536"
        }
      ]
    })
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error((data && data.error && data.error.message) || ("Error de Meta Model API (" + res.status + ")."));
  }

  const imgItem = (data && data.output ? data.output : []).find(
    (item) => item && item.type === "image_generation_call" && item.result
  );

  if (!imgItem) {
    throw new Error("Muse Image no devolvio una imagen en la respuesta.");
  }

  return {
    bytes: base64ToUint8Array(imgItem.result),
    mimeType: "image/jpeg"
  };
}

async function runGeminiTryOn({ apiKey, modelName, modelo, selfieBase64, selfieMime, lenteBase64, lenteMime }) {
  const endpoint = "https://generativelanguage.googleapis.com/v1beta/models/" + modelName + ":generateContent?key=" + encodeURIComponent(apiKey);

  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [
            { text: buildTryOnPrompt(modelo) },
            { inlineData: { mimeType: selfieMime, data: selfieBase64 } },
            { inlineData: { mimeType: lenteMime, data: lenteBase64 } }
          ]
        }
      ],
      generationConfig: {
        responseModalities: ["TEXT", "IMAGE"]
      }
    })
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error((data && data.error && data.error.message) || ("Error de Gemini (" + res.status + ")."));
  }

  const parts = (data && data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
  const imgPart = parts.find((p) => p && p.inlineData && p.inlineData.data);

  if (!imgPart) {
    const reason = parts.map((p) => p.text).filter(Boolean).join(" ").trim();
    throw new Error(reason || "Gemini no devolvio una imagen resultante.");
  }

  return {
    bytes: base64ToUint8Array(imgPart.inlineData.data),
    mimeType: (imgPart.inlineData && imgPart.inlineData.mimeType) || "image/png"
  };
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function base64ToUint8Array(base64) {
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization"
  };
}

function jsonError(message, status = 400) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders()
    }
  });
}

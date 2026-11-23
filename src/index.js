export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/api/probar") {
      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders() });
      }
      if (request.method !== "POST") {
        return jsonError("Método no permitido. Usa POST.", 405);
      }
      return handleProbarConIA(request, env);
    }

    // Sirve la webapp estática desde ./public
    return env.ASSETS.fetch(request);
  }
};

async function handleProbarConIA(request, env) {
  try {
    const contentType = request.headers.get("content-type") || "";
    if (!contentType.includes("multipart/form-data")) {
      return jsonError("Envía los datos como multipart/form-data.", 400);
    }

    const formData = await request.formData();
    const selfie = formData.get("selfie");
    const lente = formData.get("lente");
    const modelo = String(formData.get("modelo") || "Retro Carey").trim();

    if (!(selfie instanceof File) || !(lente instanceof File)) {
      return jsonError("Debes enviar los archivos 'selfie' y 'lente'.", 400);
    }

    const [selfieBuf, lenteBuf] = await Promise.all([
      selfie.arrayBuffer(),
      lente.arrayBuffer()
    ]);

    const provider = (env.AI_PROVIDER || "meta").toLowerCase();

    let result;
    if (provider === "meta") {
      if (!env.MODEL_API_KEY) {
        return jsonError("Falta MODEL_API_KEY en el Worker para AI_PROVIDER='meta'.", 500);
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
        return jsonError("Falta

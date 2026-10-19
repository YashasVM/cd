export default {
  async fetch(req, env) {
    const p = new URL(req.url).pathname;
    async function page(key, min) {
      try {
        const kv = env.LESSONS;
        if (kv) {
          const v = await kv.get(key);
          if (typeof v === "string" && v.length > min) { return v; }
        }
      } catch (e) {}
      return null;
    }
    if (p === "/whisperlow" || p === "/whisperlow/" || p === "/whisperlow/index.html") {
      const v = await page("lesson-001", 1000);
      if (v !== null) { return new Response(v, { headers: { "content-type": "text/html;charset=UTF-8", "cache-control": "public, max-age=300" } }); }
    }
    if (p === "/wl" || p === "/wl/" || p === "/wl/index.html") {
      const v = await page("cd-file-sharing-guide", 1000);
      if (v !== null) { return new Response(v, { headers: { "content-type": "text/html;charset=UTF-8", "cache-control": "public, max-age=300" } }); }
    }
    if (p === "/" || p === "/index.html") {
      const v = await page("root-redirect", 100);
      if (v !== null) { return new Response(v, { headers: { "content-type": "text/html;charset=UTF-8" } }); }
    }
    if (p === "/openstream" || p === "/openstream/" || p === "/openstream/index.html") {
      const v = await page("openstream-audit", 1000);
      if (v !== null) { return new Response(v, { headers: { "content-type": "text/html;charset=UTF-8" } }); }
    }
    if (env.ASSETS) { return env.ASSETS.fetch(req); }
    return new Response("see /whisperlow and /openstream/", { status: 404 });
  }
};

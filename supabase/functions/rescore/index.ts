// Supabase Edge Function: trigger the GitHub Actions scoring run on demand
// (used by the app's "Refresh now" button after changing home or adding a spot).
//
// Secrets (Supabase dashboard → Edge Functions → Secrets):
//   GH_TOKEN  fine-grained GitHub token, this repo only, permission "Actions: read and write"
//   GH_REPO   colesome/condfishions
// JWT verification stays ON (default), so only your signed-in app can call it.

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const repo = Deno.env.get("GH_REPO");
  const token = Deno.env.get("GH_TOKEN");
  if (!repo || !token) {
    return new Response(JSON.stringify({ ok: false, error: "GH_REPO / GH_TOKEN not set" }),
      { status: 500, headers: { ...cors, "Content-Type": "application/json" } });
  }
  const r = await fetch(
    `https://api.github.com/repos/${repo}/actions/workflows/score.yml/dispatches`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "condfishions-rescore",
      },
      body: JSON.stringify({ ref: "main" }),
    },
  );
  const ok = r.status === 204;
  return new Response(JSON.stringify({ ok, status: r.status }), {
    status: ok ? 200 : 502,
    headers: { ...cors, "Content-Type": "application/json" },
  });
});

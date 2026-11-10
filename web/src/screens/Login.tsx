import { useState } from "react";
import { api } from "../lib/api";

export function Login({ onDone }: { onDone: () => void }) {
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function go(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    const msg = await api.signIn(email, pw);
    setBusy(false);
    if (msg) setErr(msg); else onDone();
  }

  return (
    <form className="login" onSubmit={go}>
      <img src={`${import.meta.env.BASE_URL}icons/icon-192.png`} alt="" width={84} height={84} />
      <h1>CondFishions</h1>
      <input type="email" autoComplete="username" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} />
      <input type="password" autoComplete="current-password" placeholder="Password" value={pw} onChange={(e) => setPw(e.target.value)} />
      {err && <p className="hint err">{err}</p>}
      <button className="btn wide" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
    </form>
  );
}

export default function Flash({ ok, err }: { ok?: string; err?: string }) {
  if (err) return <div className="flash error" role="alert">{err}</div>;
  if (ok) return <div className="flash" role="status">{ok}</div>;
  return null;
}

// POST /api/waitlist  {email, ai, lang, source, website}
// `website` is a hidden field people never see; bots that fill it get a quiet "ok".
const AIS = ['claude', 'chatgpt', 'gemini', 'cursor', 'other'];
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function onRequestPost({ request, env }) {
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'bad_json' }, { status: 400 });
  }
  if (body.website) return Response.json({ ok: true });

  const email = String(body.email || '').trim().toLowerCase();
  if (email.length > 254 || !EMAIL.test(email)) return Response.json({ error: 'email' }, { status: 400 });
  const ai = AIS.includes(body.ai) ? body.ai : 'other';
  const lang = body.lang === 'ko' ? 'ko' : 'en';
  // Where the visitor came from (?src=reddit, ?src=youtube), so each channel's response can be compared.
  const source = String(body.source || '').slice(0, 32) || null;

  await env.DB.prepare('INSERT OR IGNORE INTO waitlist (email, ai, lang, source, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(email, ai, lang, source, Date.now())
    .run();
  return Response.json({ ok: true });
}

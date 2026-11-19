import { allowed } from '../store';

export async function POST(request: Request): Promise<Response> {
  const { email } = (await request.json()) as { email: string };
  const domain = String(email).split('@')[1]?.toLowerCase();
  if (!domain) return Response.json({ error: 'Enter an email address.' }, { status: 400 });
  if (!allowed.has(domain)) return Response.json({ error: `Invites to @${domain} are not allowed in this workspace.` }, { status: 403 });
  return Response.json({ invited: email });
}

import { allowed } from '../store';

export function GET(): Response {
  return Response.json({ domains: [...allowed] });
}

export async function POST(request: Request): Promise<Response> {
  const { domains } = (await request.json()) as { domains: string };
  allowed.clear();
  for (const domain of String(domains).split(',').map((d) => d.trim().toLowerCase()).filter(Boolean)) allowed.add(domain);
  return Response.json({ domains: [...allowed] });
}

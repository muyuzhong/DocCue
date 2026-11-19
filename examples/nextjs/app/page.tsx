'use client';
/** The app's own page: invite a teammate, and the email domains invites are allowed for. */
import { useEffect, useState, type CSSProperties, type FormEvent } from 'react';

const section: CSSProperties = { background: '#fff', border: '1px solid #e2e8f0', borderRadius: 10, padding: 20, marginBottom: 20 };
const input: CSSProperties = { font: 'inherit', padding: '6px 10px', border: '1px solid #cbd5e1', borderRadius: 6, width: '100%', boxSizing: 'border-box' };
const button: CSSProperties = { font: 'inherit', marginTop: 12, padding: '6px 16px', borderRadius: 6, border: 0, background: '#2563eb', color: '#fff', cursor: 'pointer' };
const label: CSSProperties = { display: 'block', fontWeight: 600, marginBottom: 4 };

const post = (path: string, data: unknown) => fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });

export default function Members() {
  const [email, setEmail] = useState('');
  const [invite, setInvite] = useState<{ ok: boolean; text: string }>();
  const [domains, setDomains] = useState('');
  const [saved, setSaved] = useState('');

  useEffect(() => {
    void fetch('/api/domains').then(async (response) => setDomains(((await response.json()) as { domains: string[] }).domains.join(', ')));
  }, []);

  async function sendInvite(event: FormEvent) {
    event.preventDefault();
    const response = await post('/api/invite', { email });
    const result = (await response.json()) as { invited?: string; error?: string };
    setInvite({ ok: response.ok, text: response.ok ? `Invite sent to ${result.invited}.` : (result.error ?? 'Something went wrong.') });
  }

  async function saveDomains(event: FormEvent) {
    event.preventDefault();
    const result = (await (await post('/api/domains', { domains })).json()) as { domains: string[] };
    setDomains(result.domains.join(', '));
    setSaved('Saved.');
  }

  return (
    <main style={{ maxWidth: 640, margin: '40px auto', padding: '0 20px' }}>
      <h1 style={{ fontSize: 22 }}>Members</h1>

      <section style={section}>
        <h2 style={{ fontSize: 17, marginTop: 0 }}>Invite a teammate</h2>
        <form onSubmit={sendInvite}>
          <label htmlFor="email" style={label}>Email</label>
          <input id="email" type="email" placeholder="name@company.com" value={email} onChange={(event) => setEmail(event.target.value)} style={input} />
          <button type="submit" style={button}>Send invite</button>
          <p role="alert" style={{ color: invite?.ok ? '#15803d' : '#b91c1c' }}>{invite?.text}</p>
        </form>
      </section>

      <section style={section}>
        <h2 style={{ fontSize: 17, marginTop: 0 }}>Allowed email domains</h2>
        <form onSubmit={saveDomains}>
          <label htmlFor="domain-list" style={label}>Domains</label>
          <input id="domain-list" value={domains} onChange={(event) => setDomains(event.target.value)} style={input} />
          <p style={{ color: '#64748b', fontSize: 13 }}>Separate domains with commas.</p>
          <button type="submit" style={button}>Save domains</button>
          <p role="status">{saved}</p>
        </form>
      </section>
    </main>
  );
}

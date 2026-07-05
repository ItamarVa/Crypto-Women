#!/usr/bin/env node
/**
 * gdoc-export.mjs — export one Google Doc to .docx via the Drive API.
 *
 * A tiny, self-contained subprocess so blog-import.mjs can stay synchronous
 * (it shells out to this the same way it shells out to `markitdown`). Auth is a
 * Google service account: no interactive login, no token to refresh, works
 * headless forever. The doc (or its containing folder) must be shared with the
 * service-account e-mail — see scripts/watcher/README.md.
 *
 *   node gdoc-export.mjs --id <docId> --key <sa.json> --out <path.docx>
 *   node gdoc-export.mjs --id <docId> --key <sa.json> --meta-only
 *
 * On success prints ONE line of JSON to stdout: {name, createdTime, modifiedTime}.
 * On failure exits non-zero with the reason on stderr.
 */
import fs from 'node:fs';
import { GoogleAuth } from 'google-auth-library';

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const SCOPES = ['https://www.googleapis.com/auth/drive.readonly'];

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const id = arg('id');
  const keyFile = arg('key');
  const out = arg('out');
  const metaOnly = process.argv.includes('--meta-only');
  if (!id) throw new Error('missing --id');
  if (!keyFile || !fs.existsSync(keyFile)) throw new Error(`service-account key not found: ${keyFile}`);

  const auth = new GoogleAuth({ keyFile, scopes: SCOPES });
  const client = await auth.getClient();
  const { token } = await client.getAccessToken();
  const authHeader = { Authorization: `Bearer ${token}` };

  const metaUrl =
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}` +
    `?fields=name,createdTime,modifiedTime,mimeType&supportsAllDrives=true`;
  const mr = await fetch(metaUrl, { headers: authHeader });
  if (!mr.ok) throw new Error(`metadata ${mr.status}: ${(await mr.text()).slice(0, 200)}`);
  const meta = await mr.json();

  if (!metaOnly) {
    if (!out) throw new Error('missing --out');
    if (meta.mimeType !== 'application/vnd.google-apps.document') {
      throw new Error(`not a Google Doc (mimeType=${meta.mimeType})`);
    }
    const expUrl =
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}/export` +
      `?mimeType=${encodeURIComponent(DOCX_MIME)}`;
    const er = await fetch(expUrl, { headers: authHeader });
    if (!er.ok) throw new Error(`export ${er.status}: ${(await er.text()).slice(0, 200)}`);
    fs.writeFileSync(out, Buffer.from(await er.arrayBuffer()));
  }

  process.stdout.write(JSON.stringify({
    name: meta.name,
    createdTime: meta.createdTime,
    modifiedTime: meta.modifiedTime,
  }));
}

main().catch((e) => {
  process.stderr.write(String(e && e.message ? e.message : e));
  process.exit(1);
});

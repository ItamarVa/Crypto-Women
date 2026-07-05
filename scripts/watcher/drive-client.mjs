/**
 * drive-client.mjs — read the blog folder straight from Google Drive (the cloud),
 * with a service account. This removes the dependency on Google Drive for Desktop
 * (which only starts at user login): the watcher can pull new/changed/deleted docs
 * from the cloud headlessly, at boot, whether or not anyone is logged in.
 *
 * Read-only (scope drive.readonly). The blog folder must be shared with the SA.
 */
import fs from 'node:fs';
import { GoogleAuth } from 'google-auth-library';

const SCOPES = ['https://www.googleapis.com/auth/drive.readonly'];
export const DOC_MIME = 'application/vnd.google-apps.document';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const MD_MIME = 'text/markdown';

// Cache the access token for its lifetime (~1h) to avoid re-minting every call.
let _token = null;
let _tokenExp = 0;
async function getToken(keyFile) {
  if (_token && Date.now() < _tokenExp) return _token;
  const auth = new GoogleAuth({ keyFile, scopes: SCOPES });
  const client = await auth.getClient();
  const { token } = await client.getAccessToken();
  _token = token;
  _tokenExp = Date.now() + 50 * 60 * 1000; // refresh a little before the 1h expiry
  return _token;
}

async function driveGet(pathAndQuery, keyFile) {
  const token = await getToken(keyFile);
  const r = await fetch(`https://www.googleapis.com/drive/v3/${pathAndQuery}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new Error(`Drive ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r;
}

/** All non-trashed children of a folder (paginated). */
async function listChildren(parentId, keyFile) {
  let files = [];
  let pageToken = '';
  do {
    const q = encodeURIComponent(`'${parentId}' in parents and trashed = false`);
    const fields = encodeURIComponent('nextPageToken,files(id,name,mimeType,modifiedTime,createdTime)');
    const page = pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '';
    const r = await driveGet(
      `files?q=${q}&fields=${fields}&pageSize=200&supportsAllDrives=true&includeItemsFromAllDrives=true${page}`,
      keyFile,
    );
    const j = await r.json();
    files = files.concat(j.files || []);
    pageToken = j.nextPageToken || '';
  } while (pageToken);
  return files;
}

/**
 * Flat list of every publishable file under the blog folder, tagged with the
 * category = its sub-folder name (root-level files get category null → default).
 * @returns {Promise<Array<{id,name,mimeType,modifiedTime,createdTime,category}>>}
 */
export async function listBlogFiles(folderId, keyFile) {
  const top = await listChildren(folderId, keyFile);
  const out = [];
  for (const f of top) {
    if (f.mimeType === FOLDER_MIME) continue;
    out.push({ ...f, category: null });
  }
  for (const sub of top.filter((f) => f.mimeType === FOLDER_MIME)) {
    for (const f of await listChildren(sub.id, keyFile)) {
      if (f.mimeType === FOLDER_MIME) continue; // one level of categories only
      out.push({ ...f, category: sub.name });
    }
  }
  return out;
}

/** Export a Google Doc to Markdown text (Drive does the conversion). */
export async function exportDocMarkdown(id, keyFile) {
  const r = await driveGet(`files/${encodeURIComponent(id)}/export?mimeType=${encodeURIComponent(MD_MIME)}`, keyFile);
  return r.text();
}

/** Download a text file's raw content (e.g. an uploaded .md). */
export async function downloadText(id, keyFile) {
  const r = await driveGet(`files/${encodeURIComponent(id)}?alt=media&supportsAllDrives=true`, keyFile);
  return r.text();
}

/** Download a binary file (docx/pdf/…) to a local path for markitdown. */
export async function downloadBinary(id, dest, keyFile) {
  const r = await driveGet(`files/${encodeURIComponent(id)}?alt=media&supportsAllDrives=true`, keyFile);
  fs.writeFileSync(dest, Buffer.from(await r.arrayBuffer()));
}

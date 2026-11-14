const { put, list, del } = require('@vercel/blob');

const STATE_KEY = 'uhs-saraitand-portal-state-v1.json';

function collectActiveBlobUrls(st) {
  const urls = new Set();
  if (!st || typeof st !== 'object') return urls;
  const add = (u) => {
    if (typeof u === 'string' && u.includes('blob.vercel-storage.com')) {
      urls.add(u);
    }
  };
  add(st.logoDataUrl);
  add(st.heroPhotoDataUrl);
  (st.notices || []).forEach((n) => add(n.pdfData));
  (st.boardItems || []).forEach((b) => add(b.pdfData));
  (st.forms || []).forEach((f) => add(f.pdfData));
  (st.pdfDocs || []).forEach((d) => add(d.pdfData));
  (st.gallerySlots || []).forEach((g) => add(g.photo));
  (st.teacherSlots || []).forEach((t) => add(t.photo));
  if (st.toppers && typeof st.toppers === 'object') {
    Object.values(st.toppers).forEach((grp) => {
      ((grp && grp.ranks) || []).forEach((r) => add(r.photo));
    });
  }
  return urls;
}

async function loadCloudState() {
  if (!process.env.BLOB_READ_WRITE_TOKEN) return null;
  const { blobs } = await list({ prefix: STATE_KEY, limit: 5 });
  const match = blobs.find((b) => b.pathname === STATE_KEY) || blobs[0];
  if (!match) return null;
  const res = await fetch(match.url, { cache: 'no-store' });
  if (!res.ok) return null;
  return await res.json();
}

async function saveCloudState(stateObj) {
  const blob = await put(STATE_KEY, JSON.stringify(stateObj), {
    access: 'public',
    addRandomSuffix: false,
    contentType: 'application/json',
    cacheControlMaxAge: 0
  });
  return blob.url;
}

async function getStorageStats() {
  const { blobs } = await list({ limit: 1000 });
  let totalBytes = 0;
  let fileCount = 0;
  blobs.forEach((b) => {
    totalBytes += b.size || 0;
    if (b.pathname !== STATE_KEY) fileCount += 1;
  });
  return { totalBytes, fileCount };
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  try {
    if (!process.env.BLOB_READ_WRITE_TOKEN) {
      return res.status(200).json({
        cloudConfigured: false,
        message: 'Connect a free Vercel Blob store in Vercel Dashboard -> Storage -> Create Blob Store.'
      });
    }

    if (req.method === 'GET') {
      const [data, stats] = await Promise.all([loadCloudState(), getStorageStats()]);
      return res.status(200).json({
        cloudConfigured: true,
        state: data,
        storageStats: stats
      });
    }

    if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});

      // 1. Public student complaint submission
      if (body.action === 'submit_complaint' && body.complaint) {
        const current = (await loadCloudState()) || {};
        if (current.acceptComplaints === false) {
          return res.status(403).json({ error: 'Complaint box is closed by Principal.' });
        }
        current.complaints = Array.isArray(current.complaints) ? current.complaints : [];
        current.complaints.unshift(body.complaint);
        await saveCloudState(current);
        return res.status(200).json({ ok: true, state: current });
      }

      // Authenticate Principal for all admin actions below
      const existing = await loadCloudState();
      const validPass = (existing && existing.principalPass) || 'Saraitand@2026';
      if (body.password !== validPass && body.oldPassword !== validPass) {
        return res.status(401).json({ error: 'Unauthorized: Invalid Principal password' });
      }

      // 2. Upload an image or PDF file to Vercel Blob CDN
      if (body.action === 'upload_file' && body.dataUrl && body.fileName) {
        const matches = String(body.dataUrl).match(/^data:([^;]+);base64,(.+)$/);
        if (!matches) {
          return res.status(400).json({ error: 'Invalid file format' });
        }
        const contentType = matches[1];
        const buffer = Buffer.from(matches[2], 'base64');
        const safeName = 'uploads/' + Date.now() + '-' + String(body.fileName).replace(/[^a-zA-Z0-9._-]/g, '_');
        const uploaded = await put(safeName, buffer, {
          access: 'public',
          addRandomSuffix: true,
          contentType: contentType
        });
        const stats = await getStorageStats();
        return res.status(200).json({ ok: true, url: uploaded.url, storageStats: stats });
      }

      // 3. Save full portal state AND automatically delete any removed/replaced Blob files!
      if (body.action === 'save_state' && body.state) {
        const oldUrls = collectActiveBlobUrls(existing);
        const newUrls = collectActiveBlobUrls(body.state);
        const removedUrls = [];
        oldUrls.forEach((u) => {
          if (!newUrls.has(u)) removedUrls.push(u);
        });
        if (removedUrls.length > 0) {
          try {
            await del(removedUrls);
          } catch (delErr) {
            console.warn('Blob delete warning:', delErr);
          }
        }
        await saveCloudState(body.state);
        const stats = await getStorageStats();
        return res.status(200).json({
          ok: true,
          deletedFilesCount: removedUrls.length,
          storageStats: stats
        });
      }

      // 4. One-click Orphan Cleanup (deletes any unreferenced files in Vercel Blob)
      if (body.action === 'cleanup_orphans') {
        const current = (await loadCloudState()) || {};
        const activeUrls = collectActiveBlobUrls(current);
        const { blobs } = await list({ prefix: 'uploads/', limit: 1000 });
        const orphanUrls = blobs
          .filter((b) => !activeUrls.has(b.url))
          .map((b) => b.url);
        if (orphanUrls.length > 0) {
          await del(orphanUrls);
        }
        const stats = await getStorageStats();
        return res.status(200).json({
          ok: true,
          cleanedCount: orphanUrls.length,
          storageStats: stats
        });
      }

      return res.status(400).json({ error: 'Unknown action' });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Server error' });
  }
};

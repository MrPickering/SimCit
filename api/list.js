import { list } from '@vercel/blob';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { blobs } = await list({ prefix: 'saves/' });

    const saves = blobs.map(blob => {
      // Extract save ID from filename (saves/saveId.json)
      const match = blob.pathname.match(/saves\/(.+)\.json$/);
      return {
        saveId: match ? match[1] : blob.pathname,
        url: blob.url,
        uploadedAt: blob.uploadedAt,
        size: blob.size,
      };
    });

    return res.status(200).json({
      success: true,
      saves,
    });
  } catch (error) {
    console.error('List error:', error);
    return res.status(500).json({ error: 'Failed to list saves' });
  }
}

import { list } from '@vercel/blob';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { saveId } = req.query;

    if (!saveId) {
      return res.status(400).json({ error: 'Missing saveId parameter' });
    }

    // Sanitize saveId to prevent path traversal
    const sanitizedId = saveId.replace(/[^a-zA-Z0-9-_]/g, '');
    const prefix = `saves/${sanitizedId}.json`;

    // List blobs to find the exact file
    const { blobs } = await list({ prefix });

    if (blobs.length === 0) {
      return res.status(404).json({ error: 'Save not found' });
    }

    // Fetch the save data from the blob URL
    const response = await fetch(blobs[0].url);
    const gameData = await response.json();

    return res.status(200).json({
      success: true,
      gameData,
      saveId: sanitizedId,
    });
  } catch (error) {
    console.error('Load error:', error);
    return res.status(500).json({ error: 'Failed to load game' });
  }
}

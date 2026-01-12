import { put } from '@vercel/blob';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { saveId, gameData } = req.body;

    if (!saveId || !gameData) {
      return res.status(400).json({ error: 'Missing saveId or gameData' });
    }

    // Sanitize saveId to prevent path traversal
    const sanitizedId = saveId.replace(/[^a-zA-Z0-9-_]/g, '');
    const filename = `saves/${sanitizedId}.json`;

    const blob = await put(filename, JSON.stringify(gameData), {
      access: 'public',
      addRandomSuffix: false,
    });

    return res.status(200).json({
      success: true,
      url: blob.url,
      saveId: sanitizedId,
    });
  } catch (error) {
    console.error('Save error:', error);
    return res.status(500).json({ error: 'Failed to save game' });
  }
}

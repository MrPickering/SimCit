import { list } from '@vercel/blob';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { code } = req.query;

    if (!code) {
      return res.status(400).json({ error: 'Missing access code' });
    }

    // Sanitize code - only allow alphanumeric, uppercase
    const sanitizedCode = code.toUpperCase().replace(/[^A-Z0-9]/g, '');

    if (sanitizedCode.length !== 6) {
      return res.status(400).json({ error: 'Invalid access code format' });
    }

    const prefix = `saves/${sanitizedCode}.json`;

    // List blobs to find the exact file
    const { blobs } = await list({ prefix });

    if (blobs.length === 0) {
      return res.status(404).json({ error: 'Save not found. Check your access code.' });
    }

    // Fetch the save data from the blob URL
    const response = await fetch(blobs[0].url);
    const gameData = await response.json();

    return res.status(200).json({
      success: true,
      gameData,
    });
  } catch (error) {
    console.error('Load error:', error);
    return res.status(500).json({ error: 'Failed to load game' });
  }
}

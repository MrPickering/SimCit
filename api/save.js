import { put } from '@vercel/blob';

// Generate a random 6-character alphanumeric code
function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Removed confusing chars (0,O,1,I)
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { gameData } = req.body;

    if (!gameData) {
      return res.status(400).json({ error: 'Missing gameData' });
    }

    // Generate a unique access code
    const accessCode = generateCode();
    const filename = `saves/${accessCode}.json`;

    const blob = await put(filename, JSON.stringify(gameData), {
      access: 'public',
      addRandomSuffix: false,
    });

    return res.status(200).json({
      success: true,
      url: blob.url,
      accessCode: accessCode,
    });
  } catch (error) {
    console.error('Save error:', error);
    return res.status(500).json({ error: 'Failed to save game' });
  }
}

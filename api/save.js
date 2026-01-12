import { put } from '@vercel/blob';

export const config = {
  runtime: 'edge',
};

export default async function handler(request) {
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const body = await request.json();
    const { saveId, gameData } = body;

    if (!saveId || !gameData) {
      return new Response(JSON.stringify({ error: 'Missing saveId or gameData' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Sanitize saveId to prevent path traversal
    const sanitizedId = saveId.replace(/[^a-zA-Z0-9-_]/g, '');
    const filename = `saves/${sanitizedId}.json`;

    const blob = await put(filename, JSON.stringify(gameData), {
      access: 'public',
      addRandomSuffix: false,
    });

    return new Response(JSON.stringify({
      success: true,
      url: blob.url,
      saveId: sanitizedId,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Save error:', error);
    return new Response(JSON.stringify({ error: 'Failed to save game' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

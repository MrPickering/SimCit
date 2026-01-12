import { list } from '@vercel/blob';

export const config = {
  runtime: 'edge',
};

export default async function handler(request) {
  if (request.method !== 'GET') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const url = new URL(request.url);
    const saveId = url.searchParams.get('saveId');

    if (!saveId) {
      return new Response(JSON.stringify({ error: 'Missing saveId parameter' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Sanitize saveId to prevent path traversal
    const sanitizedId = saveId.replace(/[^a-zA-Z0-9-_]/g, '');
    const prefix = `saves/${sanitizedId}.json`;

    // List blobs to find the exact file
    const { blobs } = await list({ prefix });

    if (blobs.length === 0) {
      return new Response(JSON.stringify({ error: 'Save not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Fetch the save data from the blob URL
    const response = await fetch(blobs[0].url);
    const gameData = await response.json();

    return new Response(JSON.stringify({
      success: true,
      gameData,
      saveId: sanitizedId,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Load error:', error);
    return new Response(JSON.stringify({ error: 'Failed to load game' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

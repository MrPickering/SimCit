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

    return new Response(JSON.stringify({
      success: true,
      saves,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('List error:', error);
    return new Response(JSON.stringify({ error: 'Failed to list saves' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

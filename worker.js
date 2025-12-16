// worker.js - Cloudflare Worker for Telegram CDN Proxy
// Deploy this to Cloudflare Workers

// Environment variables needed (set in Cloudflare Dashboard):
// BOT_TOKEN - Your Telegram bot token
// CHANNEL_ID - Your Telegram channel ID
// SECRET_KEY - Random secret for URL signing
// VIDEOS - KV namespace binding

export default {
  async fetch(request, env) {
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (path === '/api/upload' && request.method === 'POST') {
        return await handleUpload(request, env, corsHeaders);
      }
      
      if (path === '/api/videos' && request.method === 'GET') {
        return await handleGetVideos(env, corsHeaders);
      }
      
      if (path.startsWith('/api/video/') && path.endsWith('/stream')) {
        return await handleStream(request, env, corsHeaders);
      }
      
      if (path.startsWith('/api/video/') && request.method === 'GET') {
        return await handleGetVideo(request, env, corsHeaders);
      }
      
      if (path.startsWith('/api/video/') && request.method === 'DELETE') {
        return await handleDelete(request, env, corsHeaders);
      }
      
      if (path === '/api/health') {
        return jsonResponse({ status: 'ok', timestamp: new Date().toISOString() }, corsHeaders);
      }

      return jsonResponse({ error: 'Not found' }, corsHeaders, 404);

    } catch (error) {
      console.error('Worker error:', error);
      return jsonResponse({ error: error.message }, corsHeaders, 500);
    }
  }
};

// Upload video to Telegram
async function handleUpload(request, env, corsHeaders) {
  try {
    const formData = await request.formData();
    const title = formData.get('title');
    const description = formData.get('description');
    const videoFile = formData.get('video');

    if (!videoFile) {
      return jsonResponse({ success: false, error: 'No video file' }, corsHeaders, 400);
    }

    // Check file size
    const maxSize = 2 * 1024 * 1024 * 1024; // 2GB
    if (videoFile.size > maxSize) {
      return jsonResponse({ 
        success: false, 
        error: 'File too large. Max 2GB (4GB with Premium)' 
      }, corsHeaders, 400);
    }

    // Upload to Telegram
    const telegramFormData = new FormData();
    telegramFormData.append('chat_id', env.CHANNEL_ID);
    telegramFormData.append('video', videoFile);
    telegramFormData.append('caption', `${title}\n\n${description}`);
    telegramFormData.append('supports_streaming', 'true');

    const response = await fetch(
      `https://api.telegram.org/bot${env.BOT_TOKEN}/sendVideo`,
      {
        method: 'POST',
        body: telegramFormData,
      }
    );

    const result = await response.json();

    if (!result.ok) {
      return jsonResponse({ 
        success: false, 
        error: result.description || 'Upload failed' 
      }, corsHeaders, 500);
    }

    // Extract video info
    const video = result.result.video;
    const videoId = generateVideoId();
    
    // Store metadata in KV
    const metadata = {
      id: videoId,
      title,
      description,
      fileId: video.file_id,
      fileUniqueId: video.file_unique_id,
      duration: video.duration,
      width: video.width,
      height: video.height,
      fileSize: video.file_size,
      mimeType: video.mime_type,
      thumbnailFileId: video.thumb?.file_id,
      messageId: result.result.message_id,
      uploadDate: new Date().toISOString(),
      views: 0,
    };

    await env.VIDEOS.put(`video:${videoId}`, JSON.stringify(metadata));
    
    // Add to video list
    const videoList = await getVideoList(env);
    videoList.unshift(videoId);
    await env.VIDEOS.put('video:list', JSON.stringify(videoList));

    return jsonResponse({
      success: true,
      videoId,
      title,
      duration: video.duration,
    }, corsHeaders);

  } catch (error) {
    console.error('Upload error:', error);
    return jsonResponse({ success: false, error: error.message }, corsHeaders, 500);
  }
}

// Get all videos
async function handleGetVideos(env, corsHeaders) {
  try {
    const videoList = await getVideoList(env);
    const videos = [];

    for (const videoId of videoList) {
      const metadataStr = await env.VIDEOS.get(`video:${videoId}`);
      if (metadataStr) {
        const metadata = JSON.parse(metadataStr);
        videos.push({
          id: metadata.id,
          title: metadata.title,
          description: metadata.description,
          duration: metadata.duration,
          views: metadata.views,
          uploadDate: metadata.uploadDate,
        });
      }
    }

    return jsonResponse({ success: true, videos }, corsHeaders);
  } catch (error) {
    return jsonResponse({ success: false, error: error.message }, corsHeaders, 500);
  }
}

// Get single video details
async function handleGetVideo(request, env, corsHeaders) {
  try {
    const url = new URL(request.url);
    const videoId = url.pathname.split('/')[3];

    const metadataStr = await env.VIDEOS.get(`video:${videoId}`);
    if (!metadataStr) {
      return jsonResponse({ success: false, error: 'Video not found' }, corsHeaders, 404);
    }

    const metadata = JSON.parse(metadataStr);
    
    // Generate signed URL
    const { signature, expires } = generateSignedUrl(videoId, env.SECRET_KEY);

    return jsonResponse({
      success: true,
      video: {
        id: metadata.id,
        title: metadata.title,
        description: metadata.description,
        duration: metadata.duration,
        views: metadata.views,
        uploadDate: metadata.uploadDate,
        streamUrl: `/api/video/${videoId}/stream?signature=${signature}&expires=${expires}`
      }
    }, corsHeaders);

  } catch (error) {
    return jsonResponse({ success: false, error: error.message }, corsHeaders, 500);
  }
}

// Stream video (PROXY - hides Telegram)
async function handleStream(request, env, corsHeaders) {
  try {
    const url = new URL(request.url);
    const videoId = url.pathname.split('/')[3];
    const signature = url.searchParams.get('signature');
    const expires = url.searchParams.get('expires');

    // Verify signed URL
    if (!verifySignedUrl(videoId, signature, expires, env.SECRET_KEY)) {
      return jsonResponse({ error: 'Invalid or expired signature' }, corsHeaders, 403);
    }

    const metadataStr = await env.VIDEOS.get(`video:${videoId}`);
    if (!metadataStr) {
      return jsonResponse({ error: 'Video not found' }, corsHeaders, 404);
    }

    const metadata = JSON.parse(metadataStr);

    // Increment view count
    metadata.views++;
    await env.VIDEOS.put(`video:${videoId}`, JSON.stringify(metadata));

    // Get file URL from Telegram
    const fileResponse = await fetch(
      `https://api.telegram.org/bot${env.BOT_TOKEN}/getFile?file_id=${metadata.fileId}`
    );
    const fileResult = await fileResponse.json();

    if (!fileResult.ok) {
      return jsonResponse({ error: 'Failed to get file' }, corsHeaders, 500);
    }

    const fileUrl = `https://api.telegram.org/file/bot${env.BOT_TOKEN}/${fileResult.result.file_path}`;

    // Proxy the video stream
    const videoResponse = await fetch(fileUrl, {
      headers: {
        'Range': request.headers.get('Range') || 'bytes=0-'
      }
    });

    // Create response with proper headers (hide Telegram origin)
    const headers = new Headers(corsHeaders);
    headers.set('Content-Type', 'video/mp4');
    headers.set('Accept-Ranges', 'bytes');
    
    if (videoResponse.headers.get('Content-Range')) {
      headers.set('Content-Range', videoResponse.headers.get('Content-Range'));
    }
    
    if (videoResponse.headers.get('Content-Length')) {
      headers.set('Content-Length', videoResponse.headers.get('Content-Length'));
    }

    // Remove any Telegram-specific headers
    headers.delete('X-Telegram-Bot-Api-Secret-Token');
    
    return new Response(videoResponse.body, {
      status: videoResponse.status,
      headers: headers
    });

  } catch (error) {
    console.error('Stream error:', error);
    return jsonResponse({ error: error.message }, corsHeaders, 500);
  }
}

// Delete video
async function handleDelete(request, env, corsHeaders) {
  try {
    const url = new URL(request.url);
    const videoId = url.pathname.split('/')[3];

    const metadataStr = await env.VIDEOS.get(`video:${videoId}`);
    if (!metadataStr) {
      return jsonResponse({ success: false, error: 'Video not found' }, corsHeaders, 404);
    }

    const metadata = JSON.parse(metadataStr);

    // Delete from Telegram
    await fetch(
      `https://api.telegram.org/bot${env.BOT_TOKEN}/deleteMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: env.CHANNEL_ID,
          message_id: metadata.messageId
        })
      }
    );

    // Remove from KV
    await env.VIDEOS.delete(`video:${videoId}`);

    // Update video list
    const videoList = await getVideoList(env);
    const newList = videoList.filter(id => id !== videoId);
    await env.VIDEOS.put('video:list', JSON.stringify(newList));

    return jsonResponse({ success: true, message: 'Video deleted' }, corsHeaders);

  } catch (error) {
    return jsonResponse({ success: false, error: error.message }, corsHeaders, 500);
  }
}

// Helper functions

function generateVideoId() {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

async function getVideoList(env) {
  const listStr = await env.VIDEOS.get('video:list');
  return listStr ? JSON.parse(listStr) : [];
}

function generateSignedUrl(videoId, secretKey, expiresIn = 3600) {
  const expires = Date.now() + (expiresIn * 1000);
  const data = `${videoId}:${expires}`;
  const signature = btoa(data + secretKey).slice(0, 32);
  return { signature, expires };
}

function verifySignedUrl(videoId, signature, expires, secretKey) {
  if (Date.now() > parseInt(expires)) {
    return false;
  }
  const data = `${videoId}:${expires}`;
  const expectedSignature = btoa(data + secretKey).slice(0, 32);
  return signature === expectedSignature;
}

function jsonResponse(data, corsHeaders, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders
    }
  });
}

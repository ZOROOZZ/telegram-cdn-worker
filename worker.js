// Cloudflare Worker with MTProto Support
// Small files (<20 MB): Bot API
// Large files (>20 MB): MTProto Service

export default {
  async fetch(request, env) {
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Range',
      'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges',
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
      
      if (path === '/api/save-metadata' && request.method === 'POST') {
        return await handleSaveMetadata(request, env, corsHeaders);
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

async function handleUpload(request, env, corsHeaders) {
  try {
    const formData = await request.formData();
    const title = formData.get('title');
    const description = formData.get('description');
    const videoFile = formData.get('video');

    if (!videoFile) {
      return jsonResponse({ success: false, error: 'No video file' }, corsHeaders, 400);
    }

    const maxSize = 2 * 1024 * 1024 * 1024;
    if (videoFile.size > maxSize) {
      return jsonResponse({ 
        success: false, 
        error: 'File too large. Max 2GB (4GB with Premium)' 
      }, corsHeaders, 400);
    }

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

    const video = result.result.video;
    const videoId = generateVideoId();
    
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
    
    const videoList = await getVideoList(env);
    videoList.unshift(videoId);
    await env.VIDEOS.put('video:list', JSON.stringify(videoList));

    return jsonResponse({
      success: true,
      videoId,
      title,
      duration: video.duration,
      fileSize: video.file_size,
      isLarge: video.file_size > 20 * 1024 * 1024,
    }, corsHeaders);

  } catch (error) {
    console.error('Upload error:', error);
    return jsonResponse({ success: false, error: error.message }, corsHeaders, 500);
  }
}

async function handleSaveMetadata(request, env, corsHeaders) {
  try {
    const metadata = await request.json();
    
    if (!metadata || !metadata.id) {
      return jsonResponse({ success: false, error: 'Invalid metadata' }, corsHeaders, 400);
    }
    
    console.log('Saving metadata for video:', metadata.id);
    
    // Save metadata to KV
    await env.VIDEOS.put(`video:${metadata.id}`, JSON.stringify(metadata));
    
    // Add to video list
    const videoList = await getVideoList(env);
    videoList.unshift(metadata.id);
    await env.VIDEOS.put('video:list', JSON.stringify(videoList));
    
    return jsonResponse({ success: true, videoId: metadata.id }, corsHeaders);
    
  } catch (error) {
    console.error('Save metadata error:', error);
    return jsonResponse({ success: false, error: error.message }, corsHeaders, 500);
  }
}

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
          fileSize: metadata.fileSize,
        });
      }
    }

    return jsonResponse({ success: true, videos }, corsHeaders);
  } catch (error) {
    return jsonResponse({ success: false, error: error.message }, corsHeaders, 500);
  }
}

async function handleGetVideo(request, env, corsHeaders) {
  try {
    const url = new URL(request.url);
    const videoId = url.pathname.split('/')[3];

    const metadataStr = await env.VIDEOS.get(`video:${videoId}`);
    if (!metadataStr) {
      return jsonResponse({ success: false, error: 'Video not found' }, corsHeaders, 404);
    }

    const metadata = JSON.parse(metadataStr);
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
        fileSize: metadata.fileSize,
        streamUrl: `/api/video/${videoId}/stream?signature=${signature}&expires=${expires}`,
      }
    }, corsHeaders);

  } catch (error) {
    return jsonResponse({ success: false, error: error.message }, corsHeaders, 500);
  }
}

// HYBRID STREAMING with MTProto
async function handleStream(request, env, corsHeaders) {
  try {
    const url = new URL(request.url);
    const videoId = url.pathname.split('/')[3];
    const signature = url.searchParams.get('signature');
    const expires = url.searchParams.get('expires');

    if (!verifySignedUrl(videoId, signature, expires, env.SECRET_KEY)) {
      return jsonResponse({ error: 'Invalid or expired signature' }, corsHeaders, 403);
    }

    const metadataStr = await env.VIDEOS.get(`video:${videoId}`);
    if (!metadataStr) {
      return jsonResponse({ error: 'Video not found' }, corsHeaders, 404);
    }

    const metadata = JSON.parse(metadataStr);
    metadata.views++;
    await env.VIDEOS.put(`video:${videoId}`, JSON.stringify(metadata));

    const isLarge = metadata.fileSize > 20 * 1024 * 1024;

    // LARGE FILES: Use MTProto Service
    if (isLarge) {
      console.log(`Large file (${metadata.fileSize} bytes), using MTProto service`);
      
      // Get MTProto service URL from environment
      const mtprotoServiceUrl = env.MTPROTO_SERVICE_URL || 'https://your-mtproto-service.onrender.com';
      
      // Option 1: Stream by message_id (recommended - more reliable)
      const mtprotoUrl = `${mtprotoServiceUrl}/stream-from-message/${metadata.messageId}`;
      
      // Option 2: Stream by file_id (alternative)
      // const mtprotoUrl = `${mtprotoServiceUrl}/stream/${metadata.fileId}`;
      
      console.log(`Proxying to MTProto service: ${mtprotoUrl}`);
      
      // Proxy the request to MTProto service
      const mtprotoResponse = await fetch(mtprotoUrl, {
        headers: {
          'Range': request.headers.get('Range') || 'bytes=0-',
        }
      });
      
      if (!mtprotoResponse.ok) {
        console.error(`MTProto service error: ${mtprotoResponse.status}`);
        return jsonResponse({ 
          error: 'Failed to stream from MTProto service',
          status: mtprotoResponse.status 
        }, corsHeaders, 500);
      }
      
      // Create response with proper headers
      const headers = new Headers();
      headers.set('Access-Control-Allow-Origin', '*');
      headers.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
      headers.set('Access-Control-Allow-Headers', 'Range');
      headers.set('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
      headers.set('Content-Type', 'video/mp4');
      headers.set('Accept-Ranges', 'bytes');
      headers.set('Cache-Control', 'public, max-age=3600');
      
      // Copy important headers from MTProto response
      if (mtprotoResponse.headers.get('Content-Range')) {
        headers.set('Content-Range', mtprotoResponse.headers.get('Content-Range'));
      }
      
      if (mtprotoResponse.headers.get('Content-Length')) {
        headers.set('Content-Length', mtprotoResponse.headers.get('Content-Length'));
      }
      
      return new Response(mtprotoResponse.body, {
        status: mtprotoResponse.status,
        headers: headers
      });
    }

    // SMALL FILES: Use Bot API
    console.log(`Small file (${metadata.fileSize} bytes), using Bot API`);
    
    const fileResponse = await fetch(
      `https://api.telegram.org/bot${env.BOT_TOKEN}/getFile?file_id=${metadata.fileId}`
    );
    const fileResult = await fileResponse.json();

    if (!fileResult.ok) {
      return jsonResponse({ 
        error: 'Failed to get file from Telegram', 
        details: fileResult.description 
      }, corsHeaders, 500);
    }

    const fileUrl = `https://api.telegram.org/file/bot${env.BOT_TOKEN}/${fileResult.result.file_path}`;

    const videoResponse = await fetch(fileUrl, {
      headers: {
        'Range': request.headers.get('Range') || 'bytes=0-'
      }
    });

    const headers = new Headers();
    headers.set('Access-Control-Allow-Origin', '*');
    headers.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
    headers.set('Access-Control-Allow-Headers', 'Range');
    headers.set('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
    headers.set('Content-Type', 'video/mp4');
    headers.set('Accept-Ranges', 'bytes');
    headers.set('Cache-Control', 'public, max-age=3600');
    
    if (videoResponse.headers.get('Content-Range')) {
      headers.set('Content-Range', videoResponse.headers.get('Content-Range'));
    }
    
    if (videoResponse.headers.get('Content-Length')) {
      headers.set('Content-Length', videoResponse.headers.get('Content-Length'));
    }

    const responseStatus = videoResponse.headers.get('Content-Range') ? 206 : 200;
    
    return new Response(videoResponse.body, {
      status: responseStatus,
      headers: headers
    });

  } catch (error) {
    console.error('Stream error:', error);
    return jsonResponse({ error: error.message }, corsHeaders, 500);
  }
}

async function handleDelete(request, env, corsHeaders) {
  try {
    const url = new URL(request.url);
    const videoId = url.pathname.split('/')[3];

    const metadataStr = await env.VIDEOS.get(`video:${videoId}`);
    if (!metadataStr) {
      return jsonResponse({ success: false, error: 'Video not found' }, corsHeaders, 404);
    }

    const metadata = JSON.parse(metadataStr);

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

    await env.VIDEOS.delete(`video:${videoId}`);

    const videoList = await getVideoList(env);
    const newList = videoList.filter(id => id !== videoId);
    await env.VIDEOS.put('video:list', JSON.stringify(newList));

    return jsonResponse({ success: true, message: 'Video deleted' }, corsHeaders);

  } catch (error) {
    return jsonResponse({ success: false, error: error.message }, corsHeaders, 500);
  }
}

function generateVideoId() {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

async function getVideoList(env) {
  const listStr = await env.VIDEOS.get('video:list');
  return listStr ? JSON.parse(listStr) : [];
}

function generateSignedUrl(videoId, secretKey, expiresIn = 86400) {
  const expires = Math.floor(Date.now() + (expiresIn * 1000));
  const data = `${videoId}:${expires}`;
  const signature = btoa(data + secretKey).slice(0, 32);
  return { signature, expires: expires.toString() };
}

function verifySignedUrl(videoId, signature, expires, secretKey) {
  try {
    const expiresNum = parseInt(expires);
    if (isNaN(expiresNum) || Date.now() > expiresNum) {
      return false;
    }
    const data = `${videoId}:${expires}`;
    const expectedSignature = btoa(data + secretKey).slice(0, 32);
    return signature === expectedSignature;
  } catch (error) {
    return false;
  }
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

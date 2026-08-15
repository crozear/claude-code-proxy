const http = require('http');
const url = require('url');
const fs = require('fs');
const path = require('path');
const ClaudeRequest = require('./ClaudeRequest');
const Logger = require('./Logger');
const OAuthManager = require('./OAuthManager');
const { exec } = require('child_process');

let config = {};

// PKCE state storage with automatic expiration (10 minutes)
const pkceStates = new Map();
const PKCE_EXPIRY_MS = 10 * 60 * 1000; // 10 minutes

function cleanupExpiredPKCE() {
  const now = Date.now();
  for (const [state, data] of pkceStates.entries()) {
    if (now - data.created_at > PKCE_EXPIRY_MS) {
      pkceStates.delete(state);
    }
  }
}

// Cleanup expired PKCE states every minute
setInterval(cleanupExpiredPKCE, 60000);

function loadConfig() {
  try {
    const configPath = path.join(__dirname, 'config.txt');
    const configFile = fs.readFileSync(configPath, 'utf8');
    
    configFile.split('\n').forEach(line => {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) {
        const [key, ...valueParts] = trimmed.split('=');
        const value = valueParts.join('=').trim();
        const commentIndex = value.indexOf('#');
        config[key.trim()] = commentIndex >= 0 ? value.substring(0, commentIndex).trim() : value;
      }
    });
    
    Logger.init(config);
    
    Logger.info('Config loaded from config.txt');
  } catch (error) {
    Logger.error('Failed to load config:', error.message);
    process.exit(1);
  }
}


function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(new Error(`Invalid JSON: ${error.message}`));
      }
    });
    req.on('error', reject);
  });
}

function getClientIP(req) {
  return req.headers['x-forwarded-for'] ||
         req.headers['x-real-ip'] ||
         req.connection.remoteAddress ||
         '127.0.0.1';
}

function serveStaticFile(res, filePath, contentType) {
  const staticPath = path.join(__dirname, 'static', filePath);
  fs.readFile(staticPath, 'utf8', (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
}

function openBrowser(url) {
  let command;
  if (process.platform === 'darwin') {
    command = `open "${url}"`;
  } else if (process.platform === 'win32') {
    // start is a shell built-in; first quoted arg is window title, so use empty title
    command = `cmd /c start "" "${url}"`;
  } else {
    command = `xdg-open "${url}"`;
  }

  exec(command, (error) => {
    if (error) {
      Logger.debug(`Failed to open browser: ${error.message}`);
    }
  });
}

function isRunningInDocker() {
  // Check for /.dockerenv file (Docker creates this)
  if (fs.existsSync('/.dockerenv')) return true;

  // Check /proc/self/cgroup for docker/containerd (Linux)
  try {
    const cgroup = fs.readFileSync('/proc/self/cgroup', 'utf8');
    return cgroup.includes('docker') || cgroup.includes('containerd');
  } catch (err) {
    return false;
  }
}

async function handleRequest(req, res) {
  const clientIP = getClientIP(req);
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;

  Logger.info(`${req.method} ${pathname} from ${clientIP}`);

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  // OAuth Routes
  if (pathname === '/auth/login' && req.method === 'GET') {
    serveStaticFile(res, 'login.html', 'text/html');
    return;
  }

  if (pathname === '/auth/get-url' && req.method === 'GET') {
    try {
      const pkce = OAuthManager.generatePKCE();
      pkceStates.set(pkce.state, {
        code_verifier: pkce.code_verifier,
        created_at: Date.now()
      });

      const authUrl = OAuthManager.buildAuthorizationURL(pkce);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ url: authUrl, state: pkce.state }));
      Logger.info('Generated OAuth authorization URL');
    } catch (error) {
      Logger.error('OAuth get-url error:', error.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to generate OAuth URL' }));
    }
    return;
  }

  if (pathname === '/auth/callback' && req.method === 'GET') {
    try {
      const query = parsedUrl.query;
      let code = query.code;
      let state = query.state;

      // Handle manual code entry format: "code#state"
      if (query.manual_code) {
        const parts = query.manual_code.split('#');
        if (parts.length !== 2) {
          throw new Error('Invalid code format. Expected: code#state');
        }
        code = parts[0];
        state = parts[1];
      }

      if (!code || !state) {
        throw new Error('Missing authorization code or state');
      }

      const pkceData = pkceStates.get(state);
      if (!pkceData) {
        throw new Error('Invalid or expired state parameter. Please start the authorization process again.');
      }

      pkceStates.delete(state);

      const tokens = await OAuthManager.exchangeCodeForTokens(code, pkceData.code_verifier, state);

      const tokenData = {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expires_at: Date.now() + (tokens.expires_in * 1000)
      };
      OAuthManager.saveTokens(tokenData);

      serveStaticFile(res, 'callback.html', 'text/html');
      Logger.info('OAuth authentication successful');
    } catch (error) {
      Logger.error('OAuth callback error:', error.message);
      res.writeHead(500, { 'Content-Type': 'text/html' });
      res.end(`
        <!DOCTYPE html>
        <html>
        <head><title>Authentication Failed</title></head>
        <body>
          <h1>Authentication Failed</h1>
          <p>Error: ${error.message}</p>
          <p><a href="/auth/login">Try again</a></p>
        </body>
        </html>
      `);
    }
    return;
  }

  if (pathname === '/auth/status' && req.method === 'GET') {
    try {
      const isAuthenticated = OAuthManager.isAuthenticated();
      const expiration = OAuthManager.getTokenExpiration();

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        authenticated: isAuthenticated,
        access_token_expired: isAuthenticated ? OAuthManager.isAccessTokenExpired() : true,
        expires_at: expiration ? expiration.toISOString() : null
      }));
    } catch (error) {
      Logger.error('Auth status error:', error.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to check authentication status' }));
    }
    return;
  }

  if (pathname === '/auth/logout' && req.method === 'GET') {
    try {
      OAuthManager.logout();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, message: 'Logged out successfully' }));
      Logger.info('User logged out');
    } catch (error) {
      Logger.error('Logout error:', error.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to logout' }));
    }
    return;
  }

  if (pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', server: 'claude-code-proxy', timestamp: Date.now() }));
    return;
  }
  
  // Message Batches API (optionally preset-scoped: /v1/<preset>/messages/batches...)
  const batchCreate = pathname.match(/^\/v1(?:\/(\w+))?\/messages\/batches$/);
  const batchCancel = pathname.match(/^\/v1(?:\/(\w+))?\/messages\/batches\/([\w-]+)\/cancel$/);
  const batchResults = pathname.match(/^\/v1(?:\/(\w+))?\/messages\/batches\/([\w-]+)\/results$/);
  const batchRetrieve = pathname.match(/^\/v1(?:\/(\w+))?\/messages\/batches\/([\w-]+)$/);

  if (req.method === 'POST' && batchCreate) {
    try {
      const presetName = batchCreate[1] || null;
      const body = await parseBody(req);
      const result = await new ClaudeRequest(req).createBatch(body, presetName);
      res.writeHead(result.statusCode, { 'Content-Type': 'application/json' });
      res.end(result.body);
      Logger.info(`Batch create → ${result.statusCode}`);
    } catch (error) {
      Logger.error('Batch create error:', error.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  if (req.method === 'POST' && batchCancel) {
    try {
      const result = await new ClaudeRequest(req).cancelBatch(batchCancel[2]);
      res.writeHead(result.statusCode, { 'Content-Type': 'application/json' });
      res.end(result.body);
    } catch (error) {
      Logger.error('Batch cancel error:', error.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  if (req.method === 'GET' && batchResults) {
    try {
      const result = await new ClaudeRequest(req).getBatchResults(batchResults[2]);
      // Results are JSONL (one line per request). Pass through as text.
      res.writeHead(result.statusCode, { 'Content-Type': result.headers?.['content-type'] || 'application/x-ndjson' });
      res.end(result.body);
    } catch (error) {
      Logger.error('Batch results error:', error.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  if (req.method === 'GET' && batchRetrieve) {
    try {
      const result = await new ClaudeRequest(req).retrieveBatch(batchRetrieve[2]);
      res.writeHead(result.statusCode, { 'Content-Type': 'application/json' });
      res.end(result.body);
    } catch (error) {
      Logger.error('Batch retrieve error:', error.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  // Token counting (optionally preset-scoped). Must be matched before /v1/messages,
  // and the preset is intentionally ignored — see ClaudeRequest.countTokens.
  const countTokens = pathname.match(/^\/v1(?:\/\w+)?\/messages\/count_tokens$/);

  if (req.method === 'POST' && countTokens) {
    try {
      const body = await parseBody(req);
      const result = await new ClaudeRequest(req).countTokens(body);
      res.writeHead(result.statusCode, { 'Content-Type': 'application/json' });
      res.end(result.body);
    } catch (error) {
      Logger.error('Token count error:', error.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  if (req.method === 'POST' && (pathname === '/v1/messages' || pathname.match(/^\/v1\/\w+\/messages$/))) {
    try {
      Logger.debug('Incoming request headers:', JSON.stringify(req.headers, null, 2));
      const body = await parseBody(req);
      Logger.debug(`Claude request body (${JSON.stringify(body).length} bytes): ${Logger.truncate(JSON.stringify(body))}`);
      
      let presetName = null;
      const presetMatch = pathname.match(/^\/v1\/(\w+)\/messages$/);
      if (presetMatch) {
        presetName = presetMatch[1];
        Logger.debug(`Detected preset: ${presetName}`);
      }
      
      await new ClaudeRequest(req).handleResponse(res, body, presetName);
    } catch (error) {
      Logger.error('Request error:', error.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }
  
  
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
}

function startServer() {
  loadConfig();

  const server = http.createServer(handleRequest);
  const port = parseInt(config.port) || 3000;

  // Smart host binding: auto-detect Docker or use config
  const host = config.host || (isRunningInDocker() ? '0.0.0.0' : '127.0.0.1');

  server.listen(port, host, () => {
    Logger.info(`claude-code-proxy server listening on ${host}:${port}`);

    // Display authentication status
    const isAuthenticated = OAuthManager.isAuthenticated();
    const expiration = OAuthManager.getTokenExpiration();
    const isExpired = OAuthManager.isAccessTokenExpired();

    Logger.info('');
    Logger.info('Authentication Status:');
    if (isAuthenticated && expiration && !isExpired) {
      Logger.info(`  ✓ Authenticated until ${expiration.toLocaleString()}`);
    } else if (isAuthenticated && expiration) {
      // Expired access token is normal after an idle period — the refresh token
      // is still on disk, so the first request will silently mint a new one
      Logger.info(`  ↻ Access token expired ${expiration.toLocaleString()} — will refresh on first request`);
    } else {
      Logger.info('  ✗ Not authenticated');
      const authUrl = `http://localhost:${port}/auth/login`;
      Logger.info(`  → Visit ${authUrl} to authenticate`);

      // Auto-open browser if configured (only works when running natively)
      const autoOpenBrowser = config.auto_open_browser !== 'false';
      if (!isAuthenticated && autoOpenBrowser && !isRunningInDocker()) {
        Logger.info('  → Opening browser for authentication...');
        setTimeout(() => openBrowser(authUrl), 1000);
      }
    }
    Logger.info('');
  });

  process.on('SIGTERM', () => {
    Logger.info('Shutting down...');
    server.close(() => process.exit(0));
  });

  process.on('SIGINT', () => {
    Logger.info('Shutting down...');
    server.close(() => process.exit(0));
  });
}

if (require.main === module) {
  startServer();
}

module.exports = { startServer, ClaudeRequest };

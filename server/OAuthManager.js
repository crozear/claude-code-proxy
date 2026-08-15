const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const https = require('https');
const Logger = require('./Logger');

const OAUTH_CONFIG = {
  client_id: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
  authorize_url: 'https://claude.ai/oauth/authorize',
  token_url: 'https://console.anthropic.com/v1/oauth/token',
  redirect_uri: 'https://console.anthropic.com/oauth/code/callback', // Anthropic's callback page (shows code to user)
  scope: 'org:create_api_key user:profile user:inference'
};

// Treat a token as expired this far ahead of its actual expiry, so a refresh
// happens before an in-flight request can hit a 401
const REFRESH_BUFFER_MS = 60000;

class OAuthManager {
  constructor() {
    this.tokenPath = path.join(
      process.env.HOME || process.env.USERPROFILE,
      '.claude-code-proxy',
      'tokens.json'
    );
    this.cachedToken = null;
    this.refreshPromise = null;
  }

  /**
   * Generate PKCE code verifier, challenge, and state for OAuth flow
   * @returns {{code_verifier: string, code_challenge: string, state: string}}
   */
  generatePKCE() {
    // Generate random code verifier (43-128 chars)
    const code_verifier = crypto.randomBytes(32).toString('base64url');

    // Generate code challenge using S256 method
    const code_challenge = crypto
      .createHash('sha256')
      .update(code_verifier)
      .digest('base64url');

    // Generate random state for CSRF protection (32 bytes to match OpenCode)
    const state = crypto.randomBytes(32).toString('base64url');

    return { code_verifier, code_challenge, state };
  }

  /**
   * Build authorization URL for user to visit
   * @param {{code_challenge: string, state: string}} pkce
   * @returns {string} Authorization URL
   */
  buildAuthorizationURL(pkce) {
    const params = new URLSearchParams({
      code: 'true', // Required: tells Anthropic to display the authorization code
      client_id: OAUTH_CONFIG.client_id,
      response_type: 'code',
      redirect_uri: OAUTH_CONFIG.redirect_uri,
      scope: OAUTH_CONFIG.scope,
      code_challenge: pkce.code_challenge,
      code_challenge_method: 'S256',
      state: pkce.state
    });

    return `${OAUTH_CONFIG.authorize_url}?${params.toString()}`;
  }

  /**
   * Exchange authorization code for access and refresh tokens
   * @param {string} code - Authorization code from callback
   * @param {string} code_verifier - PKCE code verifier
   * @param {string} state - State parameter from callback
   * @returns {Promise<{access_token: string, refresh_token: string, expires_in: number}>}
   */
  async exchangeCodeForTokens(code, code_verifier, state) {
    const payload = JSON.stringify({
      grant_type: 'authorization_code',
      code: code,
      state: state,
      client_id: OAUTH_CONFIG.client_id,
      code_verifier: code_verifier,
      redirect_uri: OAUTH_CONFIG.redirect_uri
    });

    try {
      const response = await this._makeTokenRequest(payload);
      Logger.info('Successfully exchanged authorization code for tokens');
      return response;
    } catch (error) {
      Logger.error('Failed to exchange code for tokens', error);
      throw error;
    }
  }

  /**
   * Refresh the access token using the refresh token
   * @returns {Promise<{access_token: string, refresh_token: string, expires_in: number}>}
   */
  async refreshAccessToken() {
    // Prevent race conditions with concurrent refresh attempts
    if (this.refreshPromise) {
      Logger.debug('Token refresh already in progress, waiting...');
      return this.refreshPromise;
    }

    this.refreshPromise = (async () => {
      try {
        const tokens = this.loadTokens();
        if (!tokens || !tokens.refresh_token) {
          throw new Error('No refresh token available');
        }

        const payload = JSON.stringify({
          grant_type: 'refresh_token',
          refresh_token: tokens.refresh_token,
          client_id: OAUTH_CONFIG.client_id
        });

        const response = await this._makeTokenRequest(payload);
        Logger.info('Successfully refreshed access token');

        // Save new tokens
        const newTokens = {
          access_token: response.access_token,
          refresh_token: response.refresh_token || tokens.refresh_token,
          expires_at: Date.now() + (response.expires_in * 1000)
        };
        this.saveTokens(newTokens);
        this.cachedToken = newTokens.access_token;

        return response;
      } finally {
        this.refreshPromise = null;
      }
    })();

    return this.refreshPromise;
  }

  /**
   * Make an HTTPS request to the token endpoint
   * @param {string} payload - JSON payload to send
   * @returns {Promise<Object>} Token response
   * @private
   */
  _makeTokenRequest(payload) {
    return new Promise((resolve, reject) => {
      const url = new URL(OAUTH_CONFIG.token_url);

      const options = {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        }
      };

      const req = https.request(options, (res) => {
        let data = '';

        res.on('data', (chunk) => {
          data += chunk;
        });

        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(JSON.parse(data));
            } catch (error) {
              reject(new Error(`Failed to parse token response: ${error.message}`));
            }
          } else {
            reject(new Error(`Token request failed with status ${res.statusCode}: ${data}`));
          }
        });
      });

      req.on('error', (error) => {
        reject(error);
      });

      req.write(payload);
      req.end();
    });
  }

  /**
   * Load tokens from local file
   * @returns {Object|null} Tokens object or null if not found
   */
  loadTokens() {
    try {
      if (!fs.existsSync(this.tokenPath)) {
        return null;
      }

      const data = fs.readFileSync(this.tokenPath, 'utf8');
      return JSON.parse(data);
    } catch (error) {
      Logger.error('Failed to load tokens from file', error);
      return null;
    }
  }

  /**
   * Save tokens to local file
   * @param {{access_token: string, refresh_token: string, expires_at: number}} tokens
   */
  saveTokens(tokens) {
    try {
      // Ensure directory exists
      const dir = path.dirname(this.tokenPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      fs.writeFileSync(this.tokenPath, JSON.stringify(tokens, null, 2), 'utf8');

      // Set file permissions to 600 (owner read/write only) on Unix
      if (process.platform !== 'win32') {
        fs.chmodSync(this.tokenPath, 0o600);
      }

      Logger.info('Tokens saved successfully');
    } catch (error) {
      Logger.error('Failed to save tokens to file', error);
      throw error;
    }
  }

  /**
   * Get a valid access token, refreshing if necessary
   * @returns {Promise<string>} Valid access token
   */
  async getValidAccessToken() {
    // Use cached token if available
    if (this.cachedToken) {
      const tokens = this.loadTokens();
      if (tokens && tokens.expires_at > Date.now() + REFRESH_BUFFER_MS) {
        return this.cachedToken;
      }
    }

    const tokens = this.loadTokens();
    if (!tokens) {
      throw new Error('No authentication tokens found. Please authenticate first.');
    }

    // Check if token is expired or expiring soon
    if (tokens.expires_at <= Date.now() + REFRESH_BUFFER_MS) {
      Logger.info('Access token expired or expiring soon, refreshing...');
      await this.refreshAccessToken();
      const newTokens = this.loadTokens();
      this.cachedToken = newTokens.access_token;
      return this.cachedToken;
    }

    this.cachedToken = tokens.access_token;
    return tokens.access_token;
  }

  /**
   * Check if user is authenticated (has valid tokens)
   * @returns {boolean} True if authenticated
   */
  isAuthenticated() {
    const tokens = this.loadTokens();
    return !!(tokens && tokens.access_token && tokens.refresh_token);
  }

  /**
   * Check whether the stored access token is expired (or expiring within the
   * refresh buffer). Expired is not the same as unauthenticated: as long as the
   * refresh token is still good, getValidAccessToken() will mint a new one.
   * @returns {boolean} True if there is no usable access token right now
   */
  isAccessTokenExpired() {
    const tokens = this.loadTokens();
    if (!tokens || !tokens.expires_at) {
      return true;
    }
    return tokens.expires_at <= Date.now() + REFRESH_BUFFER_MS;
  }

  /**
   * Get token expiration time
   * @returns {Date|null} Expiration date or null if not authenticated
   */
  getTokenExpiration() {
    const tokens = this.loadTokens();
    if (!tokens || !tokens.expires_at) {
      return null;
    }
    return new Date(tokens.expires_at);
  }

  /**
   * Delete stored tokens (logout)
   */
  logout() {
    try {
      if (fs.existsSync(this.tokenPath)) {
        fs.unlinkSync(this.tokenPath);
        Logger.info('Tokens deleted successfully');
      }
      this.cachedToken = null;
    } catch (error) {
      Logger.error('Failed to delete tokens', error);
      throw error;
    }
  }

}

// Export singleton instance
module.exports = new OAuthManager();

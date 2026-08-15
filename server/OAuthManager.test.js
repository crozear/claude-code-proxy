const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const nock = require('nock');
const OAuthManager = require('./OAuthManager');

// Mock the Logger module
jest.mock('./Logger', () => ({
  info: jest.fn(),
  debug: jest.fn(),
  error: jest.fn(),
  warn: jest.fn()
}));

describe('OAuthManager', () => {
  let testTokenPath;

  beforeEach(() => {
    // Use a temporary directory for testing
    testTokenPath = path.join(__dirname, '.test-tokens', 'tokens.json');
    OAuthManager.tokenPath = testTokenPath;
    OAuthManager.cachedToken = null;
    OAuthManager.refreshPromise = null;

    // Clean up test directory
    const testDir = path.dirname(testTokenPath);
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  afterEach(() => {
    // Clean up
    const testDir = path.dirname(testTokenPath);
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
    nock.cleanAll();
  });

  describe('generatePKCE', () => {
    it('should generate valid PKCE parameters', () => {
      const pkce = OAuthManager.generatePKCE();

      expect(pkce).toHaveProperty('code_verifier');
      expect(pkce).toHaveProperty('code_challenge');
      expect(pkce).toHaveProperty('state');

      expect(typeof pkce.code_verifier).toBe('string');
      expect(typeof pkce.code_challenge).toBe('string');
      expect(typeof pkce.state).toBe('string');

      expect(pkce.code_verifier.length).toBeGreaterThan(0);
      expect(pkce.code_challenge.length).toBeGreaterThan(0);
      expect(pkce.state.length).toBeGreaterThan(0);
    });

    it('should generate different values on each call', () => {
      const pkce1 = OAuthManager.generatePKCE();
      const pkce2 = OAuthManager.generatePKCE();

      expect(pkce1.code_verifier).not.toBe(pkce2.code_verifier);
      expect(pkce1.code_challenge).not.toBe(pkce2.code_challenge);
      expect(pkce1.state).not.toBe(pkce2.state);
    });

    it('should generate code_challenge from code_verifier using SHA256', () => {
      const pkce = OAuthManager.generatePKCE();

      const expectedChallenge = crypto
        .createHash('sha256')
        .update(pkce.code_verifier)
        .digest('base64url');

      expect(pkce.code_challenge).toBe(expectedChallenge);
    });
  });

  describe('buildAuthorizationURL', () => {
    it('should build valid authorization URL', () => {
      const pkce = {
        code_challenge: 'test-challenge',
        state: 'test-state'
      };

      const url = OAuthManager.buildAuthorizationURL(pkce);

      expect(url).toContain('https://claude.ai/oauth/authorize');
      expect(url).toContain('client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e');
      expect(url).toContain('response_type=code');
      expect(url).toContain('code_challenge=test-challenge');
      expect(url).toContain('code_challenge_method=S256');
      expect(url).toContain('state=test-state');
      expect(url).toContain('scope=org%3Acreate_api_key+user%3Aprofile+user%3Ainference');
      expect(url).toContain('redirect_uri=https%3A%2F%2Fconsole.anthropic.com%2Foauth%2Fcode%2Fcallback');
    });
  });

  describe('saveTokens and loadTokens', () => {
    it('should save and load tokens successfully', () => {
      const tokens = {
        access_token: 'test-access-token',
        refresh_token: 'test-refresh-token',
        expires_at: Date.now() + 3600000
      };

      OAuthManager.saveTokens(tokens);

      const loaded = OAuthManager.loadTokens();
      expect(loaded).toEqual(tokens);
    });

    it('should create directory if it does not exist', () => {
      const tokens = {
        access_token: 'test-access-token',
        refresh_token: 'test-refresh-token',
        expires_at: Date.now() + 3600000
      };

      const testDir = path.dirname(testTokenPath);
      expect(fs.existsSync(testDir)).toBe(false);

      OAuthManager.saveTokens(tokens);

      expect(fs.existsSync(testDir)).toBe(true);
      expect(fs.existsSync(testTokenPath)).toBe(true);
    });

    it('should set file permissions to 600 on Unix', () => {
      if (process.platform === 'win32') {
        return; // Skip this test on Windows
      }

      const tokens = {
        access_token: 'test-access-token',
        refresh_token: 'test-refresh-token',
        expires_at: Date.now() + 3600000
      };

      OAuthManager.saveTokens(tokens);

      const stats = fs.statSync(testTokenPath);
      const mode = stats.mode & 0o777;
      expect(mode).toBe(0o600);
    });

    it('should return null if token file does not exist', () => {
      const loaded = OAuthManager.loadTokens();
      expect(loaded).toBeNull();
    });

    it('should return null if token file is invalid JSON', () => {
      const testDir = path.dirname(testTokenPath);
      fs.mkdirSync(testDir, { recursive: true });
      fs.writeFileSync(testTokenPath, 'invalid json');

      const loaded = OAuthManager.loadTokens();
      expect(loaded).toBeNull();
    });
  });

  describe('isAuthenticated', () => {
    it('should return false when no tokens exist', () => {
      expect(OAuthManager.isAuthenticated()).toBe(false);
    });

    it('should return true when valid tokens exist', () => {
      const tokens = {
        access_token: 'test-access-token',
        refresh_token: 'test-refresh-token',
        expires_at: Date.now() + 3600000
      };

      OAuthManager.saveTokens(tokens);
      expect(OAuthManager.isAuthenticated()).toBe(true);
    });

    it('should return true even if tokens are expired', () => {
      // isAuthenticated only checks if tokens exist, not if they're expired
      const tokens = {
        access_token: 'test-access-token',
        refresh_token: 'test-refresh-token',
        expires_at: Date.now() - 1000
      };

      OAuthManager.saveTokens(tokens);
      expect(OAuthManager.isAuthenticated()).toBe(true);
    });
  });

  describe('isAccessTokenExpired', () => {
    it('should return true when no tokens exist', () => {
      expect(OAuthManager.isAccessTokenExpired()).toBe(true);
    });

    it('should return false when the token is still valid', () => {
      OAuthManager.saveTokens({
        access_token: 'test-access-token',
        refresh_token: 'test-refresh-token',
        expires_at: Date.now() + 3600000
      });

      expect(OAuthManager.isAccessTokenExpired()).toBe(false);
    });

    it('should return true when the token is past its expiry', () => {
      OAuthManager.saveTokens({
        access_token: 'test-access-token',
        refresh_token: 'test-refresh-token',
        expires_at: Date.now() - 1000
      });

      expect(OAuthManager.isAccessTokenExpired()).toBe(true);
    });

    it('should return true inside the refresh buffer', () => {
      // 30s out is still "expired" — getValidAccessToken refreshes at 60s
      OAuthManager.saveTokens({
        access_token: 'test-access-token',
        refresh_token: 'test-refresh-token',
        expires_at: Date.now() + 30000
      });

      expect(OAuthManager.isAccessTokenExpired()).toBe(true);
    });
  });

  describe('getTokenExpiration', () => {
    it('should return null when no tokens exist', () => {
      expect(OAuthManager.getTokenExpiration()).toBeNull();
    });

    it('should return expiration date when tokens exist', () => {
      const expiresAt = Date.now() + 3600000;
      const tokens = {
        access_token: 'test-access-token',
        refresh_token: 'test-refresh-token',
        expires_at: expiresAt
      };

      OAuthManager.saveTokens(tokens);

      const expiration = OAuthManager.getTokenExpiration();
      expect(expiration).toBeInstanceOf(Date);
      expect(expiration.getTime()).toBe(expiresAt);
    });
  });

  describe('logout', () => {
    it('should delete token file and clear cached token', () => {
      const tokens = {
        access_token: 'test-access-token',
        refresh_token: 'test-refresh-token',
        expires_at: Date.now() + 3600000
      };

      OAuthManager.saveTokens(tokens);
      OAuthManager.cachedToken = 'cached-token';

      expect(fs.existsSync(testTokenPath)).toBe(true);
      expect(OAuthManager.cachedToken).toBe('cached-token');

      OAuthManager.logout();

      expect(fs.existsSync(testTokenPath)).toBe(false);
      expect(OAuthManager.cachedToken).toBeNull();
    });

    it('should not throw error if token file does not exist', () => {
      expect(() => OAuthManager.logout()).not.toThrow();
    });
  });

  describe('exchangeCodeForTokens', () => {
    it('should exchange authorization code for tokens', async () => {
      const mockResponse = {
        access_token: 'new-access-token',
        refresh_token: 'new-refresh-token',
        expires_in: 3600
      };

      nock('https://console.anthropic.com')
        .post('/v1/oauth/token', {
          grant_type: 'authorization_code',
          code: 'test-auth-code',
          state: 'test-state',
          client_id: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
          code_verifier: 'test-code-verifier',
          redirect_uri: 'https://console.anthropic.com/oauth/code/callback'
        })
        .reply(200, mockResponse);

      const tokens = await OAuthManager.exchangeCodeForTokens('test-auth-code', 'test-code-verifier', 'test-state');

      expect(tokens).toEqual(mockResponse);
    });

    it('should throw error on failed token exchange', async () => {
      nock('https://console.anthropic.com')
        .post('/v1/oauth/token')
        .reply(400, { error: 'invalid_grant' });

      await expect(
        OAuthManager.exchangeCodeForTokens('invalid-code', 'test-verifier', 'test-state')
      ).rejects.toThrow();
    });
  });

  describe('refreshAccessToken', () => {
    it('should refresh access token successfully', async () => {
      const oldTokens = {
        access_token: 'old-access-token',
        refresh_token: 'test-refresh-token',
        expires_at: Date.now() - 1000
      };
      OAuthManager.saveTokens(oldTokens);

      const mockResponse = {
        access_token: 'new-access-token',
        refresh_token: 'new-refresh-token',
        expires_in: 3600
      };

      nock('https://console.anthropic.com')
        .post('/v1/oauth/token', {
          grant_type: 'refresh_token',
          refresh_token: 'test-refresh-token',
          client_id: '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
        })
        .reply(200, mockResponse);

      await OAuthManager.refreshAccessToken();

      const updatedTokens = OAuthManager.loadTokens();
      expect(updatedTokens.access_token).toBe('new-access-token');
      expect(updatedTokens.refresh_token).toBe('new-refresh-token');
      expect(updatedTokens.expires_at).toBeGreaterThan(Date.now());
    });

    it('should prevent concurrent refresh attempts', async () => {
      const tokens = {
        access_token: 'old-token',
        refresh_token: 'test-refresh-token',
        expires_at: Date.now() - 1000
      };
      OAuthManager.saveTokens(tokens);

      const mockResponse = {
        access_token: 'new-token',
        refresh_token: 'new-refresh-token',
        expires_in: 3600
      };

      let requestCount = 0;
      nock('https://console.anthropic.com')
        .post('/v1/oauth/token')
        .times(2)
        .reply(200, () => {
          requestCount++;
          return mockResponse;
        });

      // Start two refresh operations concurrently
      const [result1, result2] = await Promise.all([
        OAuthManager.refreshAccessToken(),
        OAuthManager.refreshAccessToken()
      ]);

      // Both should succeed but only one request should be made
      expect(result1).toEqual(mockResponse);
      expect(result2).toEqual(mockResponse);
      expect(requestCount).toBe(1);
    });

    it('should throw error if no refresh token available', async () => {
      await expect(OAuthManager.refreshAccessToken()).rejects.toThrow('No refresh token available');
    });
  });

  describe('getValidAccessToken', () => {
    it('should return cached token if valid', async () => {
      const tokens = {
        access_token: 'test-token',
        refresh_token: 'test-refresh-token',
        expires_at: Date.now() + 3600000 // 1 hour from now
      };
      OAuthManager.saveTokens(tokens);
      OAuthManager.cachedToken = 'test-token';

      const token = await OAuthManager.getValidAccessToken();
      expect(token).toBe('test-token');
    });

    it('should refresh token if expired', async () => {
      const tokens = {
        access_token: 'old-token',
        refresh_token: 'test-refresh-token',
        expires_at: Date.now() - 1000 // Expired
      };
      OAuthManager.saveTokens(tokens);

      const mockResponse = {
        access_token: 'new-token',
        refresh_token: 'new-refresh-token',
        expires_in: 3600
      };

      nock('https://console.anthropic.com')
        .post('/v1/oauth/token')
        .reply(200, mockResponse);

      const token = await OAuthManager.getValidAccessToken();
      expect(token).toBe('new-token');
    });

    it('should refresh token if expiring soon (within 1 minute)', async () => {
      const tokens = {
        access_token: 'old-token',
        refresh_token: 'test-refresh-token',
        expires_at: Date.now() + 30000 // 30 seconds from now
      };
      OAuthManager.saveTokens(tokens);

      const mockResponse = {
        access_token: 'new-token',
        refresh_token: 'new-refresh-token',
        expires_in: 3600
      };

      nock('https://console.anthropic.com')
        .post('/v1/oauth/token')
        .reply(200, mockResponse);

      const token = await OAuthManager.getValidAccessToken();
      expect(token).toBe('new-token');
    });

    it('should throw error if no tokens exist', async () => {
      await expect(OAuthManager.getValidAccessToken()).rejects.toThrow(
        'No authentication tokens found. Please authenticate first.'
      );
    });
  });

});

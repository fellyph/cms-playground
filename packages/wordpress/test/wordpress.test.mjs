import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { wordpressAdapter, wpDownloadUrl } from '../src/index.js';

describe('@cms-playground/wordpress', () => {
  it('builds WordPress download URLs', () => {
    assert.equal(wpDownloadUrl(null), 'https://wordpress.org/latest.zip');
    assert.equal(wpDownloadUrl('latest'), 'https://wordpress.org/latest.zip');
    assert.equal(wpDownloadUrl('6.7.2'), 'https://wordpress.org/wordpress-6.7.2.zip');
  });

  it('routes non-PHP paths to /index.php and missing .php files to 404', () => {
    assert.deepEqual(wordpressAdapter.getFileNotFoundAction('/sample-post/'), { type: 'internal-redirect', uri: '/index.php' });
    assert.deepEqual(wordpressAdapter.getFileNotFoundAction('/missing.php'), { type: '404' });
  });
});

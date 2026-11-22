import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { joomlaAdapter, matchJoomlaVersion } from '../src/index.js';

describe('@cms-playground/joomla', () => {
  const manifest = { default: '6.2.0', versions: ['6.2.0', '5.4.10'] };

  it('matches default, exact, and minor/major version prefixes', () => {
    assert.equal(matchJoomlaVersion(null, manifest), '6.2.0');
    assert.equal(matchJoomlaVersion('latest', manifest), '6.2.0');
    assert.equal(matchJoomlaVersion('5.4.10', manifest), '5.4.10');
    assert.equal(matchJoomlaVersion('5.4', manifest), '5.4.10');
    assert.equal(matchJoomlaVersion('5', manifest), '5.4.10');
  });

  it('throws on unknown Joomla version', () => {
    assert.throws(() => matchJoomlaVersion('4.4', manifest), /not available/);
  });

  it('routes site SEF URLs to /index.php and leaves /administrator and /api as 404', () => {
    assert.deepEqual(joomlaAdapter.getFileNotFoundAction('/about-us'), { type: 'internal-redirect', uri: '/index.php' });
    assert.deepEqual(joomlaAdapter.getFileNotFoundAction('/administrator/missing'), { type: '404' });
    assert.deepEqual(joomlaAdapter.getFileNotFoundAction('/api/missing'), { type: '404' });
  });
});

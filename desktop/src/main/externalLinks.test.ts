import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isOpenableExternalLink } from './externalLinks.ts';

describe('desktop external links', () => {
  it('opens pages in the project repository', () => {
    assert.equal(isOpenableExternalLink('https://github.com/Chia-Network/chia-gaming'), true);
    assert.equal(
      isOpenableExternalLink(
        'https://github.com/Chia-Network/chia-gaming/blob/main/games/krunk/clsp/krunkwords.txt',
      ),
      true,
    );
  });

  it('blocks everything else', () => {
    for (const url of [
      'https://github.com/Chia-Network/chia-gaming-evil',
      'https://github.com/Chia-Network/other',
      'http://github.com/Chia-Network/chia-gaming',
      'https://github.com.example/Chia-Network/chia-gaming',
      'https://user@github.com/Chia-Network/chia-gaming',
      'https://example.com/',
      'chiagaming://app/index.html',
      'not a url',
    ]) {
      assert.equal(isOpenableExternalLink(url), false, url);
    }
  });
});

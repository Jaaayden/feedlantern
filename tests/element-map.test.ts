import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hitTest, levelsBetween, liftNode, linkFor, nodeRect } from '../src/shared/element-map.js';
import type { ElementMap } from '../src/shared/types.js';

// 0 page (0,0 1000x2000) > 1 card (100,100 400x200) > 2 title (110,110 300x40)
//                        > 3 card (100,400 400x200)
// 4 overlay (0,0 1000x2000), a later root at the same depth as the page
const map: ElementMap = {
  boxes: [
    0, 0, 1000, 2000, -1,
    100, 100, 400, 200, 0,
    110, 110, 300, 40, 1,
    100, 400, 400, 200, 0,
    0, 0, 1000, 2000, -1,
  ],
  labels: ['main', 'article.card', 'h2.title', 'article.card', 'div.overlay'],
  links: { '1': 'https://example.test/one' },
  truncated: false,
};

test('命中检测选最深的元素，同深度取文档中靠后的元素', () => {
  assert.equal(hitTest(map, 120, 120), 2);
  assert.equal(hitTest(map, 450, 250), 1);
  assert.equal(hitTest(map, 450, 1500), 4, 'a later root wins over an earlier one at equal depth');
  assert.equal(hitTest(map, 5000, 5000), -1);
  assert.deepEqual(nodeRect(map, 3), { x: 100, y: 400, width: 400, height: 200 });
});

test('扩大与缩小沿祖先链移动，并在根部停止', () => {
  assert.equal(liftNode(map, 2, 1), 1);
  assert.equal(liftNode(map, 2, 9), 0);
  assert.equal(levelsBetween(map, 2, 0), 2);
  assert.equal(levelsBetween(map, 2, 3), -1);
});

test('链接取自身或最近的祖先', () => {
  assert.equal(linkFor(map, 2), 'https://example.test/one');
  assert.equal(linkFor(map, 3), undefined);
});

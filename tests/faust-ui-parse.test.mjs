import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isFaustInputWidgetType,
  isFaustWidgetType,
  parseFaustUiAstFromUnknown,
  flattenFaustUiAstToItems,
  parseFaustUiItemsFromUnknown,
  parseFaustUiControlsFromUnknown
} from '../node_modules/faust-orbit-ui/dist/faust-ui-parse.js';

test('type guards detect supported and unsupported widget kinds', () => {
  assert.equal(isFaustWidgetType('hslider'), true);
  assert.equal(isFaustWidgetType('hbargraph'), true);
  assert.equal(isFaustWidgetType('vbargraph'), true);
  assert.equal(isFaustWidgetType('vgroup'), false);
  assert.equal(isFaustWidgetType('unknown'), false);

  assert.equal(isFaustInputWidgetType('hslider'), true);
  assert.equal(isFaustInputWidgetType('checkbox'), true);
  assert.equal(isFaustInputWidgetType('hbargraph'), false);
});

test('parseFaustUiAstFromUnknown throws when root is not an array', () => {
  assert.throws(() => parseFaustUiAstFromUnknown({}), /Faust UI must be an array/);
});

test('parseFaustUiAstFromUnknown builds an AST and ignores unknown nodes', () => {
  const input = [
    {
      type: 'vgroup',
      label: 'synth',
      items: [
        { type: 'hslider', label: 'freq', address: '/synth/freq', min: 20, max: 20000, step: 1 },
        { type: 'button', label: 'gate', address: '/synth/gate' },
        { type: 'foo', label: 'ignored' },
        { type: 'hgroup', items: [{ type: 'vbargraph', label: 'meter', address: '/synth/meter', min: -80, max: 0, step: 0.1 }] }
      ]
    }
  ];

  const ast = parseFaustUiAstFromUnknown(input);
  assert.equal(ast.length, 1);
  assert.equal(ast[0].kind, 'group');
  assert.equal(ast[0].type, 'vgroup');
  assert.equal(ast[0].label, 'synth');
  assert.equal(ast[0].children.length, 3);
});

test('flattenFaustUiAstToItems keeps depth-first order and normalized values', () => {
  const input = [
    {
      type: 'vgroup',
      label: 'synth',
      items: [
        { type: 'hslider', label: 'freq', address: '/synth/freq', min: 20, max: 20000, step: 1 },
        { type: 'button', label: 'gate', address: '/synth/gate', min: -1, max: 9, step: 0.5 },
        {
          type: 'hgroup',
          label: 'mod',
          items: [
            { type: 'nentry', address: '/synth/mod/index', min: 0, max: 10, step: 0.25 },
            { type: 'hbargraph', address: '/synth/mod/meter', min: -40, max: -40, step: 0 }
          ]
        }
      ]
    }
  ];

  const ast = parseFaustUiAstFromUnknown(input);
  const items = flattenFaustUiAstToItems(ast);

  assert.deepEqual(items.map((item) => item.path), [
    '/synth/freq',
    '/synth/gate',
    '/synth/mod/index',
    '/synth/mod/meter'
  ]);

  const gate = items.find((item) => item.path === '/synth/gate');
  assert.ok(gate);
  assert.equal(gate.min, 0);
  assert.equal(gate.max, 1);
  assert.equal(gate.step, 1);

  const meter = items.find((item) => item.path === '/synth/mod/meter');
  assert.ok(meter);
  assert.equal(meter.type, 'hbargraph');
  assert.equal(meter.max > meter.min, true);
  assert.equal(meter.step, 0);

  const index = items.find((item) => item.path === '/synth/mod/index');
  assert.ok(index);
  assert.equal(index.label, 'index');
});

test('parseFaustUiItemsFromUnknown and parseFaustUiControlsFromUnknown return same normalized output', () => {
  const input = [
    { type: 'checkbox', address: '/fx/bypass' },
    { type: 'vbargraph', address: '/fx/peak', min: -60, max: 6, step: 0.5 }
  ];

  const items = parseFaustUiItemsFromUnknown(input);
  const controls = parseFaustUiControlsFromUnknown(input);
  assert.deepEqual(controls, items);
});

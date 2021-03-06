/* @flow */

import watchFilteredChildren from './watchFilteredChildren';

import LiveSet from 'live-set';
import delay from 'pdelay';
import createCssFn from './createCssFn';
import emitMutation from '../../testlib/MockMutationObserver';
import tagAndClassName from '../../testlib/tagAndClassName';

test('listen', async () => {
  const div = document.createElement('div');
  const divA = Object.assign(document.createElement('div'), {className: 'a'});
  const divIgnoreA = Object.assign(document.createElement('div'), {className: 'aa ignore'});
  const divB = Object.assign(document.createElement('div'), {className: 'b'});
  const divIgnoreB = Object.assign(document.createElement('div'), {className: 'bb ignore'});
  const commentNode = document.createComment('comment should be ignored');
  div.appendChild(divA);
  div.appendChild(divIgnoreA);
  const parents = [];
  const liveSet = watchFilteredChildren(LiveSet.constant(new Set([{el: div, parents}])), createCssFn('div:not(.ignore)'));

  const next = jest.fn();
  liveSet.subscribe({next});

  div.appendChild(commentNode);
  div.appendChild(divIgnoreB);
  div.appendChild(divB);
  emitMutation(div, {addedNodes: [commentNode, divIgnoreB, divB]});
  expect(next).toHaveBeenCalledTimes(0);
  await delay(0);
  liveSet.values().forEach(ec => {
    expect(ec.parents).toBe(parents);
  });
  expect(Array.from(liveSet.values()).map(({el}) => tagAndClassName(el))).toEqual([
    divA, divB
  ].map(tagAndClassName));
  expect(next.mock.calls.map(([changes]) => changes.map(({type, value: {el}}) => [type, tagAndClassName(el)]))).toEqual([
    [['add', 'div.b']]
  ]);
});

test('listen, pullChanges', async () => {
  const div = document.createElement('div');
  const divA = Object.assign(document.createElement('div'), {className: 'a'});
  const divIgnoreA = Object.assign(document.createElement('div'), {className: 'aa ignore'});
  const divB = Object.assign(document.createElement('div'), {className: 'b'});
  const divIgnoreB = Object.assign(document.createElement('div'), {className: 'bb ignore'});
  div.appendChild(divA);
  div.appendChild(divIgnoreA);
  const liveSet = watchFilteredChildren(LiveSet.constant(new Set([{el: div, parents: []}])), createCssFn('div:not(.ignore)'));

  const next = jest.fn();
  liveSet.subscribe({next});

  expect(Array.from(liveSet.values()).map(({el}) => tagAndClassName(el))).toEqual([
    divA
  ].map(tagAndClassName));

  div.appendChild(divB);
  div.appendChild(divIgnoreB);
  emitMutation(div, {addedNodes: [divB, divIgnoreB]});
  await delay(0);
  expect(Array.from(liveSet.values()).map(({el}) => tagAndClassName(el))).toEqual([
    divA, divB
  ].map(tagAndClassName));

  expect(next.mock.calls.map(([changes]) => changes.map(({type, value: {el}}) => [type, tagAndClassName(el)]))).toEqual([
    [['add', 'div.b']]
  ]);
  await delay(0);
  expect(Array.from(liveSet.values()).map(({el}) => tagAndClassName(el))).toEqual([
    divA, divB
  ].map(tagAndClassName));
  expect(next.mock.calls.map(([changes]) => changes.map(({type, value: {el}}) => [type, tagAndClassName(el)]))).toEqual([
    [['add', 'div.b']]
  ]);
});

test('do not reprocess nodes removed and re-added immediately', async () => {
  const div = document.createElement('div');
  const divA = Object.assign(document.createElement('div'), {className: 'a'});
  const divB = Object.assign(document.createElement('div'), {className: 'b'});
  const divC = Object.assign(document.createElement('div'), {className: 'c'});
  div.appendChild(divA);
  const parents = [];
  const liveSet = watchFilteredChildren(LiveSet.constant(new Set([{el: div, parents}])), createCssFn('div:not(.ignore)'));

  const next = jest.fn();
  liveSet.subscribe({next});

  div.appendChild(divB);
  emitMutation(div, {addedNodes: [divB, divC]});
  emitMutation(div, {removedNodes: [divA, divB, divC]});
  emitMutation(div, {addedNodes: [divA, divB]});
  expect(next).toHaveBeenCalledTimes(0);
  await delay(0);
  liveSet.values().forEach(ec => {
    expect(ec.parents).toBe(parents);
  });
  expect(Array.from(liveSet.values()).map(({el}) => tagAndClassName(el))).toEqual([
    divA, divB
  ].map(tagAndClassName));
  expect(next.mock.calls.map(([changes]) => changes.map(({type, value: {el}}) => [type, tagAndClassName(el)]))).toEqual([
    [['add', 'div.b'], ['add', 'div.c'], ['remove', 'div.c']]
  ]);
});

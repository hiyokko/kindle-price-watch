import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

// A small DOM double for series rendering; real layout and keyboard checks use a browser.
function element() {
  const selectors = new Map();
  const attributes = new Map();
  const classes = new Set();
  return {
    children: [], events: {}, dataset: {},
    classList: {
      toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); },
      contains(name) { return classes.has(name); }
    },
    addEventListener(type, handler) { this.events[type] = handler; },
    setAttribute(name, value) { attributes.set(name, String(value)); },
    getAttribute(name) { return attributes.get(name); },
    querySelector(selector) {
      if (!selectors.has(selector)) selectors.set(selector, element());
      return selectors.get(selector);
    },
    querySelectorAll() { return []; },
    append(...nodes) { this.children.push(...nodes.flatMap(node => node.fragment ? node.children : [node])); },
    replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  };
}

function renderingContext() {
  const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8')
    .replace(/load\(\)\.catch\(\(error\) => setMessage\(error\.message, 'error'\)\);\s*$/, '');
  const context = vm.createContext({
    document: {
      getElementById: element,
      createElement: element,
      createDocumentFragment: () => ({ ...element(), fragment: true })
    },
    localStorage: { getItem: () => null }, URL
  });
  vm.runInContext(source, context);
  const created = [];
  context.createBookNode = (book, onSelectionChange) => {
    created.push({ id: book.id, onSelectionChange });
    return element();
  };
  context.renderBulkControls = () => {};
  const books = [1, 2].map(index => ({
    id: `book-${index}`, title: `Sample ${index}`, seriesName: 'Sample <script>',
    seriesKey: 'series:one/two', seriesExpectedCount: 2, currentPrice: 500
  }));
  return { context, created, group: context.groupBooks(books)[0] };
}

test('collapsed series do not build book cards; toggling only updates its own panel', () => {
  const { context, created, group } = renderingContext();
  context.renderBooks = () => assert.fail('a disclosure must not rebuild the entire list');
  const section = context.createSeriesNode(group);
  const [header, panel] = section.children;
  const summary = header.children[0];
  assert.equal(created.length, 0);
  assert.equal(panel.hidden, true);
  assert.equal(summary.getAttribute('aria-controls'), panel.id);
  assert.equal(summary.getAttribute('aria-expanded'), 'false');
  assert.ok(summary.innerHTML.includes('Sample &lt;script&gt;'));
  summary.events.click();
  assert.equal(created.length, 2);
  assert.equal(panel.children.length, 2);
  assert.equal(panel.hidden, false);
  assert.equal(summary.getAttribute('aria-expanded'), 'true');
  assert.equal(section.classList.contains('expanded'), true);
  summary.events.click();
  assert.equal(panel.children.length, 0);
  assert.equal(panel.hidden, true);
  assert.equal(vm.runInContext('state.expandedSeriesKeys.size', context), 0);
});

test('expanded panels survive re-rendering and selection is retained across collapse', () => {
  const { context, created, group } = renderingContext();
  vm.runInContext("state.expandedSeriesKeys.add('series:one/two'); state.selectedBookIds.add('book-1')", context);
  const section = context.createSeriesNode(group);
  const [header, panel] = section.children;
  const [summary, actions] = header.children;
  const checkbox = actions.children[0].querySelector('input');
  assert.equal(created.length, 2);
  assert.equal(panel.hidden, false);
  assert.equal(checkbox.indeterminate, true);
  checkbox.checked = true;
  checkbox.events.change();
  assert.equal(checkbox.indeterminate, false);
  assert.equal(summary.querySelector('.series-selection-count').textContent, '2冊選択中');
  summary.events.click();
  summary.events.click();
  assert.equal(vm.runInContext('state.selectedBookIds.size', context), 2);
  vm.runInContext("state.selectedBookIds.delete('book-1')", context);
  created.at(-1).onSelectionChange();
  assert.equal(checkbox.indeterminate, true);
  assert.equal(summary.querySelector('.series-selection-count').textContent, '1冊選択中');
});

test('series covers reserve space and defer non-leading images', () => {
  const { context, group } = renderingContext();
  group.books[0].imageUrl = 'https://example.test/cover.jpg';
  const lazy = context.createSeriesNode(group).children[0].children[0].innerHTML;
  const eager = context.createSeriesNode(group, true).children[0].children[0].innerHTML;
  assert.match(lazy, /width="64" height="86" loading="lazy" decoding="async"/);
  assert.match(eager, /loading="eager"/);
});

test('every native dialog has a visible heading as its accessible name', () => {
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const dialogs = [...html.matchAll(/<dialog\b([^>]*)>([\s\S]*?)<\/dialog>/g)];
  assert.equal(dialogs.length, 3);
  for (const [, attributes, content] of dialogs) {
    const headingId = attributes.match(/aria-labelledby="([\w-]+)"/)?.[1];
    assert.ok(headingId, 'dialog must have an accessible name');
    assert.match(content, new RegExp(`<h2 id="${headingId}">`));
  }
});

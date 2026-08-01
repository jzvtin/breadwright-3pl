/**
 * src/xml/util.js
 * Minimal, dependency-free XML serializer. Enough to reproduce the exact
 * element names, order, namespace and empty-element style of the Datex
 * samples. XML is whitespace-insensitive here, so we emit clean 2-space
 * indentation (the samples' own indentation was inconsistent).
 *
 * A node is created with el(tag, children, attrs):
 *   el('Foo', 'bar')                 -> <Foo>bar</Foo>
 *   el('Foo', null)                  -> <Foo/>            (self-closing)
 *   el('Foo', [ el('Bar', 'x') ])    -> nested block
 */

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Create an XML node. children: string | number | null | node[] */
function el(tag, children = null, attrs = null) {
  return { tag, children, attrs };
}

function attrStr(attrs) {
  if (!attrs) return '';
  return Object.entries(attrs)
    .map(([k, v]) => ` ${k}="${esc(v)}"`)
    .join('');
}

function render(node, indent = 0) {
  const pad = '  '.repeat(indent);
  const a = attrStr(node.attrs);

  if (node.children === null || node.children === undefined) {
    return `${pad}<${node.tag}${a}/>`;
  }
  if (!Array.isArray(node.children)) {
    return `${pad}<${node.tag}${a}>${esc(node.children)}</${node.tag}>`;
  }
  const inner = node.children
    .filter(Boolean)
    .map((c) => render(c, indent + 1))
    .join('\n');
  return `${pad}<${node.tag}${a}>\n${inner}\n${pad}</${node.tag}>`;
}

/** Serialize a root node to a full XML string (no XML declaration — samples had none). */
function toXml(root) {
  return render(root, 0) + '\n';
}

module.exports = { el, toXml, esc };

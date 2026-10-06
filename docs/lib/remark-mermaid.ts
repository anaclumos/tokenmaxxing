type Node = {
  type: string;
  name?: string;
  lang?: string | null;
  value?: string;
  attributes?: { type: string; name: string; value: string }[];
  children?: Node[];
  data?: Record<string, unknown>;
};

function walk(node: Node) {
  if (!node.children) return;
  node.children = node.children.map((child) => {
    if (child.type === 'code' && child.lang === 'mermaid' && child.value) {
      return {
        type: 'mdxJsxFlowElement',
        name: 'Mermaid',
        attributes: [{ type: 'mdxJsxAttribute', name: 'chart', value: child.value }],
        children: [],
        data: { _stringify: { node: child } },
      } satisfies Node;
    }
    walk(child);
    return child;
  });
}

export function remarkMermaid() {
  return (tree: Node) => walk(tree);
}

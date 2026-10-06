'use client';

import { useTheme } from 'fumadocs-ui/provider/base';
import { useEffect, useState } from 'react';

let renderCount = 0;

export function Mermaid({ chart }: { chart: string }) {
  const { resolvedTheme } = useTheme();
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      const mermaid = (await import('mermaid')).default;
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        theme: resolvedTheme === 'dark' ? 'dark' : 'neutral',
      });
      try {
        const rendered = await mermaid.render(`mermaid-${renderCount++}`, chart);
        if (live) {
          setSvg(rendered.svg);
          setError(null);
        }
      } catch (cause) {
        if (live) setError(String(cause));
      }
    })();
    return () => {
      live = false;
    };
  }, [chart, resolvedTheme]);

  if (error) {
    return (
      <pre className="overflow-x-auto" title={error}>
        <code>{chart}</code>
      </pre>
    );
  }
  if (!svg) return <div className="my-6 min-h-24" />;
  return <div className="my-6 flex justify-center overflow-x-auto" dangerouslySetInnerHTML={{ __html: svg }} />;
}

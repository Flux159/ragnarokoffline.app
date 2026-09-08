/**
 * TableOfContents - Right sidebar showing page headings
 */

import { useEffect, useState } from 'react';

interface TocItem {
  id: string;
  text: string;
  level: number;
}

export function TableOfContents() {
  const [headings, setHeadings] = useState<TocItem[]>([]);
  const [activeId, setActiveId] = useState<string>('');

  useEffect(() => {
    const findHeadings = () => {
      const article = document.querySelector('.content');
      if (!article) return;

      const elements = article.querySelectorAll('h1, h2, h3');
      const items: TocItem[] = [];

      elements.forEach((el) => {
        if (!el.id) {
          el.id = el.textContent?.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '') || '';
        }

        items.push({
          id: el.id,
          text: el.textContent || '',
          level: parseInt(el.tagName[1], 10),
        });
      });

      setHeadings(items);
    };

    findHeadings();

    // Observe for DOM changes (when MDX content loads asynchronously)
    const observer = new MutationObserver(() => {
      findHeadings();
    });

    const article = document.querySelector('.content');
    if (article) {
      observer.observe(article, { childList: true, subtree: true });
    }

    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            setActiveId(entry.target.id);
          }
        });
      },
      { rootMargin: '-80px 0px -80% 0px' }
    );

    headings.forEach(({ id }) => {
      const el = document.getElementById(id);
      if (el) observer.observe(el);
    });

    return () => observer.disconnect();
  }, [headings]);

  if (headings.length === 0) {
    return null;
  }

  return (
    <aside className="toc">
      <div className="toc-title">On this page</div>
      <nav className="toc-nav">
        {headings.map((heading) => (
          <a
            key={heading.id}
            href={`#${heading.id}`}
            className={`toc-link toc-level-${heading.level} ${activeId === heading.id ? 'active' : ''}`}
            onClick={(e) => {
              e.preventDefault();
              setActiveId(heading.id);
              document.getElementById(heading.id)?.scrollIntoView({ behavior: 'smooth' });
            }}
          >
            {heading.text}
          </a>
        ))}
      </nav>
    </aside>
  );
}

import { useEffect, useState, useRef } from 'react';
import { AppMark } from '../components/AppMark';
import { Link, useLocation } from 'react-router-dom';
import { TableOfContents } from '../components/TableOfContents';

// Import all markdown files at build time.
// NOTE: only files that live in docs-site/docs/ are bundled into the site —
// pages must be explicitly added there (and to the sidebar below) to publish.
const mdxModules = import.meta.glob('../../docs/**/*.{md,mdx}');
// Import raw markdown content for copy/download
const mdxRaw = import.meta.glob('../../docs/**/*.{md,mdx}', { query: '?raw', import: 'default' });

// Sidebar configuration
const sidebarItems = [
  {
    title: 'Getting Started',
    items: [
      { label: 'Introduction', path: 'getting-started' },
      { label: 'Installing', path: 'installing' },
      { label: 'Playing from the keyboard', path: 'keyboard' },
    ],
  },
  {
    title: 'Settings',
    items: [
      { label: 'General', path: 'settings-general' },
      { label: 'Multiplayer', path: 'settings-multiplayer' },
      { label: 'Accounts', path: 'settings-accounts' },
      { label: 'Save data', path: 'settings-save-data' },
      { label: 'Mods', path: 'settings-mods' },
      { label: 'Population', path: 'settings-population' },
      { label: 'Rates', path: 'settings-rates' },
    ],
  },
  {
    title: 'Guides',
    items: [
      { label: 'Playing with friends', path: 'friends' },
      { label: 'Making mods', path: 'modding' },
      { label: 'Troubleshooting', path: 'troubleshooting' },
    ],
  },
];

function CopyDownloadButton({ rawContent, slug }: { rawContent: string; slug: string }) {
  const [copied, setCopied] = useState(false);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(rawContent);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDownload = () => {
    const filename = slug.replace(/\//g, '-') + '.md';
    const blob = new Blob([rawContent], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
    setOpen(false);
  };

  return (
    <div className="copy-download-group" ref={ref}>
      <button className="copy-btn" onClick={handleCopy}>
        {copied ? 'Copied!' : 'Copy page'}
      </button>
      <button className="copy-dropdown-toggle" onClick={() => setOpen(!open)}>
        <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
          <path d="M3 5l3 3 3-3H3z" />
        </svg>
      </button>
      {open && (
        <div className="copy-dropdown-menu">
          <button onClick={handleDownload}>Download .md</button>
        </div>
      )}
    </div>
  );
}

export default function DocPage() {
  const location = useLocation();
  const [Content, setContent] = useState<React.ComponentType | null>(null);
  const [rawContent, setRawContent] = useState<string>('');
  const [error, setError] = useState<string | null>(null);

  // Extract slug from path (e.g., /docs/getting-started -> getting-started)
  const slug = location.pathname.replace('/docs/', '') || 'getting-started';

  useEffect(() => {
    async function loadContent() {
      setError(null);
      setContent(null);
      setRawContent('');

      // Try different path variations
      const possiblePaths = [
        `../../docs/${slug}.mdx`,
        `../../docs/${slug}.md`,
        `../../docs/${slug}/index.mdx`,
        `../../docs/${slug}/index.md`,
      ];

      for (const path of possiblePaths) {
        if (mdxModules[path]) {
          try {
            const module = (await mdxModules[path]()) as { default: React.ComponentType };
            setContent(() => module.default);
            // Load raw content
            if (mdxRaw[path]) {
              const raw = (await mdxRaw[path]()) as string;
              setRawContent(raw);
            }
            return;
          } catch (err) {
            console.error('Failed to load:', path, err);
          }
        }
      }

      setError(`Document not found: ${slug}`);
    }

    loadContent();
  }, [slug]);

  return (
    <>
      <nav className="navbar">
        <Link to="/" className="navbar-brand">
          <AppMark size={26} />
          Ragnarok Offline
        </Link>
        <div className="navbar-links">
          <a href="https://discord.gg/jUYC9dMbu5" target="_blank" rel="noopener">
            Discord
          </a>
          <Link to="/docs/getting-started">Docs</Link>
          <a href="https://github.com/Flux159/ragnarokoffline.app" target="_blank" rel="noopener">
            GitHub
          </a>
        </div>
      </nav>

      <div className="layout">
        <aside className="sidebar">
          {sidebarItems.map((section) => (
            <div key={section.title} className="sidebar-section">
              <div className="sidebar-title">{section.title}</div>
              {section.items.map((item) => (
                <Link
                  key={item.path}
                  to={`/docs/${item.path}`}
                  className={`sidebar-link ${slug === item.path ? 'active' : ''}`}
                >
                  {item.label}
                </Link>
              ))}
            </div>
          ))}
        </aside>

        <main className="content">
          {error ? (
            <div>
              <h1>Page Not Found</h1>
              <p>{error}</p>
              <p>
                <Link to="/docs/getting-started">Go to Getting Started</Link>
              </p>
            </div>
          ) : Content ? (
            <>
              {rawContent && <CopyDownloadButton rawContent={rawContent} slug={slug} />}
              <Content />
            </>
          ) : (
            <div>Loading...</div>
          )}
        </main>

        <TableOfContents key={slug} />
      </div>
    </>
  );
}

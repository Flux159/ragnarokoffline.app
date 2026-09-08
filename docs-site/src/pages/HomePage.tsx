import { Link } from 'react-router-dom';
import { AppMark } from '../components/AppMark';

const features = [
  {
    title: 'One app, no setup',
    body: 'The server, the database and the client are all inside it. No Docker to install, no rAthena to compile, no client to patch. Point it at your Ragnarok files and press play.',
  },
  {
    title: 'Your own rules',
    body: 'Experience and drop rates, stat and attack-speed caps, free Kafra warps, Renewal or Pre-Renewal. Change them in Settings; the server restarts and your characters stay.',
  },
  {
    title: 'Play with friends',
    body: 'Share a link and a friend plays in their browser. They install nothing. Over your own network, or over the internet through a Cloudflare tunnel you control.',
  },
  {
    title: 'A world that is not empty',
    body: 'The population engine fills towns and fields with characters who walk, fight, sit in Prontera and open stalls, so a server of one does not feel like one.',
  },
  {
    title: 'Mods that are just folders',
    body: 'Drop in sprites, maps, NPCs, item tables or a whole custom island. No GRF repacking. Settings lists what is installed, with a checkbox each.',
  },
  {
    title: 'It stays yours',
    body: 'Everything runs on your machine and nothing is sent anywhere. Back up your characters to a file whenever you like, and restore them the same way.',
  },
];

export default function HomePage() {
  return (
    <>
      <nav className="navbar">
        <Link to="/" className="navbar-brand">
          <AppMark size={26} />
          Ragnarok Offline
        </Link>
        <div className="navbar-links">
          <Link to="/docs/getting-started">Docs</Link>
          <a href="https://github.com/Flux159/ragnarokoffline.app" target="_blank" rel="noopener">
            GitHub
          </a>
        </div>
      </nav>

      <div style={{ marginTop: 'var(--navbar-height)' }}>
        <header className="hero">
          <h1>Your own Ragnarok Online server</h1>
          <p>
            A single app for macOS, Windows and Linux. It carries the server, the database and the
            client, so there is nothing to configure before you are standing in Prontera.
          </p>
          <div className="hero-buttons">
            <a
              className="btn btn-primary"
              href="https://github.com/Flux159/ragnarokoffline.app/releases/latest"
              target="_blank"
              rel="noopener"
            >
              Download
            </a>
            <Link className="btn btn-secondary" to="/docs/getting-started">
              Read the docs
            </Link>
          </div>
          <p className="hero-note">
            You supply your own Ragnarok client files. Nothing copyrighted ships with the app.
          </p>
        </header>

        <section className="features">
          {features.map((feature) => (
            <div className="feature" key={feature.title}>
              <h3>{feature.title}</h3>
              <p>{feature.body}</p>
            </div>
          ))}
        </section>

        <footer className="footer">
          <p>
            Built on <a href="https://github.com/rathena/rathena" target="_blank" rel="noopener">rAthena</a>,{' '}
            <a href="https://github.com/MrAntares/roBrowserLegacy" target="_blank" rel="noopener">roBrowserLegacy</a>{' '}
            and <a href="https://github.com/Flux159/nebula" target="_blank" rel="noopener">nebula</a>.
          </p>
        </footer>
      </div>
    </>
  );
}

/**
 * The app's own icon, not a second drawing of it.
 *
 * BASE_URL keeps it correct under the /ragnarokoffline.app/ project-pages path
 * as well as at a domain root, so moving the site does not break the mark.
 */
export function AppMark({ size = 24 }: { size?: number }) {
  return (
    <img
      src={`${import.meta.env.BASE_URL}icon.png`}
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
      style={{ flexShrink: 0, display: 'block', borderRadius: 6 }}
    />
  );
}

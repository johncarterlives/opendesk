import { LINKS } from './site';

/**
 * The desktop app's downloads. CI publishes every stable build under the same
 * names on the rolling `desktop-latest` release, so these links never change;
 * `version.json` beside them says which version they are. The build reads it
 * once for /download. A build that cannot reach it (or finds something it does
 * not expect) hides the version line; the links work either way. Only when GitHub
 * answers that it does not exist is the app unpublished: /download then says it
 * is coming instead of linking to files that are not there. Publishing a stable
 * release redeploys the site (.github/workflows/desktop.yml).
 */
const repo = new URL(LINKS.github).pathname.replace(/^\/|\/$/g, '');
const LATEST = `https://github.com/${repo}/releases/download/desktop-latest`;

export type DesktopOs = 'mac' | 'windows' | 'linux';

export interface DesktopAsset {
  os: DesktopOs;
  /** The file's name on the release. */
  file: string;
  url: string;
  /** What kind of file it is, as people know it. */
  format: string;
  arch: string;
}

const asset = (os: DesktopOs, file: string, format: string, arch: string): DesktopAsset => ({
  os,
  file,
  url: `${LATEST}/${file}`,
  format,
  arch,
});

export const DESKTOP_ASSETS = {
  mac: asset('mac', 'opendesk-mac.dmg', '.dmg', 'Apple silicon and Intel'),
  windows: asset('windows', 'opendesk-windows.exe', '.exe', 'x64 and arm64'),
  appImageX64: asset('linux', 'opendesk-linux-x64.AppImage', 'AppImage', 'x64'),
  appImageArm64: asset('linux', 'opendesk-linux-arm64.AppImage', 'AppImage', 'arm64'),
  debAmd64: asset('linux', 'opendesk-linux-amd64.deb', '.deb', 'amd64'),
  debArm64: asset('linux', 'opendesk-linux-arm64.deb', '.deb', 'arm64'),
} as const;

/** Every desktop release, newest first, for when the version is unknown. */
export const DESKTOP_RELEASES = `${LINKS.githubReleases}?q=desktop-v&expanded=true`;

/** The checksums for one version, published on its own release. */
export const checksumsUrl = (version: string) =>
  `https://github.com/${repo}/releases/download/desktop-v${version}/SHA256SUMS`;

export interface DesktopRelease {
  version: string;
  /** ISO 8601. */
  date: string;
  /** "13 Oct 2026", the same in every locale and time zone. */
  dateLabel: string;
  notesUrl: string;
  /** The systems with a download, this version's or an earlier one's (a release can leave systems out). */
  platforms: DesktopOs[];
}

let cache: Promise<DesktopRelease | null> | undefined;
let published = true;

export function getDesktopRelease(): Promise<DesktopRelease | null> {
  cache ??= load();
  return cache;
}

/** False only when the rolling release has no version.json: nothing to download yet. */
export async function isDesktopPublished(): Promise<boolean> {
  await getDesktopRelease();
  return published;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

async function load(): Promise<DesktopRelease | null> {
  // A local copy can stand in while checking the page, before a release exists.
  const source = (import.meta.env.DESKTOP_VERSION_URL as string | undefined) || `${LATEST}/version.json`;
  try {
    // github.com answers with a redirect to its download host; fetch follows it.
    const res = await fetch(source, {
      headers: { Accept: 'application/json', 'User-Agent': 'opendesk-site' },
      signal: AbortSignal.timeout(4000),
    });
    if (res.status === 404) published = false;
    if (!res.ok) throw new Error(`responded ${res.status}`);
    const body = (await res.json()) as { version?: unknown; date?: unknown; notes_url?: unknown; platforms?: unknown };
    const { version, date, notes_url: notesUrl } = body;
    if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) throw new Error('no stable version in it');
    const when = typeof date === 'string' ? new Date(date) : null;
    if (!when || Number.isNaN(when.getTime())) throw new Error('no release date in it');
    if (typeof notesUrl !== 'string' || !notesUrl.startsWith(`https://github.com/${repo}/`)) throw new Error('no release notes link in it');
    // Older version.json files have no list: every system.
    const all: DesktopOs[] = ['mac', 'windows', 'linux'];
    const platforms = Array.isArray(body.platforms) ? all.filter((os) => (body.platforms as unknown[]).includes(os)) : all;
    return {
      version,
      date: when.toISOString(),
      dateLabel: `${when.getUTCDate()} ${MONTHS[when.getUTCMonth()]} ${when.getUTCFullYear()}`,
      notesUrl,
      platforms,
    };
  } catch (err) {
    console.info(
      published
        ? `[desktop] release version unavailable, showing the downloads without it (${(err as Error).message})`
        : '[desktop] no desktop release yet, /download says it is coming',
    );
    return null;
  }
}

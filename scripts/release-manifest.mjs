/**
 * Builds the `latest.json` an updater endpoint serves.
 *
 * Written because the manual version of this job has one step that is easy to
 * get wrong and impossible to notice: pasting the signature. A `latest.json`
 * carrying the *previous* release's signature looks perfectly well-formed, is
 * served without complaint, and fails only on the user's machine — silently,
 * because a signature that does not verify is indistinguishable from "no update
 * available" by design. So the signature is read from the file the build just
 * produced, never typed.
 *
 * Nothing here talks to GitHub, or to anything else. It reads the bundle folder
 * and writes one file; publishing it is yours to do.
 *
 *   npm run release:manifest
 *
 * With no arguments it builds the GitHub Releases URL for the version in
 * `tauri.conf.json` — `.../releases/download/v<version>/<installer>` — which is
 * the tag the release will live under. Typing that by hand each time is a typo
 * waiting to happen, and a manifest pointing at a tag that does not exist fails
 * the same silent way a bad signature does.
 *
 * `--base-url` overrides it for anywhere else; `--repo owner/name` for another
 * repository.
 */

import { readFile, writeFile, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const BUNDLE = join(root, 'src-tauri', 'target', 'release', 'bundle');

/** Reads `--name value` off the command line. */
function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index !== -1 ? process.argv[index + 1] : undefined;
}

function fail(message) {
  console.error(`\n  ✗ ${message}\n`);
  process.exit(1);
}

const config = JSON.parse(await readFile(join(root, 'src-tauri', 'tauri.conf.json'), 'utf8'));
const version = config.version;

/** The repository the releases live in. Overridable, so a fork works. */
const repo = argument('repo') ?? 'Xeiners/veglass';

/**
 * The folder the installer will be reachable from.
 *
 * Defaults to the GitHub Releases download URL for this version's tag, which is
 * the one thing about a release that is entirely predictable — and the one most
 * worth not retyping, since a manifest pointing at a tag that does not exist
 * fails exactly as silently as a bad signature.
 */
const baseUrl = argument('base-url') ?? `https://github.com/${repo}/releases/download/v${version}`;

if (!baseUrl.startsWith('https://')) {
  // The plugin refuses a non-HTTPS endpoint in a release build, and an installer
  // fetched over HTTP is exactly the thing signing exists to prevent.
  fail(`L'URL doit être en HTTPS : ${baseUrl}`);
}

/**
 * The installer this manifest points at, and its detached signature.
 *
 * NSIS rather than MSI: it is the one the app is distributed as, and pointing
 * an updater at a different installer than the one people have is a good way to
 * end up with two copies of the application.
 */
async function installer() {
  const dir = join(BUNDLE, 'nsis');
  let entries;
  try {
    entries = await readdir(dir);
  } catch {
    fail(`Aucun bundle NSIS. Lancez d'abord « npm run desktop:build ».\n    Attendu dans : ${dir}`);
  }

  // Matched against the configured version rather than "the newest file": a
  // stale build from a previous version sitting in the folder would otherwise
  // be published under the new version's name.
  const name = entries.find((entry) => entry.endsWith('-setup.exe') && entry.includes(version));
  if (!name) {
    fail(
      `Aucun installateur pour la version ${version} dans ${dir}.\n` +
        `    Présents : ${entries.join(', ') || '(rien)'}\n` +
        `    La version de tauri.conf.json et celle du build doivent correspondre.`,
    );
  }

  let signature;
  try {
    signature = (await readFile(join(dir, `${name}.sig`), 'utf8')).trim();
  } catch {
    fail(
      `L'installateur existe mais pas sa signature (${name}.sig).\n` +
        `    Le build n'a pas été signé : définissez TAURI_SIGNING_PRIVATE_KEY\n` +
        `    (et TAURI_SIGNING_PRIVATE_KEY_PASSWORD) avant « npm run desktop:build ».`,
    );
  }
  if (signature.length === 0) {
    fail(`La signature ${name}.sig est vide.`);
  }

  return { name, signature };
}

const { name, signature } = await installer();

const manifest = {
  version,
  notes: argument('notes') ?? `Veglass ${version}`,
  pub_date: new Date().toISOString(),
  platforms: {
    'windows-x86_64': {
      signature,
      url: `${baseUrl.replace(/\/+$/, '')}/${encodeURIComponent(name)}`,
    },
  },
};

const output = join(BUNDLE, 'latest.json');
await writeFile(output, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

console.log(`
  ✓ ${output}

    version   ${version}
    fichier   ${name}
    url       ${manifest.platforms['windows-x86_64'].url}

  À joindre à la release « v${version} », avec l'installateur lui-même.
  Le tag doit s'appeler exactement v${version} pour que l'URL ci-dessus résolve.
`);

/** The project's GitHub repository, the one site player links may open. */
export const PROJECT_URL = 'https://github.com/Chia-Network/chia-gaming';

/**
 * Whether a link the player window asked to open in a new window may go to the
 * system browser. Only pages in the project's repository qualify, such as the
 * Krunk word list linked from the rules; everything else stays blocked.
 */
export function isOpenableExternalLink(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  const project = new URL(PROJECT_URL);
  return (
    url.protocol === project.protocol &&
    url.host === project.host &&
    url.username === '' &&
    url.password === '' &&
    (url.pathname === project.pathname || url.pathname.startsWith(`${project.pathname}/`))
  );
}

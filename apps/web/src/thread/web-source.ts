/** How a cited web page is named: its title, then where and when it was read. */
export function webLabels(web: { url: string; title: string; fetched_at: string }) {
  const host = URL.canParse(web.url) ? new URL(web.url).hostname : web.url;
  return {
    documentName: web.title || host,
    place: `${host}, read ${web.fetched_at.slice(0, 10)}`,
  };
}
